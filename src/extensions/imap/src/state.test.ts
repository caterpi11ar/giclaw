import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IMAP_CLAIM_TTL_MS, IMAP_SEEN_LIMIT, IMAP_STATE_VERSION, ImapStateStore, messageKey } from './state.js'

const NOW = Date.parse('2026-05-05T05:05:05.000Z')
let dir = ''
let path = ''
let logger: { warn: ReturnType<typeof vi.fn>, debug: ReturnType<typeof vi.fn> }

async function open(overrides: { now?: () => number } = {}) {
  return await ImapStateStore.open({ path, now: () => NOW, logger, ...overrides })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'giclaw-imap-state-'))
  path = join(dir, 'imap-state.json')
  logger = { warn: vi.fn(), debug: vi.fn() }
})

describe('imapStateStore cursors', () => {
  it('baselines a mailbox on first sight instead of replaying it', async () => {
    const store = await open()

    expect(store.peek('main')).toBeUndefined()
    expect(store.syncCursor('main', '1', 5)).toEqual({ kind: 'baseline', cursor: { uidValidity: '1', lastSeenUid: 4 } })
    expect(store.peek('main')).toEqual({ uidValidity: '1', lastSeenUid: 4 })
    expect(store.syncCursor('main', '1', 9)).toEqual({ kind: 'resume', cursor: { uidValidity: '1', lastSeenUid: 4 } })
  })

  it('resets when the server reports a new uid validity', async () => {
    const store = await open()
    store.syncCursor('main', '1', 5)

    expect(store.syncCursor('main', '2', 3)).toEqual({ kind: 'reset', cursor: { uidValidity: '2', lastSeenUid: 2 } })
  })

  it('moves the cursor forward and ignores stale epochs', async () => {
    const store = await open()
    store.syncCursor('main', '1', 5)

    store.advanceCursor('main', '1', 7)
    store.advanceCursor('main', '1', 6)
    expect(store.peek('main')?.lastSeenUid).toBe(7)

    store.advanceCursor('main', '2', 99)
    store.advanceCursor('ghost', '1', 99)
    expect(store.peek('main')?.lastSeenUid).toBe(7)
  })
})

describe('imapStateStore message memory', () => {
  it('remembers message ids and answers for unknown accounts', async () => {
    const store = await open()
    store.syncCursor('main', '1', 1)

    expect(store.hasMessageId('main', '<a@b>')).toBe(false)
    expect(store.hasMessageId('ghost', '<a@b>')).toBe(false)
    store.rememberMessage('main', '<a@b>')
    expect(store.hasMessageId('main', '<a@b>')).toBe(true)
  })

  it('keeps a bounded newest-last ring', async () => {
    const store = await open()
    store.syncCursor('main', '1', 1)

    for (let index = 0; index < IMAP_SEEN_LIMIT + 5; index += 1)
      store.rememberMessage('main', `<${index}@example.com>`)

    const seen = store.toJSON().accounts.main!.seenMessageIds
    expect(seen).toHaveLength(IMAP_SEEN_LIMIT)
    expect(seen).not.toContain('<0@example.com>')
    expect(seen.at(-1)).toBe(`<${IMAP_SEEN_LIMIT + 4}@example.com>`)

    store.rememberMessage('main', '<1@example.com>')
    expect(store.toJSON().accounts.main!.seenMessageIds.at(-1)).toBe('<1@example.com>')
    store.rememberMessage('ghost', '<x@example.com>')
    expect(store.toJSON().accounts.ghost).toBeUndefined()
  })

  it('counts skips per reason', async () => {
    const store = await open()
    store.syncCursor('main', '1', 1)

    store.countSkip('main', 'duplicate-uid')
    store.countSkip('main', 'duplicate-uid')
    store.countSkip('main', 'sender-not-allowed')
    store.countSkip('ghost', 'duplicate-uid')

    expect(store.toJSON().accounts.main!.skips).toEqual({ 'duplicate-uid': 2, 'sender-not-allowed': 1 })
  })
})

describe('imapStateStore claims', () => {
  it('claims once and releases', async () => {
    const store = await open()
    const key = messageKey('main', '1', 4)

    expect(store.claim(key)).toBe(true)
    expect(store.claim(key)).toBe(false)
    store.releaseClaim(key)
    expect(store.claim(key)).toBe(true)
    store.releaseClaim('nobody')
    expect(store.toJSON().claims[key]).toEqual({ recordedAt: NOW })
  })

  it('counts attempts under their own key and keeps the last reason', async () => {
    const store = await open()
    const key = messageKey('main', '1', 4)

    expect(store.recordAttempt(key, 'dispatch-rejected')).toBe(1)
    expect(store.recordAttempt(key, 'authentication-temperror')).toBe(2)
    expect(store.toJSON().attempts[key]).toEqual({ recordedAt: NOW, count: 2, reason: 'authentication-temperror' })
    // An attempt is not a claim: the message may still be dispatched later.
    expect(store.claim(key)).toBe(true)
  })
})

