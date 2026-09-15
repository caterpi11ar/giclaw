import type { AppConfig } from '../config/schema.js'
import type { Gateway } from '../gateway/gateway.js'
import type { RunResult } from '../tasks/task-runner.js'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../config/schema.js'
import { logger } from '../utils/logger.js'
import {
  bootstrapPlugins,
  createPluginHost,
  createPluginRuntime,
  discoverAllPlugins,
} from './bootstrap.js'
import * as discovery from './discovery.js'
import { NotificationOutbox } from './outbox.js'

function createConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return appConfigSchema.parse(overrides)
}

interface FakeGateway {
  gateway: Gateway
  state: EventEmitter
}

function createGateway(): FakeGateway {
  const state = new EventEmitter()
  const gateway = {
    state,
    getSnapshot: vi.fn(() => ({ runId: 'run-1' })),
    getRunHistory: vi.fn(async () => [{ runId: 'run-1' }]),
    enqueueRun: vi.fn(() => ({ accepted: true })),
    resolveRoutine: vi.fn(() => ['welkin-moon']),
  } as unknown as Gateway
  return { gateway, state }
}

const runResult: RunResult = {
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
  completedAt: new Date('2026-01-01T00:01:00.000Z'),
  results: [
    {
      taskId: 'welkin-moon',
      success: true,
      message: 'ok',
      durationMs: 1,
      completedAt: new Date('2026-01-01T00:00:30.000Z'),
    },
  ],
}

describe('createPluginRuntime', () => {
  it('forwards every gateway call and tags runs as extension triggers', async () => {
    const { gateway } = createGateway()
    const runtime = createPluginRuntime(gateway)

    expect(runtime.gateway.getSnapshot()).toEqual({ runId: 'run-1' })
    await expect(runtime.gateway.getRunHistory(5)).resolves.toEqual([{ runId: 'run-1' }])
    expect(runtime.gateway.enqueueRun(['welkin-moon'])).toEqual({ accepted: true })
    expect(runtime.gateway.resolveRoutine('daily')).toEqual(['welkin-moon'])

    expect(gateway.getRunHistory).toHaveBeenCalledWith(5)
    expect(gateway.enqueueRun).toHaveBeenCalledWith('extension', ['welkin-moon'])
    expect(gateway.resolveRoutine).toHaveBeenCalledWith('daily')
  })
})

describe('discoverAllPlugins', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'giclaw-bootstrap-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('includes every bundled plugin', async () => {
    const plugins = await discoverAllPlugins(createConfig())

    expect(plugins.map(plugin => plugin.manifest.id)).toEqual(['webhook', 'feishu', 'smtp', 'imap'])
    expect(plugins.every(plugin => plugin.bundled)).toBe(true)
  })

  it('appends external plugins after the bundled ones', async () => {
    vi.spyOn(discovery, 'discoverExternalPlugins').mockResolvedValue([
      { manifest: { id: 'extra', name: 'Extra' }, definition: { id: 'extra' }, source: directory, bundled: false },
    ])

    const plugins = await discoverAllPlugins(createConfig())

    expect(plugins.map(plugin => plugin.manifest.id)).toEqual(['webhook', 'feishu', 'smtp', 'imap', 'extra'])
  })

  it('drops an external plugin that shadows a bundled id', async () => {
    vi.spyOn(discovery, 'discoverExternalPlugins').mockResolvedValue([
      { manifest: { id: 'webhook', name: 'Fake' }, definition: { id: 'webhook' }, source: directory, bundled: false },
      { manifest: { id: 'extra', name: 'Extra' }, definition: { id: 'extra' }, source: directory, bundled: false },
    ])

    const plugins = await discoverAllPlugins(createConfig())

    expect(plugins.map(plugin => plugin.manifest.id)).toEqual(['webhook', 'feishu', 'smtp', 'imap', 'extra'])
    expect(plugins[0]?.bundled).toBe(true)
  })
})

describe('createPluginHost', () => {
  it('binds discovered plugins to the supplied gateway', async () => {
    const { gateway } = createGateway()
    const host = await createPluginHost(createConfig({ plugins: { enabled: ['webhook'] } }), gateway)

    expect(host.getStatus().map(entry => entry.id)).toEqual(['webhook', 'feishu', 'smtp', 'imap'])
    await host.load()
    expect(host.capabilities.getChannel('webhook')).toBeDefined()
  })
})

