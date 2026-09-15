import type { InFlightLimiter, PluginHttpRequest, PluginLogger, PluginRuntime } from '../../../plugin-sdk/index.js'
import { Buffer } from 'node:buffer'
import { createCipheriv } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createInFlightLimiter } from '../../../plugin-sdk/index.js'
import { listFeishuInboundAccounts } from './accounts.js'
import { FEISHU_MESSAGE_EVENT_TYPE, feishuConfigSchema } from './config.js'
import { computeFeishuSignature, deriveFeishuKey } from './crypto.js'
import {
  createFeishuInboundHandler,
  FEISHU_PRE_AUTH_MAX_IN_FLIGHT,
  FEISHU_WEBHOOK_MAX_BODY_BYTES,
  FEISHU_WEBHOOK_RATE_LIMIT,
  isFeishuWebhookTimestampFresh,
} from './inbound.js'

const ENCRYPT_KEY = 'encrypt-key'
const VERIFICATION_TOKEN = 'verify-token'
const SIGNED_AT = '1700000000'
const SIGNED_AT_MS = 1_700_000_000_000

function createLogger(): PluginLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function createRuntime(): PluginRuntime {
  return {
    gateway: {
      getSnapshot: vi.fn(),
      getRunHistory: vi.fn(),
      enqueueRun: vi.fn(async () => ({
        results: [{ taskId: 'welkin-moon', success: true, message: 'ok', durationMs: 1 }],
      })),
      resolveRoutine: vi.fn((name: string) => (name === 'daily' ? ['welkin-moon', 'claim-mail'] : null)),
    },
  } as unknown as PluginRuntime
}

interface HandlerHarness {
  handler: ReturnType<typeof createFeishuInboundHandler>
  runtime: PluginRuntime
  logger: PluginLogger
}

/**
 * The `webhook` transport as the plugin wires it: credentials and the callback
 * path resolved into per-account settings, with a fixed clock so the signed
 * timestamp in `request()` is always inside the freshness window.
 */
function createHandler(options: {
  /** Top-level plugin keys (sender policy, credentials, ...). */
  config?: Record<string, unknown>
  /** Event routing and rate limit; omit for an observe-only callback. */
  inbound?: Record<string, unknown>
  /** Overrides the per-account in-flight limiter. */
  limiter?: InFlightLimiter
} = {}, runtime = createRuntime()): HandlerHarness {
  const logger = createLogger()
  const config = feishuConfigSchema.parse({
    connectionMode: 'webhook',
    verificationToken: VERIFICATION_TOKEN,
    encryptKey: ENCRYPT_KEY,
    ...options.config,
    inbound: { ...options.inbound },
  })
  const entry = listFeishuInboundAccounts(config)[0]
  if (entry?.settings.connectionMode !== 'webhook')
    throw new Error('   ')

  return {
    handler: createFeishuInboundHandler({
      account: entry.account,
      settings: entry.settings,
      runtime,
      logger,
      now: () => SIGNED_AT_MS,
      ...(options.limiter ? { limiter: options.limiter } : {}),
    }),
    runtime,
    logger,
  }
}

/** A signed v2 event callback, the way Feishu posts it. */
function request(
  body: unknown,
  options: {
    raw?: string
    headers?: Record<string, string | string[] | undefined>
    signed?: boolean
    method?: string
    path?: string
    remoteAddress?: string | null
  } = {},
): PluginHttpRequest {
  const raw = options.raw ?? (typeof body === 'string' ? body : JSON.stringify(body))
  const headers: Record<string, string | string[] | undefined> = {
    'content-type': 'application/json; charset=utf-8',
    ...options.headers,
  }
  if (options.signed !== false && !('x-lark-signature' in headers)) {
    headers['x-lark-request-timestamp'] = SIGNED_AT
    headers['x-lark-request-nonce'] = 'nonce'
    headers['x-lark-signature'] = computeFeishuSignature({
      timestamp: SIGNED_AT,
      nonce: 'nonce',
      encryptKey: ENCRYPT_KEY,
      rawBody: raw,
    })
  }
  return {
    method: options.method ?? 'POST',
    path: options.path ?? '/feishu/events',
    headers,
    rawBody: raw,
    query: {},
    remoteAddress: options.remoteAddress === undefined ? '127.0.0.1' : options.remoteAddress,
  }
}

