import type { AppConfig } from '../../../config/schema.js'
import type { NotificationMessage, PluginLogger } from '../../../plugin-sdk/index.js'
import { describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../../../config/schema.js'
import { feishuConfigSchema } from './config.js'
import { createFeishuOutbound } from './outbound.js'
import { signFeishuWebhook } from './sign.js'

const message: NotificationMessage = {
  level: 'success',
  title: 'Giclaw 运行成功 (1/1)',
  body: 'runId: run-1\ntrigger: cron\n✓ welkin-moon',
  runId: 'run-1',
  trigger: 'cron',
  occurredAt: '2026-01-01T00:00:00.000Z',
  results: [{ taskId: 'welkin-moon', success: true, message: 'done', durationMs: 12 }],
}

const appConfig: AppConfig = appConfigSchema.parse({})
const logger: PluginLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const context = { config: appConfig, channelConfig: {}, logger }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Route responses by URL so one fake can serve both token and message calls. */
function routingFetch(routes: (url: string, init: RequestInit) => Response | undefined): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    const response = routes(url, init ?? {})
    if (!response)
      throw new Error(`unexpected request to ${url}`)
    return response
  }) as typeof fetch
}

describe('createFeishuOutbound — webhook mode', () => {
  const config = feishuConfigSchema.parse({
    mode: 'webhook',
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/token',
    webhookSecret: 's3cret',
  })

  it('sends an interactive card', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0 }))
    const outbound = createFeishuOutbound({ config, fetchImpl, now: () => 1_700_000_000_000 })

    await expect(outbound.send(message, context)).resolves.toEqual({ ok: true, detail: 'sent via Feishu webhook (account default)' })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://open.feishu.cn/open-apis/bot/v2/hook/token')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.msg_type).toBe('interactive')
    expect(body.timestamp).toBe('1700000000')
    expect(body.sign).toBe(signFeishuWebhook('s3cret', 1_700_000_000))
    expect(body.card).toMatchObject({ header: { template: 'green' } })
  })

  it('sends plain text when cards are disabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0 }))
    const outbound = createFeishuOutbound({
      config: feishuConfigSchema.parse({ mode: 'webhook', webhookUrl: 'https://example.test/hook', card: false }),
      fetchImpl,
    })

    await outbound.send(message, context)

    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      msg_type: 'text',
      content: { text: `${message.title}\n${message.body}` },
    })
  })

  it('prefers a per-target webhook from the route target', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0 }))
    const outbound = createFeishuOutbound({
      config: feishuConfigSchema.parse({
        mode: 'webhook',
        webhookUrl: 'https://example.test/global',
        targets: { ops: { webhookUrl: 'https://example.test/ops' } },
      }),
      fetchImpl,
    })

    await outbound.send(message, { ...context, target: { name: 'ops' } })

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.test/ops')
  })

  it('skips without a webhook URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const outbound = createFeishuOutbound({ config: feishuConfigSchema.parse({ mode: 'webhook' }), fetchImpl })

    await expect(outbound.send(message, context))
      .resolves
      .toEqual({ ok: false, detail: 'no Feishu webhook URL configured', retryable: false })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('Feishu notification skipped: no Feishu webhook URL configured')
  })

  it('reports a rejected webhook as non-retryable', async () => {
    const outbound = createFeishuOutbound({
      config,
      fetchImpl: vi.fn<typeof fetch>(async () => jsonResponse({ code: 19021, msg: 'sign match fail' })),
    })

    await expect(outbound.send(message, context)).resolves.toMatchObject({
      ok: false,
      detail: 'Feishu webhook send failed: 19021 sign match fail',
      retryable: false,
    })
  })

  it('reports transport failures as retryable', async () => {
    const outbound = createFeishuOutbound({
      config,
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new Error('socket hang up')
      }),
    })

    await expect(outbound.send(message, context))
      .resolves
      .toEqual({ ok: false, detail: 'socket hang up', retryable: true })
  })
})

const configValues = {
  appId: 'cli_x',
  appSecret: 's3cret',
  targets: { ops: { chatId: 'oc_ops' } },
}

