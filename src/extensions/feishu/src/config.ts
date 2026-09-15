import type { PluginConfigSchema } from '../../../plugin-sdk/index.js'
import { z } from 'zod'
import { hasNoUrlCredentials, isHttpsOrLoopbackHttp } from '../../../utils/url.js'
import {
  evaluateDmPolicyAllowFromDependency,
  FEISHU_DM_POLICIES,
  FEISHU_GROUP_POLICIES,
  FEISHU_GROUP_POLICY_ALIAS,
  normalizeFeishuAllowList,
} from './policy.js'

/** Receiver identifier kinds accepted by `POST /open-apis/im/v1/messages`. */
export const RECEIVE_ID_TYPES = ['chat_id', 'open_id', 'user_id', 'union_id', 'email'] as const
export type ReceiveIdType = (typeof RECEIVE_ID_TYPES)[number]

const outboundUrlSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine(isHttpsOrLoopbackHttp, 'must use HTTPS unless the host is loopback')
  .refine(hasNoUrlCredentials, 'must not contain credentials')

const targetSchema = z.object({
  chatId: z.string().min(1).max(200).optional(),
  receiveIdType: z.enum(RECEIVE_ID_TYPES).default('chat_id'),
  webhookUrl: outboundUrlSchema.optional(),
})

/** Feishu (CN) open platform origin. */
export const DEFAULT_FEISHU_BASE_URL = 'https://open.feishu.cn'
/** Lark (international) open platform origin. */
export const DEFAULT_FEISHU_LARK_BASE_URL = 'https://open.larksuite.com'

/** Tenant domains accepted by `domain`, mirroring openclaw's `FeishuDomainSchema`. */
export const FEISHU_DOMAINS = ['feishu', 'lark'] as const
export type FeishuDomain = (typeof FEISHU_DOMAINS)[number]

/** Default event-callback path of the self-built app subscription. */
export const DEFAULT_FEISHU_INBOUND_PATH = '/feishu/events'

/** Default bind host of openclaw's callback server; see `webhookHost`. */
export const DEFAULT_FEISHU_WEBHOOK_HOST = '127.0.0.1'
/** Default bind port of openclaw's callback server; see `webhookPort`. */
export const DEFAULT_FEISHU_WEBHOOK_PORT = 3000

/** Default outbound API timeout (openclaw `FEISHU_HTTP_TIMEOUT_MS`). */
export const FEISHU_HTTP_TIMEOUT_MS = 30_000
/** Upper bound accepted for `httpTimeoutMs` (openclaw parity). */
export const FEISHU_HTTP_TIMEOUT_MAX_MS = 300_000

/**
 * Event transport (openclaw: `channels.feishu.connectionMode`).
 *
 * `websocket` dials out to Feishu over a long-lived connection, so no public
 * URL, reverse proxy or tunnel is needed — LAN and NAT hosts work. `webhook`
 * receives Feishu's HTTP callback and therefore needs a reachable endpoint.
 */
export const FEISHU_CONNECTION_MODES = ['websocket', 'webhook'] as const
export type FeishuConnectionMode = (typeof FEISHU_CONNECTION_MODES)[number]

/** Event type emitted for a message sent to a chat the app is a member of. */
export const FEISHU_MESSAGE_EVENT_TYPE = 'im.message.receive_v1'

/**
 * Every event type `monitor.account.ts` subscribes to (openclaw parity).
 *
 * These are the wire values Feishu puts in `header.event_type` and the keys
 * `Lark.EventDispatcher.register` expects. Subscribing to the full set keeps the
 * Feishu console subscription and the runtime in sync; events Giclaw has no
 * consumer for are accepted and dropped, which is what openclaw does for
 * `message_read` too.
 */
export const FEISHU_EVENT_TYPES = [
  FEISHU_MESSAGE_EVENT_TYPE,
  'im.message.message_read_v1',
  'im.chat.access_event.bot_p2p_chat_entered_v1',
  'im.chat.member.bot.added_v1',
  'im.chat.member.bot.deleted_v1',
  'im.message.reaction.created_v1',
  'im.message.reaction.deleted_v1',
  'application.bot.menu_v6',
  'card.action.trigger',
  'drive.notice.comment_add_v1',
  'vc.bot.meeting_invited_v1',
] as const
export type FeishuEventType = (typeof FEISHU_EVENT_TYPES)[number]

