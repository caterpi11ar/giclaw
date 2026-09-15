import type { PluginHttpRequest, PluginLogger, PluginRuntime } from '../../../plugin-sdk/index.js'
import { describe, expect, it, vi } from 'vitest'
import { webhookConfigSchema } from './config.js'
import { createWebhookInboundHandler } from './inbound.js'
import { signPayload } from './signature.js'

const SECRET = 's3cret'

function createLogger(): PluginLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function createRuntime(): PluginRuntime {
  return {
    gateway: {
      getSnapshot: vi.fn(() => ({ status: 'idle' })),
      getRunHistory: vi.fn(async () => [{ runId: 'run-1' }]),
      enqueueRun: vi.fn(async () => ({
        results: [{ taskId: 'welkin-moon', success: true, message: 'ok', durationMs: 3 }],
      })),
      resolveRoutine: vi.fn((name: string) => (name === 'daily' ? ['welkin-moon', 'claim-mail'] : null)),
    },
  } as unknown as PluginRuntime
}

function createHandler(overrides: Record<string, unknown> = {}, runtime = createRuntime()): {
  handler: ReturnType<typeof createWebhookInboundHandler>
  runtime: PluginRuntime
  logger: PluginLogger
} {
  const logger = createLogger()
  const inbound = webhookConfigSchema.parse({
    inbound: { path: '/api/ext/webhook', secret: SECRET, ...overrides },
  }).inbound!

  return {
    handler: createWebhookInboundHandler({ inbound, runtime, logger }),
    runtime,
    logger,
  }
}

function request(body: unknown, options: Partial<PluginHttpRequest> & { raw?: string } = {}): PluginHttpRequest {
  const { raw: rawOption, headers: headerOptions, ...rest } = options
  const raw = rawOption ?? (typeof body === 'string' ? body : JSON.stringify(body))
  const headers: Record<string, string | string[] | undefined> = { ...headerOptions }
  if (!Object.keys(headers).some(key => key.toLowerCase() === 'x-giclaw-signature'))
    headers['x-giclaw-signature'] = signPayload(SECRET, raw)

  return {
    method: 'POST',
    path: '/api/ext/webhook',
    ...rest,
    headers,
    rawBody: raw,
  } as PluginHttpRequest
}

function parseBody(response: { body?: string }): Record<string, unknown> {
  return JSON.parse(response.body ?? '{}') as Record<string, unknown>
}

