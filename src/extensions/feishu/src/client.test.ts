import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BOT_INFO_PATH,
  createTenantTokenProvider,
  FeishuApiError,
  fetchBotOpenId,
  isFeishuAuthError,
  MESSAGE_PATH,
  sendAppMessage,
  sendWebhookMessage,
  TENANT_TOKEN_PATH,
} from './client.js'
import { signFeishuWebhook } from './sign.js'

const BASE_URL = 'https://open.feishu.cn'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function callOf(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, index = 0): [URL, RequestInit] {
  return fetchImpl.mock.calls[index] as unknown as [URL, RequestInit]
}

describe('feishu API error', () => {
  it('names itself and exposes the platform code', () => {
    const error = new FeishuApiError('boom', 99, 500, true)
    expect(error.name).toBe('FeishuApiError')
    expect(error).toMatchObject({ message: 'boom', code: 99, httpStatus: 500, retryable: true })
    expect(error).toBeInstanceOf(Error)
  })
})

describe('isFeishuAuthError', () => {
  it('recognizes the tenant-token failure codes', () => {
    expect(isFeishuAuthError(new FeishuApiError('x', 99991663, 200, false))).toBe(true)
    expect(isFeishuAuthError(new FeishuApiError('x', 99991664, 200, false))).toBe(true)
    expect(isFeishuAuthError(new FeishuApiError('x', 10003, 200, false))).toBe(false)
    expect(isFeishuAuthError(new Error('x'))).toBe(false)
    expect(isFeishuAuthError('x')).toBe(false)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('global fetch fallback', () => {
  it('uses the ambient fetch implementation when none is injected', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0, tenant_access_token: 't-global', expire: 7_200 }))
    vi.stubGlobal('fetch', fetchImpl)

    const provider = createTenantTokenProvider({ baseUrl: BASE_URL, appId: 'cli_x', appSecret: 's', timeoutMs: 1_000 })
    await expect(provider.getToken()).resolves.toBe('t-global')

    await expect(sendAppMessage({
      baseUrl: BASE_URL,
      token: 't-global',
      receiveId: 'oc_1',
      receiveIdType: 'chat_id',
      msgType: 'text',
      content: '{"text":"hi"}',
      timeoutMs: 1_000,
    })).resolves.toBeUndefined()

    await expect(sendWebhookMessage({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/token',
      payload: { msg_type: 'text' },
      timeoutMs: 1_000,
    })).resolves.toBeUndefined()

    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})

describe('createTenantTokenProvider', () => {
  const credentials = { baseUrl: BASE_URL, appId: 'cli_x', appSecret: 's3cret', timeoutMs: 1_000 }

  it('requests, caches and reuses a tenant token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7_200 }))
    const provider = createTenantTokenProvider({ ...credentials, fetchImpl, now: () => 1_000 })

    expect(await provider.getToken()).toBe('t-1')
    expect(await provider.getToken()).toBe('t-1')
    expect(fetchImpl).toHaveBeenCalledOnce()

    const [url, init] = callOf(fetchImpl)
    expect(String(url)).toBe(`${BASE_URL}${TENANT_TOKEN_PATH}`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json; charset=utf-8' })
    expect(JSON.parse(init.body as string)).toEqual({ app_id: 'cli_x', app_secret: 's3cret' })
  })

  it('refreshes a token that has entered the expiry skew window', async () => {
    let clock = 0
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ code: 0, tenant_access_token: `t-${clock}`, expire: 7_200 }))
    const provider = createTenantTokenProvider({ ...credentials, fetchImpl, now: () => clock })

    expect(await provider.getToken()).toBe('t-0')
    clock = 7_200_000 - 60_000
    expect(await provider.getToken()).toBe(`t-${clock}`)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('falls back to the default TTL when the response omits expire', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0, tenant_access_token: 't-1' }))
    const provider = createTenantTokenProvider({ ...credentials, fetchImpl, now: () => 0 })

    expect(await provider.getToken()).toBe('t-1')
    expect(await provider.getToken()).toBe('t-1')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('uses a custom refresh skew', async () => {
    let clock = 0
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0, tenant_access_token: 't', expire: 10 }))
    const provider = createTenantTokenProvider({
      ...credentials,
      fetchImpl,
      now: () => clock,
      refreshSkewMs: 10_000,
    })

    await provider.getToken()
    // expire(10s) - skew(10s) clamps to 0, so the cache is already stale.
    clock = 1
    await provider.getToken()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('de-duplicates concurrent refreshes', async () => {
    let release: ((response: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => {
      release = resolve
    })
    const fetchImpl = vi.fn<typeof fetch>(() => pending)
    const provider = createTenantTokenProvider({ ...credentials, fetchImpl, now: () => 0 })

    const first = provider.getToken()
    const second = provider.getToken()
    release?.(jsonResponse({ code: 0, tenant_access_token: 't-shared', expire: 7_200 }))

    expect(await Promise.all([first, second])).toEqual(['t-shared', 't-shared'])
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('retries after a failed refresh instead of caching the rejection', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 99991400, msg: 'too many requests' }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 't-2', expire: 7_200 }))
    const provider = createTenantTokenProvider({ ...credentials, fetchImpl, now: () => 0 })

    await expect(provider.getToken()).rejects.toThrow('Feishu tenant token request failed: 99991400 too many requests')
    await expect(provider.getToken()).resolves.toBe('t-2')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('drops the cache when invalidated', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0, tenant_access_token: 't-1', expire: 7_200 }))
    const provider = createTenantTokenProvider({ ...credentials, fetchImpl, now: () => 0 })

    await provider.getToken()
    provider.invalidate()
    await provider.getToken()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects an envelope without a token', async () => {
    const provider = createTenantTokenProvider({
      ...credentials,
      fetchImpl: vi.fn<typeof fetch>(async () => jsonResponse({ code: 0, msg: 'ok' })),
      now: () => 0,
    })

    await expect(provider.getToken()).rejects.toThrow(/did not include a token/)
    await expect(provider.getToken()).rejects.toMatchObject({ code: 0, retryable: true })
  })

  it('rejects an empty token', async () => {
    const provider = createTenantTokenProvider({
      ...credentials,
      fetchImpl: vi.fn<typeof fetch>(async () => jsonResponse({ code: 0, tenant_access_token: '' })),
      now: () => 0,
    })

    await expect(provider.getToken()).rejects.toThrow(/did not include a token/)
  })

  it('reports an HTTP failure without a platform message', async () => {
    const provider = createTenantTokenProvider({
      ...credentials,
      fetchImpl: vi.fn<typeof fetch>(async () => jsonResponse({ code: 0 }, 502)),
      now: () => 0,
    })

    await expect(provider.getToken()).rejects.toThrow('Feishu tenant token request failed: HTTP 502')
    await expect(provider.getToken()).rejects.toMatchObject({ httpStatus: 502, retryable: true })
  })

  it('treats an empty platform message as absent', async () => {
    const provider = createTenantTokenProvider({
      ...credentials,
      fetchImpl: vi.fn<typeof fetch>(async () => jsonResponse({ code: 400, msg: '' }, 400)),
      now: () => 0,
    })

    await expect(provider.getToken()).rejects.toThrow('Feishu tenant token request failed: 400 HTTP 400')
    await expect(provider.getToken()).rejects.toMatchObject({ retryable: false })
  })

  it('reports a non-JSON error response', async () => {
    const provider = createTenantTokenProvider({
      ...credentials,
      fetchImpl: vi.fn<typeof fetch>(async () => new Response('<html>nope</html>', { status: 503 })),
      now: () => 0,
    })

    await expect(provider.getToken()).rejects.toThrow(/response was not JSON \(HTTP 503\)/)
    await expect(provider.getToken()).rejects.toMatchObject({ retryable: true })
  })

  it('defaults a missing platform code to zero', async () => {
    const provider = createTenantTokenProvider({
      ...credentials,
      fetchImpl: vi.fn<typeof fetch>(async () => jsonResponse({ tenant_access_token: 't-1', expire: 7_200 })),
      now: () => 0,
    })

    await expect(provider.getToken()).resolves.toBe('t-1')
  })

  it('treats a non-JSON client error as non-retryable', async () => {
    const provider = createTenantTokenProvider({
      ...credentials,
      fetchImpl: vi.fn<typeof fetch>(async () => new Response('<html>nope</html>', { status: 400 })),
      now: () => 0,
    })

    await expect(provider.getToken()).rejects.toMatchObject({ retryable: false, code: 0, httpStatus: 400 })
  })
})