/** The event envelope a message callback carries. */
function messageEvent(overrides: {
  chatId?: string
  openId?: string
  chatType?: string
  messageType?: string
  mentions?: unknown
  eventId?: string
} = {}): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      event_id: overrides.eventId ?? 'evt-1',
      event_type: FEISHU_MESSAGE_EVENT_TYPE,
      token: VERIFICATION_TOKEN,
    },
    event: {
      sender: { sender_id: { open_id: overrides.openId ?? 'ou_1' } },
      message: {
        chat_id: overrides.chatId ?? 'oc_1',
        chat_type: overrides.chatType ?? 'group',
        message_type: overrides.messageType ?? 'text',
        content: '{"text":"@_user_1 ping"}',
        mentions: overrides.mentions ?? [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      },
    },
  }
}

function parseBody(response: { body?: string }): Record<string, unknown> {
  return JSON.parse(response.body ?? '{}') as Record<string, unknown>
}

/** Let the background `enqueueRun` promise settle before asserting on it. */
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

describe('isFeishuWebhookTimestampFresh', () => {
  it('accepts second-level and millisecond-level timestamps', () => {
    expect(isFeishuWebhookTimestampFresh(SIGNED_AT, SIGNED_AT_MS)).toBe(true)
    expect(isFeishuWebhookTimestampFresh(String(SIGNED_AT_MS), SIGNED_AT_MS)).toBe(true)
  })

  it('rejects a stale, a future and an unparseable timestamp', () => {
    const hourMs = 60 * 60_000
    expect(isFeishuWebhookTimestampFresh(SIGNED_AT, SIGNED_AT_MS + hourMs + 1)).toBe(false)
    expect(isFeishuWebhookTimestampFresh(String(SIGNED_AT_MS + hourMs + 1), SIGNED_AT_MS)).toBe(false)
    expect(isFeishuWebhookTimestampFresh('not-a-number', SIGNED_AT_MS)).toBe(false)
  })
})

