import type { AppConfig } from '../../config/schema.js'
import type { PluginApi, PluginHttpResponse, PluginRuntime } from '../../plugins/types.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../../config/schema.js'
import { PluginCapabilities } from '../../plugins/capabilities.js'
import { parsePluginManifest, readPluginManifest } from '../../plugins/manifest.js'
import definition, { manifestPath } from './index.js'
import { webhookPluginConfig } from './src/config.js'
import { signPayload } from './src/signature.js'

const config: AppConfig = appConfigSchema.parse({})

function createRuntime(): PluginRuntime {
  return {
    gateway: {
      getSnapshot: vi.fn(() => ({ status: 'idle' })),
      getRunHistory: vi.fn(async () => []),
      enqueueRun: vi.fn(async () => ({ results: [] })),
      resolveRoutine: vi.fn(() => null),
    },
  } as unknown as PluginRuntime
}

function createApi(
  pluginConfig: Record<string, unknown>,
  registrationMode: 'full' | 'metadata' = 'full',
): { api: PluginApi, capabilities: PluginCapabilities, logger: PluginApi['logger'] } {
  const capabilities = new PluginCapabilities()
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const api: PluginApi = {
    registrationMode,
    pluginConfig,
    config,
    logger,
    runtime: createRuntime(),
    registerChannel: channel => capabilities.registerChannel('webhook', channel),
    registerService: service => capabilities.registerService('webhook', service),
    registerHttpRoute: route => capabilities.registerHttpRoute('webhook', route),
    registerTool: tool => capabilities.registerTool('webhook', tool),
  }
  return { api, capabilities, logger }
}

describe('webhook plugin entry', () => {
  it('points at a manifest that resolves and parses', async () => {
    expect(manifestPath.endsWith('giclaw.plugin.json')).toBe(true)
    const manifest = await readPluginManifest(manifestPath)

    expect(manifest.id).toBe('webhook')
    expect(manifest.channels).toEqual(['webhook'])
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest)
  })

  it('declares the same id as its definition', () => {
    expect(parsePluginManifest({ id: 'webhook', name: 'Webhook' }).id).toBe(definition.id)
  })

  it('always registers the outbound channel', () => {
    const { api, capabilities } = createApi({ endpoints: {} })
    definition.register?.(api)

    expect(capabilities.getChannel('webhook')?.meta.label).toBe('Webhook')
    expect(capabilities.listRoutes()).toEqual([])
  })

  it('registers an inbound route when one is configured', () => {
    const { api, capabilities, logger } = createApi(webhookPluginConfig.parse({
      endpoints: {},
      inbound: { path: '/api/ext/webhook', secret: 's3cret' },
    }))
    definition.register?.(api)

    const route = capabilities.listRoutes()[0]?.route
    expect(route).toMatchObject({ path: '/api/ext/webhook', method: 'POST', auth: 'plugin', match: 'exact' })
    expect(logger.info).toHaveBeenCalledWith('Inbound webhook listening on /api/ext/webhook')
  })

  it('registers nothing but metadata outside full mode', () => {
    const { api, capabilities } = createApi({ endpoints: {}, inbound: { path: '/x', secret: 's' } }, 'metadata')
    definition.register?.(api)

    expect(capabilities.listChannels()).toEqual([])
    expect(capabilities.listRoutes()).toEqual([])
  })

  it('serves a signed inbound request end to end', async () => {
    const { api, capabilities } = createApi(webhookPluginConfig.parse({
      endpoints: {},
      inbound: { path: '/api/ext/webhook', secret: 's3cret' },
    }))
    definition.register?.(api)

    const handler = capabilities.listRoutes()[0]?.route.handler
    const raw = JSON.stringify({ command: 'status' })
    const response = await handler?.({
      method: 'POST',
      path: '/api/ext/webhook',
      headers: { 'x-giclaw-signature': signPayload('s3cret', raw) },
      rawBody: raw,
      query: {},
      remoteAddress: null,
    })

    expect(response?.status).toBe(200)
    expect(JSON.parse((response as PluginHttpResponse).body ?? '{}')).toMatchObject({ ok: true, command: 'status' })
  })
})

describe('webhook plugin manifest on disk', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'giclaw-webhook-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('ships the config schema section the host validates against', async () => {
    const manifest = await readPluginManifest(manifestPath)
    expect(manifest.configContracts?.secretInputs?.paths?.map(entry => entry.path)).toEqual([
      'endpoints.*.secret',
      'inbound.secret',
    ])
    expect(manifest.uiHints?.['inbound.secret']?.sensitive).toBe(true)
    expect(manifest.activation?.onStartup).toBe(true)
    expect(manifest.enabledByDefault).toBe(false)
  })
})
