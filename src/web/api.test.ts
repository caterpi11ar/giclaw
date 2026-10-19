import type { Gateway } from '../gateway/gateway.js'
import type { TaskDefinition } from '../tasks/base-task.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../config/schema.js'
import { EvolveStore } from '../evolve/store.js'
import { QueueError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { registerApi } from './api.js'

function task(id: string): TaskDefinition {
  return {
    id,
    name: id,
    description: id,
    defaultEnabled: true,
    timeoutMs: 1000,
    dependsOn: [],
    execute: vi.fn(),
  }
}

describe('hTTP API', () => {
  const apps: ReturnType<typeof Fastify>[] = []
  let gateway: {
    config: ReturnType<typeof appConfigSchema.parse>
    getSnapshot: ReturnType<typeof vi.fn>
    getRunHistory: ReturnType<typeof vi.fn>
    getSkillSummaries: ReturnType<typeof vi.fn>
    getTaskRunner: ReturnType<typeof vi.fn>
    enqueueRunAccepted: ReturnType<typeof vi.fn>
  }
  let getEnabledTasks: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const config = appConfigSchema.parse({
      model: {
        name: 'gpt-5.6-sol',
        baseUrl: 'http://127.0.0.1:3002/v1',
        apiKey: 'secret-token',
      },
      queue: { maxDepth: 2 },
    })
    getEnabledTasks = vi.fn((ids: string[]) => ids.map(task))
    gateway = {
      config,
      getSnapshot: vi.fn(() => ({ running: false, queueDepth: 0 })),
      getRunHistory: vi.fn(async () => []),
      getSkillSummaries: vi.fn(() => [{ id: 'mail' }]),
      getTaskRunner: vi.fn(() => ({ getEnabledTasks })),
      enqueueRunAccepted: vi.fn(() => ({
        status: 'started',
        completion: Promise.resolve({ results: [], startedAt: new Date(), completedAt: new Date() }),
      })),
    }
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  async function app(
    plugins?: Parameters<typeof registerApi>[2],
    evolveStore?: Parameters<typeof registerApi>[3],
  ) {
    const instance = Fastify()
    apps.push(instance)
    registerApi(instance, gateway as unknown as Gateway, plugins, evolveStore)
    await instance.ready()
    return instance
  }

  it('returns an empty plugin list when no bridge is mounted', async () => {
    const instance = await app()
    const response = await instance.inject({ method: 'GET', url: '/api/plugins' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([])
  })

  it('returns plugin status through the bridge without leaking secrets', async () => {
    const status = [{ id: 'webhook', name: 'Webhook', enabled: true, loaded: true }]
    const instance = await app({
      capabilities: { getChannel: vi.fn() },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      host: { getStatus: vi.fn(() => status) },
    } as unknown as Parameters<typeof registerApi>[2])

    const response = await instance.inject({ method: 'GET', url: '/api/plugins' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(status)
  })

  it('returns status, tasks, and a masked configuration', async () => {
    const lastRun = {
      runId: 'run-1',
      trigger: 'manual',
      startedAt: 'start',
      completedAt: 'end',
      results: [],
    }
    gateway.getRunHistory.mockResolvedValue([lastRun])
    const instance = await app()

    const status = await instance.inject({ method: 'GET', url: '/api/status' })
    expect(status.json()).toMatchObject({
      running: false,
      queueDepth: 0,
      lastRun: { startedAt: 'start', completedAt: 'end', results: [] },
    })
    expect(gateway.getRunHistory).toHaveBeenCalledWith(1)

    const tasks = await instance.inject({ method: 'GET', url: '/api/tasks' })
    expect(tasks.json()).toEqual([{ id: 'mail' }])

    const config = await instance.inject({ method: 'GET', url: '/api/config' })
    expect(config.json().model.apiKey).toBe('***')
    expect(gateway.config.model.apiKey).toBe('secret-token')
  })

  it('exposes read-only evolution status and 404s unknown generations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolve-api-'))
    try {
      const store = new EvolveStore({
        evolveDir: join(root, 'evolve'),
        overrideSkillsDir: join(root, 'skills'),
      })
      await store.writeGeneration({
        genId: 'demo-1',
        skillId: 'demo',
        parentGenId: null,
        startedAt: '2026-08-07T00:00:00.000Z',
        completedAt: '2026-08-07T00:01:00.000Z',
        status: 'pending-approval',
        trigger: 'manual',
      })
      await store.setBestKnownGood({ skillId: 'demo', genId: 'demo-1', acceptedAt: 't', candidateFile: 'f' })
      await store.writePending({
        genId: 'demo-1',
        skillId: 'demo',
        candidateFile: 'f',
        createdAt: 't',
        originalOverride: null,
      })

      const instance = await app(undefined, store)
      const list = await instance.inject({ method: 'GET', url: '/api/evolve' })
      expect(list.statusCode).toBe(200)
      expect(list.json().bestKnownGood).toHaveLength(1)
      expect(list.json().pending).toHaveLength(1)
      expect(list.json().generations[0].genId).toBe('demo-1')

      const one = await instance.inject({ method: 'GET', url: '/api/evolve/demo-1' })
      expect(one.statusCode).toBe(200)
      expect(one.json().status).toBe('pending-approval')

      const missing = await instance.inject({ method: 'GET', url: '/api/evolve/nope' })
      expect(missing.statusCode).toBe(404)
      expect(missing.json()).toEqual({ error: 'Unknown generation' })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns empty status history and preserves an empty model key', async () => {
    gateway.config.model.apiKey = ''
    const instance = await app()

    const status = await instance.inject({ method: 'GET', url: '/api/status' })
    expect(status.json().lastRun).toBeNull()
    const config = await instance.inject({ method: 'GET', url: '/api/config' })
    expect(config.json().model.apiKey).toBe('')
  })

  it('uses a default history limit and validates explicit limits', async () => {
    const instance = await app()
    await instance.inject({ method: 'GET', url: '/api/history' })
    expect(gateway.getRunHistory).toHaveBeenLastCalledWith(20)

    await instance.inject({ method: 'GET', url: '/api/history?limit=5' })
    expect(gateway.getRunHistory).toHaveBeenLastCalledWith(5)

    for (const limit of ['0', '-1', '1.5', 'abc']) {
      const response = await instance.inject({ method: 'GET', url: `/api/history?limit=${limit}` })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: 'limit must be a positive integer' })
    }
  })

  it.each([
    { payload: null, error: 'Request body must be an object' },
    { payload: 1, error: 'Request body must be an object' },
    { payload: 'run', error: 'Request body must be an object' },
    { payload: [], error: 'Request body must be an object' },
    { payload: { tasks: [] }, error: 'tasks must be a non-empty array of task IDs' },
    { payload: { tasks: [''] }, error: 'tasks must be a non-empty array of task IDs' },
    { payload: { routine: 1 }, error: 'routine must be a non-empty string' },
    { payload: { tasks: ['mail'], routine: 'daily' }, error: 'Use either tasks or routine, not both' },
  ])('rejects invalid run body %#', async ({ payload, error }) => {
    const instance = await app()
    const response = await instance.inject({
      method: 'POST',
      url: '/api/run',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error })
    expect(gateway.enqueueRunAccepted).not.toHaveBeenCalled()
  })

  it('rejects unknown routines and task resolution failures', async () => {
    const instance = await app()
    const unknownRoutine = await instance.inject({
      method: 'POST',
      url: '/api/run',
      payload: { routine: 'missing' },
    })
    expect(unknownRoutine.statusCode).toBe(400)
    expect(unknownRoutine.json()).toMatchObject({
      error: 'Unknown routine "missing"',
      availableRoutines: ['daily', 'rewards', 'full'],
    })

    getEnabledTasks.mockImplementationOnce(() => {
      throw new Error('Unknown task "missing"')
    })
    const unknownTask = await instance.inject({
      method: 'POST',
      url: '/api/run',
      payload: { tasks: ['missing'] },
    })
    expect(unknownTask.statusCode).toBe(400)
    expect(unknownTask.json()).toEqual({ error: 'Unknown task "missing"' })

    getEnabledTasks.mockImplementationOnce(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain resolution failure'
    })
    const plainFailure = await instance.inject({
      method: 'POST',
      url: '/api/run',
      payload: { tasks: ['missing'] },
    })
    expect(plainFailure.statusCode).toBe(400)
    expect(plainFailure.json()).toEqual({ error: 'plain resolution failure' })
  })

  it('returns 429 without enqueuing when the queue is full', async () => {
    gateway.enqueueRunAccepted.mockImplementation(() => {
      throw new QueueError('Queue is full (2/2); run test was not enqueued')
    })
    const instance = await app()
    const response = await instance.inject({ method: 'POST', url: '/api/run', payload: { tasks: ['mail'] } })

    expect(response.statusCode).toBe(429)
    expect(response.json()).toEqual({ error: 'Queue is full (2/2)' })
    expect(gateway.enqueueRunAccepted).toHaveBeenCalledOnce()
  })

  it('returns 503 when the queue has stopped accepting work', async () => {
    gateway.enqueueRunAccepted.mockImplementation(() => {
      throw new QueueError('Queue is closed; run test was not accepted')
    })
    const instance = await app()

    const response = await instance.inject({ method: 'POST', url: '/api/run', payload: { tasks: ['mail'] } })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ error: 'Queue is not accepting work' })
  })

  it.each([
    [false, 200, 'started'],
    [true, 202, 'queued'],
  ] as const)('starts or queues a validated run (running=%s)', async (running, statusCode, status) => {
    gateway.getSnapshot.mockReturnValue({ running, queueDepth: running ? 1 : 0 })
    gateway.enqueueRunAccepted.mockReturnValue({
      status,
      completion: Promise.resolve({ results: [], startedAt: new Date(), completedAt: new Date() }),
    })
    getEnabledTasks.mockReturnValue([task('launch'), task('mail')])
    const instance = await app()
    const response = await instance.inject({
      method: 'POST',
      url: '/api/run',
      payload: { routine: 'daily' },
    })

    expect(response.statusCode).toBe(statusCode)
    expect(response.json()).toEqual({ status, tasks: ['launch', 'mail'] })
    expect(gateway.enqueueRunAccepted).toHaveBeenCalledWith('api', ['welkin-moon', 'claim-mail'])
  })

  it('uses default tasks for an empty body and logs background run failures', async () => {
    gateway.enqueueRunAccepted.mockReturnValue({
      status: 'started',
      completion: Promise.reject(new Error('background failure')),
    })
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const instance = await app()

    const response = await instance.inject({ method: 'POST', url: '/api/run' })
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(
      'API-triggered run failed',
      expect.objectContaining({ message: 'background failure' }),
    ))

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'started',
      tasks: gateway.config.tasks.enabled,
    })
    expect(getEnabledTasks).toHaveBeenCalledWith(gateway.config.tasks.enabled)
    expect(gateway.enqueueRunAccepted).toHaveBeenCalledWith('api', undefined)
  })

  it('does not misreport unexpected admission failures as accepted', async () => {
    gateway.enqueueRunAccepted.mockImplementation(() => {
      throw new Error('unexpected admission failure')
    })
    const instance = await app()

    const response = await instance.inject({ method: 'POST', url: '/api/run' })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'unexpected admission failure',
    })
  })
})