const FEISHU_EVENT_TYPE_SET: ReadonlySet<string> = new Set(FEISHU_EVENT_TYPES)

/** Whether a value is one of the subscribed event types. */
export function isFeishuEventType(value: unknown): value is FeishuEventType {
  return typeof value === 'string' && FEISHU_EVENT_TYPE_SET.has(value)
}

/**
 * Event types that map onto a configured routine or task list. Every other
 * subscribed event is observed (logged, de-duplicated) but never triggers.
 */
export const FEISHU_TRIGGER_EVENT_TYPES = [
  FEISHU_MESSAGE_EVENT_TYPE,
  'application.bot.menu_v6',
  'card.action.trigger',
] as const

const FEISHU_TRIGGER_EVENT_TYPE_SET: ReadonlySet<string> = new Set(FEISHU_TRIGGER_EVENT_TYPES)

/** Whether a subscribed event maps onto a configured routine. */
export function isFeishuTriggerEventType(value: FeishuEventType): boolean {
  return FEISHU_TRIGGER_EVENT_TYPE_SET.has(value)
}

/**
 * Canonicalize a configured callback path (openclaw `normalizeFeishuWebhookPath`).
 *
 * Returns `null` when the value cannot be a request target; a valid value is
 * always returned unchanged so the configured wire target stays exact.
 */
export function normalizeFeishuWebhookPath(value?: string): string | null {
  const configured = value?.trim()
  if (!configured)
    return DEFAULT_FEISHU_INBOUND_PATH

  return parseWebhookPath(configured, configured.includes('#'))
}

function parseWebhookPath(configured: string, hasFragment: boolean): string | null {
  const parsed = tryParseUrl(configured)
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:'))
    return null
  // URL.search drops a trailing empty query, so preserve an explicitly empty
  // `?` when the operator wrote one and no fragment follows it.
  const emptyQuery = !parsed.search && parsed.href.endsWith('?') && !hasFragment ? '?' : ''
  return `${parsed.pathname}${parsed.search}${emptyQuery}`
}

function tryParseUrl(value: string): URL | null {
  if (!URL.canParse(value, 'http://localhost'))
    return null
  return new URL(value, 'http://localhost')
}

const rateLimitSchema = z.object({
  /** Accepted messages per chat inside `windowMs`. */
  limit: z.number().int().min(1).max(1_000).default(6),
  windowMs: z.number().int().min(1_000).max(86_400_000).default(60_000),
})

/**
 * Routing for events that arrive over either transport.
 *
 * The message text is never interpreted: an accepted event only ever maps onto
 * a configured routine or task list.
 */
const inboundSchema = z.object({
  /** Routine started by an accepted event; takes precedence over `tasks`. */
  routine: z.string().min(1).max(100).optional(),
  tasks: z.array(z.string().min(1).max(100)).max(20).default([]),
  rateLimit: rateLimitSchema.default({}),
})

/** `allowFrom` entries: sender ids as strings, or numeric Feishu user ids. */
const allowFromSchema = z.array(z.union([z.string(), z.number()]))

const dmPolicySchema = z.enum(FEISHU_DM_POLICIES)

/** `groupPolicy`, keeping openclaw's shipped `allowall` alias for `open`. */
const groupPolicySchema = z.union([
  z.enum(FEISHU_GROUP_POLICIES),
  z.literal(FEISHU_GROUP_POLICY_ALIAS).transform(() => 'open' as const),
])

/** Per-chat overrides under `groups.<chatId>` (openclaw `FeishuGroupSchema`). */
const groupEntrySchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    /** Replaces the top-level `groupSenderAllowFrom` list for this chat. */
    allowFrom: allowFromSchema.optional(),
  })
  .strict()

