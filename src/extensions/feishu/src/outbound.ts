import type { ChannelOutbound, ChannelSendResult, NotificationMessage } from '../../../plugin-sdk/index.js'
import type { FeishuMergedConfig } from './accounts.js'
import type { TenantTokenProvider } from './client.js'
import type { FeishuConfig } from './config.js'
import { toError } from '../../../utils/errors.js'
import { resolveFeishuAccount } from './accounts.js'
import { buildFeishuCard, buildFeishuText } from './card.js'
import {
  createTenantTokenProvider,
  FeishuApiError,
  isFeishuAuthError,
  sendAppMessage,
  sendWebhookMessage,
} from './client.js'
import {
  resolveFeishuBaseUrl,
  resolveFeishuMode,
  resolveFeishuTarget,
  resolveWebhookUrl,
} from './config.js'

export interface FeishuOutboundOptions {
  config: FeishuConfig
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * Outbound channel for run notifications.
 *
 * Every send resolves its own account: a notification route may name an
 * `accountId` (multi-tenant deployments), otherwise the default account is used.
 * Tenant tokens are cached per account so one account's expired token cannot
 * invalidate another's.
 */
export function createFeishuOutbound(options: FeishuOutboundOptions): ChannelOutbound {
  const { config } = options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? Date.now
  const providers = new Map<string, TenantTokenProvider>()

  /**
   * Only app accounts need a tenant token; defer creation until one is used.
   * A merged account config always carries `httpTimeoutMs` (the top-level
   * default), so the timeout needs no fallback here.
   */
  function providerFor(account: FeishuMergedConfig, accountId: string): TenantTokenProvider | undefined {
    if (!account.appId || !account.appSecret)
      return undefined
    const existing = providers.get(accountId)
    if (existing)
      return existing
    const created = createTenantTokenProvider({
      baseUrl: resolveFeishuBaseUrl(account),
      appId: account.appId,
      appSecret: account.appSecret,
      timeoutMs: account.httpTimeoutMs,
      fetchImpl,
      now,
    })
    providers.set(accountId, created)
    return created
  }

  return {
    async send(message: NotificationMessage, context): Promise<ChannelSendResult> {
      const skip = (detail: string): ChannelSendResult => {
        context.logger.warn(`Feishu notification skipped: ${detail}`)
        return { ok: false, detail, retryable: false }
      }

      const account = resolveFeishuAccount({
        config,
        accountId: context.target?.accountId,
      })
      const accountConfig = account.config
      const baseUrl = resolveFeishuBaseUrl(accountConfig)
      const mode = resolveFeishuMode(accountConfig)
      const target = resolveFeishuTarget(accountConfig, context.target?.name)
      const card = buildFeishuCard(message)
      const text = buildFeishuText(message)

      try {
        if (mode === 'webhook') {
          const webhookUrl = resolveWebhookUrl(accountConfig, target)
          if (webhookUrl === undefined)
            return skip('no Feishu webhook URL configured')

          await sendWebhookMessage({
            webhookUrl,
            ...(accountConfig.webhookSecret === undefined ? {} : { secret: accountConfig.webhookSecret }),
            payload: accountConfig.card
              ? { msg_type: 'interactive', card }
              : { msg_type: 'text', content: { text } },
            timeoutMs: accountConfig.httpTimeoutMs,
            nowSeconds: () => Math.floor(now() / 1_000),
            fetchImpl,
          })
          return { ok: true, detail: `sent via Feishu webhook (account ${account.accountId})` }
        }

        const provider = providerFor(accountConfig, account.accountId)
        if (provider === undefined)
          return skip(`Feishu appId/appSecret are not configured for account ${account.accountId}`)
        if (target === undefined || target.chatId === undefined)
          return skip('no Feishu chatId configured for this target')

        const { chatId, receiveIdType } = target
        const sendOnce = (): Promise<string | undefined> =>
          provider.getToken().then(token => sendAppMessage({
            baseUrl,
            token,
            receiveId: chatId,
            receiveIdType,
            msgType: accountConfig.card ? 'interactive' : 'text',
            content: accountConfig.card ? JSON.stringify(card) : JSON.stringify({ text }),
            timeoutMs: accountConfig.httpTimeoutMs,
            fetchImpl,
          }))

        let messageId: string | undefined
        try {
          messageId = await sendOnce()
        }
        catch (error) {
          // A tenant token can expire while the daemon idles; refresh once.
          if (!isFeishuAuthError(error))
            throw error
          provider.invalidate()
          messageId = await sendOnce()
        }

        return { ok: true, detail: messageId !== undefined ? `sent ${messageId}` : 'sent via Feishu app' }
      }
      catch (error) {
        const detail = toError(error).message
        const retryable = error instanceof FeishuApiError ? error.retryable : true
        context.logger.warn(`Feishu notification failed: ${detail}`)
        return { ok: false, detail, retryable }
      }
    },
  }
}
