import type { ParsedMail } from 'mailparser'
import type { PluginRuntime } from '../../../plugin-sdk/index.js'
import type { PluginLogger } from '../../../plugins/types.js'
import type { RunResult } from '../../../tasks/task-runner.js'
import type { ImapAccount } from './config.js'
import type { evaluateImapSender } from './sender-gate.js'
import type { ImapWatcherClient, ImapWatcherMessage } from './watcher.js'
import { Buffer } from 'node:buffer'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { imapConfigSchema } from './config.js'
import { ImapStateStore, messageKey } from './state.js'
import { ImapAccountWatcher, MAX_ATTEMPTS } from './watcher.js'

const NOW = Date.parse('2026-05-05T05:05:05.000Z')

const minimal = { host: 'imap.example.com', user: 'ops', password: 'secret', allowedSenders: ['ops@example.com'] }

function account(overrides: Record<string, unknown> = {}): ImapAccount {
  return imapConfigSchema.parse({ accounts: { main: { ...minimal, ...overrides } } }).accounts.main!
}

/** A parsed message that the real sender gate would accept. */
function parsedMail(overrides: { messageId?: string | undefined, subject?: string, to?: string[] } = {}): ParsedMail {
  return {
    from: { value: [{ address: 'ops@example.com' }] },
    to: overrides.to === undefined ? undefined : { value: overrides.to.map(address => ({ address })) },
    subject: 'subject' in overrides ? overrides.subject : 'Claim the mail',
    messageId: 'messageId' in overrides ? overrides.messageId : '<m-1@example.com>',
    headerLines: [{ key: 'From', line: 'From: ops@example.com' }],
    headers: new Map(),
  } as unknown as ParsedMail
}

interface FakeClient extends ImapWatcherClient {
  connect: ReturnType<typeof vi.fn>
  fetch: ReturnType<typeof vi.fn>
  emitted: { event: string, arg?: unknown }[]
  ranges: string[]
  emit: (event: string, arg?: unknown) => void
  gate: { promise: Promise<void>, release: () => void }
}

function createFakeClient(overrides: {
  messages?: ImapWatcherMessage[]
  capabilities?: string[]
  uidValidity?: bigint
  uidNext?: number
  connectError?: unknown
  mailboxOpenError?: unknown
  blockConnect?: boolean
  blockMailboxOpen?: boolean
  blockFetch?: boolean
} = {}): FakeClient {
  const messages = (overrides.messages ?? []).map(message => ({
    internalDate: new Date(NOW),
    ...message,
  }))
  const listeners = new Map<string, ((arg?: unknown) => void)[]>()
  const fake = {
    capabilities: new Set(overrides.capabilities ?? ['IDLE']),
    connect: vi.fn(async () => {
      if (overrides.blockConnect === true)
        await fake.gate.promise
      if (overrides.connectError !== undefined)
        throw overrides.connectError
    }),
    close: vi.fn(),
    mailboxOpen: vi.fn(async () => {
      if (overrides.blockMailboxOpen === true)
        await fake.gate.promise
      if (overrides.mailboxOpenError !== undefined)
        throw overrides.mailboxOpenError
      return { uidValidity: overrides.uidValidity ?? 1n, uidNext: overrides.uidNext ?? 1, exists: 0 }
    }),
    fetch: vi.fn((range: string) => {
      fake.ranges.push(range)
      return (async function* () {
        if (overrides.blockFetch === true)
          await fake.gate.promise
        for (const message of messages)
          yield message
      })()
    }),
    on: (event: string, listener: (arg?: unknown) => void) => {
      listeners.set(event, [...listeners.get(event) ?? [], listener])
    },
    once: (event: string, listener: (arg?: unknown) => void) => {
      listeners.set(event, [...listeners.get(event) ?? [], listener])
    },
    emitted: [] as { event: string, arg?: unknown }[],
    ranges: [] as string[],
    emit: (event: string, arg?: unknown) => {
      fake.emitted.push({ event, arg })
      for (const listener of listeners.get(event) ?? [])
        listener(arg)
    },
    gate: (() => {
      let release = () => {}
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      return { promise, release }
    })(),
  }
  return fake as unknown as FakeClient
}

