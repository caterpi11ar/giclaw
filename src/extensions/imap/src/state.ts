import type { PluginLogger } from '../../../plugins/types.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWritePrivateFile, PATHS } from '../../../config/paths.js'
import { toError } from '../../../utils/errors.js'
import { sanitizeBoundedText } from '../../../utils/logger.js'

/**
 * Per-account IMAP progress.
 *
 * openclaw keeps this in its plugin keyed-store (`cursor` / `dispatch-claim` /
 * `msgid-ring` / `skip-count` namespaces); Giclaw's plugin runtime has no such
 * store, so the same information lives in a private JSON file next to the other
 * runtime state. Nothing here is a secret, but it does reveal mailbox activity,
 * so the file is written with the private-file helper.
 */

export const IMAP_STATE_VERSION = 1
/** How many message ids are remembered per account for duplicate suppression. */
export const IMAP_SEEN_LIMIT = 100
/** A dispatch claim lives this long, so a restart cannot replay an old message. */
export const IMAP_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1_000

export interface ImapCursor {
  uidValidity: string
  lastSeenUid: number
}

export interface ImapAccountState extends ImapCursor {
  /** Newest-last ring of handled message ids. */
  seenMessageIds: string[]
  /** Messages dropped per reason, so `giclaw plugins` can show the operator. */
  skips: Record<string, number>
  updatedAt: number
}

/** A message that was admitted (or is being retried), kept across restarts. */
export interface ImapClaim {
  recordedAt: number
}

/** Attempts live under their own key, so a retry does not look like a claim. */
export interface ImapAttempt {
  recordedAt: number
  count: number
  reason: string
}

export interface ImapStateFile {
  version: number
  accounts: Record<string, ImapAccountState>
  claims: Record<string, ImapClaim>
  attempts: Record<string, ImapAttempt>
}

export type CursorAction = 'baseline' | 'reset' | 'resume'

export interface CursorResult {
  kind: CursorAction
  cursor: ImapCursor
}

export interface ImapStateOptions {
  path?: string
  now?: () => number
  logger?: Pick<PluginLogger, 'warn' | 'debug'>
}

function emptyAccount(uidValidity: string, lastSeenUid: number, now: number): ImapAccountState {
  return { uidValidity, lastSeenUid, seenMessageIds: [], skips: {}, updatedAt: now }
}

function isAccountState(value: unknown): value is ImapAccountState {
  if (typeof value !== 'object' || value === null)
    return false
  const candidate = value as Partial<ImapAccountState>
  return typeof candidate.uidValidity === 'string'
    && typeof candidate.lastSeenUid === 'number'
    && Array.isArray(candidate.seenMessageIds)
}

function isClaim(value: unknown): value is ImapClaim {
  return typeof value === 'object' && value !== null && typeof (value as ImapClaim).recordedAt === 'number'
}

function isAttempt(value: unknown): value is ImapAttempt {
  return typeof value === 'object'
    && value !== null
    && typeof (value as ImapAttempt).recordedAt === 'number'
    && typeof (value as ImapAttempt).count === 'number'
    && typeof (value as ImapAttempt).reason === 'string'
}

export class ImapStateStore {
  private readonly path: string
  private readonly now: () => number
  private readonly logger: Pick<PluginLogger, 'warn' | 'debug'> | undefined
  private readonly accounts: Record<string, ImapAccountState> = {}
  private readonly claims: Record<string, ImapClaim> = {}
  private readonly attempts: Record<string, ImapAttempt> = {}
  private dirty = false

  private constructor(options: ImapStateOptions) {
    this.path = options.path ?? join(PATHS.dataDir, 'imap-state.json')
    this.now = options.now ?? Date.now
    this.logger = options.logger
  }

