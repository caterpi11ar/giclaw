import type { ParsedMail } from 'mailparser'
import type { Buffer } from 'node:buffer'
import type { PluginRuntime } from '../../../plugin-sdk/index.js'
import type { PluginLogger } from '../../../plugins/types.js'
import type { ImapAccount } from './config.js'
import type { MailAuthenticator } from './sender-gate.js'
import type { ImapStateStore } from './state.js'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { createRateLimiter } from '../../../plugin-sdk/index.js'
import { toError } from '../../../utils/errors.js'
import { sanitizeBoundedText } from '../../../utils/logger.js'
import { resolveImapTaskIds } from './config.js'
import { evaluateImapSender } from './sender-gate.js'
import { messageKey } from './state.js'

/**
 * Watch one mailbox and start a configured routine for each acceptable message.
 *
 * Ported from openclaw's `extensions/imap/src/watcher.ts`: a read-only mailbox,
 * a server-push (`IDLE`) connection with an interval reconciliation, bounded
 * reconnection with jitter, at-least-once dispatch with bounded retries, and
 * persisted per-account progress. Giclaw has no agent session to steer, so an
 * accepted message only selects which task list or routine runs.
 *
 * Giclaw additions: a per-sender rate limit, and dispatch through the plugin
 * runtime's `enqueueRun` instead of a hook turn.
 */

/** The largest message Giclaw will read; a bigger one is fetched truncated. */
export const MAX_SOURCE_BYTES = 1_048_576
/** Attempts per message before it is dropped, matching openclaw. */
export const MAX_ATTEMPTS = 3
export const MAX_RECONNECT_DELAY_MS = 60_000

/** The slice of `ImapFlow` the watcher uses, so tests can drive it directly. */
export interface ImapWatcherClient {
  capabilities: Set<string>
  connect: () => Promise<void>
  close: () => void
  mailboxOpen: (path: string, options: { readOnly: boolean }) => Promise<{ uidValidity: bigint, uidNext: number, exists: number }>
  fetch: (range: string, query: unknown, options: { uid: boolean }) => AsyncIterable<ImapWatcherMessage>
  on: (event: string, listener: (arg?: unknown) => void) => void
  once: (event: string, listener: (arg?: unknown) => void) => void
}

export interface ImapWatcherMessage {
  uid: number
  size?: number
  internalDate?: Date | string
  source?: Buffer
}

export interface ImapWatcherOptions {
  accountId: string
  account: ImapAccount
  runtime: PluginRuntime
  state: ImapStateStore
  logger: PluginLogger
  /** Injected in tests; defaults to a real `ImapFlow` client. */
  createClient?: () => ImapWatcherClient
  /** Injected in tests; defaults to `mailparser`'s `simpleParser`. */
  parse?: (source: Buffer) => Promise<ParsedMail>
  authenticator?: MailAuthenticator
  reconnectBaseMs?: number
  now?: () => number
  random?: () => number
}

interface DispatchOutcome {
  ok: boolean
  detail: string
}

/** Bound a log snippet so one huge subject cannot flood the log file. */
export function snippet(value: string, limit = 280): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/** Parse just enough MIME to answer who sent it, what it is called and when. */
async function parseMessage(source: Buffer): Promise<ParsedMail> {
  return await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true })
}

function senderDomain(sender: string | undefined): string {
  return sender?.split('@').at(-1)?.toLowerCase() ?? 'unknown'
}

function messageDate(message: ImapWatcherMessage): Date {
  const date = message.internalDate
  if (date instanceof Date)
    return date
  if (typeof date === 'string') {
    const parsed = new Date(date)
    if (!Number.isNaN(parsed.getTime()))
      return parsed
  }
  return new Date()
}

export class ImapAccountWatcher {
  private readonly options: ImapWatcherOptions
  private readonly logger: PluginLogger
  private readonly limiter: ReturnType<typeof createRateLimiter>
  private client: ImapWatcherClient | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private activeSweep: Promise<void> | undefined
  private activeConnection: Promise<void> | undefined
  private stopping = false
  private failures = 0
  private authFailures = 0
  private reconnectPending = false
  private sweepPending = false

  constructor(options: ImapWatcherOptions) {
    this.options = options
    this.logger = options.logger
    this.limiter = createRateLimiter({
      limit: options.account.rateLimit.limit,
      windowMs: options.account.rateLimit.windowMs,
      ...(options.now ? { now: options.now } : {}),
    })
  }

  /** Connect and reconcile until `stop()`. A bad config never throws. */
  start(): void {
    if (this.options.account.allowedSenders.length === 0) {
      this.logger.warn(`imap: account=${this.options.accountId} disabled; configure allowedSenders before watching`)
      return
    }
    this.startConnection()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const client = this.client
    this.client = undefined
    client?.close()
    await Promise.allSettled([this.activeConnection, this.activeSweep])
  }

  private startConnection(): void {
    if (this.stopping || this.activeConnection !== undefined)
      return
    const pending = this.connect().then(
      () => undefined,
      (error: unknown) => this.handleConnectionFailure(error),
    )
    this.activeConnection = pending.then(() => {
      this.activeConnection = undefined
      if (this.reconnectPending && !this.stopping)
        this.scheduleReconnect()
    })
  }

