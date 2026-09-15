import type {
  InFlightLimiter,
  PluginHttpHandler,
  PluginHttpRequest,
  PluginHttpResponse,
  PluginLogger,
  PluginRuntime,
  RateLimiter,
} from '../../../plugin-sdk/index.js'
import type { ResolvedFeishuAccount } from './accounts.js'
import type { FeishuWebhookSettings } from './config.js'
import type { FeishuEventGate, FeishuPairingRequest } from './event-gate.js'
import { Buffer } from 'node:buffer'
import {
  constantTimeEquals,
  createInFlightLimiter,
  createRateLimiter,
  readHeaderValue,
} from '../../../plugin-sdk/index.js'
import { computeFeishuSignature, decryptFeishuPayload } from './crypto.js'
import { createFeishuEventGate } from './event-gate.js'
import { asRecord, stringField } from './record.js'

/**
 * Largest callback body accepted (openclaw `FEISHU_WEBHOOK_MAX_BODY_BYTES`).
 * Event payloads are small; the cap is what keeps an unbounded upload from
 * occupying a connection.
 */
export const FEISHU_WEBHOOK_MAX_BODY_BYTES = 64 * 1024

/**
 * Tolerance for the signed `x-lark-request-timestamp` (openclaw
 * `FEISHU_WEBHOOK_TIMESTAMP_MAX_SKEW_MS`).
 *
 * Feishu signs each delivery at send time, so a captured callback stays validly
 * signed forever; a freshness window is the only thing that bounds a replay.
 */
export const FEISHU_WEBHOOK_TIMESTAMP_MAX_SKEW_MS = 60 * 60_000

/** Unauthenticated requests accepted per source address per window. */
export const FEISHU_WEBHOOK_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const

/**
 * Concurrent unauthenticated callbacks allowed per account (openclaw
 * `FEISHU_PRE_AUTH_MAX_IN_FLIGHT`).
 *
 * A rate limit bounds how often one source may try; this bounds how many
 * unauthenticated requests may be held at once, so a flood of slow callbacks
 * cannot occupy every connection slot.
 */
export const FEISHU_PRE_AUTH_MAX_IN_FLIGHT = 64

export interface FeishuInboundOptions {
  /** Account this route belongs to; the sender policy is evaluated per account. */
  account: ResolvedFeishuAccount
  settings: FeishuWebhookSettings
  runtime: PluginRuntime
  logger: PluginLogger
  now?: () => number
  readPairedSenderIds?: () => Promise<readonly string[]>
  onPairingRequired?: (params: FeishuPairingRequest) => void
  resolveBotOpenId?: () => Promise<string | undefined>
  /** Overridable for tests; defaults to {@link FEISHU_PRE_AUTH_MAX_IN_FLIGHT}. */
  limiter?: InFlightLimiter
}

function json(status: number, body: unknown): PluginHttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/** Feishu treats any 2xx body without `code: 0` as a failure and retries. */
function ack(): PluginHttpResponse {
  return json(200, { code: 0 })
}

/** Whether a signed timestamp is within the tolerated clock skew. */
export function isFeishuWebhookTimestampFresh(timestamp: string, nowMs: number): boolean {
  const parsed = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(parsed))
    return false
  // Feishu signs with second-level timestamps; tolerate millisecond values too.
  const timestampMs = parsed < 1e12 ? parsed * 1_000 : parsed
  return Math.abs(nowMs - timestampMs) <= FEISHU_WEBHOOK_TIMESTAMP_MAX_SKEW_MS
}

