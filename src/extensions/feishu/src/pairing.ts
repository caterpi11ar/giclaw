/**
 * DM pairing store for the Feishu channel (openclaw parity).
 *
 * openclaw's default `dmPolicy` is `pairing`: a stranger's direct message is
 * answered with a short-lived pairing code and dropped, and the operator
 * approves the sender out-of-band. The store keeps the approved senders and the
 * outstanding requests, so the policy has somewhere to read from.
 *
 * The file lives in the private data directory (`0o600` inside `0o700`) and is
 * written atomically; read-modify-write cycles are serialized in-process so two
 * concurrent events cannot lose each other's update.
 *
 * openclaw keeps its channel pairing queue in the gateway's store and surfaces
 * it through the Control UI; Giclaw has no gateway store, so the plugin owns an
 * equally small JSON file. The observable contract is the same: an 8-character
 * code, one hour to approve it, three outstanding requests per account.
 */
import { randomInt } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWritePrivateFile, PATHS } from '../../../config/paths.js'
import { toError } from '../../../utils/errors.js'
import { sanitizeBoundedText } from '../../../utils/logger.js'

/** Pairing codes are case-insensitive and avoid look-alike characters. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** openclaw: "8 characters, uppercase, no ambiguous chars (`0O1I`)". */
export const PAIRING_CODE_LENGTH = 8
/** A pending request older than this can no longer be approved. */
export const PAIRING_REQUEST_TTL_MS = 60 * 60 * 1_000
/**
 * Outstanding requests per account (openclaw `CHANNEL_PAIRING_PENDING_MAX`):
 * once the queue is full, further requests are ignored until one expires,
 * is approved or is dismissed.
 */
export const MAX_PENDING_PAIRING_REQUESTS = 3
/** Bound on approved senders per account. */
export const MAX_APPROVED_SENDERS = 500
export const PAIRING_STORE_VERSION = 1

export interface PendingPairingRequest {
  /** Canonical `user:<id>` subjects the requester may be identified by. */
  subjects: string[]
  createdAt: string
}

export interface FeishuPairingAccount {
  approved: string[]
  pending: Record<string, PendingPairingRequest>
}

export interface FeishuPairingFile {
  version: number
  accounts: Record<string, FeishuPairingAccount>
}

export interface FeishuPairingStoreOptions {
  path?: string
  now?: () => number
  logger?: { warn: (message: string) => void }
  /** Injectable so a test can pin the (astronomically unlikely) code collision. */
  generateCode?: () => string
}

/**
 * `code: null` means the request was refused because the account already holds
 * `MAX_PENDING_PAIRING_REQUESTS` outstanding requests.
 */
export interface PairingRequestOutcome {
  code: string | null
  created: boolean
}

export type PairingApprovalResult
  = | { ok: true, subjects: string[], alreadyApproved: boolean }
    | { ok: false, reason: 'unknown-code' }

const FILE_NAME = 'feishu-pairing.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function parseAccount(value: unknown): FeishuPairingAccount {
  if (!isRecord(value))
    return { approved: [], pending: {} }
  const pending: Record<string, PendingPairingRequest> = {}
  if (isRecord(value.pending)) {
    for (const [code, request] of Object.entries(value.pending)) {
      if (!isRecord(request))
        continue
      pending[code] = {
        subjects: stringArray(request.subjects),
        createdAt: typeof request.createdAt === 'string' ? request.createdAt : new Date(0).toISOString(),
      }
    }
  }
  return { approved: stringArray(value.approved), pending }
}

/** Generate a pairing code; `randomInt` is rejection-sampled, not modulo-biased. */
export function generatePairingCode(length = PAIRING_CODE_LENGTH): string {
  let code = ''
  for (let index = 0; index < length; index += 1)
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)]
  return code
}

/** Canonical form of a pairing code as typed by the operator. */
export function normalizePairingCode(value: string): string {
  return value.trim().toUpperCase()
}

/** Prune requests past the TTL so a forgotten code can no longer be approved. */
export function pruneExpired(
  account: FeishuPairingAccount,
  nowMs: number,
): FeishuPairingAccount {
  const pending: Record<string, PendingPairingRequest> = {}
  for (const [code, request] of Object.entries(account.pending)) {
    if (nowMs - Date.parse(request.createdAt) <= PAIRING_REQUEST_TTL_MS)
      pending[code] = request
  }
  return { approved: account.approved, pending }
}

