import type { PluginApi, PluginHttpRequest, PluginService } from '../../plugin-sdk/index.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../../config/schema.js'
import definition, { manifestPath } from './index.js'
import { feishuPluginConfig } from './src/config.js'
import { computeFeishuSignature } from './src/crypto.js'
import { FeishuPairingStore, MAX_PENDING_PAIRING_REQUESTS } from './src/pairing.js'
import { FeishuWsTransport } from './src/ws.js'

/** Stands in for the Feishu SDK so the long connection never dials out in tests. */
const mocks = vi.hoisted(() => {
  /** Lets a test hold the handshake so it can stop a connection mid-flight. */
  const state: { hold?: { promise: Promise<void>, release: () => void } } = {}

  class FakeWsClient {
    static instances: FakeWsClient[] = []
    close = vi.fn()
    start = vi.fn(async () => {
      if (state.hold)
        await state.hold.promise
    })

    constructor(readonly params: unknown) {
      FakeWsClient.instances.push(this)
    }
  }

  class FakeDispatcher {
    static instances: FakeDispatcher[] = []
    register = vi.fn()
    constructor(readonly params: unknown) {
      FakeDispatcher.instances.push(this)
    }
  }

  return { FakeWsClient, FakeDispatcher, state }
})

vi.mock('@larksuiteoapi/node-sdk', () => ({
  WSClient: mocks.FakeWsClient,
  EventDispatcher: mocks.FakeDispatcher,
  Domain: { Feishu: 0, Lark: 1 },
  LoggerLevel: { info: 'info' },
}))

/**
 * The pairing store persists to the daemon's real state directory and no option
 * on the plugin can redirect it, so the pending queue is drained before every
 * test: the store ignores new requests once `MAX_PENDING_PAIRING_REQUESTS` are
 * outstanding, which would otherwise silence the prompts under test.
 */
const RUN = Math.random().toString(36).slice(2, 8)

const ENCRYPT_KEY = 'k'
const VERIFICATION_TOKEN = 't'
const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'
const MESSAGE_PATH = '/open-apis/im/v1/messages'
const BOT_INFO_PATH = '/open-apis/bot/v3/info'

beforeEach(async () => {
  mocks.FakeWsClient.instances.length = 0
  mocks.FakeDispatcher.instances.length = 0
  mocks.state.hold = undefined
  await drainPendingPairingRequests()
})

/** Empty the shared on-disk queue so each test starts from an idle store. */
async function drainPendingPairingRequests(): Promise<void> {
  const store = await FeishuPairingStore.open()
  const pending = await store.listPending('default')
  await Promise.all(Object.keys(pending).map(code => store.dismiss('default', code)))
}

interface ApiHarness {
  api: PluginApi
  channels: Array<{ id: string, meta: { label: string, aliases?: string[] } }>
  routes: Array<{ path: string, method?: string, auth?: string, match?: string, handler: (request: PluginHttpRequest) => unknown }>
  services: PluginService[]
  enqueueRun: ReturnType<typeof vi.fn>
}

function createApi(mode: PluginApi['registrationMode'], pluginConfig: Record<string, unknown> = {}): ApiHarness {
  const channels: ApiHarness['channels'] = []
  const routes: ApiHarness['routes'] = []
  const services: PluginService[] = []
  const enqueueRun = vi.fn(async () => ({
    results: [{ taskId: 'welkin-moon', success: true, message: 'ok', durationMs: 1 }],
  }))
  const api: PluginApi = {
    registrationMode: mode,
    pluginConfig,
    config: appConfigSchema.parse({}),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: { gateway: {
      getSnapshot: vi.fn(),
      getRunHistory: vi.fn(),
      enqueueRun,
      resolveRoutine: vi.fn((name: string) => (name === 'daily' ? ['welkin-moon', 'claim-mail'] : null)),
    } } as unknown as PluginApi['runtime'],
    registerChannel: channel => void channels.push(channel as ApiHarness['channels'][number]),
    registerService: service => void services.push(service),
    registerHttpRoute: route => void routes.push(route as ApiHarness['routes'][number]),
    registerTool: vi.fn(),
  }
  return { api, channels, routes, services, enqueueRun }
}

