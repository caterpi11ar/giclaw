/**
 * End-to-end mock test for the Feishu connector.
 *
 * Nothing here talks to Feishu: a local HTTP server impersonates the open
 * platform (tenant token, message send, custom-bot webhook, event callback),
 * and the assertions drive the *real* connector code from `src/` through the
 * real notification dispatcher and the real Fastify plugin-route stack.
 *
 * What is mocked
 *   - Feishu itself (a local HTTP server, including signature checking, so a
 *     broken signature is reported the way Feishu would report it).
 *   - The gateway (runs are recorded instead of driving a browser).
 *
 * What is real
 *   - Plugin discovery, manifest parsing, config parsing, `env:` secret
 *     resolution, capability registration, `NotificationDispatcher`,
 *     `registerWebSecurity`, `registerPluginRoutes` and the connector code.
 *
 * Usage:  npx tsx scripts/feishu-e2e.mjs   (or: pnpm test:feishu)
 * Env:    GICLAW_E2E_PORT (default 3210), GICLAW_E2E_VERBOSE=1 for plugin logs.
 */

import { Buffer } from 'node:buffer'
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import process from 'node:process'
import Fastify from 'fastify'
import { appConfigSchema } from '../src/config/schema.js'
import { discoverAllPlugins } from '../src/plugins/bootstrap.js'
import { PluginHost } from '../src/plugins/host.js'
import { NotificationDispatcher } from '../src/plugins/notify.js'
import { logger } from '../src/utils/logger.js'
import { isSelfAuthenticatingPluginRoute, registerPluginRoutes } from '../src/web/plugin-routes.js'
import { registerWebSecurity } from '../src/web/security.js'

const E2E_PORT = Number(process.env.GICLAW_E2E_PORT ?? 3210)
const WEBHOOK_SECRET = randomBytes(16).toString('hex')
const ENCRYPT_KEY = randomBytes(16).toString('hex')
const VERIFICATION_TOKEN = `vt-${randomBytes(6).toString('hex')}`
const APP_ID = 'cli_e2e_app'
const APP_SECRET = `secret-${randomBytes(8).toString('hex')}`
const ALLOWED_OPEN_ID = 'ou_owner'
const ALLOWED_CHAT_ID = 'oc_ops'
const RATE_LIMIT_CHAT_ID = 'oc_ratelimit'
const DAILY_TASKS = ['welkin-moon', 'claim-mail']

// Both secrets are referenced from the config as `env:` so the real secret
// resolution path is exercised instead of a hardcoded literal.
process.env.FEISHU_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.FEISHU_APP_SECRET = APP_SECRET
if (process.env.GICLAW_E2E_VERBOSE !== '1')
  logger.setLevel('warn')

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------

const results = []
let failed = 0