export class FeishuPairingStore {
  private readonly path: string
  private readonly now: () => number
  private readonly logger?: { warn: (message: string) => void }
  private readonly generateCode: () => string
  private data: FeishuPairingFile = { version: PAIRING_STORE_VERSION, accounts: {} }
  /** Resolves once the on-disk state has been read (or found absent). */
  private ready: Promise<void> = Promise.resolve()
  /** Serializes read-modify-write cycles so concurrent events cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(options: FeishuPairingStoreOptions) {
    this.path = options.path ?? join(PATHS.dataDir, FILE_NAME)
    this.now = options.now ?? Date.now
    this.logger = options.logger
    this.generateCode = options.generateCode ?? generatePairingCode
  }

  /**
   * Open the store, loading the file before the first operation.
   *
   * Plugin registration must not await I/O (the host reads its registries as
   * soon as `register` returns), so construction is synchronous and every
   * operation awaits {@link ready} first.
   */
  static create(options: FeishuPairingStoreOptions = {}): FeishuPairingStore {
    const store = new FeishuPairingStore(options)
    store.ready = store.load()
    return store
  }

  /** Load persisted state; a missing or unreadable file starts empty. */
  static async open(options: FeishuPairingStoreOptions = {}): Promise<FeishuPairingStore> {
    const store = FeishuPairingStore.create(options)
    await store.ready
    return store
  }

  private async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf-8'))
      if (isRecord(parsed) && isRecord(parsed.accounts)) {
        for (const [accountId, account] of Object.entries(parsed.accounts))
          this.data.accounts[accountId] = parseAccount(account)
      }
    }
    catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.logger?.warn(
          `Discarding unreadable Feishu pairing store at ${this.path}: ${sanitizeBoundedText(toError(error).message, 200)}`,
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

  private prune(accountId: string): FeishuPairingAccount {
    const pruned = pruneExpired(this.account(accountId), this.now())
    this.data.accounts[accountId] = pruned
    return pruned
  }

  private account(accountId: string): FeishuPairingAccount {
    return this.data.accounts[accountId] ?? { approved: [], pending: {} }
  }

  private async save(): Promise<void> {
    await atomicWritePrivateFile(this.path, `${JSON.stringify(this.data)}\n`)
  }

  /** Approved canonical subjects for one account. */
  async readApproved(accountId: string): Promise<string[]> {
    await this.ready
    return this.prune(accountId).approved
  }

  /**
   * Record a pairing request and return the code the sender should be told.
   *
   * A repeated request from the same subject reuses the outstanding code, so a
   * retried event cannot burn through codes or spam the operator. A full queue
   * refuses the request instead of evicting someone else's (openclaw parity).
   */
  async request(params: {
    accountId: string
    subjects: string[]
  }): Promise<PairingRequestOutcome> {
    return this.serialize(async () => {
      const account = this.prune(params.accountId)
      const wanted = new Set(params.subjects)
      const existing = Object.entries(account.pending)
        .find(([, request]) => request.subjects.some(subject => wanted.has(subject)))
      if (existing)
        return { code: existing[0], created: false }

      if (Object.keys(account.pending).length >= MAX_PENDING_PAIRING_REQUESTS)
        return { code: null, created: false }

      const code = this.uniqueCode(account.pending)
      account.pending[code] = {
        subjects: [...wanted],
        createdAt: new Date(this.now()).toISOString(),
      }
      await this.save()
      return { code, created: true }
    })
  }

  /** Drop one pending request without approving it (openclaw: "Dismiss"). */
  async dismiss(accountId: string, rawCode: string): Promise<boolean> {
    return this.serialize(async () => {
      const account = this.prune(accountId)
      const code = normalizePairingCode(rawCode)
      if (!account.pending[code])
        return false
      delete account.pending[code]
      await this.save()
      return true
    })
  }

  /** Approve a pending code, moving its subjects into the approved list. */
  async approve(accountId: string, rawCode: string): Promise<PairingApprovalResult> {
    return this.serialize(async () => {
      const account = this.prune(accountId)
      const code = normalizePairingCode(rawCode)
      const request = account.pending[code]
      if (!request)
        return { ok: false, reason: 'unknown-code' }

      delete account.pending[code]
      const alreadyApproved = request.subjects.every(subject => account.approved.includes(subject))
      account.approved = [...new Set([...account.approved, ...request.subjects])].slice(-MAX_APPROVED_SENDERS)
      await this.save()
      return { ok: true, subjects: request.subjects, alreadyApproved }
    })
  }

  /** Remove an approved sender; returns whether it was present. */
  async revoke(accountId: string, subject: string): Promise<boolean> {
    return this.serialize(async () => {
      const account = this.account(accountId)
      if (!account.approved.includes(subject))
        return false
      account.approved = account.approved.filter(entry => entry !== subject)
      await this.save()
      return true
    })
  }

  /** Pending requests for one account, expired entries removed. */
  async listPending(accountId: string): Promise<Record<string, PendingPairingRequest>> {
    await this.ready
    return this.prune(accountId).pending
  }

  /** Every account id that has approved senders or pending requests. */
  async listAccountIds(): Promise<string[]> {
    await this.ready
    return Object.keys(this.data.accounts)
  }

  private uniqueCode(pending: Record<string, PendingPairingRequest>): string {
    let code = this.generateCode()
    while (Object.hasOwn(pending, code))
      code = this.generateCode()
    return code
  }
}
