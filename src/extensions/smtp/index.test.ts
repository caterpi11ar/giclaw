import type { PluginApi } from '../../plugin-sdk/index.js'
import { describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../../config/schema.js'
import definition, { manifestPath } from './index.js'
import { smtpPluginConfig } from './src/config.js'

function createApi(mode: PluginApi['registrationMode'], pluginConfig: Record<string, unknown> = {}) {
  const channels: unknown[] = []
  const api: PluginApi = {
    registrationMode: mode,
    pluginConfig,
    config: appConfigSchema.parse({}),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: { gateway: {
      getSnapshot: vi.fn(),
      getRunHistory: vi.fn(),
      enqueueRun: vi.fn(),
      resolveRoutine: vi.fn(),
    } } as unknown as PluginApi['runtime'],
    registerChannel: channel => void channels.push(channel),
    registerService: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerTool: vi.fn(),
  }
  return { api, channels }
}

describe('smtp plugin entry', () => {
  it('declares its identity and config parser', () => {
    expect(definition.id).toBe('smtp')
    expect(definition.name).toBe('Email (SMTP)')
    expect(definition.version).toBe('0.1.0')
    expect(definition.configSchema).toBe(smtpPluginConfig)
    expect(definition.description).toContain('SMTP')
  })

  it('registers a channel in full mode', () => {
    const { api, channels } = createApi('full', {
      host: 'smtp.example.com',
      from: 'giclaw@example.com',
      secure: 'implicit',
      port: 465,
    })

    definition.register?.(api)

    expect(channels).toHaveLength(1)
    const channel = channels[0] as { id: string, meta: { label: string, aliases?: string[] } }
    expect(channel.id).toBe('smtp')
    expect(channel.meta.label).toBe('Email')
    expect(channel.meta.aliases).toEqual(['mail', 'email'])
    expect(api.logger.info).toHaveBeenCalledWith('SMTP connector registered against smtp.example.com:465 (implicit)')
  })

  it('registers nothing in metadata mode', () => {
    const { api, channels } = createApi('metadata')

    definition.register?.(api)

    expect(channels).toEqual([])
  })
})

describe('smtp manifest', () => {
  it('points at the shipped manifest file and flags the unsafe TLS override', async () => {
    const { readPluginManifest } = await import('../../plugins/manifest.js')
    const manifest = await readPluginManifest(manifestPath)

    expect(manifest.id).toBe('smtp')
    expect(manifest.channels).toEqual(['smtp'])
    expect(manifest.enabledByDefault).toBe(false)
    expect(manifest.configContracts?.secretInputs?.paths.map(path => path.path)).toEqual(['password'])
    expect(manifest.configContracts?.dangerousFlags).toEqual([{ path: 'rejectUnauthorized', equals: false }])
    expect(manifest.uiHints?.rejectUnauthorized?.sensitive).toBe(true)
  })
})
