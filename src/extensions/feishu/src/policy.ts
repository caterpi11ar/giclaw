/**
 * Sender policy for the Feishu channel.
 *
 * Ported from openclaw `extensions/feishu/src/policy.ts` +
 * `src/config/zod-schema.core.ts` (allowFrom/dmPolicy dependency rule) and
 * `extensions/feishu/src/targets.ts` (id typing). The rules are the same; the
 * surrounding `channel-ingress-runtime` plumbing is host-specific and is not
 * reproduced here.
 */
import type { FeishuConfig, FeishuGroupEntry } from './config.js'

/** Direct-message policy (`channels.feishu.dmPolicy`), openclaw default `pairing`. */
export const FEISHU_DM_POLICIES = ['pairing', 'allowlist', 'open', 'disabled'] as const
export type FeishuDmPolicy = (typeof FEISHU_DM_POLICIES)[number]

/** Group policy (`channels.feishu.groupPolicy`), openclaw default `allowlist`. */
export const FEISHU_GROUP_POLICIES = ['open', 'allowlist', 'disabled'] as const
export type FeishuGroupPolicy = (typeof FEISHU_GROUP_POLICIES)[number]

/** Shipped openclaw alias for `open`; still accepted so old configs keep loading. */
export const FEISHU_GROUP_POLICY_ALIAS = 'allowall'
export type FeishuGroupPolicyInput = FeishuGroupPolicy | typeof FEISHU_GROUP_POLICY_ALIAS

const CHAT_ID_PREFIX = 'oc_'
const OPEN_ID_PREFIX = 'ou_'
const USER_ID_REGEX = /^[\w-]+$/u
const FEISHU_PROVIDER_PREFIX_RE = /^(feishu|lark):/iu
const FEISHU_TYPED_PREFIX_RE = /^(chat|group|channel|user|dm|open_id):/iu

export type FeishuIdType = 'chat_id' | 'open_id' | 'user_id'

/** Accepted values for Feishu `allowFrom` entries: strings or numeric user ids. */
export type FeishuAllowFromEntry = string | number

/** An allowlist subject: either `*`, a chat (`chat:oc_…`) or a user (`user:ou_…`). */
export const FEISHU_WILDCARD_ENTRY = '*'

/** Map an id to its kind from its prefix; `user_id` ids have no marker prefix. */
export function detectFeishuIdType(id: string): FeishuIdType | null {
  const trimmed = id.trim()
  if (trimmed.startsWith(CHAT_ID_PREFIX))
    return 'chat_id'
  if (trimmed.startsWith(OPEN_ID_PREFIX))
    return 'open_id'
  if (USER_ID_REGEX.test(trimmed))
    return 'user_id'
  return null
}

/** Drop a leading `feishu:`/`lark:` provider prefix (repeatable). */
export function stripFeishuProviderPrefix(raw: string): string {
  let value = raw.trim()
  while (FEISHU_PROVIDER_PREFIX_RE.test(value))
    value = value.replace(FEISHU_PROVIDER_PREFIX_RE, '').trim()
  return value
}

/**
 * Canonicalize one `allowFrom` entry.
 *
 * One configured entry is deliberately ambiguous between `open_id` and
 * `user_id`: both normalize to the same `user:<id>` subject and match whichever
 * candidate carries that value (openclaw's `feishu-alt-id` alias). Unknown
 * shapes normalize to the empty string and never match anything.
 */
export function normalizeFeishuAllowEntry(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed)
    return ''
  if (trimmed === FEISHU_WILDCARD_ENTRY)
    return FEISHU_WILDCARD_ENTRY

  const withoutProviderPrefix = stripFeishuProviderPrefix(trimmed)
  if (withoutProviderPrefix === FEISHU_WILDCARD_ENTRY)
    return FEISHU_WILDCARD_ENTRY

  const lowered = withoutProviderPrefix.toLowerCase()
  if (!lowered)
    return ''

  const prefixed = FEISHU_TYPED_PREFIX_RE.exec(lowered)
  if (prefixed?.[1]) {
    const kind = ['chat', 'group', 'channel'].includes(prefixed[1]) ? 'chat' : 'user'
    const value = withoutProviderPrefix.slice(prefixed[0].length).trim()
    if (value === FEISHU_WILDCARD_ENTRY)
      return FEISHU_WILDCARD_ENTRY
    return value ? `${kind}:${value}` : ''
  }

  const detectedType = detectFeishuIdType(withoutProviderPrefix)
  if (detectedType === 'chat_id')
    return `chat:${withoutProviderPrefix}`
  if (detectedType === 'open_id' || detectedType === 'user_id')
    return `user:${withoutProviderPrefix}`
  return ''
}

/** Coerce, trim and keep the non-empty entries of an allowlist (order preserved). */
export function normalizeAllowFrom(values?: ReadonlyArray<FeishuAllowFromEntry> | null): string[] {
  return (values ?? []).map(entry => String(entry).trim()).filter(Boolean)
}

