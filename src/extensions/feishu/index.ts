import type {
  PluginApi,
  PluginLogger,
  PluginRuntime,
} from '../../plugin-sdk/index.js'
import type { ResolvedFeishuAccount } from './src/accounts.js'
import type { FeishuConfig, FeishuInboundSettings } from './src/config.js'
import type { FeishuEventGateOptions, FeishuPairingRequest } from './src/event-gate.js'
import { fileURLToPath } from 'node:url'
import { createChannelPlugin, definePluginEntry } from '../../plugin-sdk/index.js'
import { toError } from '../../utils/errors.js'
import { sanitizeBoundedText } from '../../utils/logger.js'
import { listFeishuInboundAccounts, resolveFeishuAccount } from './src/accounts.js'
import { createTenantTokenProvider, fetchBotOpenId, sendAppMessage } from './src/client.js'
import { feishuPluginConfig, resolveFeishuBaseUrl, resolveFeishuMode } from './src/config.js'
import { createFeishuEventGate } from './src/event-gate.js'
import { createFeishuInboundHandler } from './src/inbound.js'
import { createFeishuOutbound } from './src/outbound.js'
import { FeishuPairingStore, MAX_PENDING_PAIRING_REQUESTS } from './src/pairing.js'
import { FeishuWsTransport } from './src/ws.js'

/** Absolute manifest location, used by bundled plugin discovery. */
export const manifestPath = fileURLToPath(new URL('./giclaw.plugin.json', import.meta.url))

/** The gate callbacks that need account credentials or the pairing store. */
type InboundWiring = Pick<
  FeishuEventGateOptions,
  'readPairedSenderIds' | 'onPairingRequired' | 'resolveBotOpenId'
>

interface FeishuInboundRuntime {
  account: ResolvedFeishuAccount
  settings: FeishuInboundSettings
  store: FeishuPairingStore
  logger: PluginLogger
  runtime: PluginRuntime
}

/**
 * Account-scoped gate wiring: the DM pairing flow plus this app's own identity.
 *
 * A pairing prompt is the only message Giclaw sends on its own initiative in
 * response to an inbound event, and only to tell a stranger the code an operator
 * has to approve.
 */
function createInboundWiring(runtime: FeishuInboundRuntime): InboundWiring {
  const { account, store, logger } = runtime
  const accountId = account.accountId
  let provider: ReturnType<typeof createTenantTokenProvider> | undefined

  const tenantToken = (): ReturnType<typeof createTenantTokenProvider> | undefined => {
    const { appId, appSecret } = account
    if (!appId || !appSecret)
      return undefined
    provider ??= createTenantTokenProvider({
      baseUrl: resolveFeishuBaseUrl(account.config),
      appId,
      appSecret,
      timeoutMs: account.config.httpTimeoutMs,
    })
    return provider
  }

  return {
    readPairedSenderIds: () => store.readApproved(accountId),
    onPairingRequired: (request: FeishuPairingRequest) => {
      void sendPairingPrompt({
        store,
        tenantToken,
        baseUrl: resolveFeishuBaseUrl(account.config),
        timeoutMs: account.config.httpTimeoutMs,
        accountId,
        request,
        logger,
      }).catch((error: unknown) => {
        logger.warn(`Feishu pairing prompt failed: ${sanitizeBoundedText(toError(error).message, 200)}`)
      })
    },
    resolveBotOpenId: async () => {
      const token = await tenantToken()?.getToken()
      if (token === undefined)
        return undefined
      return fetchBotOpenId({
        baseUrl: resolveFeishuBaseUrl(account.config),
        token,
        timeoutMs: account.config.httpTimeoutMs,
      })
    },
  }
}

/** Tell an unpaired direct sender the code an operator has to approve. */
async function sendPairingPrompt(params: {
  store: FeishuPairingStore
  tenantToken: () => ReturnType<typeof createTenantTokenProvider> | undefined
  baseUrl: string
  timeoutMs: number
  accountId: string
  request: FeishuPairingRequest
  logger: PluginLogger
}): Promise<void> {
  const { store, request, logger, accountId } = params
  const subject = sanitizeBoundedText(request.subjects[0] as string, 100)
  const outcome = await store.request({ accountId, subjects: request.subjects })
  if (outcome.code === null) {
    logger.warn(`Feishu pairing request from ${subject} ignored: ${MAX_PENDING_PAIRING_REQUESTS} requests are already pending`)
    return
  }
  const { code, created } = outcome
  if (!created) {
    logger.info(`Feishu pairing request from ${subject} is already pending (code ${code})`)
    return
  }
  logger.warn(
    `Feishu pairing required: approve code ${code} for ${subject} with "giclaw pairing approve ${accountId} ${code}"`,
  )
  const provider = params.tenantToken()
  if (provider === undefined || request.chatId === undefined)
    return
  const token = await provider.getToken()
  await sendAppMessage({
    baseUrl: params.baseUrl,
    token,
    receiveId: request.chatId,
    receiveIdType: 'chat_id',
    msgType: 'text',
    content: JSON.stringify({
      text: `配对码：${code}\n请让管理员执行 giclaw pairing approve ${accountId} ${code} 完成配对。`,
    }),
    timeoutMs: params.timeoutMs,
  })
}

