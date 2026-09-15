/**
 * Durable outbox for run notifications.
 *
 * openclaw advertises durable delivery to its channels (its Feishu webhook
 * answers with `x-openclaw-delivery-accepted: durable`); Giclaw only logged a
 * failed notification and forgot it, so an unreachable channel silently lost
 * the run outcome. This store is the missing half: a failed send is persisted
 * and replayed when the daemon next starts.
 *
 * The boundary stays the same as {@link NotificationDispatcher}: delivery is a
 * side effect of a run that already committed, so nothing here can ever rewrite
 * a successful reward claim into a failure. A message that keeps failing is
 * dropped after {@link MAX_OUTBOX_ATTEMPTS} tries.
 *
 * The file lives in the private data directory (`0o600` inside `0o700`) and is
 * written atomically; read-modify-write cycles are serialized in-process.
 */
import type { NotificationMessage } from './types.js'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWritePrivateFile, PATHS } from '../config/paths.js'
import { toError } from '../utils/errors.js'
import { sanitizeBoundedText } from '../utils/logger.js'

/** Bounded queue: the oldest entry is sacrificed once the cap is reached. */
export const MAX_OUTBOX_ENTRIES = 200
/** A notification is dropped after this many failed delivery attempts. */
export const MAX_OUTBOX_ATTEMPTS = 5
/** A notification older than this is dropped even if it never failed. */
export const MAX_OUTBOX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
export const OUTBOX_VERSION = 1

export interface OutboxEntry {
  id: string
  channel: string
  target?: string
  accountId?: string
  message: NotificationMessage
  /** Number of failed deliveries recorded for this entry. */
  attempts: number
  createdAt: string
  lastAttemptAt?: string
  lastError?: string
}

export interface OutboxFile {
  version: number
  entries: OutboxEntry[]
}

export interface NotificationOutboxOptions {
  path?: string
  now?: () => number
  logger?: { warn: (message: string) => void }
  /** Injectable so a test can produce a deterministic id. */
  generateId?: () => string
}

export interface OutboxAppendResult {
  id: string
  /** True when an equivalent entry was already queued. */
  duplicate: boolean
}

/** A failed delivery is retried until this reports `dropped`. */
export type OutboxFailureResult = 'retrying' | 'dropped'

const FILE_NAME = 'notification-outbox.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEntry(value: unknown): OutboxEntry | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.channel !== 'string')
    return null
  if (!isRecord(value.message))
    return null
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString()
  return {
    id: value.id,
    channel: value.channel,
    ...(typeof value.target === 'string' ? { target: value.target } : {}),
    ...(typeof value.accountId === 'string' ? { accountId: value.accountId } : {}),
    message: value.message as unknown as NotificationMessage,
    attempts: typeof value.attempts === 'number' && Number.isFinite(value.attempts) ? value.attempts : 0,
    createdAt,
    ...(typeof value.lastAttemptAt === 'string' ? { lastAttemptAt: value.lastAttemptAt } : {}),
    ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {}),
  }
}

/** Two entries are the same delivery when they describe the same route and run. */
function dedupeKey(entry: Pick<OutboxEntry, 'channel' | 'target' | 'accountId' | 'message'>): string {
  return [entry.channel, entry.target ?? '', entry.accountId ?? '', entry.message.runId].join('\u0000')
}

export class NotificationOutbox {
  private readonly path: string
  private readonly now: () => number
  private readonly logger?: { warn: (message: string) => void }
  private readonly generateId: () => string
  private entries: OutboxEntry[] = []
  /** Resolves once the on-disk state has been read (or found absent). */
  private ready: Promise<void> = Promise.resolve()
  /** Serializes read-modify-write cycles so concurrent failures cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(options: NotificationOutboxOptions) {
    this.path = options.path ?? join(PATHS.dataDir, FILE_NAME)
    this.now = options.now ?? Date.now
    this.logger = options.logger
    this.generateId = options.generateId ?? randomUUID
  }

  /**
   * Create the outbox, loading the file in the background.
   *
   * The dispatcher is built while the daemon boots and must not wait on disk,
   * so construction is synchronous and every operation awaits {@link ready}.
   */
  static create(options: NotificationOutboxOptions = {}): NotificationOutbox {
    const outbox = new NotificationOutbox(options)
    outbox.ready = outbox.load()
    return outbox
  }