interface Harness {
  watcher: ImapAccountWatcher
  state: ImapStateStore
  client: FakeClient
  logger: PluginLogger & { warn: ReturnType<typeof vi.fn>, info: ReturnType<typeof vi.fn>, error: ReturnType<typeof vi.fn>, debug: ReturnType<typeof vi.fn> }
  enqueueRun: ReturnType<typeof vi.fn>
  resolveRoutine: ReturnType<typeof vi.fn>
}

async function harness(options: {
  accountOverrides?: Record<string, unknown>
  client?: FakeClient
  parse?: (source: Buffer) => Promise<ParsedMail>
  authenticator?: Parameters<typeof evaluateImapSender>[0]['authenticator']
  reconnectBaseMs?: number
  random?: () => number
  seed?: { uidValidity: string, uidNext: number } | false
  /** `true` leaves the watcher on the real clock. */
  realClock?: boolean
} = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'giclaw-imap-watch-'))
  const state = await ImapStateStore.open({ path: join(dir, 'state.json'), now: () => NOW })
  const accounts = { ...account(), ...options.accountOverrides }
  if (options.seed)
    state.syncCursor('main', options.seed.uidValidity, options.seed.uidNext)

  const client = options.client ?? createFakeClient()
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const enqueueRun = vi.fn(async () => ({ results: [] }) as unknown as RunResult)
  const resolveRoutine = vi.fn((name: string) => (name === 'daily' ? ['welkin-moon'] : null))
  const runtime = { gateway: { enqueueRun, resolveRoutine, getSnapshot: vi.fn(), getRunHistory: vi.fn() } } as unknown as PluginRuntime

  const watcher = new ImapAccountWatcher({
    accountId: 'main',
    account: accounts,
    runtime,
    state,
    logger,
    createClient: () => client,
    random: options.random ?? (() => 0),
    ...(options.realClock === true ? {} : { now: () => NOW }),
    ...(options.parse ? { parse: options.parse } : {}),
    ...(options.authenticator ? { authenticator: options.authenticator } : {}),
    ...(options.reconnectBaseMs === undefined ? {} : { reconnectBaseMs: options.reconnectBaseMs }),
  })

  return { watcher, state, client, logger, enqueueRun, resolveRoutine }
}

/** Start a watcher and wait until it owns a connected client. */
async function connected(h: Harness): Promise<void> {
  h.watcher.start()
  await vi.waitFor(() => expect(h.client.mailboxOpen).toHaveBeenCalled())
}

