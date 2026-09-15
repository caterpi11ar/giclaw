import type { AppConfig } from '../config/schema.js'
import type { Gateway } from './gateway.js'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../config/schema.js'
import { bootstrapPlugins } from '../plugins/bootstrap.js'
import { renderDashboard } from '../tui/render.js'
import { logger } from '../utils/logger.js'
import { startWebServer } from '../web/server.js'
import { startGateway } from './lifecycle.js'

const mocks = vi.hoisted(() => ({
  gateway: {
    init: vi.fn(),
    start: vi.fn(),
    shutdown: vi.fn(),
  },
  Gateway: vi.fn(),
  webClose: vi.fn(),
  pluginShutdown: vi.fn(),
  pluginHost: { capabilities: {}, getStatus: vi.fn(() => []) },
}))

vi.mock('../plugins/bootstrap.js', () => ({
  bootstrapPlugins: vi.fn(async () => ({
    host: mocks.pluginHost,
    dispatcher: {},
    shutdown: mocks.pluginShutdown,
  })),
}))

vi.mock('./gateway.js', () => ({
  Gateway: mocks.Gateway,
}))
vi.mock('../web/server.js', () => ({ startWebServer: vi.fn() }))
vi.mock('../tui/render.js', () => ({ renderDashboard: vi.fn() }))

function createConfig(webEnabled = true): AppConfig {
  return appConfigSchema.parse({
    model: {
      name: 'model',
      baseUrl: 'https://example.test/v1',
      apiKey: 'key',
    },
    web: { enabled: webEnabled },
  })
}