describe('createFeishuInboundHandler', () => {
  it('rejects a non-POST request', async () => {
    const { handler } = createHandler()

    const response = await handler(request(messageEvent(), { method: 'GET' }))

    expect(response.status).toBe(405)
    expect(parseBody(response)).toEqual({ code: 1, msg: 'Method not allowed' })
  })

  it('rejects a body that does not advertise JSON', async () => {
    const { handler, logger } = createHandler()

    const response = await handler(request(messageEvent(), { headers: { 'content-type': 'text/plain' } }))
    const missing = await handler(request(messageEvent(), { headers: { 'content-type': undefined } }))
    const anonymous = await handler(request(messageEvent(), {
      headers: { 'content-type': 'text/plain' },
      remoteAddress: null,
    }))

    expect(response.status).toBe(415)
    expect(missing.status).toBe(415)
    expect(anonymous.status).toBe(415)
    expect(parseBody(response)).toEqual({ code: 1, msg: 'Content-Type must be application/json' })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('content-type must be application/json'))
    expect(logger.warn).toHaveBeenCalledWith('Feishu event rejected: content-type must be application/json (remote=unknown)')
  })

  it('rejects a body larger than the cap before parsing it', async () => {
    const { handler, logger } = createHandler()
    const oversized = 'x'.repeat(FEISHU_WEBHOOK_MAX_BODY_BYTES + 1)

    const response = await handler(request(oversized, { raw: oversized }))

    expect(response.status).toBe(413)
    expect(parseBody(response)).toEqual({ code: 1, msg: 'Request body too large' })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('body exceeds'))
  })

  it('rate limits one source flooding the callback', async () => {
    const { handler, logger } = createHandler()
    const call = async (): Promise<number> => (await handler(request(messageEvent()))).status

    const allowed = await Promise.all(
      Array.from({ length: FEISHU_WEBHOOK_RATE_LIMIT.limit }, call),
    )
    const extra = await call()

    expect(new Set(allowed)).toEqual(new Set([200]))
    expect(extra).toBe(429)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('too many callbacks'))
  })

  it('rejects a callback while the account is already at the pre-auth in-flight limit', async () => {
    const limiter = createInFlightLimiter({ maxInFlightPerKey: FEISHU_PRE_AUTH_MAX_IN_FLIGHT })
    const { handler, logger } = createHandler({ limiter })
    for (let slot = 0; slot < FEISHU_PRE_AUTH_MAX_IN_FLIGHT; slot += 1)
      limiter.tryAcquire('default')

    const response = await handler(request(messageEvent()))

    expect(response.status).toBe(429)
    expect(parseBody(response)).toEqual({ code: 1, msg: 'Too many in-flight requests' })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unauthenticated callbacks already in flight'))
  })

  it('gives the in-flight slot back when the callback is rejected', async () => {
    const limiter = createInFlightLimiter({ maxInFlightPerKey: 1 })
    const { handler } = createHandler({ limiter })

    const first = await handler(request(messageEvent(), { signed: false }))
    const second = await handler(request(messageEvent(), { signed: false }))

    expect(first.status).toBe(401)
    expect(second.status).toBe(401)
    expect(limiter.size()).toBe(0)
  })

  it('rejects a body that is not JSON', async () => {
    const { handler } = createHandler()

    expect(parseBody(await handler(request('not json', { raw: 'not json' }))))
      .toEqual({ code: 1, msg: 'Body must be valid JSON' })
  })

  it('rejects a JSON body that is not an object', async () => {
    const { handler } = createHandler()

    expect(parseBody(await handler(request([1, 2]))))
      .toEqual({ code: 1, msg: 'Body must be a JSON object' })
  })

  it('rejects an event whose verification token does not match', async () => {
    const { handler, logger } = createHandler()
    const body = messageEvent()
    ;(body.header as Record<string, unknown>).token = 'wrong'

    const response = await handler(request(body, { remoteAddress: null }))

    expect(response.status).toBe(401)
    expect(logger.warn).toHaveBeenCalledWith('Feishu event rejected: verification token mismatch (remote=unknown)')
  })

  it('accepts a token carried in the request header', async () => {
    const { handler, runtime } = createHandler({ config: { groupPolicy: 'open' } })
    const body = messageEvent()
    delete (body.header as Record<string, unknown>).token

    const response = await handler(request(body, { headers: { 'X-Lark-Request-Token': VERIFICATION_TOKEN } }))

    expect(response.status).toBe(200)
    await settle()
    expect(runtime.gateway.enqueueRun).toHaveBeenCalled()
  })

  it('rejects a request without a token anywhere', async () => {
    const { handler } = createHandler()
    const body = messageEvent()
    delete (body.header as Record<string, unknown>).token

    expect((await handler(request(body))).status).toBe(401)
  })

  it('rejects a missing signature', async () => {
    const { handler, logger } = createHandler()

    const response = await handler(request(messageEvent(), { signed: false, remoteAddress: null }))

    expect(response.status).toBe(401)
    expect(logger.warn).toHaveBeenCalledWith('Feishu event rejected: missing signature headers (remote=unknown)')
  })

  it('rejects a stale signature', async () => {
    const { handler, logger } = createHandler()
    const raw = JSON.stringify(messageEvent())
    const stale = String(Number(SIGNED_AT) - 7_200)

    const response = await handler(request(messageEvent(), {
      raw,
      headers: {
        'x-lark-request-timestamp': stale,
        'x-lark-request-nonce': 'nonce',
        'x-lark-signature': computeFeishuSignature({
          timestamp: stale,
          nonce: 'nonce',
          encryptKey: ENCRYPT_KEY,
          rawBody: raw,
        }),
      },
    }))

    expect(response.status).toBe(401)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('stale signed timestamp'))
  })

  it('rejects a mismatched signature', async () => {
    const { handler, logger } = createHandler()

    const response = await handler(request(messageEvent(), {
      headers: {
        'x-lark-request-timestamp': SIGNED_AT,
        'x-lark-request-nonce': 'nonce',
        'x-lark-signature': 'deadbeef',
      },
    }))

    expect(response.status).toBe(401)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('signature mismatch'))
  })

  it('answers the subscription challenge after authenticating the caller', async () => {
    const { handler } = createHandler()

    const response = await handler(request({ type: 'url_verification', token: VERIFICATION_TOKEN, challenge: 'c-1' }))

    expect(response.status).toBe(200)
    expect(parseBody(response)).toEqual({ challenge: 'c-1' })
  })

  it('rejects a challenge without a usable string', async () => {
    const { handler } = createHandler()

    expect(parseBody(await handler(request({ type: 'url_verification', token: VERIFICATION_TOKEN }))))
      .toEqual({ code: 1, msg: 'challenge must be a non-empty string' })
  })

  it('accepts a correctly signed event and hands it to the shared gates', async () => {
    const { handler, runtime } = createHandler({ config: { groupPolicy: 'open' }, inbound: { routine: 'daily' } })

    const response = await handler(request(messageEvent()))

    expect(response.status).toBe(200)
    expect(parseBody(response)).toEqual({ code: 0 })
    await settle()
    expect(runtime.gateway.enqueueRun).toHaveBeenCalledWith(['welkin-moon', 'claim-mail'])
  })

  it('rejects an encrypted body it cannot decrypt', async () => {
    const { handler, logger } = createHandler()

    const response = await handler(request({ encrypt: Buffer.alloc(64).toString('base64') }))

    expect(response.status).toBe(400)
    expect(logger.warn).toHaveBeenCalledWith('Feishu event rejected: payload could not be decrypted')
  })

  it('decrypts an encrypted event before routing it', async () => {
    const { handler, runtime } = createHandler({ config: { groupPolicy: 'open' } })
    const iv = Buffer.from('0123456789abcdef', 'utf-8')
    const cipher = createCipheriv('aes-256-cbc', deriveFeishuKey(ENCRYPT_KEY), iv)
    const plaintext = JSON.stringify(messageEvent())
    const encrypt = Buffer.concat([iv, cipher.update(plaintext, 'utf-8'), cipher.final()]).toString('base64')

    const response = await handler(request({ encrypt }))

    expect(response.status).toBe(200)
    await settle()
    expect(runtime.gateway.enqueueRun).toHaveBeenCalled()
  })

  it('rejects a decrypted payload that is not JSON', async () => {
    const { handler, logger } = createHandler()
    const iv = Buffer.from('0123456789abcdef', 'utf-8')
    const cipher = createCipheriv('aes-256-cbc', deriveFeishuKey(ENCRYPT_KEY), iv)
    const encrypt = Buffer.concat([iv, cipher.update('not json at all', 'utf-8'), cipher.final()]).toString('base64')

    expect(parseBody(await handler(request({ encrypt }))))
      .toEqual({ code: 1, msg: 'Event payload could not be decrypted' })
    expect(logger.warn).toHaveBeenCalledWith('Feishu event rejected: decrypted payload is not JSON')
  })

  it('rejects a decrypted payload that is not an object', async () => {
    const { handler, logger } = createHandler()
    const iv = Buffer.from('0123456789abcdef', 'utf-8')
    const cipher = createCipheriv('aes-256-cbc', deriveFeishuKey(ENCRYPT_KEY), iv)
    const encrypt = Buffer.concat([iv, cipher.update('"just a string"', 'utf-8'), cipher.final()]).toString('base64')

    expect(parseBody(await handler(request({ encrypt }))))
      .toEqual({ code: 1, msg: 'Event payload could not be decrypted' })
    expect(logger.warn).toHaveBeenCalledWith('Feishu event rejected: decrypted payload is not a JSON object')
  })

  it('acknowledges a re-delivered event without starting a second run', async () => {
    const { handler, runtime, logger } = createHandler({ config: { groupPolicy: 'open' } })
    const body = messageEvent({ eventId: 'evt-dup' })

    await handler(request(body))
    await settle()
    const response = await handler(request(body))
    await settle()

    expect(response.status).toBe(200)
    expect(runtime.gateway.enqueueRun).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('ignoring the redelivery'))
  })

  it('acknowledges a dropped event so Feishu stops retrying it', async () => {
    const { handler, runtime, logger } = createHandler()

    // The default group policy is `allowlist`: an unlisted chat is dropped, but
    // the delivery itself is still accepted.
    const response = await handler(request(messageEvent()))

    expect(response.status).toBe(200)
    expect(parseBody(response)).toEqual({ code: 0 })
    expect(runtime.gateway.enqueueRun).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('chat is not in groupAllowFrom'))
  })
})
