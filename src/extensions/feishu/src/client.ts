import type { ReceiveIdType } from './config.js'
import { signFeishuWebhook } from './sign.js'

/**
 * Minimal, dependency-free Feishu (Lark) open-platform transport.
 *
 * openclaw builds on `@larksuiteoapi/node-sdk`; Giclaw only needs two calls
 * (tenant token + send message) plus the custom-bot webhook, so the transport
 * is implemented directly instead of pulling a large SDK into the daemon.
 */

/** Tenant token endpoint (self-built app). */
export const TENANT_TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'
/** Message send endpoint. */
export const MESSAGE_PATH = '/open-apis/im/v1/messages'
/** App identity endpoint, used to attribute `@`-mentions. */
export const BOT_INFO_PATH = '/open-apis/bot/v3/info'

/** Token-validity window we treat as "expired" to avoid in-flight 401s. */
const DEFAULT_REFRESH_SKEW_MS = 60_000
const DEFAULT_TOKEN_TTL_SECONDS = 7_200

/** Feishu codes that are worth retrying (rate limit / transient platform errors). */
const RETRYABLE_CODES = new Set([99991400, 99991661, 99991664])
/** Feishu codes that mean "the tenant token is not usable; fetch a fresh one". */
const AUTH_CODES = new Set([99991661, 99991663, 99991664])

export class FeishuApiError extends Error {
  constructor(
    message: string,
    /** Feishu envelope `code` (0 when the call failed before the envelope). */
    readonly code: number,
    readonly httpStatus: number,
    /** True when a later attempt could plausibly succeed. */
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'FeishuApiError'
  }
}

/** True when a failure means the cached tenant token should be discarded. */
export function isFeishuAuthError(error: unknown): boolean {
  return error instanceof FeishuApiError && AUTH_CODES.has(error.code)
}

interface FeishuEnvelope {
  code?: number
  msg?: string
}

function isRetryable(code: number, httpStatus: number): boolean {
  return httpStatus === 429 || httpStatus >= 500 || RETRYABLE_CODES.has(code)
}

function describeFailure(action: string, code: number, httpStatus: number, msg: string | undefined): string {
  const detail = msg !== undefined && msg !== '' ? msg : `HTTP ${httpStatus}`
  return code === 0 ? `${action} failed: ${detail}` : `${action} failed: ${code} ${detail}`
}

/**
 * Unwrap a Feishu JSON envelope, converting `{ code, msg }` and transport
 * failures into a single error type.
 */
async function readEnvelope<T extends Record<string, unknown>>(
  response: Response,
  action: string,
): Promise<T & FeishuEnvelope> {
  const httpStatus = response.status
  let payload: T & FeishuEnvelope
  try {
    payload = await response.json() as T & FeishuEnvelope
  }
  catch {
    throw new FeishuApiError(
      `${action} failed: response was not JSON (HTTP ${httpStatus})`,
      0,
      httpStatus,
      httpStatus >= 500,
    )
  }

  const code = payload.code ?? 0
  if (!response.ok || code !== 0) {
    throw new FeishuApiError(
      describeFailure(action, code, httpStatus, payload.msg),
      code,
      httpStatus,
      isRetryable(code, httpStatus),
    )
  }
  return payload
}

export interface TenantTokenProvider {
  /** Current tenant access token, refreshing when the cached one is stale. */
  getToken: () => Promise<string>
  /** Drop the cached token (called after an authentication failure). */
  invalidate: () => void
}

export interface TenantTokenProviderOptions {
  baseUrl: string
  appId: string
  appSecret: string
  timeoutMs: number
  fetchImpl?: typeof fetch
  now?: () => number
  refreshSkewMs?: number
}

/**
 * Caches one tenant access token per credential set and de-duplicates
 * concurrent refreshes, so a burst of notifications triggers a single call.
 */
export function createTenantTokenProvider(options: TenantTokenProviderOptions): TenantTokenProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? Date.now
  const skewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS

  let cached: { token: string, expiresAt: number } | undefined
  let pending: Promise<string> | undefined

  const request = async (): Promise<string> => {
    const response = await fetchImpl(new URL(TENANT_TOKEN_PATH, options.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: options.appId, app_secret: options.appSecret }),
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    const payload = await readEnvelope<{ tenant_access_token?: string, expire?: number }>(
      response,
      'Feishu tenant token request',
    )
    const token = payload.tenant_access_token
    if (token === undefined || token === '') {
      throw new FeishuApiError(
        'Feishu tenant token request failed: response did not include a token',
        0,
        response.status,
        true,
      )
    }
    const ttlSeconds = payload.expire ?? DEFAULT_TOKEN_TTL_SECONDS
    cached = { token, expiresAt: now() + Math.max(0, ttlSeconds * 1_000 - skewMs) }
    return token
  }

  return {
    async getToken() {
      if (cached && cached.expiresAt > now())
        return cached.token
      pending ??= request().finally(() => {
        pending = undefined
      })
      return pending
    },
    invalidate() {
      cached = undefined
    },
  }
}

export interface SendAppMessageOptions {
  baseUrl: string
  token: string
  receiveId: string
  receiveIdType: ReceiveIdType
  /** `text` or `interactive` (card). */
  msgType: 'text' | 'interactive'
  /** Pre-serialized Feishu message content JSON. */
  content: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}

/** `POST /open-apis/im/v1/messages`. Returns the created message id when present. */
export async function sendAppMessage(options: SendAppMessageOptions): Promise<string | undefined> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const url = new URL(MESSAGE_PATH, options.baseUrl)
  url.searchParams.set('receive_id_type', options.receiveIdType)

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${options.token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: options.receiveId,
      msg_type: options.msgType,
      content: options.content,
    }),
    signal: AbortSignal.timeout(options.timeoutMs),
  })

  const payload = await readEnvelope<{ data?: { message_id?: string } }>(response, 'Feishu message send')
  return payload.data?.message_id
}

/**
 * `GET /open-apis/bot/v3/info`.
 *
 * Returns this app's own `open_id`, which is what makes an `@`-mention
 * attributable: without it any mention in a group would count as "the app was
 * mentioned". A failure here is not fatal (openclaw falls back the same way).
 */
export async function fetchBotOpenId(options: {
  baseUrl: string
  token: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}): Promise<string | undefined> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const response = await fetchImpl(new URL(BOT_INFO_PATH, options.baseUrl), {
    method: 'GET',
    headers: { authorization: `Bearer ${options.token}` },
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  const payload = await readEnvelope<{ bot?: { open_id?: string } }>(response, 'Feishu bot info request')
  const openId = payload.bot?.open_id
  return openId === '' ? undefined : openId
}

export interface SendWebhookMessageOptions {
  webhookUrl: string
  /** Signing secret of the custom bot; enables `timestamp` + `sign`. */
  secret?: string
  payload: Record<string, unknown>
  timeoutMs: number
  /** Seconds since the epoch; injectable so signatures stay deterministic in tests. */
  nowSeconds?: () => number
  fetchImpl?: typeof fetch
}

/** `POST <custom-bot webhook>` with an optional signature. */
export async function sendWebhookMessage(options: SendWebhookMessageOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000))
  const body: Record<string, unknown> = { ...options.payload }
  if (options.secret !== undefined && options.secret !== '') {
    const timestamp = nowSeconds()
    body.timestamp = String(timestamp)
    body.sign = signFeishuWebhook(options.secret, timestamp)
  }

  const response = await fetchImpl(options.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs),
  })

  await readEnvelope<Record<string, unknown>>(response, 'Feishu webhook send')
}