describe('bootstrapPlugins', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads plugins, starts services and bridges run events', async () => {
    const { gateway, state } = createGateway()
    const config = createConfig({
      plugins: {
        enabled: ['webhook'],
        entries: { webhook: { config: { endpoints: { ops: { url: 'https://example.test/hook' } } } } },
      },
      notifications: { on: ['run:complete', 'run:error'], routes: [{ channel: 'webhook', target: 'ops' }] },
    })

    const handle = await bootstrapPlugins(config, gateway)
    const dispatchSafe = vi.spyOn(handle.dispatcher, 'dispatchSafe')

    state.emit('run:start', 'run-1', 'manual')
    state.emit('run:complete', 'run-1', runResult)

    expect(dispatchSafe).toHaveBeenCalledOnce()
    const message = dispatchSafe.mock.calls[0]?.[0]
    expect(message?.trigger).toBe('manual')
    expect(message?.runId).toBe('run-1')

    await handle.shutdown()
    expect(state.listenerCount('run:complete')).toBe(0)
  })

  it('defaults to the cron trigger when no start event was seen', async () => {
    const { gateway, state } = createGateway()
    const handle = await bootstrapPlugins(createConfig({ notifications: { routes: [] } }), gateway)
    const dispatchSafe = vi.spyOn(handle.dispatcher, 'dispatchSafe')

    state.emit('run:complete', 'run-9', runResult)

    expect(dispatchSafe.mock.calls[0]?.[0]?.trigger).toBe('cron')

    await handle.shutdown()
  })

  it('reports run errors using the recorded trigger', async () => {
    const { gateway, state } = createGateway()
    const handle = await bootstrapPlugins(createConfig(), gateway)
    const dispatchSafe = vi.spyOn(handle.dispatcher, 'dispatchSafe')

    state.emit('run:start', 'run-2', 'api')
    state.emit('run:error', 'run-2', new Error('crashed'))

    const message = dispatchSafe.mock.calls[0]?.[0]
    expect(message?.title).toBe('Giclaw 运行失败')
    expect(message?.trigger).toBe('api')

    await handle.shutdown()
  })

  it('does not dispatch when the event is not enabled', async () => {
    const { gateway, state } = createGateway()
    const handle = await bootstrapPlugins(createConfig({ notifications: { on: [] } }), gateway)
    const dispatchSafe = vi.spyOn(handle.dispatcher, 'dispatchSafe')

    state.emit('run:complete', 'run-3', runResult)
    state.emit('run:error', 'run-3', new Error('also ignored'))

    expect(dispatchSafe).not.toHaveBeenCalled()

    await handle.shutdown()
  })

  it('warns about enabled plugins that are not installed', async () => {
    const { gateway } = createGateway()
    const handle = await bootstrapPlugins(createConfig({ plugins: { enabled: ['ghost'] } }), gateway)

    await handle.shutdown()
    expect(handle.host.getStatus().map(entry => entry.id)).toEqual(['webhook', 'feishu', 'smtp', 'imap'])
    expect(handle.host.getStatus().every(entry => !entry.loaded)).toBe(true)
  })

  it('warns when a plugin service fails to start', async () => {
    const { gateway } = createGateway()
    vi.spyOn(discovery, 'discoverExternalPlugins').mockResolvedValue([
      {
        manifest: { id: 'flaky', name: 'Flaky' },
        definition: {
          id: 'flaky',
          register: (api) => {
            api.registerService({
              id: 'watch',
              start: () => {
                throw new Error('nope')
              },
            })
          },
        },
        source: 'external',
        bundled: false,
      },
    ])

    const handle = await bootstrapPlugins(createConfig({ plugins: { enabled: ['flaky'] } }), gateway)

    await handle.shutdown()
  })

  it('clears recorded triggers on shutdown', async () => {
    const { gateway, state } = createGateway()
    const handle = await bootstrapPlugins(createConfig(), gateway)
    const dispatchSafe = vi.spyOn(handle.dispatcher, 'dispatchSafe')

    state.emit('run:start', 'run-4', 'manual')
    await handle.shutdown()
    state.emit('run:complete', 'run-4', runResult)

    expect(dispatchSafe).not.toHaveBeenCalled()
  })

  describe('startup redelivery', () => {
    /** The outbox the dispatcher will pick up, with only what a test needs. */
    function useOutbox(overrides: Partial<Record<'list' | 'remove' | 'recordFailure' | 'size', unknown>>): {
      remove: ReturnType<typeof vi.fn>
      recordFailure: ReturnType<typeof vi.fn>
    } {
      const remove = vi.fn(async () => true)
      const recordFailure = vi.fn(async () => 'retrying' as const)
      vi.spyOn(NotificationOutbox, 'create').mockReturnValue({
        list: async () => [],
        remove,
        recordFailure,
        size: async () => 0,
        ...overrides,
      } as unknown as NotificationOutbox)
      return { remove, recordFailure }
    }

    it('logs what a failed replay left behind', async () => {
      const warn = vi.spyOn(logger, 'warn')
      const { recordFailure } = useOutbox({
        list: async () => [
          {
            id: 'id-1',
            channel: 'ghost',
            message: { level: 'success', title: 't', body: 'b', runId: 'run-7', trigger: 'cron', occurredAt: '2026-01-01T00:00:00.000Z', results: [] },
            attempts: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        size: async () => 3,
      })
      const { gateway } = createGateway()

      const handle = await bootstrapPlugins(createConfig({ notifications: { routes: [{ channel: 'ghost' }] } }), gateway)

      await vi.waitFor(() => expect(recordFailure).toHaveBeenCalledWith('id-1', 'Channel "ghost" is not registered'))
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
        '3 notification(s) could not be redelivered and stay queued',
      ))

      await handle.shutdown()
    })

    it('reports a replay that could not run at all', async () => {
      const warn = vi.spyOn(logger, 'warn')
      useOutbox({ list: async () => {
        throw new Error('disk unreadable')
      } })
      const { gateway } = createGateway()

      const handle = await bootstrapPlugins(createConfig(), gateway)

      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
        'Notification redelivery failed',
        expect.objectContaining({ message: 'disk unreadable' }),
      ))

      await handle.shutdown()
    })
  })
})
