import type { OutboxEntry } from './outbox.js'
import type { NotificationMessage } from './types.js'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_OUTBOX_AGE_MS, MAX_OUTBOX_ATTEMPTS, MAX_OUTBOX_ENTRIES, NotificationOutbox } from './outbox.js'

const NOW = Date.parse('2026-05-05T05:05:05.000Z')

function message(runId = 'run-1'): NotificationMessage {
  return {
    level: 'success',
    title: 'Giclaw 运行成功',
    body: `runId: ${runId}`,
    runId,
    trigger: 'cron',
    occurredAt: '2026-05-05T05:04:00.000Z',
    results: [],
  }
}

function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: 'id-1',
    channel: 'feishu',
    message: message(),
    attempts: 0,
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  }
}

describe('notification outbox', () => {
  let dir: string
  let path: string
  let logger: { warn: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'giclaw-outbox-'))
    path = join(dir, 'outbox.json')
    logger = { warn: vi.fn() }
  })

  function open() {
    let counter = 0
    const ids = ['id-1', 'id-2', 'id-3']
    return NotificationOutbox.create({
      path,
      now: () => NOW,
      logger,
      generateId: () => ids[counter++] as string,
    })
  }

  it('starts empty when the file does not exist', async () => {
    const outbox = open()

    await expect(outbox.list()).resolves.toEqual([])
    await expect(outbox.size()).resolves.toBe(0)
  })

  it('persists a failed delivery and writes it privately', async () => {
    const outbox = open()

    await expect(outbox.record({ channel: 'feishu', message: message() })).resolves.toEqual({
      id: 'id-1',
      duplicate: false,
    })

    const stored = JSON.parse(await readFile(path, 'utf-8')) as { version: number, entries: OutboxEntry[] }
    expect(stored.version).toBe(1)
    expect(stored.entries).toHaveLength(1)
    expect(stored.entries[0]).toMatchObject({ id: 'id-1', channel: 'feishu', attempts: 0 })
  })

  it('reloads persisted deliveries with their retry state', async () => {
    const first = open()
    const { id } = await first.record({ channel: 'feishu', target: 'ops', accountId: 'beta', message: message() })
    await first.recordFailure(id, 'HTTP 503')

    const reopened = await NotificationOutbox.open({ path, now: () => NOW })

    await expect(reopened.list()).resolves.toEqual([
      expect.objectContaining({
        id,
        channel: 'feishu',
        target: 'ops',
        accountId: 'beta',
        attempts: 1,
        lastError: 'HTTP 503',
        lastAttemptAt: new Date(NOW).toISOString(),
      }),
    ])
  })

  it('reuses an equivalent pending delivery instead of duplicating it', async () => {
    const outbox = open()

    await outbox.record({ channel: 'feishu', message: message() })

    await expect(outbox.record({ channel: 'feishu', message: message() })).resolves.toEqual({
      id: 'id-1',
      duplicate: true,
    })
    await expect(outbox.size()).resolves.toBe(1)

    // A different route or run is a different delivery.
    await outbox.record({ channel: 'feishu', target: 'ops', message: message() })
    await outbox.record({ channel: 'feishu', message: message('run-2') })
    await expect(outbox.size()).resolves.toBe(3)
  })

  it('records a failed attempt and drops the delivery at the retry limit', async () => {
    const outbox = open()
    await outbox.record({ channel: 'feishu', message: message() })

    for (let attempt = 1; attempt < MAX_OUTBOX_ATTEMPTS; attempt += 1)
      await expect(outbox.recordFailure('id-1', 'boom')).resolves.toBe('retrying')

    await expect(outbox.list()).resolves.toEqual([
      expect.objectContaining({
        attempts: MAX_OUTBOX_ATTEMPTS - 1,
        lastError: 'boom',
        lastAttemptAt: new Date(NOW).toISOString(),
      }),
    ])

    await expect(outbox.recordFailure('id-1', 'boom')).resolves.toBe('dropped')
    await expect(outbox.size()).resolves.toBe(0)
  })

  it('truncates a long failure detail', async () => {
    const outbox = open()
    await outbox.record({ channel: 'feishu', message: message() })

    await outbox.recordFailure('id-1', 'x'.repeat(500))

    const [stored] = await outbox.list()
    expect(stored?.lastError).toHaveLength(200)
  })

  it('reports a delivery that is already gone as dropped', async () => {
    const outbox = open()

    await expect(outbox.recordFailure('missing', 'boom')).resolves.toBe('dropped')
  })

  it('removes one delivery and reports whether it existed', async () => {
    const outbox = open()
    await outbox.record({ channel: 'feishu', message: message() })

    await expect(outbox.remove('id-1')).resolves.toBe(true)
    await expect(outbox.remove('id-1')).resolves.toBe(false)
    await expect(outbox.size()).resolves.toBe(0)
  })

  it('clears every pending delivery and reports how many were queued', async () => {
    const outbox = open()
    await outbox.record({ channel: 'feishu', message: message() })
    await outbox.record({ channel: 'smtp', message: message() })

    await expect(outbox.clear()).resolves.toBe(2)
    await expect(outbox.list()).resolves.toEqual([])
    await expect(outbox.clear()).resolves.toBe(0)
  })

  it('drops the oldest delivery when the queue is full', async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: Array.from({ length: MAX_OUTBOX_ENTRIES }, (_, index) =>
          entry({ id: `id-${index}`, message: message(`run-${index}`) })),
      }),
      'utf-8',
    )
    const outbox = NotificationOutbox.create({ path, now: () => NOW, generateId: () => 'id-new' })

    await outbox.record({ channel: 'feishu', message: message('run-new') })

    const stored = await outbox.list()
    expect(stored).toHaveLength(MAX_OUTBOX_ENTRIES)
    expect(stored[0]?.id).toBe('id-1')
    expect(stored.at(-1)?.id).toBe('id-new')
  })

  it('expires deliveries that are older than the age limit', async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          entry({ id: 'fresh', createdAt: new Date(NOW).toISOString() }),
          entry({ id: 'stale', createdAt: new Date(NOW - MAX_OUTBOX_AGE_MS - 1).toISOString() }),
        ],
      }),
      'utf-8',
    )

    const outbox = await NotificationOutbox.open({ path, now: () => NOW })

    await expect(outbox.list()).resolves.toEqual([expect.objectContaining({ id: 'fresh' })])
    // The expiry is persisted, so the stale entry cannot come back.
    const stored = JSON.parse(await readFile(path, 'utf-8')) as { entries: OutboxEntry[] }
    expect(stored.entries.map(item => item.id)).toEqual(['fresh'])
  })

  it('keeps a delivery that is exactly at the age limit', async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: [entry({ id: 'edge', createdAt: new Date(NOW - MAX_OUTBOX_AGE_MS).toISOString() })],
      }),
      'utf-8',
    )

    const outbox = await NotificationOutbox.open({ path, now: () => NOW })

    await expect(outbox.size()).resolves.toBe(1)
  })

  it('skips persisted entries that are not shaped like a delivery', async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          null,
          'nope',
          { id: 'no-channel', message: message() },
          { id: 'no-message', channel: 'feishu' },
          { id: 'not-serializable', channel: 'feishu', message: 'text' },
          { id: 'ok', channel: 'feishu', message: message(), attempts: 'many', createdAt: 5 },
        ],
      }),
      'utf-8',
    )

    // `now` sits at the epoch so the entry's fallback timestamp is still fresh.
    const outbox = await NotificationOutbox.open({ path, now: () => 0 })

    await expect(outbox.list()).resolves.toEqual([
      expect.objectContaining({ id: 'ok', attempts: 0, createdAt: new Date(0).toISOString() }),
    ])
  })

  it('ignores a file whose top level is not an outbox', async () => {
    await writeFile(path, JSON.stringify({ version: 1, entries: 'no' }), 'utf-8')
    const outbox = await NotificationOutbox.open({ path, now: () => NOW })

    await expect(outbox.list()).resolves.toEqual([])

    await writeFile(path, 'null', 'utf-8')
    const other = await NotificationOutbox.open({ path, now: () => NOW })
    await expect(other.list()).resolves.toEqual([])
  })

  it('warns and starts empty when the store is unreadable', async () => {
    await writeFile(path, '{ not json', 'utf-8')

    const outbox = await NotificationOutbox.open({ path, now: () => NOW, logger })

    await expect(outbox.list()).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Discarding unreadable notification outbox'),
    )
  })

  it('keeps the queue usable after a write that failed', async () => {
    // A directory sitting where the file belongs makes the atomic rename fail.
    const brokenPath = join(dir, 'broken.json')
    await mkdir(brokenPath)
    await writeFile(join(brokenPath, 'keep'), 'x', 'utf-8')
    const broken = NotificationOutbox.create({ path: brokenPath, now: () => NOW })

    await expect(broken.record({ channel: 'feishu', message: message() })).rejects.toThrow()

    // The queue survives the rejection, so later calls still run: the entry is
    // in memory even though it never reached the disk.
    await expect(broken.list()).resolves.toEqual([expect.objectContaining({ channel: 'feishu' })])
    await expect(broken.size()).resolves.toBe(1)
  })
})