/** Authenticator doubles: the real gate turns these into verdicts. */
const dmarc = (result: string) => async () => ({ dmarc: { status: { result }, alignment: { dkim: {} } } } as never)
const accepting = dmarc('pass')
const transient = dmarc('temperror')
const refusing = dmarc('fail')

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('imapAccountWatcher lifecycle', () => {
  it('disables itself when no sender is allowed', async () => {
    const h = await harness({ accountOverrides: { allowedSenders: [] }, seed: { uidValidity: '1', uidNext: 1 } })

    h.watcher.start()
    await h.watcher.stop()

    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('configure allowedSenders'))
    expect(h.client.connect).not.toHaveBeenCalled()
  })

  it('baselines a new mailbox and reports push mode', async () => {
    const h = await harness()

    await connected(h)

    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('cursor=baseline'))
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('mode=push'))
    await h.watcher.stop()
  })

  it('reports a reset cursor when the epoch changed', async () => {
    const h = await harness({ client: createFakeClient({ uidValidity: 2n, uidNext: 4 }), seed: { uidValidity: '1', uidNext: 4 } })

    await connected(h)

    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('cursor=reset uidValidity=2'))
    await h.watcher.stop()
  })

  it('falls back to polling when the server has no IDLE, and when asked to', async () => {
    const noIdle = await harness({ client: createFakeClient({ capabilities: [] }), accountOverrides: { watch: { mode: 'idle', pollSeconds: 60 } } })
    await connected(noIdle)

    expect(noIdle.logger.warn).toHaveBeenCalledWith(expect.stringContaining('no IDLE capability'))
    expect(noIdle.logger.info).toHaveBeenCalledWith(expect.stringContaining('mode=poll'))
    await noIdle.watcher.stop()

    const interval = await harness({ accountOverrides: { watch: { mode: 'interval', pollSeconds: 60 } } })
    await connected(interval)

    expect(interval.logger.info).toHaveBeenCalledWith(expect.stringContaining('mode=poll'))
    await interval.watcher.stop()
  })

  it('reconnects with jitter after a connection failure', async () => {
    vi.useFakeTimers()
    const failing = createFakeClient({ connectError: new Error('socket hang up') })
    const h = await harness({ client: failing, reconnectBaseMs: 1_000 })

    h.watcher.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection failed=socket hang up'))
    // The first failure schedules a retry with base 1s plus a quarter jitter.
    expect(failing.connect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(failing.connect).toHaveBeenCalledTimes(2)

    failing.connect.mockImplementation(async () => {})
    await vi.advanceTimersByTimeAsync(2_500)
    expect(failing.mailboxOpen).toHaveBeenCalled()
    await h.watcher.stop()
  })

  it('stops retrying after repeated authentication failures', async () => {
    vi.useFakeTimers()
    const refused = createFakeClient({ connectError: Object.assign(new Error('login failed'), { authenticationFailed: true }) })
    const h = await harness({ client: refused, reconnectBaseMs: 1 })
    // A transport can also fail without announcing a close, and then the
    // client is still there for the give-up path to shut down.
    refused.connect.mockImplementation(async () => {
      throw Object.assign(new Error('login failed'), { authenticationFailed: true })
    })

    h.watcher.start()
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1)
      await vi.advanceTimersByTimeAsync(60_000)

    expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining('needs reauthentication'))
    expect(refused.connect).toHaveBeenCalledTimes(MAX_ATTEMPTS)

    // No further attempts: the watcher gave up rather than hammering the server.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(refused.connect).toHaveBeenCalledTimes(MAX_ATTEMPTS)
    await h.watcher.stop()
  })

  it('drops a reconnect that was queued while it was giving up', async () => {
    vi.useFakeTimers()
    const refused = createFakeClient({ connectError: Object.assign(new Error('login failed'), { authenticationFailed: true }) })
    const h = await harness({ client: refused, reconnectBaseMs: 1 })
    // ImapFlow announces the dropped socket before `connect()` rejects, which
    // queues a reconnect the give-up path must then abandon.
    refused.connect.mockImplementation(async () => {
      refused.emit('close')
      throw Object.assign(new Error('login failed'), { authenticationFailed: true })
    })

    h.watcher.start()
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1)
      await vi.advanceTimersByTimeAsync(60_000)

    expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining('needs reauthentication'))
    expect(refused.connect).toHaveBeenCalledTimes(MAX_ATTEMPTS)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(refused.connect).toHaveBeenCalledTimes(MAX_ATTEMPTS)
    await h.watcher.stop()
  })

  it('reschedules when the connection drops and logs transport errors', async () => {
    const h = await harness({ reconnectBaseMs: 1 })
    await connected(h)

    h.client.emit('error', new Error('TLS alert'))
    h.client.emit('close')
    h.client.emit('close')

    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection error=TLS alert'))
    await vi.waitFor(() => expect(h.client.connect).toHaveBeenCalledTimes(2))
    await h.watcher.stop()
  })

  it('survives a connection that is dropped while it starts', async () => {
    const h = await harness({ client: createFakeClient({ blockConnect: true }) })
    h.watcher.start()
    await vi.waitFor(() => expect(h.client.connect).toHaveBeenCalled())
    // `stop()` runs while the connection is half-open; the connect path must
    // close the client and return without registering a sweep timer.
    const stopped = h.watcher.stop()
    h.client.gate.release()

    await stopped
    // Once from `stop()`, once from the connect path that resumed afterwards.
    await vi.waitFor(() => expect(h.client.close).toHaveBeenCalledTimes(2))
    expect(h.client.mailboxOpen).not.toHaveBeenCalled()
  })

  it('ignores a second start while it is still connecting', async () => {
    const h = await harness({ client: createFakeClient({ blockConnect: true }) })

    h.watcher.start()
    h.watcher.start()
    h.client.gate.release()

    await vi.waitFor(() => expect(h.client.mailboxOpen).toHaveBeenCalled())
    expect(h.client.connect).toHaveBeenCalledTimes(1)
    await h.watcher.stop()
  })

  it('stops before it ever opens a socket', async () => {
    const h = await harness()

    h.watcher.start()
    await h.watcher.stop()

    expect(h.client.connect).not.toHaveBeenCalled()
  })

  it('ignores a mailbox that opened while stopping', async () => {
    const h = await harness({ client: createFakeClient({ blockMailboxOpen: true }) })
    h.watcher.start()
    await vi.waitFor(() => expect(h.client.mailboxOpen).toHaveBeenCalled())

    const stopped = h.watcher.stop()
    h.client.gate.release()
    await stopped
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(h.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('mode='))
    expect(h.state.peek('main')).toBeUndefined()
  })

  it('ignores a failure that arrives after stop', async () => {
    const h = await harness({ client: createFakeClient({ blockConnect: true, connectError: new Error('socket closed') }) })
    h.watcher.start()
    await vi.waitFor(() => expect(h.client.connect).toHaveBeenCalled())

    const stopped = h.watcher.stop()
    // The connection fails only after the watcher has already been stopped.
    h.client.gate.release()
    await stopped
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(h.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('connection failed'))
  })

  it('clears a reconnect timer that is still pending', async () => {
    const h = await harness({ client: createFakeClient({ connectError: new Error('down') }) })
    h.watcher.start()
    await vi.waitFor(() => expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection failed=down')))

    await h.watcher.stop()

    expect(h.client.connect).toHaveBeenCalledTimes(1)
  })

  it('builds a real imapflow client when none is injected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'giclaw-imap-real-'))
    const state = await ImapStateStore.open({ path: join(dir, 'state.json') })
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const watcher = new ImapAccountWatcher({
      accountId: 'main',
      // Nothing listens on 127.0.0.1:1, so the socket is refused immediately and
      // the constructor's option mapping is all this test exercises.
      account: account({ host: '127.0.0.1', port: 1, secure: false }),
      runtime: { gateway: {} } as unknown as PluginRuntime,
      state,
      logger,
    })

    watcher.start()
    await vi.waitFor(
      () => expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection failed=')),
      { timeout: 5_000, interval: 25 },
    )
    // A pending reconnect must be cleared, not left to fire during shutdown.
    await watcher.stop()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})