  /** Load persisted state; a missing or unreadable file starts empty. */
  static async open(options: NotificationOutboxOptions = {}): Promise<NotificationOutbox> {
    const outbox = NotificationOutbox.create(options)
    await outbox.ready
    return outbox
  }

  private async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf-8'))
      if (isRecord(parsed) && Array.isArray(parsed.entries))
        this.entries = parsed.entries.map(parseEntry).filter((entry): entry is OutboxEntry => entry !== null)
    }
    catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.logger?.warn(
          `Discarding unreadable notification outbox at ${this.path}: ${sanitizeBoundedText(toError(error).message, 200)}`,
        )
      }
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.ready
      return operation()
    }
    const next = this.queue.then(run, run)
    // Keep the chain alive without propagating a rejection into the next call.
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async save(): Promise<void> {
    await atomicWritePrivateFile(this.path, `${JSON.stringify({ version: OUTBOX_VERSION, entries: this.entries })}\n`)
  }

  /** Queue a failed delivery; an equivalent pending entry is reused. */
  async record(entry: Pick<OutboxEntry, 'channel' | 'target' | 'accountId' | 'message'>): Promise<OutboxAppendResult> {
    return this.serialize(async () => {
      const key = dedupeKey(entry)
      const existing = this.entries.find(candidate => dedupeKey(candidate) === key)
      if (existing)
        return { id: existing.id, duplicate: true }

      const created: OutboxEntry = {
        id: this.generateId(),
        channel: entry.channel,
        ...(entry.target === undefined ? {} : { target: entry.target }),
        ...(entry.accountId === undefined ? {} : { accountId: entry.accountId }),
        message: entry.message,
        attempts: 0,
        createdAt: new Date(this.now()).toISOString(),
      }
      this.entries = [...this.entries, created].slice(-MAX_OUTBOX_ENTRIES)
      await this.save()
      return { id: created.id, duplicate: false }
    })
  }

  /** Pending deliveries, oldest first, with expired entries removed. */
  async list(): Promise<OutboxEntry[]> {
    return this.serialize(async () => {
      const before = this.entries.length
      this.expire()
      if (this.entries.length !== before)
        await this.save()
      return [...this.entries]
    })
  }

  /**
   * Record a failed attempt. Returns `dropped` once the entry has exhausted its
   * retries, in which case it is removed.
   */
  async recordFailure(id: string, detail: string): Promise<OutboxFailureResult> {
    return this.serialize(async () => {
      const entry = this.entries.find(candidate => candidate.id === id)
      if (!entry)
        return 'dropped'
      entry.attempts += 1
      entry.lastAttemptAt = new Date(this.now()).toISOString()
      entry.lastError = sanitizeBoundedText(detail, 200)
      if (entry.attempts >= MAX_OUTBOX_ATTEMPTS) {
        this.entries = this.entries.filter(candidate => candidate.id !== id)
        await this.save()
        return 'dropped'
      }
      await this.save()
      return 'retrying'
    })
  }

  /** Forget one delivery (sent, or no longer wanted). */
  async remove(id: string): Promise<boolean> {
    return this.serialize(async () => {
      const remaining = this.entries.filter(entry => entry.id !== id)
      if (remaining.length === this.entries.length)
        return false
      this.entries = remaining
      await this.save()
      return true
    })
  }

  /** Drop every pending delivery. Returns how many were queued. */
  async clear(): Promise<number> {
    return this.serialize(async () => {
      const { length } = this.entries
      this.entries = []
      await this.save()
      return length
    })
  }

  /** Pending delivery count, expired entries removed. */
  async size(): Promise<number> {
    return (await this.list()).length
  }

  /** Drop entries past {@link MAX_OUTBOX_AGE_MS}. */
  private expire(): void {
    const deadline = this.now() - MAX_OUTBOX_AGE_MS
    this.entries = this.entries.filter(entry => Date.parse(entry.createdAt) >= deadline)
  }
}
