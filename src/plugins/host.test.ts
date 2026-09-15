import type { AppConfig } from '../config/schema.js'
import type { DiscoveredPlugin, PluginDefinition, PluginRuntime } from './types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../config/schema.js'
import { PluginHost } from './host.js'

function createConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return appConfigSchema.parse(overrides)
}

function createRuntime(): PluginRuntime {
  return {
    gateway: {
      getSnapshot: vi.fn(),
      getRunHistory: vi.fn(async () => []),
      enqueueRun: vi.fn(),
      resolveRoutine: vi.fn(() => null),
    },
  } as unknown as PluginRuntime
}

function plugin(
  id: string,
  definition: Partial<PluginDefinition> = {},
  overrides: Partial<DiscoveredPlugin> = {},
): DiscoveredPlugin {
  return {
    manifest: { id, name: `Plugin ${id}` },
    definition: { id, ...definition },
    source: `/plugins/${id}`,
    bundled: true,
    ...overrides,
  }
}

describe('pluginHost', () => {
  let envKey: string

  beforeEach(() => {
    envKey = `GICLAW_TEST_SECRET_${Math.random().toString(36).slice(2)}`
    process.env[envKey] = 'resolved-secret'
  })

  afterEach(() => {
    delete process.env[envKey]
  })

  it('returns enabled ids without duplicates', () => {
    const host = new PluginHost({
      config: createConfig({ plugins: { enabled: ['a', 'a', 'b'] } }),
      plugins: [],
      runtime: createRuntime(),
    })

    expect(host.getEnabledIds()).toEqual(['a', 'b'])
  })

  it('loads a plugin and exposes its registrations', async () => {
    const register = vi.fn((api) => {
      api.registerChannel({ id: 'webhook', meta: { label: 'Webhook' }, outbound: { send: vi.fn() } })
      api.registerService({ id: 'watcher', start: vi.fn() })
      api.registerHttpRoute({ path: '/api/ext/webhook', handler: () => ({ status: 200 }) })
      api.registerTool({ name: 'send', description: 'send', handler: () => null })
    })

    const host = new PluginHost({
      config: createConfig({ plugins: { enabled: ['webhook'] } }),
      plugins: [plugin('webhook', { register })],
      runtime: createRuntime(),
    })

    const report = await host.load()

    expect(report).toEqual({ loaded: ['webhook'], failed: [], unknown: [] })
    expect(host.getStatus()).toEqual([
      {
        id: 'webhook',
        name: 'Plugin webhook',
        enabled: true,
        loaded: true,
        bundled: true,
        channels: ['webhook'],
        services: ['watcher'],
        routes: ['POST /api/ext/webhook'],
        tools: ['send'],
      },
    ])
    expect(register).toHaveBeenCalledOnce()
  })

  it('resolves secret references and validates the plugin config', async () => {
    const seen: unknown[] = []
    const host = new PluginHost({
      config: createConfig({
        plugins: {
          enabled: ['webhook'],
          entries: { webhook: { config: { secret: `env:${envKey}`, nested: { value: `env:${envKey}` } } } },
        },
      }),
      plugins: [
        plugin('webhook', {
          configSchema: {
            parse: (input) => {
              seen.push(input)
              return { ...(input as Record<string, unknown>), parsed: true }
            },
          },
          register: (api) => {
            seen.push(api.pluginConfig)
          },
        }),
      ],
      runtime: createRuntime(),
    })

    await host.load()

    expect(seen[0]).toEqual({ secret: 'resolved-secret', nested: { value: 'resolved-secret' } })
    expect(seen[1]).toEqual({ secret: 'resolved-secret', nested: { value: 'resolved-secret' }, parsed: true })
  })

  it('rejects a config schema that does not return an object', async () => {
    const host = new PluginHost({
      config: createConfig({ plugins: { enabled: ['webhook'] } }),
      plugins: [
        plugin('webhook', {
          configSchema: { parse: () => 'not-an-object' as unknown as Record<string, unknown> },
          register: vi.fn(),
        }),
      ],
      runtime: createRuntime(),
    })

    const report = await host.load()

    expect(report.failed).toEqual([
      { id: 'webhook', detail: 'configSchema.parse must return an object' },
    ])
    expect(host.getStatus()[0]?.loaded).toBe(false)
    expect(host.getStatus()[0]?.failure).toBe('configSchema.parse must return an object')
    expect(host.getFailure('webhook')).toBe('configSchema.parse must return an object')
  })

  it.each([
    ['an array', []],
    ['null', null],
  ])('rejects a config schema that returns %s', async (_label, value) => {
    const host = new PluginHost({
      config: createConfig({ plugins: { enabled: ['webhook'] } }),
      plugins: [
        plugin('webhook', {
          configSchema: { parse: () => value as unknown as Record<string, unknown> },
        }),
      ],
      runtime: createRuntime(),
    })

    expect((await host.load()).failed).toHaveLength(1)
  })

  it('passes through an empty config when no entry is declared', async () => {
    const seen: unknown[] = []
    const host = new PluginHost({
      config: createConfig({ plugins: { enabled: ['webhook'] } }),
      plugins: [
        plugin('webhook', {
          register: (api) => {
            seen.push(api.pluginConfig)
          },
        }),
      ],
      runtime: createRuntime(),
    })

    await host.load()
    expect(seen[0]).toEqual({})
  })

  it('keeps the raw config when the plugin declares no schema', async () => {
    const seen: unknown[] = []
    const host = new PluginHost({
      config: createConfig({
        plugins: { enabled: ['webhook'], entries: { webhook: { config: { url: 'https://example.test' } } } },
      }),
      plugins: [
        plugin('webhook', {
          register: (api) => {
            seen.push(api.pluginConfig)
          },
        }),
      ],
      runtime: createRuntime(),
    })

    await host.load()
    expect(seen[0]).toEqual({ url: 'https://example.test' })
  })

  it('reports enabled plugins that are not installed', async () => {
    const host = new PluginHost({
      config: createConfig({ plugins: { enabled: ['missing'] } }),
      plugins: [],
      runtime: createRuntime(),
    })

    const report = await host.load()

    expect(report.unknown).toEqual(['missing'])
    expect(report.loaded).toEqual([])
  })

  it('rolls back registrations when a plugin throws during register', async () => {
    const host = new PluginHost({
      config: createConfig({ plugins: { enabled: ['broken'] } }),
      plugins: [
        plugin('broken', {
          register: (api) => {
            api.registerChannel({ id: 'ghost', meta: { label: 'Ghost' }, outbound: { send: vi.fn() } })
            throw new Error('register exploded')
          },
        }),
      ],
      runtime: createRuntime(),
    })

    const report = await host.load()

    expect(report.failed).toEqual([{ id: 'broken', detail: 'register exploded' }])
    expect(host.capabilities.listChannels()).toEqual([])
    expect(host.getFailure('broken')).toBe('register exploded')
  })

  it('re-registers cleanly on a second load', async () => {
    const host = new PluginHost({
      config: createConfig({ plugins: { enabled: ['webhook'] } }),
      plugins: [
        plugin('webhook', {
          register: (api) => {
            api.registerChannel({ id: 'webhook', meta: { label: 'Webhook' }, outbound: { send: vi.fn() } })
          },
        }),
      ],
      runtime: createRuntime(),
    })

    await host.load()
    await host.load()

    expect(host.capabilities.listChannels()).toHaveLength(1)
  })

  it('supports metadata-only registration mode', async () => {
    const register = vi.fn()
    const host = new PluginHost({
      config: createConfig({ plugins: { enabled: ['webhook'] } }),
      plugins: [plugin('webhook', { register })],
      runtime: createRuntime(),
    })

    await host.load('metadata')

    const api = register.mock.calls[0]?.[0] as { registrationMode: string }
    expect(api.registrationMode).toBe('metadata')
  })

  it('accepts a plugin without a register function', async () => {
    const host = new PluginHost({
      config: createConfig({ plugins: { enabled: ['declarative'] } }),
      plugins: [plugin('declarative', {})],
      runtime: createRuntime(),
    })

    expect((await host.load()).loaded).toEqual(['declarative'])
  })

  it('starts services once and shuts them down', async () => {
    const start = vi.fn()
    const stop = vi.fn()
    const host = new PluginHost({
      config: createConfig({ plugins: { enabled: ['webhook'] } }),
      plugins: [
        plugin('webhook', {
          register: (api) => {
            api.registerService({ id: 'watcher', start, stop })
          },
        }),
      ],
      runtime: createRuntime(),
    })

    await host.load()

    await expect(host.startServices()).resolves.toEqual([
      { id: 'watcher', pluginId: 'webhook', ok: true },
    ])
    await expect(host.startServices()).resolves.toEqual([])
    expect(start).toHaveBeenCalledOnce()

    await host.shutdown()
    expect(stop).toHaveBeenCalledOnce()

    await expect(host.startServices()).resolves.toEqual([
      { id: 'watcher', pluginId: 'webhook', ok: true },
    ])
  })

  it('reports a service that fails to start without failing the host', async () => {
    const host = new PluginHost({
      config: createConfig({ plugins: { enabled: ['webhook'] } }),
      plugins: [
        plugin('webhook', {
          register: (api) => {
            api.registerService({
              id: 'watcher',
              start: () => {
                throw new Error('cannot connect')
              },
            })
          },
        }),
      ],
      runtime: createRuntime(),
    })

    await host.load()

    await expect(host.startServices()).resolves.toEqual([
      { id: 'watcher', pluginId: 'webhook', ok: false, detail: 'cannot connect' },
    ])
  })

  it('reports the manifest description and version when present', async () => {
    const host = new PluginHost({
      config: createConfig(),
      plugins: [
        plugin('webhook', {}, {
          manifest: { id: 'webhook', name: 'Webhook', description: 'Posts notifications', version: '1.0.0' },
          bundled: false,
        }),
      ],
      runtime: createRuntime(),
    })

    expect(host.getStatus()).toEqual([
      {
        id: 'webhook',
        name: 'Webhook',
        description: 'Posts notifications',
        version: '1.0.0',
        enabled: false,
        loaded: false,
        bundled: false,
        channels: [],
        services: [],
        routes: [],
        tools: [],
      },
    ])
  })

  it('reports routes that omit an explicit method', async () => {
    const host = new PluginHost({
      config: createConfig({ plugins: { enabled: ['webhook'] } }),
      plugins: [
        plugin('webhook', {
          register: (api) => {
            api.registerHttpRoute({ path: '/api/ext/webhook', handler: () => ({ status: 200 }) })
          },
        }),
      ],
      runtime: createRuntime(),
    })

    await host.load()

    expect(host.getStatus()[0]?.routes).toEqual(['POST /api/ext/webhook'])
  })
})