  private async connect(): Promise<void> {
    // Finish the previous connection's admission before reinitialising its cursor.
    await this.activeSweep
    if (this.stopping)
      return
    const { accountId, account } = this.options
    const client = this.createClient()
    this.client = client
    client.on('error', (error) => {
      if (!this.stopping && this.client === client)
        this.logger.warn(`imap: account=${accountId} connection error=${describe(error)}`)
    })
    client.once('close', () => {
      if (!this.stopping && this.client === client) {
        this.client = undefined
        this.scheduleReconnect()
      }
    })

    await client.connect()
    if (this.stopping || this.client !== client) {
      client.close()
      return
    }

    const mailbox = await client.mailboxOpen(account.mailbox, { readOnly: true })
    // Check before touching persisted state: an abandoned connection must not
    // advance or reset the cursor of the connection that replaced it.
    if (this.stopping || this.client !== client)
      return
    const cursor = this.options.state.syncCursor(accountId, mailbox.uidValidity.toString(), mailbox.uidNext)
    if (cursor.kind !== 'resume')
      this.logger.info(`imap: account=${accountId} cursor=${cursor.kind} uidValidity=${cursor.cursor.uidValidity} uid=${cursor.cursor.lastSeenUid}`)

    const supportsIdle = client.capabilities.has('IDLE')
    const push = account.watch.mode !== 'interval' && supportsIdle
    if (account.watch.mode === 'idle' && !supportsIdle)
      this.logger.warn(`imap: account=${accountId} server has no IDLE capability; using polling`)

    this.authFailures = 0
    this.failures = 0
    this.logger.info(`imap: account=${accountId} mode=${push ? 'push' : 'poll'} mailbox=${account.mailbox}`)
    if (push) {
      client.on('exists', () => {
        this.requestSweep()
      })
    }
    // IDLE reports mailbox changes, not retry readiness. Reconcile on the same
    // cadence in both modes so a quiet inbox cannot strand a rejected admission.
    this.pollTimer = setInterval(() => this.requestSweep(), account.watch.pollSeconds * 1_000)
    this.pollTimer.unref?.()
    // A reconnect always sweeps persisted state, closing the notification gap.
    if (cursor.kind === 'resume')
      this.requestSweep()
  }