  /** Load persisted progress; a missing or unreadable file starts empty. */
  static async open(options: ImapStateOptions = {}): Promise<ImapStateStore> {
    const store = new ImapStateStore(options)
    try {
      const parsed: unknown = JSON.parse(await readFile(store.path, 'utf-8'))
      if (typeof parsed === 'object' && parsed !== null) {
        const file = parsed as Partial<ImapStateFile>
        for (const [id, value] of Object.entries(file.accounts ?? {})) {
          if (isAccountState(value))
            store.accounts[id] = { ...value, skips: value.skips ?? {} }
        }
        const deadline = store.now() - IMAP_CLAIM_TTL_MS
        for (const [key, value] of Object.entries(file.claims ?? {})) {
          if (isClaim(value) && value.recordedAt >= deadline)
            store.claims[key] = value
        }
        for (const [key, value] of Object.entries(file.attempts ?? {})) {
          if (isAttempt(value) && value.recordedAt >= deadline)
            store.attempts[key] = value
        }
      }
    }
    catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') {
        store.logger?.warn(`Discarding unreadable IMAP state at ${store.path}: ${sanitizeBoundedText(toError(error).message, 200)}`)
      }
    }
    return store
  }

  /**
   * Reconcile the stored cursor with the mailbox the server just reported.
   *
   * A first sight of a mailbox only records where "now" is, so enabling the
   * connector never starts runs for the existing backlog; a changed
   * `UIDVALIDITY` means every uid is stale and the same rule applies.
   */
  syncCursor(accountId: string, uidValidity: string, uidNext: number): CursorResult {
    const existing = this.accounts[accountId]
    if (existing?.uidValidity === uidValidity)
      return { kind: 'resume', cursor: { uidValidity, lastSeenUid: existing.lastSeenUid } }

    const lastSeenUid = Math.max(0, uidNext - 1)
    this.accounts[accountId] = emptyAccount(uidValidity, lastSeenUid, this.now())
    this.dirty = true
    return { kind: existing === undefined ? 'baseline' : 'reset', cursor: { uidValidity, lastSeenUid } }
  }

  /** Move the cursor past a message that will not be retried. */
  advanceCursor(accountId: string, uidValidity: string, uid: number): void {
    const state = this.accounts[accountId]
    if (state === undefined || state.uidValidity !== uidValidity)
      return
    state.lastSeenUid = Math.max(state.lastSeenUid, uid)
    state.updatedAt = this.now()
    this.dirty = true
  }

  /** Current cursor for an account, without changing it. */
  peek(accountId: string): ImapCursor | undefined {
    const state = this.accounts[accountId]
    return state === undefined ? undefined : { uidValidity: state.uidValidity, lastSeenUid: state.lastSeenUid }
  }

  /** True when this message id was already admitted. */
  hasMessageId(accountId: string, messageId: string): boolean {
    return this.accounts[accountId]?.seenMessageIds.includes(messageId) ?? false
  }

  rememberMessage(accountId: string, messageId: string): void {
    const state = this.accounts[accountId]
    if (state === undefined)
      return
    state.seenMessageIds = [...state.seenMessageIds.filter(seen => seen !== messageId), messageId].slice(-IMAP_SEEN_LIMIT)
    state.updatedAt = this.now()
    this.dirty = true
  }

  /** Record a message Giclaw deliberately ignored, without moving the cursor. */
  countSkip(accountId: string, reason: string): void {
    const state = this.accounts[accountId]
    if (state === undefined)
      return
    state.skips[reason] = Math.min((state.skips[reason] ?? 0) + 1, 1_000_000)
    state.updatedAt = this.now()
    this.dirty = true
  }

  /** Claim a message idempotently; `false` means another sweep already has it. */
  claim(key: string): boolean {
    if (this.claims[key] !== undefined)
      return false
    this.claims[key] = { recordedAt: this.now() }
    this.dirty = true
    return true
  }

  /** Give a claim back so the next sweep retries the message. */
  releaseClaim(key: string): void {
    if (this.claims[key] === undefined)
      return
    delete this.claims[key]
    this.dirty = true
  }

  /** Count a rejected attempt; the caller drops the message at the limit. */
  recordAttempt(key: string, reason: string): number {
    const previous = this.attempts[key]
    const count = (previous?.count ?? 0) + 1
    this.attempts[key] = { recordedAt: this.now(), count, reason }
    this.dirty = true
    return count
  }

  /** Persist only when something changed; failures are surfaced to the caller. */
  async save(): Promise<void> {
    if (!this.dirty)
      return
    await atomicWritePrivateFile(this.path, `${JSON.stringify(this.toJSON(), null, 2)}\n`)
    this.dirty = false
    this.logger?.debug(`Persisted IMAP progress for ${Object.keys(this.accounts).length} account(s)`)
  }

  toJSON(): ImapStateFile {
    return { version: IMAP_STATE_VERSION, accounts: this.accounts, claims: this.claims, attempts: this.attempts }
  }
}

/** Stable per-message key: the account, the uid validity epoch and the uid. */
export function messageKey(accountId: string, uidValidity: string, uid: number): string {
  return `${accountId}:${uidValidity}:${uid}`
}