describe('sendAppMessage', () => {
  const options = {
    baseUrl: BASE_URL,
    token: 't-1',
    receiveId: 'oc_1',
    receiveIdType: 'chat_id' as const,
    msgType: 'interactive' as const,
    content: '{"header":{}}',
    timeoutMs: 1_000,
  }

  it('posts to the message endpoint and returns the created id', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0, data: { message_id: 'om_1' } }))

    await expect(sendAppMessage({ ...options, fetchImpl })).resolves.toBe('om_1')

    const [url, init] = callOf(fetchImpl)
    expect(String(url)).toBe(`${BASE_URL}${MESSAGE_PATH}?receive_id_type=chat_id`)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ authorization: 'Bearer t-1' })
    expect(JSON.parse(init.body as string)).toEqual({
      receive_id: 'oc_1',
      msg_type: 'interactive',
      content: '{"header":{}}',
    })
  })

  it('supports other receiver identifier kinds', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0, data: { message_id: 'om_2' } }))

    await sendAppMessage({ ...options, receiveIdType: 'open_id', msgType: 'text', fetchImpl })

    expect(String(callOf(fetchImpl)[0])).toContain('receive_id_type=open_id')
  })

  it('returns undefined when the envelope omits data', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0, msg: 'success' }))

    await expect(sendAppMessage({ ...options, fetchImpl })).resolves.toBeUndefined()
  })

  it('surfaces platform errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 230001, msg: 'invalid receive_id' }))

    await expect(sendAppMessage({ ...options, fetchImpl }))
      .rejects
      .toThrow('Feishu message send failed: 230001 invalid receive_id')
  })
})