  private handleConnectionFailure(error: unknown): void {
    if (this.stopping)
      return
    const accountId = this.options.accountId
    if (isAuthenticationFailure(error) && ++this.authFailures >= MAX_ATTEMPTS) {
      this.logger.error(`imap: account=${accountId} needs reauthentication after ${MAX_ATTEMPTS} authentication failures; update its password and reload configuration`)
      this.client?.close()
      this.client = undefined
      return
    }
    this.logger.warn(`imap: account=${accountId} connection failed=${describe(error)}`)
    this.client?.close()
    this.client = undefined
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer !== undefined || this.authFailures >= MAX_ATTEMPTS)
      return
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    if (this.activeConnection !== undefined) {
      this.reconnectPending = true
      return
    }
    this.reconnectPending = false
    const base = this.options.reconnectBaseMs ?? 1_000
    const delay = Math.min(base * 2 ** this.failures, MAX_RECONNECT_DELAY_MS)
    this.failures += 1
    const random = this.options.random ?? Math.random
    const jitter = Math.floor(random() * Math.max(1, delay / 4))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.startConnection()
    }, delay + jitter)
    this.reconnectTimer.unref?.()
  }

  private requestSweep(): void {
    const client = this.client
    if (this.stopping || client === undefined)
      return
    if (this.activeSweep !== undefined) {
      // A wakeup during a sweep must queue a follow-up: the running sweep
      // snapshotted its uid range, so dropping the wakeup would strand the
      // new message until the next unrelated event or reconnect.
      this.sweepPending = true
      return
    }
    this.activeSweep = this.sweep(client).then(
      () => undefined,
      (error: unknown) => {
        if (!this.stopping)
          this.logger.warn(`imap: account=${this.options.accountId} sweep failed=${describe(error)}`)
      },
    ).then(() => {
      this.activeSweep = undefined
      if (this.sweepPending && !this.stopping) {
        this.sweepPending = false
        this.requestSweep()
      }
    })
  }

  /** Read every message after the cursor, oldest first. Never rejects. */
  async sweep(client: ImapWatcherClient): Promise<void> {
    const { accountId, state } = this.options
    const cursor = state.peek(accountId)
    if (cursor === undefined || this.stopping || this.client !== client)
      return
    const messages: ImapWatcherMessage[] = []
    for await (const message of client.fetch(`${cursor.lastSeenUid + 1}:*`, {
      uid: true,
      internalDate: true,
      size: true,
      source: { maxLength: MAX_SOURCE_BYTES },
    }, { uid: true })) {
      // IMAP `N:*` returns the final message even when its uid is below `N`.
      if (message.uid > cursor.lastSeenUid)
        messages.push(message)
    }
    for (const message of messages.toSorted((left, right) => left.uid - right.uid)) {
      if (this.stopping || this.client !== client || !(await this.processMessage(message, cursor.uidValidity)))
        break
      state.advanceCursor(accountId, cursor.uidValidity, message.uid)
    }
    await this.persist()
    this.logger.debug(`imap: account=${accountId} lastSweep=${new Date(this.now()).toISOString()} messages=${messages.length}`)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private createClient(): ImapWatcherClient {
    if (this.options.createClient !== undefined)
      return this.options.createClient()
    const { account } = this.options
    return new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.secure,
      tls: { rejectUnauthorized: account.rejectUnauthorized },
      auth: { user: account.user, pass: account.password },
      logger: false,
      maxIdleTime: 4 * 60_000,
      socketTimeout: 3 * 60_000,
      missingIdleCommand: 'NOOP',
      maxLiteralSize: MAX_SOURCE_BYTES + 8_192,
      maxResponseSize: MAX_SOURCE_BYTES + 32_768,
    }) as unknown as ImapWatcherClient
  }

  private async processMessage(message: ImapWatcherMessage, uidValidity: string): Promise<boolean> {
    const { accountId, account, state, runtime } = this.options
    const key = messageKey(accountId, uidValidity, message.uid)
    if (message.source === undefined) {
      this.recordSkip(message.uid, undefined, 'message-source-missing')
      return true
    }

    const mail = await this.parse(message.source)
    const verdict = await evaluateImapSender({
      mail,
      raw: message.source,
      internalDate: messageDate(message),
      account,
      ...(this.options.authenticator ? { authenticator: this.options.authenticator } : {}),
      now: () => this.now(),
    })

    if (!verdict.accepted) {
      if (verdict.transient && state.recordAttempt(key, verdict.reason) < MAX_ATTEMPTS) {
        this.logger.warn(`imap: account=${accountId} uid=${message.uid} domain=${senderDomain(verdict.sender)} gate=${verdict.reason} retry=true`)
        return false
      }
      state.claim(key)
      this.recordSkip(message.uid, verdict.sender, verdict.reason)
      return true
    }

    if (!this.limiter.allow(verdict.sender)) {
      this.recordSkip(message.uid, verdict.sender, 'rate-limited')
      return true
    }
    if (mail.messageId !== undefined && state.hasMessageId(accountId, mail.messageId)) {
      this.recordSkip(message.uid, verdict.sender, 'duplicate-message-id')
      return true
    }
    if (!state.claim(key)) {
      this.recordSkip(message.uid, verdict.sender, 'duplicate-uid')
      return true
    }

    const taskIds = resolveImapTaskIds(account, name => runtime.gateway.resolveRoutine(name))
    if (taskIds === null) {
      this.recordSkip(message.uid, verdict.sender, 'routine-not-configured')
      return true
    }

    const outcome = await this.dispatch(taskIds)
    if (outcome.ok) {
      if (mail.messageId !== undefined)
        state.rememberMessage(accountId, mail.messageId)
      const gate = verdict.reason === 'token' ? 'gate=token' : `strength=${verdict.strength}`
      this.logger.info(`imap: account=${accountId} uid=${message.uid} domain=${senderDomain(verdict.sender)} subject=${snippet(mail.subject ?? '', 80)} ${gate}`)
      return true
    }

    state.releaseClaim(key)
    if (state.recordAttempt(key, 'dispatch-rejected') < MAX_ATTEMPTS) {
      this.logger.warn(`imap: account=${accountId} uid=${message.uid} dispatch rejected=${outcome.detail}`)
      return false
    }
    state.claim(key)
    this.recordSkip(message.uid, verdict.sender, 'dispatch-rejected')
    return true
  }

  /** One run admission; a rejected queue is a retryable `ok: false`. */
  private async dispatch(taskIds: string[] | undefined): Promise<DispatchOutcome> {
    return this.options.runtime.gateway.enqueueRun(taskIds).then(
      result => ({ ok: true, detail: `${result.results.length} task(s)` }),
      (error: unknown) => ({ ok: false, detail: sanitizeBoundedText(toError(error).message, 200) }),
    )
  }

  private recordSkip(uid: number, sender: string | undefined, reason: string): void {
    this.options.state.countSkip(this.options.accountId, reason)
    this.logger.warn(`imap: account=${this.options.accountId} uid=${uid} domain=${senderDomain(sender)} gate=${reason}`)
  }

  private parse(source: Buffer): Promise<ParsedMail> {
    if (this.options.parse !== undefined)
      return this.options.parse(source)
    return parseMessage(source)
  }

  private async persist(): Promise<void> {
    await this.options.state.save().then(
      () => undefined,
      (error: unknown) => {
        this.logger.warn(`imap: account=${this.options.accountId} could not persist progress: ${sanitizeBoundedText(toError(error).message, 200)}`)
      },
    )
  }
}

function describe(error: unknown): string {
  return sanitizeBoundedText(toError(error).message, 200)
}

function isAuthenticationFailure(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'authenticationFailed' in error
    && (error as { authenticationFailed?: unknown }).authenticationFailed === true
}
