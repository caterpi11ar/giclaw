import type { AppConfig } from '../config/schema.js'
import type { RunResult } from '../tasks/task-runner.js'
import type { ChannelPlugin, NotificationMessage, PluginLogger } from './types.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../config/schema.js'
import { NotificationDispatcher } from './notify.js'
import { MAX_OUTBOX_ATTEMPTS, NotificationOutbox } from './outbox.js'

/** A minimal message; the dispatcher only needs a run id to dedupe on. */
function messageFor(runId: string): NotificationMessage {
  return {
    level: 'success',
    title: 'Giclaw 运行成功',
    body: `runId: ${runId}`,
    runId,
    trigger: 'cron',
    occurredAt: '2026-01-01T00:01:00.000Z',
    results: [],
  }
}

function createConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return appConfigSchema.parse(overrides)
}

function createLogger(): PluginLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function createChannel(id: string, send: ChannelPlugin['outbound']['send']): ChannelPlugin {
  return { id, meta: { label: id }, outbound: { send } }
}

const runResult: RunResult = {
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
  completedAt: new Date('2026-01-01T00:01:00.000Z'),
  results: [
    { taskId: 'welkin-moon', success: true, message: 'ok', durationMs: 10, completedAt: new Date('2026-01-01T00:00:30.000Z') },
    { taskId: 'claim-mail', success: false, message: 'network down', durationMs: 20, completedAt: new Date('2026-01-01T00:00:50.000Z') },
  ],
}

