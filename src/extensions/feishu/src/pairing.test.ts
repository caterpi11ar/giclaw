import type { FeishuPairingAccount, PairingRequestOutcome } from './pairing.js'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FeishuPairingStore,
  generatePairingCode,
  MAX_APPROVED_SENDERS,
  MAX_PENDING_PAIRING_REQUESTS,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_REQUEST_TTL_MS,
  PAIRING_STORE_VERSION,
  pruneExpired,
} from './pairing.js'

const NOW = Date.parse('2026-01-01T00:00:00.000Z')

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'giclaw-feishu-pairing-'))
  roots.push(root)
  return join(root, 'data', 'feishu-pairing.json')
}

function createLogger(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() }
}

function account(overrides: Partial<FeishuPairingAccount> = {}): FeishuPairingAccount {
  return { approved: [], pending: {}, ...overrides }
}

/** A request the store accepted always carries a code; the tests rely on it. */
function acceptedCode(outcome: PairingRequestOutcome): string {
  expect(outcome.created).toBe(true)
  return outcome.code as string
}

describe('generatePairingCode', () => {
  it('draws characters from the look-alike-free alphabet', () => {
    const code = generatePairingCode()

    expect(code).toHaveLength(PAIRING_CODE_LENGTH)
    for (const character of code)
      expect(PAIRING_CODE_ALPHABET).toContain(character)
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[IO01]/u)
  })

  it('honours an explicit length', () => {
    expect(generatePairingCode(10)).toHaveLength(10)
    expect(generatePairingCode(0)).toBe('')
  })
})

describe('normalizePairingCode', () => {
  it('trims and upper-cases what the operator typed', () => {
    expect(normalizePairingCode('  ab12cd ')).toBe('AB12CD')
  })
})

describe('pruneExpired', () => {
  it('keeps requests inside the ttl and drops the rest', () => {
    const fresh = { subjects: ['user:ou_1'], createdAt: new Date(NOW - PAIRING_REQUEST_TTL_MS).toISOString() }
    const expired = { subjects: ['user:ou_2'], createdAt: new Date(NOW - PAIRING_REQUEST_TTL_MS - 1).toISOString() }

    const pruned = pruneExpired(account({ approved: ['user:ou_9'], pending: { AAAA11: fresh, BBBB22: expired } }), NOW)

    expect(Object.keys(pruned.pending)).toEqual(['AAAA11'])
    expect(pruned.approved).toEqual(['user:ou_9'])
  })
})