/** Mount the HTTP callback, or start the long-lived connection. */
function registerInbound(runtime: FeishuInboundRuntime, api: PluginApi): void {
  const { account, settings, logger } = runtime
  const wiring = createInboundWiring(runtime)

  if (settings.connectionMode === 'webhook') {
    api.registerHttpRoute({
      path: settings.webhookPath,
      method: 'POST',
      auth: 'plugin',
      match: 'exact',
      handler: createFeishuInboundHandler({
        account,
        settings,
        runtime: api.runtime,
        logger,
        ...wiring,
      }),
    })
    logger.info(`Feishu event callback for account "${account.accountId}" listening on ${settings.webhookPath}`)
    return
  }

  const { appId, appSecret } = account
  if (appId === undefined || appSecret === undefined) {
    logger.error(`Feishu long connection for account "${account.accountId}" needs appId and appSecret; inbound events stay disabled`)
    return
  }

  const transportFactory = (): FeishuWsTransport => new FeishuWsTransport({
    appId,
    appSecret,
    baseUrl: resolveFeishuBaseUrl(account.config),
    ...(account.encryptKey === undefined ? {} : { encryptKey: account.encryptKey }),
    ...(account.verificationToken === undefined ? {} : { verificationToken: account.verificationToken }),
    gate: createFeishuEventGate({
      accountId: account.accountId,
      config: account.config,
      routing: settings.inbound,
      runtime: api.runtime,
      logger,
      ...wiring,
    }).gate,
    logger,
  })

  // openclaw's generation guard: a connection that was replaced by a newer
  // start, or that lost a race with a stop, must not keep running.
  let generation = 0
  let transport: FeishuWsTransport | undefined

  api.registerService({
    id: `feishu-ws:${account.accountId}`,
    start: async () => {
      const activeGeneration = ++generation
      await transport?.stop()
      if (activeGeneration !== generation)
        return
      const next = transportFactory()
      transport = next
      await next.start()
      if (activeGeneration !== generation)
        await next.stop()
    },
    stop: async () => {
      generation += 1
      const active = transport
      transport = undefined
      await active?.stop()
    },
  })
}

/**
 * Feishu/Lark connector.
 *
 * Outbound: run notifications as cards or custom-bot messages, from any
 * configured account. Inbound: events over a long-lived connection by default
 * (no public URL needed), or over the HTTP callback in `webhook` mode.
 */
const definition = definePluginEntry({
  id: 'feishu',
  name: 'Feishu',
  description: 'Deliver Giclaw run notifications to Feishu/Lark chats as interactive cards.',
  version: '0.1.0',
  configSchema: feishuPluginConfig,
  register(api) {
    // Outbound channels are only meaningful once the runtime can dispatch.
    if (api.registrationMode !== 'full')
      return

    const config = api.pluginConfig as unknown as FeishuConfig
    const defaultAccount = resolveFeishuAccount({ config })

    api.registerChannel(
      createChannelPlugin({
        id: 'feishu',
        meta: {
          label: 'Feishu',
          selectionLabel: 'Feishu/Lark (飞书)',
          blurb: 'Send run notifications to Feishu/Lark via a self-built app or a custom-bot webhook.',
          docsPath: '/extensions',
          aliases: ['lark'],
          order: 80,
        },
        outbound: createFeishuOutbound({ config }),
      }),
    )

    // Inbound registration must be synchronous: the host reads the route and
    // service registries once `register` returns, so the pairing store loads in
    // the background and every operation awaits that load internally.
    const store = FeishuPairingStore.create({ logger: api.logger })
    for (const entry of listFeishuInboundAccounts(config)) {
      registerInbound(
        { account: entry.account, settings: entry.settings, store, logger: api.logger, runtime: api.runtime },
        api,
      )
    }

    api.logger.info(`Feishu connector registered in ${resolveFeishuMode(config)} mode (account ${defaultAccount.accountId})`)
  },
})

export default definition