/** Canonicalized, de-duplicated allowlist subjects. */
export function normalizeFeishuAllowList(
  values?: ReadonlyArray<FeishuAllowFromEntry> | null,
): string[] {
  return [...new Set(normalizeAllowFrom(values).map(normalizeFeishuAllowEntry).filter(Boolean))]
}

/**
 * Closed set of `dmPolicy`/`allowFrom` dependency violations. Both cases drop
 * every inbound DM at runtime, so callers surface them as config problems.
 */
export type DmPolicyAllowFromViolation = 'open_requires_wildcard' | 'allowlist_requires_entries'

/** Single source of truth for the `dmPolicy` ↔ `allowFrom` cross-field rule. */
export function evaluateDmPolicyAllowFromDependency(params: {
  policy?: string | null
  allowFrom?: ReadonlyArray<FeishuAllowFromEntry> | null
}): DmPolicyAllowFromViolation | null {
  const allow = normalizeAllowFrom(params.allowFrom)
  if (params.policy === 'open' && !allow.includes(FEISHU_WILDCARD_ENTRY))
    return 'open_requires_wildcard'
  if (params.policy === 'allowlist' && allow.length === 0)
    return 'allowlist_requires_entries'
  return null
}

/** Unknown values fall back to openclaw's `pairing` default. */
export function normalizeFeishuDmPolicy(policy?: string | null): FeishuDmPolicy {
  return FEISHU_DM_POLICIES.find(entry => entry === policy) ?? 'pairing'
}

/** The `allowall` alias normalizes to `open`. */
export function normalizeFeishuGroupPolicy(policy?: string | null): FeishuGroupPolicy {
  if (policy === FEISHU_GROUP_POLICY_ALIAS)
    return 'open'
  return FEISHU_GROUP_POLICIES.find(entry => entry === policy) ?? 'allowlist'
}

function resolveExplicitGroupConfigKey(config: FeishuConfig, groupId?: string | null): string | undefined {
  const groups = config.groups ?? {}
  const trimmed = groupId?.trim()
  if (!trimmed || trimmed === FEISHU_WILDCARD_ENTRY)
    return undefined
  if (Object.hasOwn(groups, trimmed))
    return trimmed
  const lowered = trimmed.toLowerCase()
  return Object.keys(groups).find(key => key !== FEISHU_WILDCARD_ENTRY && key.toLowerCase() === lowered)
}

/**
 * Per-chat group config: an exact (case-insensitive) chat id wins, then the
 * `*` catch-all. The `groupId === "*"` lookup never re-enters the catch-all.
 */
export function resolveFeishuGroupConfig(params: {
  config: FeishuConfig
  groupId?: string | null
}): FeishuGroupEntry | undefined {
  if (!params.groupId?.trim())
    return undefined
  const key = resolveExplicitGroupConfigKey(params.config, params.groupId)
  return key ? params.config.groups?.[key] : params.config.groups?.[FEISHU_WILDCARD_ENTRY]
}

/** Whether this chat has its own explicit entry (as opposed to the `*` default). */
export function hasExplicitFeishuGroupConfig(params: {
  config: FeishuConfig
  groupId?: string | null
}): boolean {
  return resolveExplicitGroupConfigKey(params.config, params.groupId) !== undefined
}

/**
 * Effective `@`-mention requirement for one chat.
 *
 * A group-default `requireMention: false` under `groupPolicy: "open"` is
 * deliberate: non-text messages cannot carry a mention and would otherwise be
 * dropped.
 */
export function resolveFeishuReplyPolicy(params: {
  isDirectMessage: boolean
  config: FeishuConfig
  groupId?: string | null
  groupPolicy?: FeishuGroupPolicyInput
}): { requireMention: boolean } {
  if (params.isDirectMessage)
    return { requireMention: false }

  const groupRequireMention = resolveFeishuGroupConfig({
    config: params.config,
    groupId: params.groupId,
  })?.requireMention

  if (typeof groupRequireMention === 'boolean')
    return { requireMention: groupRequireMention }
  if (typeof params.config.requireMention === 'boolean')
    return { requireMention: params.config.requireMention }
  return { requireMention: normalizeFeishuGroupPolicy(params.groupPolicy) !== 'open' }
}

/** `chat_type` values that identify a direct (1:1) conversation. */
export const FEISHU_DIRECT_CHAT_TYPES = ['p2p', 'private'] as const

const DIRECT_CHAT_TYPE_SET: ReadonlySet<string> = new Set(FEISHU_DIRECT_CHAT_TYPES)

/** Whether `chat_type` describes a direct conversation rather than a group. */
export function isFeishuDirectChatType(chatType: string): boolean {
  return DIRECT_CHAT_TYPE_SET.has(chatType)
}

export type FeishuIngressDecision = { allowed: true } | { allowed: false, reason: string }

const ALLOWED: FeishuIngressDecision = { allowed: true }

function denied(reason: string): FeishuIngressDecision {
  return { allowed: false, reason }
}