describe('fetchBotOpenId', () => {
  const options = { baseUrl: BASE_URL, token: 't-1', timeoutMs: 1_000 }

  it('returns the app open id and treats an empty one as unknown', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0, bot: { open_id: 'ou_bot' } }))
    await expect(fetchBotOpenId({ ...options, fetchImpl })).resolves.toBe('ou_bot')

    const [url, init] = callOf(fetchImpl)
    expect(String(url)).toBe(`${BASE_URL}${BOT_INFO_PATH}`)
    expect(init.headers).toMatchObject({ authorization: 'Bearer t-1' })

    const empty = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0, bot: { open_id: '' } }))
    await expect(fetchBotOpenId({ ...options, fetchImpl: empty })).resolves.toBeUndefined()

    const missing = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0 }))
    await expect(fetchBotOpenId({ ...options, fetchImpl: missing })).resolves.toBeUndefined()
  })
})

describe('sendWebhookMessage', () => {
  const payload = { msg_type: 'interactive', card: { header: {} } }

  it('posts the payload without a signature when no secret is set', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0, msg: 'success' }))

    await expect(sendWebhookMessage({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/token',
      payload,
      timeoutMs: 1_000,
      fetchImpl,
    })).resolves.toBeUndefined()

    const [url, init] = callOf(fetchImpl)
    expect(String(url)).toBe('https://open.feishu.cn/open-apis/bot/v2/hook/token')
    expect(JSON.parse(init.body as string)).toEqual(payload)
  })

  it('adds a timestamp and signature when a secret is set', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0 }))

    await sendWebhookMessage({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/token',
      secret: 's3cret',
      payload,
      timeoutMs: 1_000,
      nowSeconds: () => 1_700_000_000,
      fetchImpl,
    })

    expect(JSON.parse(callOf(fetchImpl)[1].body as string)).toEqual({
      ...payload,
      timestamp: '1700000000',
      sign: signFeishuWebhook('s3cret', 1_700_000_000),
    })
  })

  it('ignores an empty secret and defaults the clock', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0 }))

    await sendWebhookMessage({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/token',
      secret: '',
      payload,
      timeoutMs: 1_000,
      fetchImpl,
    })

    expect(JSON.parse(callOf(fetchImpl)[1].body as string)).toEqual(payload)
  })

  it('reports a failed signature check', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 19021, msg: 'sign match fail' }))

    await expect(sendWebhookMessage({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/token',
      secret: 'wrong',
      payload,
      timeoutMs: 1_000,
      fetchImpl,
    })).rejects.toThrow('Feishu webhook send failed: 19021 sign match fail')
  })
})