describe('gateway lifecycle', () => {
  const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

  beforeEach(() => {
    mocks.Gateway.mockReturnValue(mocks.gateway as unknown as Gateway)
    mocks.gateway.init.mockResolvedValue(undefined)
    mocks.gateway.start.mockResolvedValue(undefined)
    mocks.gateway.shutdown.mockResolvedValue(undefined)
    mocks.webClose.mockResolvedValue(undefined)
    mocks.pluginShutdown.mockResolvedValue(undefined)
    vi.mocked(startWebServer).mockResolvedValue({ close: mocks.webClose })
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalTTY)
      Object.defineProperty(process.stdout, 'isTTY', originalTTY)
  })

  it('initializes optional surfaces, starts scheduling, and handles shutdown signals', async () => {
    const handlers = new Map<string, () => Promise<void>>()
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => Promise<void>) => {
      handlers.set(event, handler)
      return process
    }) as typeof process.on)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    void startGateway(createConfig())
    await vi.waitFor(() => expect(mocks.gateway.start).toHaveBeenCalledOnce())

    expect(mocks.gateway.init).toHaveBeenCalledOnce()
    expect(startWebServer).toHaveBeenCalledWith(mocks.gateway, {
      capabilities: mocks.pluginHost.capabilities,
      logger: expect.anything(),
      host: mocks.pluginHost,
    })
    expect(renderDashboard).toHaveBeenCalledWith(mocks.gateway)
    expect(handlers.has('SIGTERM')).toBe(true)
    expect(handlers.has('SIGINT')).toBe(true)

    await handlers.get('SIGTERM')?.()
    expect(mocks.gateway.shutdown).toHaveBeenCalledOnce()
    expect(mocks.webClose).toHaveBeenCalledOnce()
    expect(mocks.pluginShutdown).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('continues when optional web and TUI startup fail', async () => {
    vi.mocked(startWebServer).mockRejectedValue(new Error('web failed'))
    vi.mocked(renderDashboard).mockImplementation(() => {
      throw new Error('tui failed')
    })
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.spyOn(process, 'on').mockImplementation((() => process) as typeof process.on)

    void startGateway(createConfig())
    await vi.waitFor(() => expect(mocks.gateway.start).toHaveBeenCalledOnce())

    expect(warning).toHaveBeenCalledWith(
      'Web server not available, continuing without it',
      expect.objectContaining({ message: 'web failed' }),
    )
    expect(warning).toHaveBeenCalledWith(
      'TUI not available, continuing with log output',
      expect.objectContaining({ message: 'tui failed' }),
    )
  })

  it('skips disabled web and non-TTY dashboard startup', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
    vi.spyOn(process, 'on').mockImplementation((() => process) as typeof process.on)

    void startGateway(createConfig(false))
    await vi.waitFor(() => expect(mocks.gateway.start).toHaveBeenCalledOnce())

    expect(startWebServer).not.toHaveBeenCalled()
    expect(renderDashboard).not.toHaveBeenCalled()
  })

  it('keeps the daemon running when plugin bootstrap throws', async () => {
    vi.mocked(bootstrapPlugins).mockRejectedValueOnce(new Error('plugin discovery failed'))
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const handlers = new Map<string, () => Promise<void>>()
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => Promise<void>) => {
      handlers.set(event, handler)
      return process
    }) as typeof process.on)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    void startGateway(createConfig())
    await vi.waitFor(() => expect(mocks.gateway.start).toHaveBeenCalledOnce())

    expect(error).toHaveBeenCalledWith(
      'Plugin bootstrap failed; continuing without plugins',
      expect.objectContaining({ message: 'plugin discovery failed' }),
    )
    expect(startWebServer).toHaveBeenCalledWith(mocks.gateway, undefined)

    await handlers.get('SIGTERM')?.()

    expect(mocks.pluginShutdown).not.toHaveBeenCalled()
    expect(mocks.gateway.shutdown).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)

    vi.mocked(bootstrapPlugins).mockImplementation(async () => ({
      host: mocks.pluginHost,
      dispatcher: {},
      shutdown: mocks.pluginShutdown,
    }) as never)
  })

  it('shuts down cleanly when the web surface is disabled', async () => {
    const handlers = new Map<string, () => Promise<void>>()
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => Promise<void>) => {
      handlers.set(event, handler)
      return process
    }) as typeof process.on)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    void startGateway(createConfig(false))
    await vi.waitFor(() => expect(handlers.has('SIGTERM')).toBe(true))
    await handlers.get('SIGTERM')?.()

    expect(startWebServer).not.toHaveBeenCalled()
    expect(mocks.webClose).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('does not expose web or TUI surfaces when scheduler startup fails', async () => {
    const startupError = new Error('invalid cron timezone')
    mocks.gateway.start.mockRejectedValue(startupError)

    await expect(startGateway(createConfig())).rejects.toBe(startupError)

    expect(startWebServer).not.toHaveBeenCalled()
    expect(renderDashboard).not.toHaveBeenCalled()
    expect(mocks.webClose).not.toHaveBeenCalled()
  })

  it('deduplicates repeated shutdown signals', async () => {
    const handlers = new Map<string, () => Promise<void>>()
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => Promise<void>) => {
      handlers.set(event, handler)
      return process
    }) as typeof process.on)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    void startGateway(createConfig())
    await vi.waitFor(() => expect(handlers.has('SIGINT')).toBe(true))

    const first = handlers.get('SIGINT')?.()
    const second = handlers.get('SIGTERM')?.()
    await Promise.all([first, second])

    expect(mocks.gateway.shutdown).toHaveBeenCalledOnce()
    expect(mocks.webClose).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('exits unsuccessfully when gateway shutdown rejects', async () => {
    const handlers = new Map<string, () => Promise<void>>()
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => Promise<void>) => {
      handlers.set(event, handler)
      return process
    }) as typeof process.on)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    mocks.gateway.shutdown.mockRejectedValue(new Error('shutdown failed'))
    void startGateway(createConfig())
    await vi.waitFor(() => expect(handlers.has('SIGTERM')).toBe(true))

    await handlers.get('SIGTERM')?.()

    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits unsuccessfully when the web server cannot close', async () => {
    const handlers = new Map<string, () => Promise<void>>()
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => Promise<void>) => {
      handlers.set(event, handler)
      return process
    }) as typeof process.on)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    mocks.webClose.mockRejectedValue(new Error('web close failed'))
    void startGateway(createConfig())
    await vi.waitFor(() => expect(handlers.has('SIGTERM')).toBe(true))

    await handlers.get('SIGTERM')?.()

    expect(exit).toHaveBeenCalledWith(1)
  })

  it('bounds shutdown even when the web server close never settles', async () => {
    vi.useFakeTimers()
    const handlers = new Map<string, () => Promise<void>>()
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => Promise<void>) => {
      handlers.set(event, handler)
      return process
    }) as typeof process.on)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    mocks.webClose.mockImplementation(() => new Promise<void>(() => {}))
    void startGateway(createConfig())
    await vi.waitFor(() => expect(handlers.has('SIGINT')).toBe(true))

    const shutdown = handlers.get('SIGINT')?.()
    await vi.advanceTimersByTimeAsync(10_000)
    await shutdown

    expect(mocks.gateway.shutdown).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
  })
})