function check(name, condition, detail) {
  const ok = condition === true
  if (!ok)
    failed++
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || detail === undefined ? '' : `\n         ${detail}`}`)
}

function checkEqual(name, actual, expected) {
  const ok = actual === expected
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function settle() {
  return new Promise((resolve) => {
    setTimeout(resolve, 50)
  })
}
// ---------------------------------------------------------------------------
// Mock Feishu open platform
// ---------------------------------------------------------------------------

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
  })
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

/** The documented custom-bot signature, recomputed independently of the connector. */
function expectedWebhookSign(timestamp, secret) {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
}

function createMockFeishu() {
  const state = {
    requests: [],
    tokenRequests: 0,
    messages: 0,
    sendAuthRetries: 0,
    sendErrorCode: null,
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const rawBody = await readBody(request)
    let body
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody)
      }
      catch {
        body = rawBody
      }
    }
    state.requests.push({ method: request.method, path: url.pathname, search: url.search, headers: request.headers, body })

    if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
      state.tokenRequests++
      if (body?.app_id !== APP_ID || body?.app_secret !== APP_SECRET)
        return sendJson(response, 200, { code: 10003, msg: 'invalid app credentials' })
      return sendJson(response, 200, {
        code: 0,
        msg: 'ok',
        tenant_access_token: `t-e2e-${state.tokenRequests}`,
        expire: 7200,
      })
    }

    if (url.pathname === '/open-apis/im/v1/messages') {
      if (request.method !== 'POST' || request.headers.authorization === undefined)
        return sendJson(response, 200, { code: 99991661, msg: 'authorization required' })
      if (state.sendAuthRetries > 0) {
        state.sendAuthRetries--
        return sendJson(response, 200, { code: 99991663, msg: 'tenant token expired' })
      }
      if (state.sendErrorCode !== null)
        return sendJson(response, 200, { code: state.sendErrorCode, msg: 'send rejected by feishu' })
      state.messages++
      return sendJson(response, 200, { code: 0, msg: 'ok', data: { message_id: `om_e2e_${state.messages}` } })
    }

    if (url.pathname.startsWith('/open-apis/bot/v2/hook/')) {
      if (body?.sign !== undefined) {
        const expected = expectedWebhookSign(String(body.timestamp ?? ''), WEBHOOK_SECRET)
        if (body.sign !== expected)
          return sendJson(response, 200, { code: 19021, msg: 'sign match fail' })
      }
      if (!url.pathname.endsWith('/hook/e2e-token'))
        return sendJson(response, 200, { code: 19001, msg: 'unknown webhook token' })
      state.messages++
      return sendJson(response, 200, { code: 0, msg: 'success' })
    }

    return sendJson(response, 404, { code: 404, msg: `unhandled mock route ${url.pathname}` })
  })

  return {
    state,
    listen: () => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    }),
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

// ---------------------------------------------------------------------------
// Connector harness (real plugin host over a recorded gateway)
// ---------------------------------------------------------------------------

const runs = []

function createRecordedRuntime() {
  return {
    gateway: {
      getSnapshot: () => ({ running: false }),
      getRunHistory: () => [],
      resolveRoutine: name => (name === 'daily' ? [...DAILY_TASKS] : null),
      enqueueRun: async (taskIds) => {
        runs.push(taskIds ?? null)
        return runResult()
      },
    },
  }
}

async function buildHost(pluginConfig, routes) {
  const config = appConfigSchema.parse({
    plugins: { enabled: ['feishu'], entries: { feishu: { config: pluginConfig } } },
    channels: { feishu: {} },
    notifications: { on: ['run:complete', 'run:error'], routes },
  })
  const host = new PluginHost({
    config,
    plugins: await discoverAllPlugins(config),
    runtime: createRecordedRuntime(),
  })
  const report = await host.load()
  const dispatcher = new NotificationDispatcher({
    config,
    getChannel: id => host.capabilities.getChannel(id),
    logger,
  })
  return { config, host, report, dispatcher }
}

function runResult() {
  return {
    results: [{ taskId: 'welkin-moon', success: true, message: 'claimed', durationMs: 12 }],
    completedAt: new Date('2026-01-01T00:00:00.000Z'),
  }
}

// ---------------------------------------------------------------------------
// Feishu event-callback helpers
// ---------------------------------------------------------------------------

let eventCounter = 0

function signInbound(rawBody) {
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const nonce = randomBytes(4).toString('hex')
  const signature = createHash('sha256')
    .update(timestamp)
    .update(nonce)
    .update(ENCRYPT_KEY)
    .update(rawBody)
    .digest('hex')
  return {
    'content-type': 'application/json',
    'x-lark-request-timestamp': timestamp,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': signature,
  }
}

function encryptPayload(payload) {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(ENCRYPT_KEY).digest(), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf-8'), cipher.final()])
  return Buffer.concat([iv, ciphertext]).toString('base64')
}

function messageEvent(overrides = {}) {
  eventCounter++
  const {
    chatId = ALLOWED_CHAT_ID,
    openId = ALLOWED_OPEN_ID,
    mentions = true,
    messageType = 'text',
    chatType = 'group',
  } = overrides
  return {
    schema: '2.0',
    header: {
      event_id: `evt_e2e_${eventCounter}`,
      event_type: 'im.message.receive_v1',
      token: VERIFICATION_TOKEN,
      create_time: String(Date.now()),
    },
    event: {
      sender: { sender_id: { open_id: openId }, sender_type: 'user' },
      message: {
        message_id: `om_in_${eventCounter}`,
        chat_id: chatId,
        chat_type: chatType,
        message_type: messageType,
        content: JSON.stringify({ text: '@giclaw status' }),
        ...(mentions ? { mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'giclaw' }] } : {}),
      },
    },
  }
}

async function postEvent(path, body, { sign = true, headers = {} } = {}) {
  const rawBody = JSON.stringify(body)
  const response = await fetch(`http://127.0.0.1:${E2E_PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sign ? signInbound(rawBody) : {}), ...headers },
    body: rawBody,
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  }
  catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