describe('notificationDispatcher', () => {
  it('filters events against notifications.on', () => {
    const dispatcher = new NotificationDispatcher({
      config: createConfig({ notifications: { on: ['run:error'] } }),
      getChannel: () => undefined,
    })

    expect(dispatcher.shouldNotify('run:error')).toBe(true)
    expect(dispatcher.shouldNotify('run:complete')).toBe(false)
  })

  it('builds a partial-failure message with per-task lines', () => {
    const dispatcher = new NotificationDispatcher({
      config: createConfig(),
      getChannel: () => undefined,
    })

    const message = dispatcher.buildRunMessage('run-1', 'cron', runResult)

    expect(message.level).toBe('error')
    expect(message.title).toBe('Giclaw 运行部分失败 (1/2)')
    expect(message.body).toContain('runId: run-1')
    expect(message.body).toContain('trigger: cron')
    expect(message.body).toContain('✓ welkin-moon')
    expect(message.body).toContain('✗ claim-mail — network down')
    expect(message.occurredAt).toBe('2026-01-01T00:01:00.000Z')
    expect(message.results).toHaveLength(2)
  })

  it('builds a success message when every task passed', () => {
    const dispatcher = new NotificationDispatcher({
      config: createConfig(),
      getChannel: () => undefined,
    })

    const message = dispatcher.buildRunMessage('run-2', 'extension', {
      ...runResult,
      results: [{ taskId: 'claim-mail', success: true, message: 'ok', durationMs: 5, completedAt: new Date('2026-01-01T00:00:00.000Z') }],
    })

    expect(message.level).toBe('success')
    expect(message.title).toBe('Giclaw 运行成功 (1/1)')
  })

  it('sanitizes long task messages', () => {
    const dispatcher = new NotificationDispatcher({
      config: createConfig(),
      getChannel: () => undefined,
    })

    const message = dispatcher.buildRunMessage('run-3', 'api', {
      ...runResult,
      results: [{ taskId: 'claim-mail', success: false, message: 'x'.repeat(5000), durationMs: 1, completedAt: new Date('2026-01-01T00:00:00.000Z') }],
    })

    expect(message.results[0]?.message.length).toBeLessThan(5000)
  })

  it('builds an error message', () => {
    const dispatcher = new NotificationDispatcher({
      config: createConfig(),
      getChannel: () => undefined,
    })

    const message = dispatcher.buildErrorMessage('run-4', 'manual', new Error('browser crashed'))

    expect(message.level).toBe('error')
    expect(message.title).toBe('Giclaw 运行失败')
    expect(message.body).toContain('error: browser crashed')
    expect(message.results).toEqual([])
    expect(message.trigger).toBe('manual')
  })

  it('returns an empty result when no routes are configured', async () => {
    const dispatcher = new NotificationDispatcher({
      config: createConfig(),
      getChannel: () => undefined,
    })

    await expect(dispatcher.dispatch(dispatcher.buildRunMessage('run-1', 'cron', runResult)))
      .resolves
      .toEqual([])
  })

  it('reports channels that are not registered', async () => {
    const logger = createLogger()
    const dispatcher = new NotificationDispatcher({
      config: createConfig({ notifications: { routes: [{ channel: 'feishu' }] } }),
      getChannel: () => undefined,
      logger,
    })

    const entries = await dispatcher.dispatch(dispatcher.buildRunMessage('run-1', 'cron', runResult))

    expect(entries).toEqual([
      { channel: 'feishu', target: undefined, ok: false, detail: 'Channel "feishu" is not registered' },
    ])
    expect(logger.warn).toHaveBeenCalledWith(
      'Notification skipped: Channel "feishu" is not registered',
    )
  })

  it('passes the channel config, target and logger to a registered channel', async () => {
    const logger = createLogger()
    const send = vi.fn<ChannelPlugin['outbound']['send']>(async () => ({ ok: true, detail: 'HTTP 200' }))
    const dispatcher = new NotificationDispatcher({
      config: createConfig({
        channels: { webhook: { url: 'https://example.test/hook' } },
        notifications: { routes: [{ channel: 'webhook', target: 'ops' }, { channel: 'webhook' }, { channel: 'webhook', account: 'beta' }] },
      }),
      getChannel: () => createChannel('webhook', send),
      logger,
    })

    const entries = await dispatcher.dispatch(dispatcher.buildRunMessage('run-1', 'cron', runResult))

    expect(entries).toEqual([
      { channel: 'webhook', target: 'ops', ok: true, detail: 'HTTP 200' },
      { channel: 'webhook', target: undefined, ok: true, detail: 'HTTP 200' },
      { channel: 'webhook', target: undefined, ok: true, detail: 'HTTP 200' },
    ])
    expect(send).toHaveBeenCalledTimes(3)
    const context = send.mock.calls[0]?.[1] as { channelConfig: Record<string, unknown>, target: unknown }
    expect(context.channelConfig).toEqual({ url: 'https://example.test/hook' })
    expect(context.target).toEqual({ name: 'ops' })
    expect(send.mock.calls[1]?.[1]?.target).toBeUndefined()
    // A route can also pin just the account of a multi-account channel.
    expect(send.mock.calls[2]?.[1]?.target).toEqual({ accountId: 'beta' })
  })

  it('defaults the detail when a channel returns none', async () => {
    const dispatcher = new NotificationDispatcher({
      config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
      getChannel: () => createChannel('webhook', async () => ({ ok: true })),
    })

    const entries = await dispatcher.dispatch(dispatcher.buildRunMessage('run-1', 'cron', runResult))

    expect(entries[0]?.detail).toBe('sent')
  })

  it('defaults the detail to failed when a channel reports an unexplained failure', async () => {
    const dispatcher = new NotificationDispatcher({
      config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
      getChannel: () => createChannel('webhook', async () => ({ ok: false })),
    })

    const entries = await dispatcher.dispatch(dispatcher.buildRunMessage('run-1', 'cron', runResult))

    expect(entries[0]).toEqual({ channel: 'webhook', target: undefined, ok: false, detail: 'failed' })
  })

  it('normalizes a channel that rejects with a non-Error value', async () => {
    const logger = createLogger()
    const dispatcher = new NotificationDispatcher({
      config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
      getChannel: () => createChannel('webhook', () => {
        // A misbehaving outbound channel must not be able to break the run.
        // eslint-disable-next-line prefer-promise-reject-errors -- verify non-Error normalization
        return Promise.reject('socket closed')
      }),
      logger,
    })

    const entries = await dispatcher.dispatch(dispatcher.buildRunMessage('run-1', 'cron', runResult))

    expect(entries[0]).toEqual({ channel: 'webhook', target: undefined, ok: false, detail: 'socket closed' })
    expect(logger.warn).toHaveBeenCalledWith('Notification to "webhook" threw: socket closed')
  })

  it('records channel failures without throwing', async () => {
    const logger = createLogger()
    const dispatcher = new NotificationDispatcher({
      config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
      getChannel: () => createChannel('webhook', async () => ({ ok: false, detail: 'HTTP 503', retryable: true })),
      logger,
    })

    const entries = await dispatcher.dispatch(dispatcher.buildRunMessage('run-1', 'cron', runResult))

    expect(entries[0]).toEqual({ channel: 'webhook', target: undefined, ok: false, detail: 'HTTP 503' })
    expect(logger.warn).toHaveBeenCalledWith('Notification to "webhook" failed: HTTP 503')
  })

  it('captures a thrown channel error', async () => {
    const logger = createLogger()
    const dispatcher = new NotificationDispatcher({
      config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
      getChannel: () => createChannel('webhook', async () => {
        throw new Error('socket hang up')
      }),
      logger,
    })

    const entries = await dispatcher.dispatch(dispatcher.buildRunMessage('run-1', 'cron', runResult))

    expect(entries[0]?.ok).toBe(false)
    expect(entries[0]?.detail).toBe('socket hang up')
    expect(logger.warn).toHaveBeenCalledWith('Notification to "webhook" threw: socket hang up')
  })

  it('bounds a channel that never settles', async () => {
    const dispatcher = new NotificationDispatcher({
      config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
      getChannel: () => createChannel('webhook', () => new Promise(() => {})),
      timeoutMs: 5,
    })

    const entries = await dispatcher.dispatch(dispatcher.buildRunMessage('run-1', 'cron', runResult))

    expect(entries[0]?.ok).toBe(false)
    expect(entries[0]?.detail).toMatch(/timed out after 5ms/)
  })

  it('limits how many channels are contacted at once', async () => {
    let inFlight = 0
    let peak = 0
    const send = vi.fn<ChannelPlugin['outbound']['send']>(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 1))
      inFlight -= 1
      return { ok: true }
    })
    const dispatcher = new NotificationDispatcher({
      config: createConfig({
        notifications: {
          routes: Array.from({ length: 6 }, (_, index) => ({ channel: `channel-${index}` })),
        },
      }),
      getChannel: id => createChannel(id, send),
      concurrency: 2,
    })

    const entries = await dispatcher.dispatch(dispatcher.buildRunMessage('run-1', 'cron', runResult))

    expect(entries).toHaveLength(6)
    expect(peak).toBe(2)
  })

  it('caps concurrency at the number of routes when the limit is larger', async () => {
    const dispatcher = new NotificationDispatcher({
      config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
      getChannel: () => createChannel('webhook', async () => ({ ok: true })),
      concurrency: 8,
    })

    await expect(dispatcher.dispatch(dispatcher.buildRunMessage('run-1', 'cron', runResult)))
      .resolves
      .toHaveLength(1)
  })

  it('dispatches in the background and reports settled entries', async () => {
    const entries: unknown[] = []
    const dispatcher = new NotificationDispatcher({
      config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
      getChannel: () => createChannel('webhook', async () => ({ ok: true, detail: 'done' })),
    })
    const message: NotificationMessage = dispatcher.buildRunMessage('run-1', 'cron', runResult)

    dispatcher.dispatchSafe(message, settled => entries.push(...settled))
    await vi.waitFor(() => expect(entries).toHaveLength(1))

    expect(entries[0]).toEqual({ channel: 'webhook', target: undefined, ok: true, detail: 'done' })
  })

  it('ignores a failing observer and a failing dispatch', async () => {
    const logger = createLogger()
    const dispatcher = new NotificationDispatcher({
      config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
      getChannel: () => createChannel('webhook', async () => ({ ok: true })),
      logger,
    })
    const message = dispatcher.buildRunMessage('run-1', 'cron', runResult)

    dispatcher.dispatchSafe(message, () => {
      throw new Error('observer failed')
    })
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(
      'Notification observer failed',
      expect.objectContaining({ message: 'observer failed' }),
    ))

    const failing = new NotificationDispatcher({
      config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
      getChannel: () => undefined,
      logger,
    })
    vi.spyOn(failing, 'dispatch').mockRejectedValueOnce(new Error('boom'))
    failing.dispatchSafe(message)
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(
      'Notification dispatch failed',
      expect.objectContaining({ message: 'boom' }),
    ))
  })

  describe('durable redelivery', () => {
    async function createOutbox() {
      const dir = await mkdtemp(join(tmpdir(), 'giclaw-notify-outbox-'))
      return NotificationOutbox.create({ path: join(dir, 'outbox.json') })
    }

    it('queues a failed delivery for the next startup', async () => {
      const logger = createLogger()
      const outbox = await createOutbox()
      const dispatcher = new NotificationDispatcher({
        config: createConfig({ notifications: { routes: [{ channel: 'webhook', target: 'ops' }] } }),
        getChannel: () => createChannel('webhook', async () => ({ ok: false, detail: 'HTTP 503' })),
        logger,
        outbox,
      })

      const message = dispatcher.buildRunMessage('run-1', 'cron', runResult)
      const entries = await dispatcher.dispatch(message)

      expect(entries[0]?.ok).toBe(false)
      await expect(outbox.list()).resolves.toEqual([
        expect.objectContaining({ channel: 'webhook', target: 'ops', attempts: 0, message }),
      ])
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('queued for redelivery'))
    })

    it('reports a delivery that is already queued', async () => {
      const logger = createLogger()
      const outbox = await createOutbox()
      const dispatcher = new NotificationDispatcher({
        config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
        getChannel: () => createChannel('webhook', async () => ({ ok: false })),
        logger,
        outbox,
      })
      const message = dispatcher.buildRunMessage('run-1', 'cron', runResult)

      await dispatcher.dispatch(message)
      await dispatcher.dispatch(message)

      await expect(outbox.size()).resolves.toBe(1)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('is already queued for redelivery'))
    })

    it('keeps dispatching when the queue cannot be written', async () => {
      const logger = createLogger()
      const outbox = {
        record: vi.fn().mockRejectedValue(new Error('disk full')),
      } as unknown as NotificationOutbox
      const dispatcher = new NotificationDispatcher({
        config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
        getChannel: () => createChannel('webhook', async () => ({ ok: false, detail: 'HTTP 503' })),
        logger,
        outbox,
      })

      const entries = await dispatcher.dispatch(dispatcher.buildRunMessage('run-1', 'cron', runResult))

      expect(entries[0]?.ok).toBe(false)
      expect(logger.warn).toHaveBeenCalledWith(
        'Notification to "webhook" could not be queued for redelivery: disk full',
      )
    })

    it('replays queued deliveries and forgets the ones that land', async () => {
      const logger = createLogger()
      const outbox = await createOutbox()
      await outbox.record({ channel: 'webhook', accountId: 'beta', message: messageFor('run-7') })
      const dispatcher = new NotificationDispatcher({
        config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
        getChannel: () => createChannel('webhook', async () => ({ ok: true })),
        logger,
        outbox,
      })

      await expect(dispatcher.redeliverPending()).resolves.toEqual({
        delivered: 1,
        failed: 0,
        dropped: 0,
        pending: 0,
      })
      await expect(outbox.size()).resolves.toBe(0)
      expect(logger.info).toHaveBeenCalledWith('Redelivering 1 queued notification(s)')
      expect(logger.info).toHaveBeenCalledWith('Redelivery finished: 1 delivered, 0 failed, 0 still queued')
    })

    it('keeps a delivery that still fails and counts its attempts', async () => {
      const logger = createLogger()
      const outbox = await createOutbox()
      await outbox.record({ channel: 'missing', message: messageFor('run-7') })
      const dispatcher = new NotificationDispatcher({
        config: createConfig({ notifications: { routes: [{ channel: 'missing' }] } }),
        getChannel: () => undefined,
        logger,
        outbox,
      })

      await expect(dispatcher.redeliverPending()).resolves.toEqual({
        delivered: 0,
        failed: 1,
        dropped: 0,
        pending: 1,
      })
      await expect(outbox.list()).resolves.toEqual([
        expect.objectContaining({ attempts: 1, lastError: 'Channel "missing" is not registered' }),
      ])
    })

    it('drops a delivery that exhausted its retries', async () => {
      const logger = createLogger()
      const outbox = await createOutbox()
      const { id } = await outbox.record({ channel: 'webhook', message: messageFor('run-7') })
      for (let attempt = 1; attempt < MAX_OUTBOX_ATTEMPTS; attempt += 1)
        await outbox.recordFailure(id, 'HTTP 503')
      const dispatcher = new NotificationDispatcher({
        config: createConfig({ notifications: { routes: [{ channel: 'webhook' }] } }),
        getChannel: () => createChannel('webhook', async () => ({ ok: false, detail: 'HTTP 503' })),
        logger,
        outbox,
      })

      await expect(dispatcher.redeliverPending()).resolves.toEqual({
        delivered: 0,
        failed: 0,
        dropped: 1,
        pending: 0,
      })
      expect(logger.warn).toHaveBeenCalledWith(
        `Dropped queued notification ${id} for "webhook" after ${MAX_OUTBOX_ATTEMPTS} attempts`,
      )
    })

    it('does nothing without a queue or with an empty one', async () => {
      const config = createConfig({ notifications: { routes: [{ channel: 'webhook' }] } })
      const getChannel = () => createChannel('webhook', async () => ({ ok: true }))
      const empty = { delivered: 0, failed: 0, dropped: 0, pending: 0 }

      await expect(new NotificationDispatcher({ config, getChannel }).redeliverPending()).resolves.toEqual(empty)

      const outbox = await createOutbox()
      await expect(new NotificationDispatcher({ config, getChannel, outbox }).redeliverPending()).resolves.toEqual(empty)
    })
  })
})