/** A normalised allowlist matches `*`, a chat subject or either user-id form. */
function matchesAllowList(params: {
  entries: ReadonlyArray<string>
  chatId?: string
  senderOpenId?: string
  senderUserId?: string
}): boolean {
  const { entries } = params
  if (entries.includes(FEISHU_WILDCARD_ENTRY))
    return true
  if (params.chatId !== undefined && entries.includes(`chat:${params.chatId}`))
    return true
  const userSubjects = [params.senderOpenId, params.senderUserId]
    .filter((value): value is string => Boolean(value))
    .map(value => `user:${value}`)
  return userSubjects.some(subject => entries.includes(subject))
}

export interface FeishuIngressParams {
  config: FeishuConfig
  /** `message.chat_type` from the event. */
  chatType: string
  chatId: string
  senderOpenId?: string
  senderUserId?: string
  /** `sender.sender_type`; `app`/`bot` senders are gated by `allowBots`. */
  senderType?: string
  /** Whether the message mentions this app. */
  mentionedBot: boolean
  /** Sender ids approved out-of-band; the `pairing` policy consults this. */
  pairedSenderIds?: ReadonlyArray<string>
}

/**
 * Single ingress decision for one inbound message.
 *
 * Ordering follows openclaw: bot senders, then conversation policy, then the
 * effective mention requirement. Returns a machine-readable reason so the
 * caller can log why an event was dropped without leaking the message body.
 */
/** Reason string returned for an unpaired direct sender under `dmPolicy: "pairing"`. */
export const FEISHU_PAIRING_DENIED_REASON = 'sender is not paired and is not in allowFrom'

export function evaluateFeishuIngress(params: FeishuIngressParams): FeishuIngressDecision {
  const { config } = params

  if (params.senderType === 'app' || params.senderType === 'bot') {
    if (config.allowBots !== true)
      return denied('bot-authored messages are disabled')
  }

  const isDirectMessage = isFeishuDirectChatType(params.chatType)
  if (isDirectMessage)
    return evaluateDmIngress(params)
  return evaluateGroupIngress(params, isDirectMessage)
}

function evaluateDmIngress(params: FeishuIngressParams): FeishuIngressDecision {
  const policy = normalizeFeishuDmPolicy(params.config.dmPolicy)
  if (policy === 'disabled')
    return denied('dmPolicy is disabled')
  if (policy === 'open')
    return ALLOWED

  const entries = normalizeFeishuAllowList(params.config.allowFrom)
  if (matchesAllowList({ entries, senderOpenId: params.senderOpenId, senderUserId: params.senderUserId }))
    return ALLOWED

  if (policy === 'pairing') {
    const paired = new Set(normalizeFeishuAllowList([...(params.pairedSenderIds ?? [])]))
    const senderSubjects = [params.senderOpenId, params.senderUserId]
      .filter((value): value is string => Boolean(value))
      .map(value => `user:${value}`)
    if (senderSubjects.some(subject => paired.has(subject)))
      return ALLOWED
    return denied(FEISHU_PAIRING_DENIED_REASON)
  }

  return denied('sender is not in allowFrom')
}

function evaluateGroupIngress(
  params: FeishuIngressParams,
  isDirectMessage: boolean,
): FeishuIngressDecision {
  const { config } = params
  const groupPolicy = normalizeFeishuGroupPolicy(config.groupPolicy)
  if (groupPolicy === 'disabled')
    return denied('groupPolicy is disabled')

  const groupConfig = resolveFeishuGroupConfig({ config, groupId: params.chatId })
  if (groupConfig?.enabled === false)
    return denied('this group is disabled in groups')

  if (groupPolicy === 'allowlist') {
    // An explicitly configured chat is implicitly allowlisted, so operators do
    // not have to list the same id twice.
    const entries = normalizeFeishuAllowList(config.groupAllowFrom)
    if (hasExplicitFeishuGroupConfig({ config, groupId: params.chatId }))
      entries.push(`chat:${params.chatId}`)
    if (!matchesAllowList({ entries, chatId: params.chatId }))
      return denied('chat is not in groupAllowFrom')
  }

  // A non-empty group-level `allowFrom` replaces the top-level
  // `groupSenderAllowFrom` list; it is not merged with it (openclaw parity).
  const groupSenderRaw = (groupConfig?.allowFrom?.length ?? 0) > 0
    ? groupConfig?.allowFrom
    : config.groupSenderAllowFrom
  const senderEntries = normalizeFeishuAllowList(groupSenderRaw)
  if (senderEntries.length > 0
    && !matchesAllowList({
      entries: senderEntries,
      senderOpenId: params.senderOpenId,
      senderUserId: params.senderUserId,
    })) {
    return denied('sender is not in groupSenderAllowFrom')
  }

  const { requireMention } = resolveFeishuReplyPolicy({
    isDirectMessage,
    config,
    groupId: params.chatId,
    groupPolicy,
  })
  if (requireMention && !params.mentionedBot)
    return denied('message does not mention the app')

  return ALLOWED
}
