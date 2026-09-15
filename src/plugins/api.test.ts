import type { AppConfig } from '../config/schema.js'
import type { ChannelPlugin, PluginRuntime } from './types.js'
import { describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../config/schema.js'
import { createPluginApi, createPluginLogger } from './api.js'
import { PluginCapabilities } from './capabilities.js'

const config: AppConfig = appConfigSchema.parse({})

function runtime(): PluginRuntime {
  return {
    gateway: {
      getSnapshot: vi.fn(),
      getRunHistory: vi.fn(async () => []),
      enqueueRun: vi.fn(),
      resolveRoutine: vi.fn(() => null),
    },
  } as unknown as PluginRuntime
}

function channel(): ChannelPlugin {
  return { id: 'webhook', meta: { label: 'Webhook' }, outbound: { send: vi.fn(async () => ({ ok: true })) } }
}

describe('createPluginLogger', () => {
  it('prefixes every level with the plugin id', () => {
    const base = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const logger = createPluginLogger('webhook', base)

    logger.debug('d', 1)
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    expect(base.debug).toHaveBeenCalledWith('[plugin:webhook] d', 1)
    expect(base.info).toHaveBeenCalledWith('[plugin:webhook] i')
    expect(base.warn).toHaveBeenCalledWith('[plugin:webhook] w')
    expect(base.error).toHaveBeenCalledWith('[plugin:webhook] e')
  })

  it('defaults to the shared root logger', () => {
    expect(() => createPluginLogger('webhook').info('hello from test')).not.toThrow()
  })
})

describe('createPluginApi', () => {
  it('exposes configuration and runtime helpers', () => {
    const capabilities = new PluginCapabilities()
    const pluginRuntime = runtime()
    const base = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const logger = createPluginLogger('webhook', base)

    const api = createPluginApi({
      pluginId: 'webhook',
      registrationMode: 'full',
      pluginConfig: { endpoints: {} },
      config,
      logger,
      runtime: pluginRuntime,
      capabilities,
    })

    expect(api.registrationMode).toBe('full')
    expect(api.pluginConfig).toEqual({ endpoints: {} })
    expect(api.config).toBe(config)
    expect(api.logger).toBe(logger)
    expect(api.runtime).toBe(pluginRuntime)
  })

  it('routes registrations into the shared capability sink', () => {
    const capabilities = new PluginCapabilities()
    const api = createPluginApi({
      pluginId: 'webhook',
      registrationMode: 'full',
      pluginConfig: {},
      config,
      logger: createPluginLogger('webhook', { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      runtime: runtime(),
      capabilities,
    })

    api.registerChannel(channel())
    api.registerService({ id: 'svc', start: vi.fn() })
    api.registerHttpRoute({ path: '/api/ext/webhook', handler: () => ({ status: 200 }) })
    api.registerTool({ name: 'tool', description: 'tool', handler: () => null })

    expect(capabilities.listChannels()).toHaveLength(1)
    expect(capabilities.listServices()).toHaveLength(1)
    expect(capabilities.listRoutes()).toHaveLength(1)
    expect(capabilities.listTools()).toHaveLength(1)
    expect(capabilities.listChannels()[0]?.pluginId).toBe('webhook')
  })
})