describe('imapStateStore persistence', () => {
  it('writes nothing when nothing changed', async () => {
    const store = await open()

    await store.save()

    expect(existsSync(path)).toBe(false)
  })

  it('persists progress and reloads it, claims included', async () => {
    const store = await open()
    store.syncCursor('main', '1', 5)
    store.advanceCursor('main', '1', 6)
    store.rememberMessage('main', '<a@b>')
    store.countSkip('main', 'duplicate-uid')
    store.claim(messageKey('main', '1', 6))
    store.recordAttempt(messageKey('main', '1', 6), 'dispatch-rejected')
    await store.save()

    const persisted = JSON.parse(await readFile(path, 'utf-8'))
    expect(persisted.version).toBe(IMAP_STATE_VERSION)

    const reloaded = await open()
    expect(reloaded.peek('main')).toEqual({ uidValidity: '1', lastSeenUid: 6 })
    expect(reloaded.hasMessageId('main', '<a@b>')).toBe(true)
    expect(reloaded.toJSON().accounts.main!.skips).toEqual({ 'duplicate-uid': 1 })
    expect(reloaded.claim(messageKey('main', '1', 6))).toBe(false)
    expect(reloaded.toJSON().attempts[messageKey('main', '1', 6)]).toMatchObject({ count: 1 })
    expect(logger.debug).toHaveBeenCalled()
  })

  it('drops expired claims but keeps fresh ones', async () => {
    const stale = {
      version: 1,
      accounts: {},
      claims: { old: { recordedAt: NOW - IMAP_CLAIM_TTL_MS - 1 }, fresh: { recordedAt: NOW } },
      attempts: {
        'attempt:old': { recordedAt: NOW - IMAP_CLAIM_TTL_MS - 1, count: 1, reason: 'x' },
        'attempt:fresh': { recordedAt: NOW, count: 2, reason: 'y' },
      },
    }
    await writeFile(path, JSON.stringify(stale))

    const store = await open()

    expect(store.toJSON().claims).toEqual({ fresh: { recordedAt: NOW } })
    expect(store.toJSON().attempts).toEqual({ 'attempt:fresh': { recordedAt: NOW, count: 2, reason: 'y' } })
  })

  it('skips malformed entries instead of failing to start', async () => {
    await writeFile(path, JSON.stringify({
      version: 1,
      accounts: {
        missingValidity: { lastSeenUid: 1, seenMessageIds: [] },
        missingUid: { uidValidity: '1', seenMessageIds: [] },
        missingRing: { uidValidity: '1', lastSeenUid: 1 },
        notAnObject: 'nope',
        nulled: null,
        noSkips: { uidValidity: '9', lastSeenUid: 3, seenMessageIds: [] },
        good: { uidValidity: '1', lastSeenUid: 2, seenMessageIds: ['<a@b>'], skips: { dup: 1 }, updatedAt: NOW },
      },
      claims: {
        missingRecordedAt: { attempts: 1 },
        notAnObject: 7,
        good: { recordedAt: NOW },
      },
      attempts: {
        missingCount: { recordedAt: NOW, reason: 'x' },
        missingReason: { recordedAt: NOW, count: 1 },
        missingRecordedAt: { count: 1, reason: 'x' },
        notAnObject: {},
        good: { recordedAt: NOW, count: 1, reason: 'x' },
      },
    }))

    const store = await open()

    expect(Object.keys(store.toJSON().accounts).toSorted()).toEqual(['good', 'noSkips'])
    expect(store.toJSON().accounts.noSkips!.skips).toEqual({})
    expect(store.hasMessageId('good', '<a@b>')).toBe(true)
    expect(Object.keys(store.toJSON().claims)).toEqual(['good'])
    expect(Object.keys(store.toJSON().attempts)).toEqual(['good'])
  })

  it('starts empty when the file has no sections at all', async () => {
    await writeFile(path, '{"version":1}')

    const store = await open()

    expect(store.toJSON()).toMatchObject({ accounts: {}, claims: {}, attempts: {} })
  })

  it('starts empty when the file is not an object', async () => {
    await writeFile(path, '"nope"')

    const store = await open()

    expect(store.toJSON().accounts).toEqual({})
  })

  it('warns about a file it cannot read', async () => {
    await writeFile(path, 'not json at all')

    const store = await open()

    expect(store.toJSON().accounts).toEqual({})
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Discarding unreadable IMAP state'))
  })
})