describe('feishuPairingStore', () => {
  it('starts empty when the store has never been written', async () => {
    const logger = createLogger()
    const path = await tempFile()

    const store = await FeishuPairingStore.open({ path, logger })

    await expect(store.listAccountIds()).resolves.toEqual([])
    await expect(store.listPending('default')).resolves.toEqual({})
    await expect(store.readApproved('default')).resolves.toEqual([])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('reads back what it wrote, with private permissions', async () => {
    const path = await tempFile()
    const store = await FeishuPairingStore.open({ path, now: () => NOW })
    const code = acceptedCode(await store.request({ accountId: 'default', subjects: ['user:ou_1'] }))
    await store.approve('default', code)

    const reopened = await FeishuPairingStore.open({ path, now: () => NOW })
    await expect(reopened.readApproved('default')).resolves.toEqual(['user:ou_1'])

    const file = await readFile(path, 'utf-8')
    expect(JSON.parse(file)).toMatchObject({ version: PAIRING_STORE_VERSION })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('discards a store that cannot be read at all', async () => {
    const logger = createLogger()
    const path = await tempFile()
    // A directory where the file should be: readable state is impossible.
    await mkdir(path, { recursive: true })

    const store = await FeishuPairingStore.open({ path, logger })

    await expect(store.readApproved('default')).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Discarding unreadable Feishu pairing store'))
  })

  it('logs and starts empty when the file is corrupt', async () => {
    const logger = createLogger()
    const path = await tempFile()
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '{ this is not json', 'utf-8')

    const store = await FeishuPairingStore.open({ path, logger })

    await expect(store.readApproved('default')).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Discarding unreadable Feishu pairing store'))
  })

  it('tolerates a file whose accounts are not objects', async () => {
    const path = await tempFile()
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, accounts: 'nope' }), 'utf-8')

    const store = await FeishuPairingStore.open({ path })

    await expect(store.listAccountIds()).resolves.toEqual([])
  })

  it('normalizes a hand-edited file without trusting it', async () => {
    const path = await tempFile()
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, JSON.stringify({
      version: 1,
      accounts: {
        default: {
          approved: ['user:ou_1', 42, null],
          pending: {
            GOOD11: { subjects: ['user:ou_2', 7], createdAt: new Date(NOW).toISOString() },
            BROKEN: 'nope',
            UNDATED: { subjects: [] },
          },
        },
        empty: null,
        unreadable: {
          approved: 'nope',
          pending: { NONARR01: { subjects: 'nope', createdAt: new Date(NOW).toISOString() } },
        },
      },
    }), 'utf-8')

    const store = await FeishuPairingStore.open({ path, now: () => NOW })

    await expect(store.readApproved('default')).resolves.toEqual(['user:ou_1'])
    // A request with no readable timestamp is treated as long expired, and a
    // non-object entry is skipped entirely.
    await expect(store.listPending('default')).resolves.toEqual({
      GOOD11: { subjects: ['user:ou_2'], createdAt: new Date(NOW).toISOString() },
    })
    // A list that is not an array at all is read as empty rather than trusted.
    await expect(store.readApproved('unreadable')).resolves.toEqual([])
    await expect(store.listPending('unreadable')).resolves.toEqual({
      NONARR01: { subjects: [], createdAt: new Date(NOW).toISOString() },
    })
    await expect(store.listAccountIds()).resolves.toEqual(['default', 'empty', 'unreadable'])
  })

  it('creates a code, reuses it for the same sender and never repeats it', async () => {
    const store = await FeishuPairingStore.open({ path: await tempFile(), now: () => NOW })

    const first = await store.request({ accountId: 'default', subjects: ['user:ou_1', 'user:ou_2'] })
    const other = await store.request({ accountId: 'default', subjects: ['user:ou_3'] })
    const retry = await store.request({ accountId: 'default', subjects: ['user:ou_2'] })
    const firstCode = acceptedCode(first)
    const otherCode = acceptedCode(other)

    expect(firstCode).toHaveLength(PAIRING_CODE_LENGTH)
    expect(otherCode).not.toBe(firstCode)
    expect(retry).toEqual({ code: firstCode, created: false })
    await expect(store.listPending('default')).resolves.toEqual({
      [firstCode]: { subjects: ['user:ou_1', 'user:ou_2'], createdAt: new Date(NOW).toISOString() },
      [otherCode]: { subjects: ['user:ou_3'], createdAt: new Date(NOW).toISOString() },
    })
  })

  it('retries the code generator until it finds an unused code', async () => {
    const path = await tempFile()
    const store = await FeishuPairingStore.open({ path, now: () => NOW })
    const first = await store.request({ accountId: 'default', subjects: ['user:ou_1'] })

    // First repeat the code already in use, then produce a free one.
    const codes = [acceptedCode(first), 'FRESH001']
    const colliding = await FeishuPairingStore.open({
      path,
      now: () => NOW,
      generateCode: () => codes.shift() as string,
    })

    await expect(colliding.request({ accountId: 'default', subjects: ['user:ou_2'] }))
      .resolves
      .toEqual({ code: 'FRESH001', created: true })
    expect(Object.keys(await colliding.listPending('default'))).toHaveLength(2)
  })

  it('fills the queue and then ignores further requests', async () => {
    const clock = { value: NOW }
    const store = await FeishuPairingStore.open({ path: await tempFile(), now: () => clock.value })
    const codes: string[] = []
    for (let index = 0; index < MAX_PENDING_PAIRING_REQUESTS; index += 1) {
      clock.value = NOW + index * 1_000
      const { code, created } = await store.request({
        accountId: 'default',
        subjects: [`user:ou_${index}`],
      })
      expect(created).toBe(true)
      codes.push(code as string)
    }

    clock.value = NOW + 10_000
    await expect(store.request({ accountId: 'default', subjects: ['user:ou_late'] }))
      .resolves
      .toEqual({ code: null, created: false })

    // The three accepted requests are untouched: nothing was evicted.
    const pending = await store.listPending('default')
    expect(Object.keys(pending)).toEqual(codes)
  })

  it('frees a slot when a request is dismissed', async () => {
    const store = await FeishuPairingStore.open({ path: await tempFile(), now: () => NOW })
    const first = await store.request({ accountId: 'default', subjects: ['user:ou_1'] })
    await store.request({ accountId: 'default', subjects: ['user:ou_2'] })
    await store.request({ accountId: 'default', subjects: ['user:ou_3'] })
    const firstCode = acceptedCode(first)

    await expect(store.dismiss('default', ' nope99 ')).resolves.toBe(false)
    await expect(store.dismiss('default', ` ${firstCode.toLowerCase()} `)).resolves.toBe(true)
    await expect(store.dismiss('default', firstCode)).resolves.toBe(false)
    // Dismissing must not approve anyone.
    await expect(store.readApproved('default')).resolves.toEqual([])

    await expect(store.request({ accountId: 'default', subjects: ['user:ou_4'] }))
      .resolves
      .toMatchObject({ created: true })
  })

  it('is case-insensitive when approving and reports an unknown code', async () => {
    const store = await FeishuPairingStore.open({ path: await tempFile(), now: () => NOW })
    const code = acceptedCode(await store.request({ accountId: 'default', subjects: ['user:ou_1'] }))

    await expect(store.approve('default', 'NOPE99')).resolves.toEqual({ ok: false, reason: 'unknown-code' })
    await expect(store.approve('default', ` ${code.toLowerCase()} `)).resolves.toEqual({
      ok: true,
      subjects: ['user:ou_1'],
      alreadyApproved: false,
    })
    await expect(store.listPending('default')).resolves.toEqual({})
  })

  it('flags an approval of senders that were already allowed', async () => {
    const store = await FeishuPairingStore.open({ path: await tempFile(), now: () => NOW })
    const first = await store.request({ accountId: 'default', subjects: ['user:ou_1'] })
    await store.approve('default', acceptedCode(first))
    const second = await store.request({ accountId: 'default', subjects: ['user:ou_1'] })

    await expect(store.approve('default', acceptedCode(second))).resolves.toMatchObject({ ok: true, alreadyApproved: true })
    await expect(store.readApproved('default')).resolves.toEqual(['user:ou_1'])
  })

  it('bounds the approved list, keeping the most recent senders', async () => {
    const store = await FeishuPairingStore.open({ path: await tempFile(), now: () => NOW })
    const subjects = Array.from({ length: MAX_APPROVED_SENDERS + 1 }, (_, index) => `user:ou_${index}`)
    const code = acceptedCode(await store.request({ accountId: 'default', subjects }))

    await store.approve('default', code)

    const approved = await store.readApproved('default')
    expect(approved).toHaveLength(MAX_APPROVED_SENDERS)
    expect(approved[0]).toBe('user:ou_1')
    expect(approved.at(-1)).toBe(`user:ou_${MAX_APPROVED_SENDERS}`)
  })

  it('revokes an approved sender and reports a no-op', async () => {
    const store = await FeishuPairingStore.open({ path: await tempFile(), now: () => NOW })
    const code = acceptedCode(await store.request({ accountId: 'default', subjects: ['user:ou_1'] }))
    await store.approve('default', code)

    await expect(store.revoke('default', 'user:ou_1')).resolves.toBe(true)
    await expect(store.revoke('default', 'user:ou_1')).resolves.toBe(false)
    await expect(store.readApproved('default')).resolves.toEqual([])
  })

  it('forgets a request once its ttl has passed', async () => {
    const path = await tempFile()
    const now = { value: NOW }
    const store = await FeishuPairingStore.open({ path, now: () => now.value })
    const code = acceptedCode(await store.request({ accountId: 'default', subjects: ['user:ou_1'] }))

    now.value = NOW + PAIRING_REQUEST_TTL_MS + 1

    await expect(store.listPending('default')).resolves.toEqual({})
    await expect(store.approve('default', code)).resolves.toEqual({ ok: false, reason: 'unknown-code' })
  })

  it('serializes concurrent read-modify-write cycles', async () => {
    const store = await FeishuPairingStore.open({ path: await tempFile(), now: () => NOW })

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.request({ accountId: 'default', subjects: [`user:ou_${index}`] })),
    )

    expect(results.filter(result => result.created)).toHaveLength(3)
    expect(new Set(results.filter(result => result.created).map(result => result.code)).size).toBe(3)
    expect(Object.keys(await store.listPending('default'))).toHaveLength(3)
  })

  it('keeps a failed cycle from breaking the next one', async () => {
    const path = await tempFile()
    // A directory where the file should be makes the atomic write fail.
    await mkdir(path, { recursive: true })
    const store = await FeishuPairingStore.open({ path, now: () => NOW })

    await expect(store.request({ accountId: 'default', subjects: ['user:ou_1'] })).rejects.toThrow()
    await rm(path, { recursive: true, force: true })
    await expect(store.request({ accountId: 'default', subjects: ['user:ou_2'] })).resolves.toMatchObject({ created: true })
    // The failed write still left its own entry in memory; what matters is that
    // the next cycle ran instead of being rejected by the previous failure.
    expect(Object.values(await store.listPending('default')).map(entry => entry.subjects))
      .toEqual([['user:ou_1'], ['user:ou_2']])
  })

  it('tracks every account that has state', async () => {
    const store = await FeishuPairingStore.open({ path: await tempFile(), now: () => NOW })

    await store.request({ accountId: 'alpha', subjects: ['user:ou_1'] })
    await store.request({ accountId: 'beta', subjects: ['user:ou_2'] })

    await expect(store.listAccountIds()).resolves.toEqual(['alpha', 'beta'])
    await expect(store.readApproved('gamma')).resolves.toEqual([])
  })

  it('waits for the file before answering the first query', async () => {
    const path = await tempFile()
    const seeded = await FeishuPairingStore.open({ path, now: () => NOW })
    const code = acceptedCode(await seeded.request({ accountId: 'default', subjects: ['user:ou_1'] }))
    await seeded.approve('default', code)

    // `create` returns before the file has been read; the first operation waits.
    const store = FeishuPairingStore.create({ path })

    await expect(store.readApproved('default')).resolves.toEqual(['user:ou_1'])
  })
})
