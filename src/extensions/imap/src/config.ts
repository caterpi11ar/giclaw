import type { PluginConfigSchema } from '../../../plugin-sdk/index.js'
import { z } from 'zod'

/**
 * IMAP inbound mail.
 *
 * Giclaw addition over openclaw's inbound-only mail channel: the mailbox is
 * watched by a service, and an accepted message maps onto a configured routine
 * or task list — message text is never interpreted as an instruction.
 *
 * The field names, defaults and the trust ladder of `senderAuth` follow
 * openclaw's `extensions/imap/src/config.ts`; the parts that steer an agent
 * (`agentId`, `deliver`, `model`, `thinking`, `timeoutSeconds`, `includeBody`)
 * have no Giclaw equivalent and are replaced by `routine` / `tasks`.
 */

/** Account ids appear in state files and logs, so keep them boring. */
export const IMAP_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][\w-]*$/u

export const DEFAULT_IMAP_PORT = 993
export const DEFAULT_IMAP_MAILBOX = 'INBOX'
export const DEFAULT_IMAP_POLL_SECONDS = 60
export const DEFAULT_IMAP_MAX_BYTES = 20_000
export const DEFAULT_IMAP_RATE_LIMIT = { limit: 30, windowMs: 3_600_000 } as const
/** Same ladder as openclaw's `IdentifierAuthentication`, weakest → strongest. */
export const IMAP_SENDER_STRENGTHS = ['mutable', 'unverified', 'asserted', 'verified'] as const
export const IMAP_WATCH_MODES = ['auto', 'idle', 'interval'] as const

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase())
}

const rateLimitSchema = z.object({
  limit: z.number().int().min(1).max(1_000).default(DEFAULT_IMAP_RATE_LIMIT.limit),
  windowMs: z.number().int().min(1_000).max(86_400_000).default(DEFAULT_IMAP_RATE_LIMIT.windowMs),
})

/** How the mailbox is watched. `auto` uses IDLE when the server offers it. */
const watchSchema = z.object({
  mode: z.enum(IMAP_WATCH_MODES).default('auto'),
  /** Seconds between reconciliations; also the floor when a poll fails. */
  pollSeconds: z.number().int().min(15).max(3_600).default(DEFAULT_IMAP_POLL_SECONDS),
})

/**
 * How much authentication a sender must prove.
 *
 * `min` is the floor from `meetsIdentifierAuthentication`: `verified` means a
 * DMARC pass (or an aligned DKIM signature) computed by Giclaw itself,
 * `asserted` accepts a passing result from a `trustedAuthservIds` delivery
 * agent, `unverified` accepts any DKIM/SPF evidence, and `mutable` accepts the
 * bare `From` header.
 */
const senderAuthSchema = z.object({
  min: z.enum(IMAP_SENDER_STRENGTHS).default('verified'),
  trustedAuthservIds: z.array(z.string().min(1).max(255)).max(50).default([]),
  acceptTrustedAuthservId: z.boolean().default(false),
})

/** A plus-address token that proves the sender knows a secret suffix. */
const addressTokenSchema = z.object({
  token: z.string().min(1).max(128),
  senders: z.array(z.string().min(3).max(320)).min(1).max(100),
})

export const imapAccountSchema = z
  .object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65_535).default(DEFAULT_IMAP_PORT),
    /** Implicit TLS on connect (IMAPS). `false` performs STARTTLS. */
    secure: z.boolean().default(true),
    rejectUnauthorized: z.boolean().default(true),
    user: z.string().min(1).max(320).refine(value => !/[\r\n\0]/u.test(value), 'must not contain control characters'),
    password: z.string().min(1).max(4_096).refine(value => !/[\r\n\0]/u.test(value), 'must not contain control characters'),
    mailbox: z.string().min(1).max(255).default(DEFAULT_IMAP_MAILBOX),
    watch: watchSchema.default({}),
    /** Sender addresses allowed to start a run; `@domain` allows a whole domain. */
    allowedSenders: z.array(z.string().min(3).max(320)).min(1).max(100),
    senderAuth: senderAuthSchema.default({}),
    addressTokens: z.array(addressTokenSchema).max(50).default([]),
    routine: z.string().min(1).max(100).optional(),
    tasks: z.array(z.string().min(1).max(100)).max(20).default([]),
    /** Largest message body Giclaw will read into a log snippet. */
    maxBytes: z.number().int().min(256).max(1_048_576).default(DEFAULT_IMAP_MAX_BYTES),
    rateLimit: rateLimitSchema.default({}),
  })
  .refine(config => config.secure || isLoopbackHost(config.host), {
    message: 'STARTTLS without implicit TLS is only allowed for a loopback host',
    path: ['secure'],
  })

export type ImapAccount = z.infer<typeof imapAccountSchema>
export type ImapWatchMode = (typeof IMAP_WATCH_MODES)[number]

export const imapConfigSchema = z.object({
  accounts: z.record(z.string().regex(IMAP_ACCOUNT_ID_PATTERN, 'must be a simple account id'), imapAccountSchema).default({}),
})

export type ImapConfig = z.infer<typeof imapConfigSchema>

export const imapPluginConfig: PluginConfigSchema<ImapConfig> = {
  parse: input => imapConfigSchema.parse(input ?? {}),
}

export interface ImapAccountEntry {
  id: string
  account: ImapAccount
}

/** Stable account order so start-up and reporting never depend on key order. */
export function listImapAccounts(config: ImapConfig): ImapAccountEntry[] {
  return Object.entries(config.accounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, account]) => ({ id, account }))
}

/** Task ids for an account: its routine, else its tasks, else the gateway default. */
export function resolveImapTaskIds(
  account: ImapAccount,
  resolveRoutine: (name: string) => string[] | null,
): string[] | null | undefined {
  if (account.routine !== undefined)
    return resolveRoutine(account.routine)
  return account.tasks.length > 0 ? account.tasks : undefined
}