/** Serve the three Feishu endpoints the inbound wiring talks to. */
function stubFeishuFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input))
    const answer = (payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.pathname === TOKEN_PATH)
      return answer({ code: 0, tenant_access_token: 'tenant-token', expire: 7_200 })
    if (url.pathname === BOT_INFO_PATH)
      return answer({ code: 0, bot: { open_id: 'ou_bot' } })
    return answer({ code: 0, data: { message_id: 'om_1' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock as unknown as ReturnType<typeof vi.fn>
}

function signedRequest(body: unknown): PluginHttpRequest {
  const rawBody = JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1_000))
  return {
    method: 'POST',
    path: '/feishu/events',
    query: {},
    remoteAddress: '127.0.0.1',
    rawBody,
    headers: {
      'content-type': 'application/json',
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': 'nonce',
      'x-lark-signature': computeFeishuSignature({
        timestamp,
        nonce: 'nonce',
        encryptKey: ENCRYPT_KEY,
        rawBody,
      }),
    },
  }
}

function messageEvent(overrides: {
  eventId: string
  chatId?: string
  chatType?: string
  openId?: string
  token?: string
  mentions?: unknown
}): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      event_id: overrides.eventId,
      event_type: 'im.message.receive_v1',
      token: overrides.token ?? VERIFICATION_TOKEN,
    },
    event: {
      sender: { sender_id: { open_id: overrides.openId ?? 'ou_1' } },
      message: {
        chat_id: overrides.chatId ?? 'oc_1',
        chat_type: overrides.chatType ?? 'p2p',
        message_type: 'text',
        content: '{"text":"@_user_1 ping"}',
        mentions: overrides.mentions ?? [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      },
    },
  }
}

function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** The pairing prompt writes to disk, so wait for the outcome instead of guessing. */
async function expectEventually(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 2_000, interval: 10 })
}

/** The flattened payload the SDK hands the dispatcher callback. */
function dispatchedEvent(eventId: string): Record<string, unknown> {
  return {
    event_id: eventId,
    event_type: 'im.message.receive_v1',
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      chat_id: 'oc_1',
      chat_type: 'group',
      message_type: 'text',
      content: '{"text":"@_user_1 ping"}',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
    },
  }
}

function registeredHandlers(): Record<string, (data: unknown) => void> {
  const register = mocks.FakeDispatcher.instances[0]?.register
  return (register?.mock.calls[0]?.[0] ?? {}) as Record<string, (data: unknown) => void>
}