/**
 * Outbound transport keys shared by the top level and every `accounts.<id>`
 * entry, so a multi-tenant deployment can point each account at its own tenant
 * and app credentials. Defaults are applied at the top level only.
 */
const transportShape = {
  /** Outbound credential source: `app` when credentials are present, otherwise `webhook`. */
  mode: z.enum(['app', 'webhook']).optional(),
  /** Custom-bot incoming webhook used when `mode` is `webhook`. */
  webhookUrl: outboundUrlSchema.optional(),
  /** Custom-bot signing secret; enables the `timestamp` + `sign` fields. */
  webhookSecret: z.string().min(1).max(4_096).optional(),
  defaultTarget: z.string().min(1).max(100).optional(),
  targets: z.record(targetSchema).optional(),
  /** Send an interactive card instead of plain text. */
  card: z.boolean().optional(),
  /** Outbound API timeout (openclaw `httpTimeoutMs`). */
  httpTimeoutMs: z.number().int().min(100).max(FEISHU_HTTP_TIMEOUT_MAX_MS).optional(),
}

/** Policy keys shared by the top level and every `accounts.<id>` entry. */
const sharedConfigShape = {
  dmPolicy: dmPolicySchema.optional(),
  allowFrom: allowFromSchema.optional(),
  groupPolicy: groupPolicySchema.optional(),
  groupAllowFrom: allowFromSchema.optional(),
  groupSenderAllowFrom: allowFromSchema.optional(),
  requireMention: z.boolean().optional(),
  groups: z.record(z.string(), groupEntrySchema.optional()).optional(),
  allowBots: z.boolean().optional(),
  /** Bind host of openclaw's own callback server; Giclaw reuses the web server. */
  webhookHost: z.string().min(1).max(255).optional(),
  /** Bind port of openclaw's own callback server; Giclaw reuses `web.port`. */
  webhookPort: z.number().int().min(1).max(65_535).optional(),
}

const webhookPathSchema = z.string().refine(
  value => normalizeFeishuWebhookPath(value) === value,
  'must be a canonical HTTP request path such as "/feishu/events"',
)

const domainSchema = z.union([z.enum(FEISHU_DOMAINS), outboundUrlSchema])

/**
 * Per-account configuration. Every field is optional and inherits from the top
 * level, so a single-account deployment only writes the top-level keys.
 */
export const feishuAccountConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Display name for this account. */
    name: z.string().min(1).max(200).optional(),
    appId: z.string().min(1).max(200).optional(),
    appSecret: z.string().min(1).max(4_096).optional(),
    encryptKey: z.string().min(1).max(4_096).optional(),
    verificationToken: z.string().min(1).max(4_096).optional(),
    domain: domainSchema.optional(),
    connectionMode: z.enum(FEISHU_CONNECTION_MODES).optional(),
    webhookPath: webhookPathSchema.optional(),
    ...transportShape,
    ...sharedConfigShape,
  })
  .strict()

const feishuBaseSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Account used when an operation does not name one; must exist in `accounts`. */
    defaultAccount: z.string().min(1).max(200).optional(),
    /** Inbound event transport; `websocket` needs no public endpoint. */
    connectionMode: z.enum(FEISHU_CONNECTION_MODES).default('websocket'),
    /** Tenant origin: `feishu`, `lark`, or an explicit (loopback-HTTP) base URL. */
    domain: domainSchema.default('feishu'),
    appId: z.string().min(1).max(200).optional(),
    appSecret: z.string().min(1).max(4_096).optional(),
    ...transportShape,
    /** Defaults apply to the top level only; an absent account key inherits them. */
    targets: z.record(targetSchema).default({}),
    card: z.boolean().default(true),
    httpTimeoutMs: z.number().int().min(100).max(FEISHU_HTTP_TIMEOUT_MAX_MS).default(FEISHU_HTTP_TIMEOUT_MS),
    /** v1 verification token; `webhook` mode requires it. */
    verificationToken: z.string().min(1).max(4_096).optional(),
    /** Encrypt key; `webhook` mode requires it, and it enables decryption. */
    encryptKey: z.string().min(1).max(4_096).optional(),
    /** HTTP callback path; only mounted in `webhook` mode. */
    webhookPath: webhookPathSchema.default(DEFAULT_FEISHU_INBOUND_PATH),
    /** Event routing that can trigger a run; omit to stay outbound-only. */
    inbound: inboundSchema.optional(),
    ...sharedConfigShape,
    dmPolicy: dmPolicySchema.default('pairing'),
    groupPolicy: groupPolicySchema.default('allowlist'),
    /** Per-account overrides; every key falls back to the top level. */
    accounts: z.record(z.string(), feishuAccountConfigSchema.optional()).optional(),
  })
  .strict()