/** Reject the request unless it carries a fresh signature matching the encrypt key. */
function authenticateSignature(
  request: PluginHttpRequest,
  settings: FeishuWebhookSettings,
  logger: PluginLogger,
  now: () => number,
): PluginHttpResponse | null {
  // `webhook` mode is the only mode that reaches this handler and its config
  // schema (`superRefine`) guarantees both credentials, so neither is optional.
  const encryptKey = settings.encryptKey
  const source = request.remoteAddress ?? 'unknown'
  const timestamp = readHeaderValue(request.headers, 'x-lark-request-timestamp')
  const nonce = readHeaderValue(request.headers, 'x-lark-request-nonce')
  const signature = readHeaderValue(request.headers, 'x-lark-signature')
  if (timestamp === undefined || nonce === undefined || signature === undefined) {
    logger.warn(`Feishu event rejected: missing signature headers (remote=${source})`)
    return json(401, { code: 1, msg: 'Invalid signature' })
  }
  if (!isFeishuWebhookTimestampFresh(timestamp, now())) {
    logger.warn(`Feishu event rejected: stale signed timestamp (remote=${source})`)
    return json(401, { code: 1, msg: 'Invalid signature' })
  }
  const expected = computeFeishuSignature({ timestamp, nonce, encryptKey, rawBody: request.rawBody })
  if (!constantTimeEquals(signature, expected)) {
    logger.warn(`Feishu event rejected: signature mismatch (remote=${source})`)
    return json(401, { code: 1, msg: 'Invalid signature' })
  }
  return null
}

/** Reject the request unless its verification token matches the configured one. */
function authenticateToken(
  request: PluginHttpRequest,
  body: Record<string, unknown>,
  settings: FeishuWebhookSettings,
  logger: PluginLogger,
): PluginHttpResponse | null {
  const expected = settings.verificationToken
  const header = asRecord(body.header)
  const actual = readHeaderValue(request.headers, 'x-lark-request-token')
    ?? stringField(header, 'token')
    ?? stringField(body, 'token')
  if (actual === undefined || !constantTimeEquals(actual, expected)) {
    logger.warn(`Feishu event rejected: verification token mismatch (remote=${request.remoteAddress ?? 'unknown'})`)
    return json(401, { code: 1, msg: 'Invalid verification token' })
  }
  return null
}