describe('feishu plugin entry', () => {
  it('declares its identity and config parser', () => {
    expect(definition.id).toBe('feishu')
    expect(definition.name).toBe('Feishu')
    expect(definition.version).toBe('0.1.0')
    expect(definition.configSchema).toBe(feishuPluginConfig)
    expect(definition.description).toContain('Feishu')
  })

  it('registers a channel in full mode', () => {
    const { api, channels } = createApi('full', feishuPluginConfig.parse({ appId: 'cli_1', appSecret: 's' }))

    definition.register?.(api)

    expect(channels).toHaveLength(1)
    expect(channels[0]?.id).toBe('feishu')
    expect(channels[0]?.meta.label).toBe('Feishu')
    expect(channels[0]?.meta.aliases).toEqual(['lark'])
    expect(api.logger.info).toHaveBeenCalledWith('Feishu connector registered in app mode (account default)')
  })

  it('registers the long connection by default when inbound is configured', () => {
    const { api, routes, services } = createApi('full', feishuPluginConfig.parse({
      appId: 'cli_1',
      appSecret: 's',
      inbound: { routine: 'daily' },
    }))

    definition.register?.(api)

    expect(routes).toEqual([])
    expect(services.map(service => service.id)).toEqual(['feishu-ws:default'])
  })

  it('runs the long connection with the parsed credentials and stops it again', async () => {
    const { api, services } = createApi('full', feishuPluginConfig.parse({
      appId: 'cli_1',
      appSecret: 's',
      encryptKey: ENCRYPT_KEY,
      verificationToken: VERIFICATION_TOKEN,
      inbound: { routine: 'daily' },
    }))

    definition.register?.(api)
    await services[0]?.start({ logger: api.logger, signal: new AbortController().signal })

    expect(mocks.FakeWsClient.instances[0]?.params).toEqual(expect.objectContaining({
      appId: 'cli_1',
      appSecret: 's',
      domain: 0,
    }))
    // openclaw passes the callback credentials to the dispatcher even though a
    // long connection is authenticated by its handshake.
    expect(mocks.FakeDispatcher.instances[0]?.params).toEqual(expect.objectContaining({
      encryptKey: ENCRYPT_KEY,
      verificationToken: VERIFICATION_TOKEN,
    }))
    expect(Object.keys(registeredHandlers())).toHaveLength(11)

    await services[0]?.stop?.()
    expect(mocks.FakeWsClient.instances[0]?.close).toHaveBeenCalledWith({ force: true })
  })

  it('replaces a running long connection on a restart', async () => {
    const { api, services } = createApi('full', feishuPluginConfig.parse({
      appId: 'cli_1',
      appSecret: 's',
      inbound: { routine: 'daily' },
    }))

    definition.register?.(api)
    const service = services[0]!
    const context = { logger: api.logger, signal: new AbortController().signal }

    await service.start(context)
    await service.start(context)

    expect(mocks.FakeWsClient.instances).toHaveLength(2)
    expect(mocks.FakeWsClient.instances[0]?.close).toHaveBeenCalledWith({ force: true })
    expect(mocks.FakeWsClient.instances[1]?.close).not.toHaveBeenCalled()

    await service.stop?.()

    expect(mocks.FakeWsClient.instances[1]?.close).toHaveBeenCalledWith({ force: true })
  })

  it('drops a start that a newer start superseded while the old connection closed', async () => {
    const { api, services } = createApi('full', feishuPluginConfig.parse({
      appId: 'cli_1',
      appSecret: 's',
      inbound: { routine: 'daily' },
    }))

    definition.register?.(api)
    const service = services[0]!
    const context = { logger: api.logger, signal: new AbortController().signal }
    await service.start(context)

    // The second start is held while it retires the first connection.
    let releaseStop!: () => void
    const stopping = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    const stopSpy = vi.spyOn(FeishuWsTransport.prototype, 'stop').mockReturnValueOnce(stopping)
    const second = service.start(context)
    await expectEventually(() => {
      expect(stopSpy).toHaveBeenCalledTimes(1)
    })

    await service.start(context)
    expect(mocks.FakeWsClient.instances).toHaveLength(2)
    releaseStop()

    await expect(second).resolves.toBeUndefined()
    expect(mocks.FakeWsClient.instances).toHaveLength(2)
    expect(mocks.FakeWsClient.instances[0]?.close).toHaveBeenCalledWith({ force: true })
    expect(mocks.FakeWsClient.instances[1]?.close).not.toHaveBeenCalled()
  })

  it('discards a long connection that was stopped while it was still connecting', async () => {
    const { api, services } = createApi('full', feishuPluginConfig.parse({
      appId: 'cli_1',
      appSecret: 's',
      inbound: { routine: 'daily' },
    }))

    definition.register?.(api)
    const service = services[0]!
    const context = { logger: api.logger, signal: new AbortController().signal }
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.state.hold = { promise: pending, release }

    const starting = service.start(context)
    await expectEventually(() => {
      expect(mocks.FakeWsClient.instances).toHaveLength(1)
    })

    const stopping = service.stop?.()
    expect(mocks.FakeWsClient.instances[0]?.close).toHaveBeenCalledWith({ force: true })
    release()

    await expect(starting).resolves.toBeUndefined()
    await expect(stopping).resolves.toBeUndefined()
    expect(mocks.FakeWsClient.instances).toHaveLength(1)
  })

  it('attributes a group @-mention using the app identity it fetched once', async () => {
    const fetchMock = stubFeishuFetch()
    const { api, services, enqueueRun } = createApi('full', feishuPluginConfig.parse({
      appId: 'cli_1',
      appSecret: 's',
      groupAllowFrom: ['oc_1'],
      inbound: { routine: 'daily' },
    }))

    definition.register?.(api)
    await services[0]?.start({ logger: api.logger, signal: new AbortController().signal })
    const handlers = registeredHandlers()
    handlers['im.message.receive_v1']?.(dispatchedEvent('evt-1'))
    await expectEventually(() => {
      expect(enqueueRun).toHaveBeenCalledWith(['welkin-moon', 'claim-mail'])
    })
    const calls = fetchMock.mock.calls.map(call => new URL(String(call[0])).pathname)
    expect(calls.filter(path => path === BOT_INFO_PATH)).toHaveLength(1)
    await services[0]?.stop?.()
    vi.unstubAllGlobals()
  })

  it('starts one long connection per configured account', () => {
    const { api, services } = createApi('full', feishuPluginConfig.parse({
      accounts: {
        alpha: { appId: 'cli_a', appSecret: 'sa' },
        beta: { appId: 'cli_b', appSecret: 'sb' },
      },
      inbound: { routine: 'daily' },
    }))

    definition.register?.(api)

    expect(services.map(service => service.id)).toEqual(['feishu-ws:alpha', 'feishu-ws:beta'])
  })

  it('registers the event callback route in webhook mode', () => {
    // The host hands `register` a config already parsed by `feishuPluginConfig`.
    const { api, routes, services } = createApi('full', feishuPluginConfig.parse({
      connectionMode: 'webhook',
      verificationToken: VERIFICATION_TOKEN,
      encryptKey: ENCRYPT_KEY,
      inbound: {},
    }))

    definition.register?.(api)

    expect(routes).toEqual([{ path: '/feishu/events', method: 'POST', auth: 'plugin', match: 'exact', handler: expect.any(Function) }])
    expect(services).toEqual([])
    expect(api.logger.info).toHaveBeenCalledWith('Feishu event callback for account "default" listening on /feishu/events')
  })

  it('honours a custom callback path', () => {
    const { api, routes } = createApi('full', feishuPluginConfig.parse({
      connectionMode: 'webhook',
      webhookPath: '/hooks/feishu',
      verificationToken: VERIFICATION_TOKEN,
      encryptKey: ENCRYPT_KEY,
      inbound: {},
    }))

    definition.register?.(api)

    expect(routes[0]?.path).toBe('/hooks/feishu')
  })

  it('walks an unpaired direct sender through the pairing flow', async () => {
    const fetchMock = stubFeishuFetch()
    const { api, routes, enqueueRun } = createApi('full', feishuPluginConfig.parse({
      connectionMode: 'webhook',
      verificationToken: VERIFICATION_TOKEN,
      encryptKey: ENCRYPT_KEY,
      appId: 'cli_1',
      appSecret: 's',
      inbound: { routine: 'daily' },
    }))

    definition.register?.(api)
    const handler = routes[0]?.handler
    const response = await handler?.(signedRequest(messageEvent({ eventId: 'evt-dm-1', openId: `ou_dm_${RUN}_1` })))
    await settle()

    expect(response).toMatchObject({ status: 200 })
    expect(enqueueRun).not.toHaveBeenCalled()
    await expectEventually(() => {
      expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining('giclaw pairing approve default'))
    })

    const sends = fetchMock.mock.calls.filter(call => new URL(String(call[0])).pathname === MESSAGE_PATH)
    expect(sends).toHaveLength(1)
    const body = JSON.parse(String((sends[0]?.[1] as RequestInit).body)) as { receive_id: string, content: string }
    expect(body.receive_id).toBe('oc_1')
    expect(body.content).toContain('配对码：')

    // The code is reused instead of prompting twice.
    await handler?.(signedRequest(messageEvent({ eventId: 'evt-dm-2', openId: `ou_dm_${RUN}_1` })))
    await expectEventually(() => {
      expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining('is already pending'))
    })
    expect(fetchMock.mock.calls.filter(call => new URL(String(call[0])).pathname === MESSAGE_PATH)).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('records the pairing request even when the app cannot reply', async () => {
    // The pairing store lives on disk, so every test uses its own sender id to
    // stay independent of the pending requests the other tests leave behind.
    const fetchMock = stubFeishuFetch()
    // Webhook mode needs no app credentials, so no message can be sent back.
    const { api, routes } = createApi('full', feishuPluginConfig.parse({
      connectionMode: 'webhook',
      verificationToken: VERIFICATION_TOKEN,
      encryptKey: ENCRYPT_KEY,
      inbound: { routine: 'daily' },
    }))

    definition.register?.(api)
    await routes[0]?.handler(signedRequest(messageEvent({ eventId: 'evt-dm-3', openId: `ou_dm_${RUN}_3` })))
    await expectEventually(() => {
      expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining('giclaw pairing approve default'))
    })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('survives a pairing prompt that the platform rejects', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input))
      if (url.pathname === TOKEN_PATH)
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant-token' }), { status: 200 })
      return new Response(JSON.stringify({ code: 230002, msg: 'bot is not in the chat' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { api, routes } = createApi('full', feishuPluginConfig.parse({
      connectionMode: 'webhook',
      verificationToken: VERIFICATION_TOKEN,
      encryptKey: ENCRYPT_KEY,
      appId: 'cli_1',
      appSecret: 's',
      inbound: { routine: 'daily' },
    }))

    definition.register?.(api)
    const response = await routes[0]?.handler(signedRequest(messageEvent({ eventId: 'evt-dm-4', openId: `ou_dm_${RUN}_4` })))
    await expectEventually(() => {
      expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Feishu pairing prompt failed: Feishu message send failed'))
    })

    // The delivery is still acknowledged; only the prompt failed.
    expect(response).toMatchObject({ status: 200 })
    vi.unstubAllGlobals()
  })

  it('refuses to queue more pairing requests than the platform allows', async () => {
    const fetchMock = stubFeishuFetch()
    const store = await FeishuPairingStore.open()
    for (let index = 0; index < MAX_PENDING_PAIRING_REQUESTS; index += 1)
      await store.request({ accountId: 'default', subjects: [`user:ou_full_${RUN}_${index}`] })

    const { api, routes } = createApi('full', feishuPluginConfig.parse({
      connectionMode: 'webhook',
      verificationToken: VERIFICATION_TOKEN,
      encryptKey: ENCRYPT_KEY,
      appId: 'cli_1',
      appSecret: 's',
      inbound: { routine: 'daily' },
    }))

    definition.register?.(api)
    await routes[0]?.handler(signedRequest(messageEvent({ eventId: 'evt-full', openId: `ou_dm_${RUN}_full` })))

    await expectEventually(() => {
      expect(api.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`ignored: ${MAX_PENDING_PAIRING_REQUESTS} requests are already pending`),
      )
    })
    expect(fetchMock.mock.calls.filter(call => new URL(String(call[0])).pathname === MESSAGE_PATH)).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('refuses the long connection without app credentials', () => {
    const { api, routes, services } = createApi('full', feishuPluginConfig.parse({ inbound: {} }))

    definition.register?.(api)

    expect(routes).toEqual([])
    expect(services).toEqual([])
    expect(api.logger.error).toHaveBeenCalledWith(expect.stringContaining('needs appId and appSecret'))
  })

  it('registers no route when inbound is not configured', () => {
    const { api, routes, services } = createApi('full', {})

    definition.register?.(api)

    expect(routes).toEqual([])
    expect(services).toEqual([])
  })

  it('registers nothing in metadata mode', () => {
    const { api, channels, services } = createApi('metadata')

    definition.register?.(api)

    expect(channels).toEqual([])
    expect(services).toEqual([])
  })
})

describe('feishu manifest', () => {
  it('points at the shipped manifest file', async () => {
    const { readPluginManifest } = await import('../../plugins/manifest.js')
    const manifest = await readPluginManifest(manifestPath)

    expect(manifest.id).toBe('feishu')
    expect(manifest.channels).toEqual(['feishu'])
    expect(manifest.enabledByDefault).toBe(false)
    expect(manifest.configContracts?.secretInputs?.paths.map(path => path.path))
      .toEqual(['appSecret', 'webhookSecret', 'encryptKey', 'verificationToken'])
    const schema = manifest.configSchema as { properties?: Record<string, unknown> }
    expect(Object.keys(schema.properties ?? {})).toContain('connectionMode')
  })
})
