import type { PluginApi, PluginService, PluginServiceContext } from '../../plugin-sdk/index.js'
import type { ImapConfig } from './src/config.js'
import { describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../../config/schema.js'
import definition, { manifestPath } from './index.js'
import { imapPluginConfig } from './src/config.js'
import { ImapStateStore } from './src/state.js'
import { ImapAccountWatcher } from './src/watcher.js'

function createApi(mode: PluginApi['registrationMode'], pluginConfig: Record<string, unknown> = {}) {
  const services: PluginService[] = []
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
    registerChannel: vi.fn(),
    registerService: service => void services.push(service),
    registerHttpRoute: vi.fn(),
    registerTool: vi.fn(),
  }
  return { api, services }
}

function context(signal = new AbortController().signal): PluginServiceContext {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal,
  }
}

// Loopback is the only host where the schema allows STARTTLS without implicit
// TLS; the watchers themselves are stubbed so no socket is ever opened.
const account = {
  host: '127.0.0.1',
  port: 1,
  secure: false,
  user: 'ops',
  password: 'secret',
  allowedSenders: ['ops@example.com'],
}

describe('imap plugin entry', () => {
  it('declares its identity and config parser', () => {
    expect(definition.id).toBe('imap')
    expect(definition.name).toBe('Email (IMAP)')
    expect(definition.version).toBe('0.1.0')
    expect(definition.configSchema).toBe(imapPluginConfig)
    expect(definition.description).toContain('IMAP')
  })

  it('registers the watcher service in full mode', () => {
    const { api, services } = createApi('full', imapPluginConfig.parse({ accounts: { main: account } }))

    definition.register?.(api)

    expect(services.map(service => service.id)).toEqual(['imap-watch'])
  })

  it('registers nothing in metadata mode', () => {
    const { api, services } = createApi('metadata', imapPluginConfig.parse({ accounts: { main: account } }))

    definition.register?.(api)

    expect(services).toEqual([])
  })

  it('warns and stops when no mailbox is configured', () => {
    const { api, services } = createApi('full', imapPluginConfig.parse({}))

    definition.register?.(api)

    expect(services).toEqual([])
    expect(api.logger.warn).toHaveBeenCalledWith('IMAP connector is enabled but no mailbox accounts are configured')
  })

  it('starts one watcher per account and stops them together', async () => {
    const started = vi.spyOn(ImapAccountWatcher.prototype, 'start').mockImplementation(() => {})
    const stopped = vi.spyOn(ImapAccountWatcher.prototype, 'stop').mockResolvedValue()
    const { api, services } = createApi('full', imapPluginConfig.parse({
      accounts: { beta: account, alpha: account },
    }))
    definition.register?.(api)

    const service = services[0]!
    const ctx = context()
    await service.start(ctx)

    expect(started).toHaveBeenCalledTimes(2)
    expect(ctx.logger.info).toHaveBeenCalledWith('IMAP connector watching 2 mailbox(es): alpha, beta')

    await service.stop?.()

    expect(stopped).toHaveBeenCalledTimes(2)
    started.mockRestore()
    stopped.mockRestore()
  })

  it('stops cleanly when start was never awaited', async () => {
    const started = vi.spyOn(ImapAccountWatcher.prototype, 'start').mockImplementation(() => {})
    const stopped = vi.spyOn(ImapAccountWatcher.prototype, 'stop').mockResolvedValue()
    const { api, services } = createApi('full', imapPluginConfig.parse({ accounts: { main: account } }))
    definition.register?.(api)

    await services[0]!.stop?.()

    expect(stopped).not.toHaveBeenCalled()
    started.mockRestore()
    stopped.mockRestore()
  })

  it('drops a start that a stop superseded before the state file opened', async () => {
    const started = vi.spyOn(ImapAccountWatcher.prototype, 'start').mockImplementation(() => {})
    const stopped = vi.spyOn(ImapAccountWatcher.prototype, 'stop').mockResolvedValue()
    let release!: (store: ImapStateStore) => void
    const opening = new Promise<ImapStateStore>((resolve) => {
      release = resolve
    })
    const open = vi.spyOn(ImapStateStore, 'open').mockReturnValue(opening)
    const { api, services } = createApi('full', imapPluginConfig.parse({ accounts: { main: account } }))
    definition.register?.(api)

    const service = services[0]!
    const starting = service.start(context())
    await vi.waitFor(() => {
      expect(open).toHaveBeenCalledTimes(1)
    })

    await expect(service.stop?.()).resolves.toBeUndefined()
    release({} as ImapStateStore)

    await expect(starting).resolves.toBeUndefined()
    expect(started).not.toHaveBeenCalled()
    expect(stopped).not.toHaveBeenCalled()
    started.mockRestore()
    stopped.mockRestore()
    open.mockRestore()
  })

  it('drops a start that a newer start superseded', async () => {
    const started = vi.spyOn(ImapAccountWatcher.prototype, 'start').mockImplementation(() => {})
    const stopped = vi.spyOn(ImapAccountWatcher.prototype, 'stop').mockResolvedValue()
    const open = vi.spyOn(ImapStateStore, 'open').mockResolvedValue({} as ImapStateStore)
    const { api, services } = createApi('full', imapPluginConfig.parse({ accounts: { main: account } }))
    definition.register?.(api)

    const service = services[0]!
    const ctx = context()
    await service.start(ctx)
    expect(started).toHaveBeenCalledTimes(1)

    // The second start is held while it retires the first generation's watcher.
    let releaseStop!: () => void
    stopped.mockReturnValueOnce(new Promise<void>((resolve) => {
      releaseStop = resolve
    }))
    const second = service.start(ctx)
    await vi.waitFor(() => {
      expect(stopped).toHaveBeenCalledTimes(1)
    })

    await service.start(ctx)
    expect(started).toHaveBeenCalledTimes(2)

    releaseStop()
    await expect(second).resolves.toBeUndefined()
    expect(started).toHaveBeenCalledTimes(2)
    started.mockRestore()
    stopped.mockRestore()
    open.mockRestore()
  })
})

describe('imap manifest', () => {
  it('points at the shipped manifest file and flags the unsafe TLS overrides', async () => {
    const { readPluginManifest } = await import('../../plugins/manifest.js')
    const manifest = await readPluginManifest(manifestPath)

    expect(manifest.id).toBe('imap')
    expect(manifest.channels).toEqual([])
    expect(manifest.enabledByDefault).toBe(false)
    expect(manifest.configContracts?.secretInputs?.paths.map(path => path.path)).toEqual(['accounts.*.password'])
    expect(manifest.configContracts?.dangerousFlags).toEqual([
      { path: 'accounts.*.rejectUnauthorized', equals: false },
      { path: 'accounts.*.secure', equals: false },
    ])
    expect(manifest.uiHints?.['accounts.*.password']?.sensitive).toBe(true)
  })

  it('masks every account password and reports the unsafe flags', async () => {
    const { findDangerousFlags, maskDeclaredSecrets } = await import('../../plugins/config-contracts.js')
    const { readPluginManifest } = await import('../../plugins/manifest.js')
    const manifest = await readPluginManifest(manifestPath)
    const config: ImapConfig = imapPluginConfig.parse({
      accounts: { main: { ...account, rejectUnauthorized: false } },
    })

    expect(maskDeclaredSecrets(config, manifest.configContracts).accounts.main?.password).toBe('***')
    expect(findDangerousFlags(config, manifest.configContracts)).toEqual([
      'accounts.*.rejectUnauthorized',
      'accounts.*.secure',
    ])
  })
})