describe('imapAccountWatcher sweeps', () => {
  it('does nothing without a cursor', async () => {
    const h = await harness()
    const client = createFakeClient({ messages: [{ uid: 1, source: Buffer.from('x') }] })

    await h.watcher.sweep(client)

    expect(client.fetch).not.toHaveBeenCalled()
  })

  it('ignores what the server returns below the cursor', async () => {
    const messages = [
      { uid: 1, source: Buffer.from('old') },
      { uid: 4, source: Buffer.from('new') },
    ]
    const h = await harness({
      client: createFakeClient({ messages, uidNext: 4 }),
      parse: async () => parsedMail({ messageId: undefined, subject: 'x'.repeat(200) }),
      authenticator: accepting,
    })
    await connected(h)

    await h.watcher.sweep(h.client)

    expect(h.client.ranges).toEqual(['4:*'])
    expect(h.enqueueRun).toHaveBeenCalledTimes(1)
    await h.watcher.stop()
  })

  it('parses a real message when no parser is injected', async () => {
    const source = Buffer.from([
      'From: ops@example.com',
      'Subject: Claim the mail',
      'Message-ID: <real@example.com>',
      'Date: Tue, 05 May 2026 05:05:05 +0000',
      '',
      'body text',
    ].join('\r\n'))
    const h = await harness({
      client: createFakeClient({ messages: [{ uid: 2, source }] }),
      authenticator: async () => ({ dmarc: { status: { result: 'pass' }, alignment: { dkim: {} } } } as never),
    })
    await connected(h)

    await h.watcher.sweep(h.client)

    expect(h.enqueueRun).toHaveBeenCalledWith(undefined)
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('subject=Claim the mail'))
    await h.watcher.stop()
  })

  it('reads a string arrival date and falls back when it is unparseable', async () => {
    const h = await harness({
      client: createFakeClient({ messages: [
        { uid: 2, internalDate: new Date(Date.now() - 3_600_000).toISOString(), source: Buffer.from('x') },
        { uid: 3, internalDate: 'last tuesday', source: Buffer.from('y') },
      ] }),
      parse: async () => parsedMail({ messageId: undefined }),
      authenticator: accepting,
      realClock: true,
      seed: { uidValidity: '1', uidNext: 1 },
    })
    await connected(h)

    await h.watcher.sweep(h.client)

    expect(h.enqueueRun).toHaveBeenCalledTimes(2)
    expect(h.state.peek('main')?.lastSeenUid).toBe(3)
    await h.watcher.stop()
  })

  it('skips a message that arrived without a body', async () => {
    const h = await harness({ client: createFakeClient({ messages: [{ uid: 2 }] }), authenticator: accepting })
    await connected(h)

    await h.watcher.sweep(h.client)

    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('gate=message-source-missing'))
    expect(h.enqueueRun).not.toHaveBeenCalled()
    await h.watcher.stop()
  })

  it('keeps a transiently rejected message for the next sweep', async () => {
    const h = await harness({
      client: createFakeClient({ messages: [{ uid: 2, source: Buffer.from('x') }] }),
      parse: async () => parsedMail(),
      authenticator: transient,
    })
    await connected(h)

    await h.watcher.sweep(h.client)

    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('gate=authentication-temperror retry=true'))
    expect(h.state.peek('main')?.lastSeenUid).toBe(0)
    await h.watcher.stop()
  })

  it('gives up on a message that keeps failing authentication', async () => {
    const h = await harness({
      client: createFakeClient({ messages: [{ uid: 2, source: Buffer.from('x') }] }),
      parse: async () => parsedMail(),
      authenticator: transient,
    })
    await connected(h)

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1)
      await h.watcher.sweep(h.client)

    expect(h.state.claim(messageKey('main', '1', 2))).toBe(false)
    expect(h.state.peek('main')?.lastSeenUid).toBe(2)
    expect(h.state.toJSON().accounts.main!.skips['authentication-temperror']).toBe(1)
    await h.watcher.stop()
  })

  it('drops a message the gate refuses outright', async () => {
    const h = await harness({
      client: createFakeClient({ messages: [{ uid: 2, source: Buffer.from('x') }] }),
      parse: async () => parsedMail(),
      authenticator: refusing,
    })
    await connected(h)

    await h.watcher.sweep(h.client)

    expect(h.state.toJSON().accounts.main!.skips['dmarc-fail']).toBe(1)
    expect(h.state.peek('main')?.lastSeenUid).toBe(2)
    await h.watcher.stop()
  })

  it('drops a message whose id was already handled', async () => {
    const h = await harness({
      client: createFakeClient({ messages: [{ uid: 2, source: Buffer.from('x') }] }),
      parse: async () => parsedMail({ messageId: '<seen@example.com>' }),
      authenticator: accepting,
    })
    await connected(h)
    h.state.rememberMessage('main', '<seen@example.com>')

    await h.watcher.sweep(h.client)

    expect(h.state.toJSON().accounts.main!.skips['duplicate-message-id']).toBe(1)
    expect(h.enqueueRun).not.toHaveBeenCalled()
    await h.watcher.stop()
  })

  it('drops a message another sweep already claimed', async () => {
    const h = await harness({
      client: createFakeClient({ messages: [{ uid: 2, source: Buffer.from('x') }] }),
      parse: async () => parsedMail(),
      authenticator: accepting,
    })
    h.state.claim(messageKey('main', '1', 2))
    await connected(h)

    await h.watcher.sweep(h.client)

    expect(h.state.toJSON().accounts.main!.skips['duplicate-uid']).toBe(1)
    expect(h.enqueueRun).not.toHaveBeenCalled()
    await h.watcher.stop()
  })

  it('stops at the per-sender rate limit', async () => {
    const messages = [
      { uid: 2, source: Buffer.from('x') },
      { uid: 3, source: Buffer.from('y') },
    ]
    const h = await harness({
      accountOverrides: { rateLimit: { limit: 1, windowMs: 3_600_000 } },
      client: createFakeClient({ messages }),
      parse: async () => parsedMail({ messageId: undefined }),
      authenticator: accepting,
    })
    await connected(h)

    await h.watcher.sweep(h.client)

    expect(h.enqueueRun).toHaveBeenCalledTimes(1)
    expect(h.state.toJSON().accounts.main!.skips['rate-limited']).toBe(1)
    await h.watcher.stop()
  })

  it('drops a message whose routine is not configured', async () => {
    const h = await harness({
      accountOverrides: { routine: 'ghost' },
      client: createFakeClient({ messages: [{ uid: 2, source: Buffer.from('x') }] }),
      parse: async () => parsedMail(),
      authenticator: accepting,
    })
    await connected(h)

    await h.watcher.sweep(h.client)

    expect(h.state.toJSON().accounts.main!.skips['routine-not-configured']).toBe(1)
    expect(h.enqueueRun).not.toHaveBeenCalled()
    await h.watcher.stop()
  })

  it('queues a configured routine', async () => {
    const h = await harness({
      accountOverrides: { routine: 'daily' },
      client: createFakeClient({ messages: [{ uid: 2, source: Buffer.from('x') }] }),
      parse: async () => parsedMail(),
      authenticator: accepting,
    })
    await connected(h)

    await h.watcher.sweep(h.client)

    expect(h.enqueueRun).toHaveBeenCalledWith(['welkin-moon'])
    expect(h.state.peek('main')?.lastSeenUid).toBe(2)
    await h.watcher.stop()
  })

  it('retries a dispatch the queue rejected, then gives up', async () => {
    const h = await harness({
      client: createFakeClient({ messages: [{ uid: 2, source: Buffer.from('x') }] }),
      parse: async () => parsedMail(),
      authenticator: accepting,
    })
    h.enqueueRun.mockRejectedValue(new Error('queue full'))
    await connected(h)

    await h.watcher.sweep(h.client)
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('dispatch rejected=queue full'))
    expect(h.state.peek('main')?.lastSeenUid).toBe(0)

    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1)
      await h.watcher.sweep(h.client)

    expect(h.state.toJSON().accounts.main!.skips['dispatch-rejected']).toBe(1)
    expect(h.state.peek('main')?.lastSeenUid).toBe(2)
    await h.watcher.stop()
  })

  it('sweeps again when a message arrives during a sweep', async () => {
    const h = await harness({
      client: createFakeClient({ messages: [{ uid: 2, source: Buffer.from('x') }], blockFetch: true }),
      seed: { uidValidity: '1', uidNext: 1 },
      parse: async () => parsedMail(),
      authenticator: accepting,
    })
    await connected(h)
    await vi.waitFor(() => expect(h.client.fetch).toHaveBeenCalledTimes(1))

    h.client.emit('exists')
    h.client.emit('exists')
    h.client.gate.release()

    await vi.waitFor(() => expect(h.client.fetch).toHaveBeenCalledTimes(2))
    await h.watcher.stop()
  })

  it('sweeps on connect and on an IDLE wakeup', async () => {
    const h = await harness({
      client: createFakeClient({ messages: [] }),
      seed: { uidValidity: '1', uidNext: 1 },
      parse: async () => parsedMail(),
      authenticator: accepting,
    })

    await connected(h)

    // The seeded cursor resumes, so connecting reconciles immediately.
    await vi.waitFor(() => expect(h.client.fetch).toHaveBeenCalledTimes(1))
    h.client.emit('exists')
    await vi.waitFor(() => expect(h.client.fetch).toHaveBeenCalledTimes(2))
    await h.watcher.stop()
  })

  it('ignores a mailbox wakeup that arrives after stop', async () => {
    const h = await harness({ client: createFakeClient({ messages: [] }), authenticator: accepting })
    await connected(h)

    await h.watcher.stop()
    h.client.emit('exists')

    expect(h.client.fetch).not.toHaveBeenCalled()
  })

  it('accepts a plus-address token and reports it as such', async () => {
    const h = await harness({
      accountOverrides: {
        addressTokens: [{ token: 's3cret', senders: ['ops@example.com'] }],
      },
      client: createFakeClient({ messages: [{ uid: 2, internalDate: new Date(), source: Buffer.from('x') }] }),
      parse: async () => parsedMail({ subject: undefined, messageId: undefined, to: ['ops+s3cret@example.com'] }),
      realClock: true,
    })
    await connected(h)

    await h.watcher.sweep(h.client)

    expect(h.enqueueRun).toHaveBeenCalledTimes(1)
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('gate=token'))
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('subject='))
    await h.watcher.stop()
  })

  it('warns when progress cannot be persisted', async () => {
    const h = await harness({ client: createFakeClient({ messages: [] }), authenticator: accepting })
    await connected(h)
    vi.spyOn(h.state, 'save').mockRejectedValueOnce(new Error('disk full'))

    await h.watcher.sweep(h.client)

    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not persist progress: disk full'))
    await h.watcher.stop()
  })

  it('logs a sweep that failed and keeps watching', async () => {
    const h = await harness({ client: createFakeClient({ messages: [] }), authenticator: accepting })
    await connected(h)
    h.client.fetch.mockImplementation(() => {
      throw new Error('mailbox gone')
    })

    h.client.emit('exists')

    await vi.waitFor(() => expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('sweep failed=mailbox gone')))
    await h.watcher.stop()
  })
})
