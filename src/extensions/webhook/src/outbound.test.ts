import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AppConfig } from '../../../config/schema.js'
import type { NotificationMessage } from '../../../plugin-sdk/index.js'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../../../config/schema.js'
import { webhookConfigSchema } from './config.js'
import { createWebhookOutbound, toPayload } from './outbound.js'
import { SIGNATURE_HEADER, signPayload } from './signature.js'

const message: NotificationMessage = {
  level: 'error',
  title: 'Giclaw 运行失败',
  body: 'runId: run-1',
  runId: 'run-1',
  trigger: 'cron',
  occurredAt: '2026-01-01T00:00:00.000Z',
  results: [
    {
      taskId: 'claim-mail',
      success: false,
      message: 'network down',
      durationMs: 12,
    },
  ],
}

const servers: Server[] = []
const appConfig: AppConfig = appConfigSchema.parse({})
const context = { config: appConfig, channelConfig: {}, logger: console }

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
})

describe('toPayload', () => {
  it('flattens the notification into a stable wire shape', () => {
    expect(toPayload(message)).toEqual({
      level: 'error',
      title: 'Giclaw 运行失败',
      body: 'runId: run-1',
      runId: 'run-1',
      trigger: 'cron',
      occurredAt: '2026-01-01T00:00:00.000Z',
      results: message.results,
    })
  })
})

describe('createWebhookOutbound', () => {
  it('fails without an endpoint', async () => {
    const outbound = createWebhookOutbound({ config: webhookConfigSchema.parse({}) })
    await expect(outbound.send(message, context))
      .resolves
      .toEqual({ ok: false, detail: 'no webhook endpoint configured', retryable: false })
  })

  it('posts a signed payload to the resolved endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    const config = webhookConfigSchema.parse({
      endpoints: { ops: { url: 'https://example.test/hook', secret: 's3cret', headers: { 'x-trace': 'abc' } } },
    })
    const outbound = createWebhookOutbound({ config, fetchImpl })

    const result = await outbound.send(message, context)

    expect(result).toEqual({ ok: true, detail: 'HTTP 204' })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.test/hook')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify(toPayload(message)))
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-trace']).toBe('abc')
    expect(headers[SIGNATURE_HEADER]).toBe(signPayload('s3cret', init.body as string))
  })

  it('omits the signature when no secret is configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }))
    const outbound = createWebhookOutbound({
      config: webhookConfigSchema.parse({ endpoints: { ops: { url: 'https://example.test/hook' } } }),
      fetchImpl,
    })

    await outbound.send(message, context)
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty(SIGNATURE_HEADER)
  })

  it('respects a caller-supplied signature header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }))
    const outbound = createWebhookOutbound({
      config: webhookConfigSchema.parse({
        endpoints: { ops: { url: 'https://example.test/hook', secret: 's', headers: { [SIGNATURE_HEADER]: 'precomputed' } } },
      }),
      fetchImpl,
    })

    await outbound.send(message, context)
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ [SIGNATURE_HEADER]: 'precomputed' })
  })

  it('selects the endpoint named by the route target', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }))
    const outbound = createWebhookOutbound({
      config: webhookConfigSchema.parse({
        endpoints: {
          a: { url: 'https://example.test/a' },
          b: { url: 'https://example.test/b' },
        },
      }),
      fetchImpl,
    })

    await outbound.send(message, { ...context, target: { name: 'b' } })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.test/b')
  })

  it.each([[500, true], [429, true], [400, false], [404, false]])(
    'maps HTTP %i to retryable=%s',
    async (status, retryable) => {
      const outbound = createWebhookOutbound({
        config: webhookConfigSchema.parse({ endpoints: { ops: { url: 'https://example.test/hook' } } }),
        fetchImpl: vi.fn<typeof fetch>(async () => new Response('', { status })),
      })

      await expect(outbound.send(message, context))
        .resolves
        .toEqual({ ok: false, detail: `HTTP ${status}`, retryable })
    },
  )

  it('reports a transport failure as retryable', async () => {
    const outbound = createWebhookOutbound({
      config: webhookConfigSchema.parse({ endpoints: { ops: { url: 'https://example.test/hook' } } }),
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new Error('socket hang up')
      }),
    })

    await expect(outbound.send(message, context))
      .resolves
      .toEqual({ ok: false, detail: 'socket hang up', retryable: true })
  })

  it('times out a hung endpoint', async () => {
    const outbound = createWebhookOutbound({
      config: webhookConfigSchema.parse({ endpoints: { ops: { url: 'https://example.test/hook' } } }),
      timeoutMs: 5,
      fetchImpl: vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })),
    })

    await expect(outbound.send(message, context))
      .resolves
      .toMatchObject({ ok: false, retryable: true })
  })

  it('sends against a real loopback server', async () => {
    const received: { body: string, signature?: string | string[] }[] = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        received.push({
          body: Buffer.concat(chunks).toString('utf-8'),
          signature: request.headers[SIGNATURE_HEADER],
        })
        response.writeHead(202).end()
      })
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    const outbound = createWebhookOutbound({
      config: webhookConfigSchema.parse({
        endpoints: { local: { url: `http://127.0.0.1:${port}/hook`, secret: 's3cret' } },
      }),
    })

    await expect(outbound.send(message, context))
      .resolves
      .toEqual({ ok: true, detail: 'HTTP 202' })

    expect(received).toHaveLength(1)
    expect(received[0]?.body).toBe(JSON.stringify(toPayload(message)))
    expect(received[0]?.signature).toBe(signPayload('s3cret', received[0]?.body ?? ''))
  })
})