export const feishuConfigSchema = feishuBaseSchema.superRefine((value, ctx) => {
  const defaultAccount = value.defaultAccount?.trim()
  if (defaultAccount && value.accounts && Object.keys(value.accounts).length > 0) {
    if (!Object.hasOwn(value.accounts, defaultAccount)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultAccount'],
        message: `feishu.defaultAccount="${defaultAccount}" does not match a configured account key`,
      })
    }
  }

  // A callback exposed to the network must both authenticate (verification
  // token) and decrypt (encrypt key) what Feishu sends. openclaw requires both.
  if (value.connectionMode === 'webhook') {
    if (value.verificationToken === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['verificationToken'],
        message: 'feishu.connectionMode="webhook" requires feishu.verificationToken',
      })
    }
    if (value.encryptKey === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['encryptKey'],
        message: 'feishu.connectionMode="webhook" requires feishu.encryptKey',
      })
    }
  }

  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (!account)
      continue
    if ((account.connectionMode ?? value.connectionMode) !== 'webhook')
      continue
    const token = account.verificationToken ?? value.verificationToken
    const key = account.encryptKey ?? value.encryptKey
    if (token === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['accounts', accountId, 'verificationToken'],
        message: `feishu.accounts.${accountId}.connectionMode="webhook" requires a verificationToken (account-level or top-level)`,
      })
    }
    if (key === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['accounts', accountId, 'encryptKey'],
        message: `feishu.accounts.${accountId}.connectionMode="webhook" requires an encryptKey (account-level or top-level)`,
      })
    }
  }

  // `dmPolicy: "open"` / `"allowlist"` without a usable `allowFrom` would drop
  // every DM at runtime, so both cases are rejected at parse time.
  const violation = evaluateDmPolicyForRoot(value)
  if (violation === 'open_requires_wildcard') {
    ctx.addIssue({
      code: 'custom',
      path: ['allowFrom'],
      message: 'feishu.dmPolicy="open" requires feishu.allowFrom to include "*"',
    })
  }
  if (violation === 'allowlist_requires_entries') {
    ctx.addIssue({
      code: 'custom',
      path: ['allowFrom'],
      message: 'feishu.dmPolicy="allowlist" requires feishu.allowFrom to contain at least one sender ID',
    })
  }

  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (!account)
      continue
    const accountViolation = evaluateDmPolicyForAccount(value, account)
    if (accountViolation === 'open_requires_wildcard') {
      ctx.addIssue({
        code: 'custom',
        path: ['accounts', accountId, 'allowFrom'],
        message: `feishu.accounts.*.dmPolicy="open" requires feishu.accounts.*.allowFrom (or feishu.allowFrom) to include "*"`,
      })
    }
    if (accountViolation === 'allowlist_requires_entries') {
      ctx.addIssue({
        code: 'custom',
        path: ['accounts', accountId, 'allowFrom'],
        message: `feishu.accounts.*.dmPolicy="allowlist" requires feishu.accounts.*.allowFrom (or feishu.allowFrom) to contain at least one sender ID`,
      })
    }
  }
})

interface AllowFromHolder { dmPolicy?: string, allowFrom?: Array<string | number> }

type DmPolicyViolation = ReturnType<typeof evaluateDmPolicyAllowFromDependency>

function evaluateDmPolicyForRoot(value: AllowFromHolder): DmPolicyViolation {
  return evaluateDmPolicyAllowFromDependency({ policy: value.dmPolicy, allowFrom: value.allowFrom })
}