describe('createFeishuOutbound — app mode', () => {
  const config = feishuConfigSchema.parse(configValues)

  it('fetches a token then sends the message', async () => {
    const fetchImpl = vi.fn<typeof fetch>(routingFetch(url => url.includes('tenant_access_token')
      ? jsonResponse({ code: 0, tenant_access_token: 't-1', expire: 7_200 })
      : jsonResponse({ code: 0, data: { message_id: 'om_7' } })))
    const outbound = createFeishuOutbound({ config, fetchImpl })

    await expect(outbound.send(message, { ...context, target: { name: 'ops' } }))
      .resolves
      .toEqual({ ok: true, detail: 'sent om_7' })

    const [tokenUrl] = fetchImpl.mock.calls[0] as unknown as [URL]
    const [messageUrl, messageInit] = fetchImpl.mock.calls[1] as unknown as [URL, RequestInit]
    expect(String(tokenUrl)).toContain('tenant_access_token')
    expect(String(messageUrl)).toBe('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
    expect((messageInit.headers as Record<string, string>).authorization).toBe('Bearer t-1')
  })

  it('reuses the tenant token across sends on the same instance', async () => {
    const fetchImpl = vi.fn<typeof fetch>(routingFetch(url => url.includes('tenant_access_token')
      ? jsonResponse({ code: 0, tenant_access_token: 't-1', expire: 7_200 })
      : jsonResponse({ code: 0, data: { message_id: 'om_8' } })))
    const outbound = createFeishuOutbound({ config, fetchImpl })

    await outbound.send(message, { ...context, target: { name: 'ops' } })
    await outbound.send({ ...message, runId: 'run-2' }, { ...context, target: { name: 'ops' } })

    const tokenCalls = fetchImpl.mock.calls.filter(call => String(call[0]).includes('tenant_access_token'))
    expect(tokenCalls).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('sends plain text when cards are disabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>(routingFetch(url => url.includes('tenant_access_token')
      ? jsonResponse({ code: 0, tenant_access_token: 't-1', expire: 7_200 })
      : jsonResponse({ code: 0, data: { message_id: 'om_text' } })))
    const outbound = createFeishuOutbound({
      config: feishuConfigSchema.parse({ ...configValues, card: false }),
      fetchImpl,
    })

    await expect(outbound.send(message, context)).resolves.toEqual({ ok: true, detail: 'sent om_text' })

    const body = JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string) as { msg_type: string }
    expect(body.msg_type).toBe('text')
  })

  it('reports a send without a message id', async () => {
    const outbound = createFeishuOutbound({
      config,
      fetchImpl: vi.fn<typeof fetch>(routingFetch(url => url.includes('tenant_access_token')
        ? jsonResponse({ code: 0, tenant_access_token: 't-1', expire: 7_200 })
        : jsonResponse({ code: 0 }))),
    })

    await expect(outbound.send(message, context)).resolves.toEqual({ ok: true, detail: 'sent via Feishu app' })
  })

  it('refreshes an expired tenant token once and retries', async () => {
    let tokenCalls = 0
    const fetchImpl = vi.fn<typeof fetch>(routingFetch((url) => {
      if (url.includes('tenant_access_token')) {
        tokenCalls += 1
        return jsonResponse({ code: 0, tenant_access_token: `t-${tokenCalls}`, expire: 7_200 })
      }
      if (tokenCalls === 1)
        return jsonResponse({ code: 99991663, msg: 'tenant token expired' })
      return jsonResponse({ code: 0, data: { message_id: 'om_retry' } })
    }))
    const outbound = createFeishuOutbound({ config, fetchImpl })

    await expect(outbound.send(message, context)).resolves.toEqual({ ok: true, detail: 'sent om_retry' })
    // token -> rejected send -> refreshed token -> accepted send
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('does not retry a non-auth platform failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(routingFetch(url => url.includes('tenant_access_token')
      ? jsonResponse({ code: 0, tenant_access_token: 't-1', expire: 7_200 })
      : jsonResponse({ code: 230002, msg: 'bot is not in the chat' })))
    const outbound = createFeishuOutbound({ config, fetchImpl })

    await expect(outbound.send(message, context)).resolves.toEqual({
      ok: false,
      detail: 'Feishu message send failed: 230002 bot is not in the chat',
      retryable: false,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('marks transient platform failures as retryable', async () => {
    const outbound = createFeishuOutbound({
      config,
      fetchImpl: vi.fn<typeof fetch>(routingFetch(url => url.includes('tenant_access_token')
        ? jsonResponse({ code: 0, tenant_access_token: 't-1', expire: 7_200 })
        : jsonResponse({ code: 99991400, msg: 'too many requests' }))),
    })

    await expect(outbound.send(message, context)).resolves.toMatchObject({ ok: false, retryable: true })
  })

  it('reports a non-Feishu failure as retryable', async () => {
    const outbound = createFeishuOutbound({
      config,
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new Error('stub failure')
      }),
    })

    await expect(outbound.send(message, context)).resolves.toEqual({
      ok: false,
      detail: 'stub failure',
      retryable: true,
    })
  })

  it('skips when app credentials are missing', async () => {
    const outbound = createFeishuOutbound({
      config: feishuConfigSchema.parse({ mode: 'app', targets: { ops: { chatId: 'oc_ops' } } }),
      fetchImpl: vi.fn<typeof fetch>(),
    })

    await expect(outbound.send(message, context))
      .resolves
      .toEqual({ ok: false, detail: 'Feishu appId/appSecret are not configured for account default', retryable: false })
  })

  it('skips when the target has no chat id', async () => {
    const outbound = createFeishuOutbound({
      config: feishuConfigSchema.parse({ appId: 'cli_x', appSecret: 's', targets: { ops: {} } }),
      fetchImpl: vi.fn<typeof fetch>(),
    })

    await expect(outbound.send(message, context))
      .resolves
      .toEqual({ ok: false, detail: 'no Feishu chatId configured for this target', retryable: false })
  })

  it('also skips when no target is declared at all', async () => {
    const outbound = createFeishuOutbound({
      config: feishuConfigSchema.parse({ appId: 'cli_x', appSecret: 's' }),
      fetchImpl: vi.fn<typeof fetch>(),
    })

    await expect(outbound.send(message, context)).resolves.toMatchObject({ retryable: false })
  })

  it('reports a tenant token failure', async () => {
    const outbound = createFeishuOutbound({
      config,
      fetchImpl: vi.fn<typeof fetch>(async () => jsonResponse({ code: 10003, msg: 'invalid app_secret' })),
    })

    await expect(outbound.send(message, context)).resolves.toEqual({
      ok: false,
      detail: 'Feishu tenant token request failed: 10003 invalid app_secret',
      retryable: false,
    })
  })
})
