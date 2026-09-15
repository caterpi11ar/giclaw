import type { ChannelOutbound, NotificationMessage } from '../../../plugin-sdk/index.js'
import type { WebhookConfig } from './config.js'
import { toError } from '../../../utils/errors.js'
import { resolveEndpoint } from './config.js'
import { SIGNATURE_HEADER, signPayload } from './signature.js'

export interface WebhookOutboundOptions {
  config: WebhookConfig
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** Wire payload. Kept flat and stable so external automations can rely on it. */
export function toPayload(message: NotificationMessage): Record<string, unknown> {
  return {
    level: message.level,
    title: message.title,
    body: message.body,
    runId: message.runId,
    trigger: message.trigger,
    occurredAt: message.occurredAt,
    results: message.results,
  }
}

export function createWebhookOutbound(options: WebhookOutboundOptions): ChannelOutbound {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 10_000

  return {
    async send(message, context) {
      const endpoint = resolveEndpoint(options.config, context.target?.name)
      if (!endpoint)
        return { ok: false, detail: 'no webhook endpoint configured', retryable: false }

      const payload = JSON.stringify(toPayload(message))
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...endpoint.headers,
      }
      if (endpoint.secret !== undefined && !(SIGNATURE_HEADER in headers))
        headers[SIGNATURE_HEADER] = signPayload(endpoint.secret, payload)

      try {
        const response = await fetchImpl(endpoint.url, {
          method: 'POST',
          headers,
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) {
          return {
            ok: false,
            detail: `HTTP ${response.status}`,
            retryable: response.status >= 500 || response.status === 429,
          }
        }
        return { ok: true, detail: `HTTP ${response.status}` }
      }
      catch (error) {
        return { ok: false, detail: toError(error).message, retryable: true }
      }
    },
  }
}