function evaluateDmPolicyForAccount(
  value: AllowFromHolder,
  account: AllowFromHolder,
): DmPolicyViolation {
  return evaluateDmPolicyAllowFromDependency({
    policy: account.dmPolicy ?? value.dmPolicy,
    allowFrom: account.allowFrom ?? value.allowFrom,
  })
}

export type FeishuTarget = z.infer<typeof targetSchema>
export type FeishuGroupEntry = z.infer<typeof groupEntrySchema>
export type FeishuAccountConfig = z.infer<typeof feishuAccountConfigSchema>
export type FeishuConfig = z.infer<typeof feishuConfigSchema>
export type FeishuMode = 'app' | 'webhook'

/** Everything an inbound transport needs, with top-level keys folded in. */
/**
 * Normalized inbound settings for one account.
 *
 * The mode is a discriminated union because the config schema requires *both*
 * callback credentials in `webhook` mode (openclaw parity): the callback route
 * can therefore treat the signature key and the verification token as present,
 * while the long-lived connection needs neither.
 */
export type FeishuInboundSettings = {
  /** The account this transport serves; `default` in single-account setups. */
  accountId: string
  webhookPath: string
  webhookHost: string
  webhookPort: number
  /** Event routing that can trigger a run; absent means observe-only. */
  inbound?: FeishuInboundRouting
} & (
  | { connectionMode: 'webhook', verificationToken: string, encryptKey: string }
  | { connectionMode: 'websocket', verificationToken?: string, encryptKey?: string }
)

/** Settings for the HTTP callback transport, where both credentials exist. */
export type FeishuWebhookSettings = Extract<FeishuInboundSettings, { connectionMode: 'webhook' }>

export interface FeishuInboundRouting {
  routine?: string
  tasks: string[]
  rateLimit: { limit: number, windowMs: number }
}

export const feishuPluginConfig: PluginConfigSchema<FeishuConfig> = {
  parse: input => feishuConfigSchema.parse(input ?? {}),
}

/** Explicit `mode`, else inferred from which credentials are configured. */
export function resolveFeishuMode(config: FeishuConfig): FeishuMode {
  if (config.mode)
    return config.mode
  if (config.appId && config.appSecret)
    return 'app'
  return 'webhook'
}

/** API origin for this tenant: a named domain or an explicit base URL. */
export function resolveFeishuBaseUrl(config: { domain?: FeishuDomain | string }): string {
  if (config.domain === 'lark')
    return DEFAULT_FEISHU_LARK_BASE_URL
  if (config.domain === 'feishu' || config.domain === undefined)
    return DEFAULT_FEISHU_BASE_URL
  return config.domain
}

/** The named SDK domain for a tenant, or `null` for an explicit base URL. */
export function resolveFeishuDomainName(config: { domain?: FeishuDomain | string }): FeishuDomain | null {
  if (config.domain === 'lark')
    return 'lark'
  if (config.domain === 'feishu' || config.domain === undefined)
    return 'feishu'
  return null
}

/** Pick the target for a notification route: explicit name, default, then first. */
export function resolveFeishuTarget(config: FeishuConfig, name?: string): FeishuTarget | undefined {
  if (name !== undefined && Object.hasOwn(config.targets, name))
    return config.targets[name] as FeishuTarget
  if (config.defaultTarget !== undefined && Object.hasOwn(config.targets, config.defaultTarget))
    return config.targets[config.defaultTarget] as FeishuTarget
  return Object.values(config.targets)[0]
}

/** The webhook a send should use: the target's own, else the plugin-level default. */
export function resolveWebhookUrl(config: FeishuConfig, target?: FeishuTarget): string | undefined {
  return target?.webhookUrl ?? config.webhookUrl
}

/** Canonicalized sender allowlist of one account (openclaw `resolveAllowFrom`). */
export function resolveAllowFrom(account: FeishuAccountConfig | FeishuConfig): string[] {
  return normalizeFeishuAllowList(account.allowFrom ?? [])
}