describe('createWebhookInboundHandler', () => {
  it('rejects a non-POST request', async () => {
    const { handler } = createHandler()
    const response = await handler(request({ command: 'status' }, { method: 'GET' }))

    expect(response.status).toBe(405)
    expect(parseBody(response)).toEqual({ error: 'Method not allowed' })
  })

  it('rejects a declared oversized body', async () => {
    const { handler } = createHandler({ maxBodyBytes: 10 })
    const response = await handler(request({ command: 'status' }, { headers: { 'content-length': '999' } }))

    expect(response.status).toBe(413)
  })

  it('rejects an actually oversized body', async () => {
    const { handler } = createHandler({ maxBodyBytes: 10 })
    const response = await handler(request({ command: 'status', padding: 'x'.repeat(100) }))

    expect(response.status).toBe(413)
  })

  it('ignores a non-numeric content-length', async () => {
    const { handler } = createHandler()
    const response = await handler(request({ command: 'status' }, { headers: { 'content-length': 'abc' } }))

    expect(response.status).toBe(200)
  })

  it('rejects a bad signature and logs the remote address', async () => {
    const { handler, logger } = createHandler()
    const response = await handler(request({ command: 'status' }, {
      headers: { 'x-giclaw-signature': 'sha256=nope' },
      remoteAddress: '203.0.113.7',
    }))

    expect(response.status).toBe(401)
    expect(parseBody(response)).toEqual({ error: 'Invalid signature' })
    expect(logger.warn).toHaveBeenCalledWith(
      'Inbound webhook rejected: invalid signature (remote=203.0.113.7)',
    )
  })

  it('logs an unknown remote address', async () => {
    const { handler, logger } = createHandler()
    await handler(request({ command: 'status' }, { headers: { 'x-giclaw-signature': 'bad' } }))

    expect(logger.warn).toHaveBeenCalledWith(
      'Inbound webhook rejected: invalid signature (remote=unknown)',
    )
  })

  it('accepts a case-insensitive signature header', async () => {
    const { handler } = createHandler()
    const raw = JSON.stringify({ command: 'status' })
    const response = await handler(request({}, {
      raw,
      headers: { 'X-Giclaw-Signature': signPayload(SECRET, raw) },
    }))

    expect(response.status).toBe(200)
  })

  it('rejects a body that is not JSON', async () => {
    const { handler } = createHandler()
    const response = await handler(request({}, { raw: '{ not json' }))

    expect(response.status).toBe(400)
    expect(parseBody(response)).toEqual({ error: 'Body must be valid JSON' })
  })

  it.each([['an array', '[]'], ['null', 'null'], ['a string', '"text"']])(
    'rejects %s as the body',
    async (_label, raw) => {
      const { handler } = createHandler()
      const response = await handler(request({}, { raw }))

      expect(response.status).toBe(400)
      expect(parseBody(response)).toEqual({ error: 'Body must be a JSON object' })
    },
  )

  it('rejects an unknown or missing command', async () => {
    const { handler } = createHandler()

    expect(parseBody(await handler(request({})))).toEqual({
      error: 'command must be one of: status, history, run',
    })
    expect(parseBody(await handler(request({ command: 'drop-tables' })))).toEqual({
      error: 'command must be one of: status, history, run',
    })
  })

  it('honours the configured command allowlist', async () => {
    const { handler } = createHandler({ commands: ['status'] })
    const response = await handler(request({ command: 'history' }))

    expect(response.status).toBe(400)
    expect(parseBody(response)).toEqual({ error: 'command must be one of: status' })
  })

  it('answers status with the gateway snapshot', async () => {
    const { handler, runtime } = createHandler()
    const response = await handler(request({ command: 'status' }))

    expect(response.status).toBe(200)
    expect(parseBody(response)).toEqual({ ok: true, command: 'status', snapshot: { status: 'idle' } })
    expect(runtime.gateway.getSnapshot).toHaveBeenCalledOnce()
  })

  it('answers history with the default limit', async () => {
    const { handler, runtime } = createHandler()
    const response = await handler(request({ command: 'history' }))

    expect(parseBody(response)).toEqual({ ok: true, command: 'history', history: [{ runId: 'run-1' }] })
    expect(runtime.gateway.getRunHistory).toHaveBeenCalledWith(20)
  })

  it.each([
    [0, 400],
    [101, 400],
    [1.5, 400],
    ['many', 400],
    [1, 200],
    [100, 200],
    ['5', 200],
  ])('validates the history limit %s', async (limit, status) => {
    const { handler, runtime } = createHandler()
    const response = await handler(request({ command: 'history', limit }))

    expect(response.status).toBe(status)
    if (status === 400)
      expect(parseBody(response)).toEqual({ error: 'limit must be an integer between 1 and 100' })
    else
      expect(runtime.gateway.getRunHistory).toHaveBeenCalledWith(Number(limit))
  })

  it('runs the configured defaults when no target is supplied', async () => {
    const { handler, runtime } = createHandler()
    const response = await handler(request({ command: 'run' }))

    expect(response.status).toBe(200)
    expect(parseBody(response)).toEqual({
      ok: true,
      command: 'run',
      runId: null,
      results: [{ taskId: 'welkin-moon', success: true, message: 'ok', durationMs: 3 }],
    })
    expect(runtime.gateway.enqueueRun).toHaveBeenCalledWith(undefined)
  })

  it('resolves a named routine', async () => {
    const { handler, runtime } = createHandler()
    const response = await handler(request({ command: 'run', routine: 'daily' }))

    expect(response.status).toBe(200)
    expect(runtime.gateway.enqueueRun).toHaveBeenCalledWith(['welkin-moon', 'claim-mail'])
  })

  it('rejects an unknown or empty routine', async () => {
    const { handler } = createHandler()

    expect(parseBody(await handler(request({ command: 'run', routine: 'ghost' }))))
      .toEqual({ error: 'Unknown routine "ghost"' })
    expect(parseBody(await handler(request({ command: 'run', routine: '' }))))
      .toEqual({ error: 'routine must be a non-empty string' })
    expect(parseBody(await handler(request({ command: 'run', routine: 42 }))))
      .toEqual({ error: 'routine must be a non-empty string' })
  })

  it('accepts an explicit task list', async () => {
    const { handler, runtime } = createHandler()
    const response = await handler(request({ command: 'run', tasks: ['claim-mail', 'welkin-moon'] }))

    expect(response.status).toBe(200)
    expect(runtime.gateway.enqueueRun).toHaveBeenCalledWith(['claim-mail', 'welkin-moon'])
  })

  it.each([
    [[]],
    ['claim-mail'],
    [[42]],
    [['']],
  ])('rejects an invalid task list %j', async (tasks) => {
    const { handler, runtime } = createHandler()
    const response = await handler(request({ command: 'run', tasks }))

    expect(response.status).toBe(400)
    expect(parseBody(response)).toEqual({ error: 'tasks must be a non-empty array of task ids' })
    expect(runtime.gateway.enqueueRun).not.toHaveBeenCalled()
  })

  it('prefers the routine over an explicit task list', async () => {
    const { handler, runtime } = createHandler()
    await handler(request({ command: 'run', routine: 'daily', tasks: ['claim-mail'] }))

    expect(runtime.gateway.enqueueRun).toHaveBeenCalledWith(['welkin-moon', 'claim-mail'])
  })

  it('sanitizes task messages in the response', async () => {
    const runtime = createRuntime()
    vi.mocked(runtime.gateway.enqueueRun).mockResolvedValue({
      results: [{ taskId: 'x', success: false, message: 'y'.repeat(10_000), durationMs: 1 }],
    } as never)
    const { handler } = createHandler({}, runtime)

    const body = parseBody(await handler(request({ command: 'run' }))) as { results: { message: string }[] }

    expect(body.results[0]?.message.length).toBeLessThan(10_000)
  })

  it('reports a gateway failure as a sanitized 500', async () => {
    const runtime = createRuntime()
    vi.mocked(runtime.gateway.getSnapshot).mockImplementation(() => {
      throw new Error('gateway offline')
    })
    const { handler, logger } = createHandler({}, runtime)

    const response = await handler(request({ command: 'status' }))

    expect(response.status).toBe(500)
    expect(parseBody(response)).toEqual({ error: 'gateway offline' })
    expect(logger.warn).toHaveBeenCalledWith('Inbound webhook command "status" failed: gateway offline')
  })

  it('reports a rejected enqueue as a 500', async () => {
    const runtime = createRuntime()
    vi.mocked(runtime.gateway.enqueueRun).mockRejectedValue(new Error('queue full'))
    const { handler } = createHandler({}, runtime)

    const response = await handler(request({ command: 'run' }))

    expect(response.status).toBe(500)
    expect(parseBody(response)).toEqual({ error: 'queue full' })
  })

  it('logs the resolved run description', async () => {
    const { handler, logger } = createHandler()
    await handler(request({ command: 'run', tasks: ['claim-mail'] }))
    await handler(request({ command: 'run' }))

    expect(logger.info).toHaveBeenCalledWith('Inbound webhook triggering run: tasks=claim-mail')
    expect(logger.info).toHaveBeenCalledWith('Inbound webhook triggering run: configured defaults')
  })

  it('returns JSON content type on every response', async () => {
    const { handler } = createHandler()
    const response = await handler(request({ command: 'status' }))
    expect(response.headers?.['content-type']).toBe('application/json')
  })
})
