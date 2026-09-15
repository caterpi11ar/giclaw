import type { RegisteredService } from './capabilities.js'
import type { PluginLogger, PluginService } from './types.js'
import { describe, expect, it, vi } from 'vitest'
import { SERVICE_STOPPED_DURING_STARTUP, ServiceManager } from './services.js'

function createLogger(): PluginLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function entry(id: string, overrides: Partial<PluginService> = {}, pluginId = 'test'): RegisteredService {
  return { pluginId, service: { id, start: vi.fn(), ...overrides } }
}

describe('serviceManager', () => {
  it('starts services and reports success', async () => {
    const logger = createLogger()
    const manager = new ServiceManager(logger)
    const first = entry('imap-watcher')
    const second = entry('other')

    const results = await manager.startAll([first, second])

    expect(results).toEqual([
      { id: 'imap-watcher', pluginId: 'test', ok: true },
      { id: 'other', pluginId: 'test', ok: true },
    ])
    expect(manager.isRunning('imap-watcher')).toBe(true)
    expect(manager.listRunning()).toEqual(['imap-watcher', 'other'])
    expect(manager.lastFailure('imap-watcher')).toBeUndefined()
  })

  it('hands each service a logger and an abort signal', async () => {
    const logger = createLogger()
    const manager = new ServiceManager(logger)
    const start = vi.fn()
    await manager.startAll([entry('svc', { start })])

    expect(start).toHaveBeenCalledOnce()
    const context = start.mock.calls[0]?.[0] as { logger: PluginLogger, signal: AbortSignal }
    expect(context.logger).toBe(logger)
    expect(context.signal.aborted).toBe(false)

    await manager.stopAll()
    expect(context.signal.aborted).toBe(true)
  })

  it('isolates a failing service without aborting the others', async () => {
    const logger = createLogger()
    const manager = new ServiceManager(logger)
    const healthy = entry('healthy')
    const failing = entry('failing', {
      start: () => {
        throw new Error('cannot connect')
      },
    })

    const results = await manager.startAll([failing, healthy])

    expect(results).toEqual([
      { id: 'failing', pluginId: 'test', ok: false, detail: 'cannot connect' },
      { id: 'healthy', pluginId: 'test', ok: true },
    ])
    expect(manager.isRunning('failing')).toBe(false)
    expect(manager.lastFailure('failing')).toBe('cannot connect')
    expect(logger.error).toHaveBeenCalledWith('Service failing failed to start: cannot connect')
  })

  it('reports a non-Error rejection as a string detail', async () => {
    const manager = new ServiceManager(createLogger())
    const results = await manager.startAll([
      entry('weird', { start: () => Promise.reject(new Error('nope')) }),
    ])

    expect(results[0]).toEqual({ id: 'weird', pluginId: 'test', ok: false, detail: 'nope' })
  })

  it('clears a previous failure after a successful restart', async () => {
    const manager = new ServiceManager(createLogger())
    const failing = entry('flaky', {
      start: () => {
        throw new Error('down')
      },
    })
    await manager.startAll([failing])
    expect(manager.lastFailure('flaky')).toBe('down')

    const healthy = entry('flaky')
    await manager.startAll([healthy])
    expect(manager.lastFailure('flaky')).toBeUndefined()
  })

  it('skips services that are already running', async () => {
    const manager = new ServiceManager(createLogger())
    const current = entry('svc')
    await manager.startAll([current])

    const results = await manager.startAll([current])

    expect(results).toEqual([])
    expect(current.service.start).toHaveBeenCalledOnce()
  })

  it('stops services and swallows stop failures', async () => {
    const logger = createLogger()
    const manager = new ServiceManager(logger)
    const good = entry('good', { stop: vi.fn() })
    const bad = entry('bad', {
      stop: () => {
        throw new Error('stop failed')
      },
    })
    await manager.startAll([good, bad])

    await expect(manager.stopAll()).resolves.toBeUndefined()

    expect(good.service.stop).toHaveBeenCalledOnce()
    expect(manager.listRunning()).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      'Service bad failed to stop',
      expect.objectContaining({ message: 'stop failed' }),
    )
  })

  it('supports pending stop promises and services without stop hooks', async () => {
    const manager = new ServiceManager(createLogger())
    await manager.startAll([entry('no-stop'), entry('async-stop', { stop: async () => {} })])

    await expect(manager.stopAll()).resolves.toBeUndefined()
    expect(manager.listRunning()).toEqual([])
  })

  it('waits for a service that is still starting before it stops it', async () => {
    const logger = createLogger()
    const manager = new ServiceManager(logger)
    const stop = vi.fn()
    let releaseStart!: () => void
    const starting = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const starting1 = entry('slow', {
      start: () => starting,
      stop,
    })

    const starting2 = manager.startAll([starting1])
    const stopping = manager.stopAll()

    expect(stop).not.toHaveBeenCalled()
    releaseStart()

    await expect(starting2).resolves.toEqual([
      { id: 'slow', pluginId: 'test', ok: false, detail: SERVICE_STOPPED_DURING_STARTUP },
    ])
    await expect(stopping).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledOnce()
    expect(manager.listRunning()).toEqual([])
    expect(manager.lastFailure('slow')).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      'Service slow finished starting after it was already stopping',
    )
  })

  it('reports a start that fails after a stop was requested as stopped, not failed', async () => {
    const logger = createLogger()
    const manager = new ServiceManager(logger)
    let failStart!: (error: unknown) => void
    const starting = new Promise<never>((_, reject) => {
      failStart = reject
    })

    const starting2 = manager.startAll([entry('raced', { start: () => starting, stop: vi.fn() })])
    const stopping = manager.stopAll()
    failStart(new Error('socket closed'))

    await expect(starting2).resolves.toEqual([
      { id: 'raced', pluginId: 'test', ok: false, detail: SERVICE_STOPPED_DURING_STARTUP },
    ])
    await expect(stopping).resolves.toBeUndefined()
    expect(manager.lastFailure('raced')).toBeUndefined()
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('Service raced stopped while it was starting: socket closed')
  })

  it('keeps a newer attempt alive when a superseded start fails late', async () => {
    const manager = new ServiceManager(createLogger())
    let failStart!: (error: unknown) => void
    const starting = new Promise<never>((_, reject) => {
      failStart = reject
    })

    const first = manager.startAll([entry('flappy', { start: () => starting })])
    const stopping = manager.stopAll()
    const second = manager.startAll([entry('flappy')])
    await expect(second).resolves.toEqual([{ id: 'flappy', pluginId: 'test', ok: true }])
    failStart(new Error('too late'))

    await expect(first).resolves.toEqual([
      { id: 'flappy', pluginId: 'test', ok: false, detail: SERVICE_STOPPED_DURING_STARTUP },
    ])
    await expect(stopping).resolves.toBeUndefined()
    expect(manager.isRunning('flappy')).toBe(true)
  })
})