// ---------------------------------------------------------------------------
// Test run
// ---------------------------------------------------------------------------

const mock = createMockFeishu()
let app
let webhookHost
let appHost
let plainHost
let wsHost
let webhookOnlyHost

try {
  const mockPort = await mock.listen()
  const mockBaseUrl = `http://127.0.0.1:${mockPort}`
  console.log(`\nmock feishu open platform: ${mockBaseUrl}`)

  // -- A. outbound: custom-bot webhook -------------------------------------
  console.log('\nA. 出站 - 自定义群机器人（webhook 模式）')
  webhookHost = await buildHost(
    {
      mode: 'webhook',
      webhookUrl: `${mockBaseUrl}/open-apis/bot/v2/hook/e2e-token`,
      webhookSecret: 'env:FEISHU_WEBHOOK_SECRET',
      card: true,
      targets: { ops: { webhookUrl: `${mockBaseUrl}/open-apis/bot/v2/hook/e2e-token` } },
    },
    [{ channel: 'feishu', target: 'ops' }],
  )
  checkEqual('插件加载成功', webhookHost.report.loaded.includes('feishu'), true)
  checkEqual('加载失败列表为空', webhookHost.report.failed.length, 0)

  const webhookEntries = await (async () => {
    const message = webhookHost.dispatcher.buildRunMessage('run-e2e-1', 'cron', runResult())
    return webhookHost.dispatcher.dispatch(message)
  })()
  const hookRequest = mock.state.requests.find(item => item.path.startsWith('/open-apis/bot/v2/hook/'))
  checkEqual('dispatcher 派发成功', webhookEntries[0]?.ok, true)
  checkEqual('派发详情', webhookEntries[0]?.detail, 'sent via Feishu webhook (account default)')
  check('mock 平台收到了 webhook 调用', hookRequest !== undefined)
  checkEqual('自定义机器人签名通过（mock 独立验签）', hookRequest?.body?.sign !== undefined, true)
  checkEqual('发送的是互动卡片', hookRequest?.body?.msg_type, 'interactive')
  checkEqual('卡片带标题', hookRequest?.body?.card?.header?.title?.content !== undefined, true)
  check(
    '卡片正文包含运行结果',
    JSON.stringify(hookRequest?.body?.card ?? {}).includes('welkin-moon'),
  )

  // -- B. outbound: self-built app -----------------------------------------
  console.log('\nB. 出站 - 自建应用（app 模式）')
  appHost = await buildHost(
    {
      mode: 'app',
      domain: mockBaseUrl,
      appId: APP_ID,
      appSecret: `env:FEISHU_APP_SECRET`,
      card: true,
      connectionMode: 'webhook',
      encryptKey: ENCRYPT_KEY,
      verificationToken: VERIFICATION_TOKEN,
      dmPolicy: 'allowlist',
      allowFrom: [ALLOWED_OPEN_ID],
      groupPolicy: 'allowlist',
      groupAllowFrom: [ALLOWED_CHAT_ID, RATE_LIMIT_CHAT_ID],
      groupSenderAllowFrom: [ALLOWED_OPEN_ID],
      requireMention: true,
      targets: { ops: { chatId: 'oc_ops', receiveIdType: 'chat_id' } },
      inbound: { routine: 'daily' },
    },
    [{ channel: 'feishu', target: 'ops' }],
  )
  checkEqual('插件加载成功（app 模式）', appHost.report.loaded.includes('feishu'), true)

  const sendMessage = () => appHost.dispatcher.dispatch(
    appHost.dispatcher.buildRunMessage('run-e2e-2', 'manual', runResult()),
  )

  const appEntries = await sendMessage()
  const tokenRequestsAfterFirstSend = mock.state.tokenRequests
  checkEqual('app 模式派发成功', appEntries[0]?.ok, true)
  checkEqual('返回了 message_id', appEntries[0]?.detail, `sent om_e2e_${mock.state.messages}`)
  checkEqual('租户令牌请求了 1 次', tokenRequestsAfterFirstSend, 1)
  const sendRequest = mock.state.requests.filter(item => item.path === '/open-apis/im/v1/messages').at(-1)
  checkEqual('携带 Bearer 令牌', sendRequest?.headers?.authorization, `Bearer t-e2e-1`)
  checkEqual('receive_id_type=chat_id', sendRequest?.search, '?receive_id_type=chat_id')
  checkEqual('receive_id 来自 targets.ops.chatId', sendRequest?.body?.receive_id, 'oc_ops')
  checkEqual('msg_type=interactive', sendRequest?.body?.msg_type, 'interactive')
  check('content 是卡片 JSON', String(sendRequest?.body?.content ?? '').startsWith('{'))

  await sendMessage()
  checkEqual('令牌被缓存（第二次发送不重取）', mock.state.tokenRequests, 1)

  mock.state.sendAuthRetries = 1
  const retryEntries = await sendMessage()
  checkEqual('令牌过期后自动重取并重试成功', retryEntries[0]?.ok, true)
  checkEqual('重试时重新请求了令牌', mock.state.tokenRequests, 2)

  mock.state.sendErrorCode = 230002
  const failureEntries = await sendMessage()
  mock.state.sendErrorCode = null
  checkEqual('平台报错时 ok=false', failureEntries[0]?.ok, false)
  check('失败详情保留飞书错误码', String(failureEntries[0]?.detail ?? '').includes('230002'))
  checkEqual('失败不会抛出，只记录', failureEntries.length, 1)

  // -- C. inbound over real HTTP -------------------------------------------
  console.log('\nC. 入站 - 事件回调（真实 HTTP + 真实插件路由）')
  app = Fastify({ logger: false })
  registerWebSecurity(app, E2E_PORT, undefined, {
    isSelfAuthenticating: (method, path) => isSelfAuthenticatingPluginRoute(appHost.host.capabilities, method, path),
  })
  registerPluginRoutes(app, appHost.host.capabilities, logger)
  try {
    await app.listen({ port: E2E_PORT, host: '127.0.0.1' })
  }
  catch (error) {
    throw new Error(`Could not bind 127.0.0.1:${E2E_PORT} (${error.code ?? 'unknown'}); set GICLAW_E2E_PORT to a free port`)
  }
  const inboundPath = appHost.host.capabilities.listRoutes()[0]?.route?.path
  checkEqual('入站路由已注册', inboundPath, '/feishu/events')

  const challenge = await postEvent(inboundPath, { type: 'url_verification', challenge: 'e2e-challenge', token: VERIFICATION_TOKEN })
  checkEqual('订阅握手返回 challenge', challenge.body?.challenge, 'e2e-challenge')
  checkEqual('握手不触发运行', runs.length, 0)

  const badToken = await postEvent(inboundPath, { ...messageEvent(), header: { ...messageEvent().header, token: 'wrong' } })
  checkEqual('verification token 不匹配 -> 401', badToken.status, 401)

  const badSignature = await postEvent(inboundPath, messageEvent(), { sign: false })
  checkEqual('缺少签名头 -> 401', badSignature.status, 401)

  const forged = await postEvent(inboundPath, messageEvent(), { sign: false, headers: signInbound('{"tampered":true}') })
  checkEqual('签名与正文不匹配 -> 401', forged.status, 401)
  checkEqual('被拒绝的请求没有触发运行', runs.length, 0)

  const accepted = await postEvent(inboundPath, messageEvent())
  await settle()
  checkEqual('合法事件 ack 200 {code:0}', accepted.body?.code, 0)
  checkEqual('触发了 1 次运行', runs.length, 1)
  checkEqual('运行映射到 inbound.routine 的任务', JSON.stringify(runs[0]), JSON.stringify(DAILY_TASKS))

  const duplicate = messageEvent()
  const runsBeforeDuplicate = runs.length
  await postEvent(inboundPath, duplicate)
  await postEvent(inboundPath, duplicate)
  await settle()
  checkEqual('同一 event_id 首发触发、重投去重', runs.length - runsBeforeDuplicate, 1)

  const runsBeforeIgnored = runs.length
  await postEvent(inboundPath, messageEvent({ mentions: false }))
  await postEvent(inboundPath, messageEvent({ chatId: 'oc_outsider' }))
  await postEvent(inboundPath, messageEvent({ openId: 'ou_outsider', chatId: ALLOWED_CHAT_ID }))
  await postEvent(inboundPath, messageEvent({ messageType: 'image' }))
  await settle()
  checkEqual('未 @ / 非白名单 / 非文本消息都被忽略', runs.length, runsBeforeIgnored)

  const runsBeforeDm = runs.length
  await postEvent(inboundPath, messageEvent({ chatType: 'p2p' }))
  await settle()
  checkEqual('私聊事件按 dmPolicy 放行', runs.length - runsBeforeDm, 1)

  const runsBeforeEncrypted = runs.length
  const encrypted = await postEvent(inboundPath, { encrypt: encryptPayload(messageEvent()) })
  await settle()
  checkEqual('加密事件解密后触发运行', runs.length - runsBeforeEncrypted, 1)
  checkEqual('加密事件同样 ack', encrypted.body?.code, 0)

  const runsBeforeLimit = runs.length
  for (let index = 0; index < 8; index++)
    await postEvent(inboundPath, messageEvent({ chatId: RATE_LIMIT_CHAT_ID }))
  await settle()
  checkEqual('限流：6 条通过 / 2 条被丢弃', runs.length - runsBeforeLimit, 6)

  const notJson = await fetch(`http://127.0.0.1:${E2E_PORT}${inboundPath}`, {
    method: 'POST',
    headers: signInbound('not-json'),
    body: 'not-json',
  })
  checkEqual('非法 JSON -> 400', notJson.status, 400)

  const wrongContentType = await fetch(`http://127.0.0.1:${E2E_PORT}${inboundPath}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  })
  checkEqual('content-type 不是 application/json -> 415', wrongContentType.status, 415)

  const tooLarge = await postEvent(inboundPath, { pad: 'x'.repeat(70_000) })
  checkEqual('超过 64KiB 的真实请求体 -> 413', tooLarge.status, 413)

  const methodNotAllowed = await fetch(`http://127.0.0.1:${E2E_PORT}${inboundPath}`)
  checkEqual('未声明的 HTTP 方法不会进入处理器（404）', methodNotAllowed.status, 404)

  const spoofedHost = await postEvent(inboundPath, messageEvent(), { headers: { host: 'evil.example.com' } })
  checkEqual('Host 头不影响已验签的插件路由', spoofedHost.body?.code, 0)

  const protectedPath = await fetch(`http://127.0.0.1:${E2E_PORT}/api/plugins`)
  checkEqual('受保护的 API 路径仍然要求会话（说明豁免只针对插件路由）', protectedPath.status, 401)

  // Last, because it exhausts this source's callback budget for a while.
  const burst = []
  for (let index = 0; index < 160; index++)
    burst.push(await postEvent(inboundPath, messageEvent(), { sign: false }))
  checkEqual('超限前仍然是签名校验失败（401）', burst[0]?.status, 401)
  check('同一来源超出回调速率上限后返回 429', burst.some(entry => entry.status === 429))

  // -- D. inbound transport selection --------------------------------------
  console.log('\nD. 入站传输方式')
  wsHost = await buildHost(
    {
      mode: 'app',
      domain: mockBaseUrl,
      appId: APP_ID,
      appSecret: 's-e2e',
      inbound: { routine: 'daily' },
    },
    [{ channel: 'feishu' }],
  )
  const wsStatus = wsHost.host.getStatus().find(entry => entry.id === 'feishu')
  checkEqual('默认就是长连接（无需公网）', JSON.stringify(wsStatus?.services), JSON.stringify(['feishu-ws:default']))
  checkEqual('长连接模式下不注册 HTTP 路由', wsStatus?.routes.length, 0)

  webhookOnlyHost = await buildHost(
    {
      mode: 'app',
      domain: mockBaseUrl,
      appId: APP_ID,
      appSecret: 's-e2e',
      connectionMode: 'webhook',
      verificationToken: VERIFICATION_TOKEN,
      encryptKey: ENCRYPT_KEY,
      webhookPath: '/custom-feishu',
      inbound: { routine: 'daily' },
    },
    [{ channel: 'feishu' }],
  )
  const webhookOnlyStatus = webhookOnlyHost.host.getStatus().find(entry => entry.id === 'feishu')
  checkEqual('connectionMode=webhook 时注册自定义 webhookPath', JSON.stringify(webhookOnlyStatus?.routes), JSON.stringify(['POST /custom-feishu']))
  checkEqual('webhook 模式下没有后台服务', webhookOnlyStatus?.services.length, 0)

  const unauthenticated = await buildHost(
    {
      mode: 'app',
      domain: mockBaseUrl,
      appId: APP_ID,
      appSecret: 's-e2e',
      connectionMode: 'webhook',
      inbound: { routine: 'daily' },
    },
    [{ channel: 'feishu' }],
  )
  checkEqual(
    'webhook 模式缺少校验凭据时插件拒绝加载',
    JSON.stringify(unauthenticated.report.failed.map(entry => entry.id)),
    JSON.stringify(['feishu']),
  )
  check(
    '拒绝原因说明要有 verificationToken 或 encryptKey',
    String(unauthenticated.report.failed[0]?.detail ?? '').includes('verificationToken'),
  )
  await unauthenticated.host.shutdown()

  // Authentication needs both halves: a token alone cannot verify a signature.
  const halfAuthenticated = await buildHost(
    {
      mode: 'app',
      domain: mockBaseUrl,
      appId: APP_ID,
      appSecret: 's-e2e',
      connectionMode: 'webhook',
      verificationToken: VERIFICATION_TOKEN,
      inbound: { routine: 'daily' },
    },
    [{ channel: 'feishu' }],
  )
  check(
    '只有 verificationToken 时拒绝加载并点名 encryptKey',
    String(halfAuthenticated.report.failed[0]?.detail ?? '').includes('encryptKey'),
  )
  await halfAuthenticated.host.shutdown()

  // -- E. capability surface -----------------------------------------------
  console.log('\nE. 能力与配置')
  const status = appHost.host.getStatus()
  const feishuStatus = status.find(entry => entry.id === 'feishu')
  checkEqual('status 报告 feishu 已加载', feishuStatus?.loaded, true)
  checkEqual('注册了 1 个频道', feishuStatus?.channels.length, 1)
  checkEqual('注册了 0 个服务', feishuStatus?.services.length, 0)
  checkEqual('注册了 1 条路由', feishuStatus?.routes.length, 1)
  checkEqual('未启用其他内置插件', status.filter(entry => entry.loaded).length, 1)

  // -- F. a routine that is not configured --------------------------------
  console.log('\nF. 未配置的 routine')
  plainHost = await buildHost(
    {
      mode: 'app',
      domain: mockBaseUrl,
      appId: APP_ID,
      appSecret: 's-e2e',
      connectionMode: 'webhook',
      verificationToken: VERIFICATION_TOKEN,
      encryptKey: ENCRYPT_KEY,
      groupPolicy: 'open',
      requireMention: false,
      inbound: { routine: 'missing-routine' },
    },
    [{ channel: 'feishu' }],
  )
  const plainHandler = plainHost.host.capabilities.listRoutes()[0]?.route?.handler
  const callPlain = rawBody => plainHandler({
    method: 'POST',
    path: '/feishu/events',
    headers: signInbound(rawBody),
    rawBody,
    query: {},
    remoteAddress: '127.0.0.1',
  })

  const runsBeforePlain = runs.length
  const unknownRoutine = await callPlain(JSON.stringify(messageEvent()))
  checkEqual('未配置的 routine 只 ack 不运行', unknownRoutine.status, 200)
  checkEqual('确实没有触发运行', runs.length, runsBeforePlain)
}
finally {
  if (app)
    await app.close().catch(() => {})
  if (webhookHost)
    await webhookHost.host.shutdown().catch(() => {})
  if (appHost)
    await appHost.host.shutdown().catch(() => {})
  if (plainHost)
    await plainHost.host.shutdown().catch(() => {})
  if (wsHost)
    await wsHost.host.shutdown().catch(() => {})
  if (webhookOnlyHost)
    await webhookOnlyHost.host.shutdown().catch(() => {})
  await mock.close()
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n--- mock feishu platform saw ---')
for (const request of mock.state.requests)
  console.log(`  ${request.method} ${request.path}${request.search}`)

const passed = results.length - failed
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed}/${results.length} checks passed`)
if (failed > 0)
  process.exitCode = 1