/** Whether a request advertises a JSON body. */
function hasJsonContentType(request: PluginHttpRequest): boolean {
  const contentType = readHeaderValue(request.headers, 'content-type')
  if (contentType === undefined)
    return false
  return contentType.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

/** Body of an authenticated callback, or the response that rejects it. */
type PreAuthOutcome
  = | { ok: true, body: Record<string, unknown> }
    | { ok: false, response: PluginHttpResponse }

/**
 * Everything a caller must prove before its payload is treated as trusted:
 * a fresh signature, a parseable (and, when encrypted, decryptable) envelope and
 * a matching verification token.
 *
 * This is the work the pre-auth in-flight slot covers, so it must stay free of
 * awaits that hand control back to the event loop.
 */
function authenticateRequest(
  request: PluginHttpRequest,
  settings: FeishuWebhookSettings,
  logger: PluginLogger,
  now: () => number,
): PreAuthOutcome {
  const signatureFailure = authenticateSignature(request, settings, logger, now)
  if (signatureFailure)
    return { ok: false, response: signatureFailure }

  let parsed: unknown
  try {
    parsed = JSON.parse(request.rawBody)
  }
  catch {
    return { ok: false, response: json(400, { code: 1, msg: 'Body must be valid JSON' }) }
  }
  const envelope = asRecord(parsed)
  if (!envelope)
    return { ok: false, response: json(400, { code: 1, msg: 'Body must be a JSON object' }) }

  let body = envelope
  if (typeof envelope.encrypt === 'string') {
    const decrypted = decryptToRecord(settings.encryptKey, envelope.encrypt, logger)
    if (!decrypted)
      return { ok: false, response: json(400, { code: 1, msg: 'Event payload could not be decrypted' }) }
    body = decrypted
  }

  const tokenFailure = authenticateToken(request, body, settings, logger)
  if (tokenFailure)
    return { ok: false, response: tokenFailure }
  return { ok: true, body }
}

/**
 * Event callback for the `webhook` connection mode.
 *
 * This is the transport half only: it bounds the untrusted work (body size and
 * the per-source rate limit), authenticates the caller
 * (fresh signature, optional decryption, verification token), answers the
 * subscription handshake and then hands the envelope to the gates shared with
 * the WebSocket transport.
 *
 * Accepted events are acknowledged before the run is enqueued, because Feishu
 * gives the callback roughly three seconds before it retries.
 *
 * Giclaw reuses the host web server instead of starting its own listener, so
 * `webhookHost`/`webhookPort` do not bind a second socket here; the route is
 * reached through `web.host`/`web.port` and the headers below are the contract.
 *
 * openclaw holds a `FEISHU_PRE_AUTH_MAX_IN_FLIGHT` slot around the untrusted
 * body read and the signature check; the slot here covers
 * {@link authenticateRequest} and is always released before the event is
 * dispatched, because a stalled downstream (pairing store, run queue) must not
 * stop the next callback from being read.
 */
export function createFeishuInboundHandler(options: FeishuInboundOptions): PluginHttpHandler {
  const { account, settings, runtime, logger } = options
  const now = options.now ?? Date.now
  const gate: FeishuEventGate = createFeishuEventGate({
    accountId: account.accountId,
    config: account.config,
    routing: settings.inbound,
    runtime,
    logger,
    ...(options.now ? { now: options.now } : {}),
    ...(options.readPairedSenderIds ? { readPairedSenderIds: options.readPairedSenderIds } : {}),
    ...(options.onPairingRequired ? { onPairingRequired: options.onPairingRequired } : {}),
    ...(options.resolveBotOpenId ? { resolveBotOpenId: options.resolveBotOpenId } : {}),
  })
  const sourceLimiter: RateLimiter = createRateLimiter({
    limit: FEISHU_WEBHOOK_RATE_LIMIT.limit,
    windowMs: FEISHU_WEBHOOK_RATE_LIMIT.windowMs,
    ...(options.now ? { now: options.now } : {}),
  })
  const preAuthLimiter: InFlightLimiter = options.limiter ?? createInFlightLimiter({
    maxInFlightPerKey: FEISHU_PRE_AUTH_MAX_IN_FLIGHT,
    maxTrackedKeys: 1,
  })
  // One slot per account: openclaw keys on `account:path`, and the account is
  // the unit that shares a tenant token, so nothing is gained by splitting it.
  const preAuthKey = account.accountId
  return async (request) => {
    if (request.method.toUpperCase() !== 'POST')
      return json(405, { code: 1, msg: 'Method not allowed' })

    if (!hasJsonContentType(request)) {
      logger.warn(`Feishu event rejected: content-type must be application/json (remote=${request.remoteAddress ?? 'unknown'})`)
      return json(415, { code: 1, msg: 'Content-Type must be application/json' })
    }

    const source = request.remoteAddress ?? 'unknown'
    if (!sourceLimiter.allow(source)) {
      logger.warn(`Feishu event rejected: too many callbacks from remote=${source}`)
      return json(429, { code: 1, msg: 'Too many requests' })
    }

    if (Buffer.byteLength(request.rawBody, 'utf-8') > FEISHU_WEBHOOK_MAX_BODY_BYTES) {
      logger.warn(`Feishu event rejected: body exceeds ${FEISHU_WEBHOOK_MAX_BODY_BYTES} bytes`)
      return json(413, { code: 1, msg: 'Request body too large' })
    }

    if (!preAuthLimiter.tryAcquire(preAuthKey)) {
      logger.warn(`Feishu event rejected: ${FEISHU_PRE_AUTH_MAX_IN_FLIGHT} unauthenticated callbacks already in flight (account=${account.accountId})`)
      return json(429, { code: 1, msg: 'Too many in-flight requests' })
    }
    const authenticated = authenticateRequest(request, settings, logger, now)
    preAuthLimiter.release(preAuthKey)
    if (!authenticated.ok)
      return authenticated.response
    const body = authenticated.body

    // Subscription handshake: echo the challenge once the caller is authenticated.
    if (body.type === 'url_verification') {
      const challenge = stringField(body, 'challenge')
      if (challenge === undefined)
        return json(400, { code: 1, msg: 'challenge must be a non-empty string' })
      return json(200, { challenge })
    }

    await gate.gate(body)
    return ack()
  }
}

/** Decrypt one encrypted envelope, logging (never echoing) a decrypt failure. */
function decryptToRecord(
  encryptKey: string,
  payload: string,
  logger: PluginLogger,
): Record<string, unknown> | null {
  let decrypted: string
  try {
    decrypted = decryptFeishuPayload(encryptKey, payload)
  }
  catch {
    logger.warn('Feishu event rejected: payload could not be decrypted')
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decrypted)
  }
  catch {
    logger.warn('Feishu event rejected: decrypted payload is not JSON')
    return null
  }
  const record = asRecord(parsed)
  if (!record)
    logger.warn('Feishu event rejected: decrypted payload is not a JSON object')
  return record
}
