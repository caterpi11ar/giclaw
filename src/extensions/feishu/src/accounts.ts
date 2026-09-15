/**
 * Multi-account resolution for the Feishu channel (openclaw parity).
 *
 * Ported from openclaw `extensions/feishu/src/accounts.ts` and
 * `src/routing/account-id.ts`: account ids are short lowercase config keys, the
 * top-level keys form the implicit `default` account, and every account-level
 * key overrides the matching top-level key.
 */
import type {
  FeishuConfig,
  FeishuInboundRouting,
  FeishuInboundSettings,
} from './config.js'
import {
  DEFAULT_FEISHU_WEBHOOK_HOST,
  DEFAULT_FEISHU_WEBHOOK_PORT,
} from './config.js'

/** Account used when no account is named and none is configured. */
export const DEFAULT_ACCOUNT_ID = 'default'

// Account ids are config keys, not display names: normalize them into short
// lowercase safe keys and reject prototype-like object keys.
const VALID_ID_RE = /^[a-z0-9][\w-]{0,63}$/iu
const INVALID_CHARS_RE = /[^a-z0-9_-]+/gu
const LEADING_DASH_RE = /^-+/u
const TRAILING_DASH_RE = /-+$/u
const BLOCKED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Whether an id would collide with `Object.prototype` when used as a key. */
export function isBlockedObjectKey(key: string): boolean {
  return BLOCKED_OBJECT_KEYS.has(key)
}

function canonicalizeAccountId(value: string): string {
  if (VALID_ID_RE.test(value))
    return value.toLowerCase()
  return value
    .toLowerCase()
    .replace(INVALID_CHARS_RE, '-')
    .replace(LEADING_DASH_RE, '')
    .replace(TRAILING_DASH_RE, '')
    .slice(0, 64)
}

function normalizeCanonicalAccountId(value: string): string | undefined {
  const canonical = canonicalizeAccountId(value)
  if (!canonical || isBlockedObjectKey(canonical))
    return undefined
  return canonical
}

/** Normalize an account id; an empty or invalid id falls back to `default`. */
export function normalizeAccountId(value?: string | null): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed)
    return DEFAULT_ACCOUNT_ID
  return normalizeCanonicalAccountId(trimmed) ?? DEFAULT_ACCOUNT_ID
}

/**
 * Normalize an optional account id. Unlike `normalizeAccountId`, absence stays
 * absent and an unusable id returns `undefined` rather than silently selecting
 * the default account.
 */
export function normalizeOptionalAccountId(value?: string | null): string | undefined {
  const trimmed = (value ?? '').trim()
  if (!trimmed)
    return undefined
  return normalizeCanonicalAccountId(trimmed)
}

const MERGE_OMIT_KEYS = new Set(['accounts', 'defaultAccount'])

/**
 * Merge the top-level config with one account's overrides.
 *
 * Account keys win. `groups` is replaced wholesale when an account defines it
 * (openclaw only deep-merges its `tools` block, which Giclaw does not have).
 */
export function mergeFeishuAccountConfig(config: FeishuConfig, accountId: string): FeishuMergedConfig {
  const account = config.accounts?.[accountId]
  const merged: FeishuMergedConfig = { ...config, name: account?.name }
  delete (merged as Record<string, unknown>).accounts
  if (!account)
    return merged

  const overrides = account as Record<string, unknown>
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || MERGE_OMIT_KEYS.has(key)) {
      continue
    }
    ;(merged as Record<string, unknown>)[key] = value
  }
  return merged
}

/**
 * Every configured account id.
 *
 * Top-level `appId` + `appSecret` describe the implicit `default` account, which
 * is how a single-account deployment keeps working with no `accounts` block.
 */
export function listFeishuAccountIds(config: FeishuConfig): string[] {
  const ids = Object.keys(config.accounts ?? {}).filter(id => !isBlockedObjectKey(id))
  // openclaw keys the account list off the app credentials. Giclaw also lists
  // the implicit default when only an inbound subscription is configured, since
  // the callback transport needs no app credentials and the account would
  // otherwise never be registered (its events were silently ignored).
  const hasImplicitDefault = Boolean((config.appId && config.appSecret) || config.inbound !== undefined)
  const normalized = ids.map(id => normalizeAccountId(id))
  if (hasImplicitDefault && !normalized.includes(DEFAULT_ACCOUNT_ID))
    normalized.unshift(DEFAULT_ACCOUNT_ID)
  return [...new Set(normalized)]
}

export type FeishuDefaultAccountSelectionSource
  = | 'explicit-default'
    | 'mapped-default'
    | 'fallback'

/** Resolve the default account id together with the reason it was selected. */
export function resolveDefaultFeishuAccountSelection(config: FeishuConfig): {
  accountId: string
  source: FeishuDefaultAccountSelectionSource
} {
  const preferred = normalizeOptionalAccountId(config.defaultAccount)
  if (preferred)
    return { accountId: preferred, source: 'explicit-default' }

  const ids = listFeishuAccountIds(config)
  if (ids.includes(DEFAULT_ACCOUNT_ID))
    return { accountId: DEFAULT_ACCOUNT_ID, source: 'mapped-default' }

  const [first] = ids
  if (first !== undefined)
    return { accountId: first, source: 'fallback' }
  return { accountId: DEFAULT_ACCOUNT_ID, source: 'fallback' }
}

/** The default account id for this config. */
export function resolveDefaultFeishuAccountId(config: FeishuConfig): string {
  return resolveDefaultFeishuAccountSelection(config).accountId
}

/** Merged config with `name` and account identity folded in. */
export type FeishuMergedConfig = Omit<FeishuConfig, 'accounts'> & { name?: string }

export type FeishuAccountSelectionSource = FeishuDefaultAccountSelectionSource | 'explicit'

/** Which account to use, and why. */
interface FeishuAccountSelection {
  accountId: string
  source: FeishuAccountSelectionSource
}

export interface ResolvedFeishuAccount {
  accountId: string
  selectionSource: FeishuAccountSelectionSource
  /** Top-level `enabled` and the account's own `enabled` are both honoured. */
  enabled: boolean
  /** Whether this account has an app id and secret to authenticate with. */
  configured: boolean
  name?: string
  appId?: string
  appSecret?: string
  encryptKey?: string
  verificationToken?: string
  /** Merged per-account configuration. */
  config: FeishuMergedConfig
}

/** Resolve one account (or the default account) from the plugin config. */
export function resolveFeishuAccount(params: {
  config: FeishuConfig
  accountId?: string | null
}): ResolvedFeishuAccount {
  const hasExplicitAccountId = typeof params.accountId === 'string' && params.accountId.trim() !== ''
  const selection: FeishuAccountSelection = hasExplicitAccountId
    ? { accountId: normalizeAccountId(params.accountId), source: 'explicit' }
    : resolveDefaultFeishuAccountSelection(params.config)
  const { accountId, source: selectionSource } = selection

  const config = mergeFeishuAccountConfig(params.config, accountId)
  const enabled = params.config.enabled !== false && params.config.accounts?.[accountId]?.enabled !== false

  return {
    accountId,
    selectionSource,
    enabled,
    configured: Boolean(config.appId && config.appSecret),
    ...(config.name === undefined ? {} : { name: config.name }),
    ...(config.appId === undefined ? {} : { appId: config.appId }),
    ...(config.appSecret === undefined ? {} : { appSecret: config.appSecret }),
    ...(config.encryptKey === undefined ? {} : { encryptKey: config.encryptKey }),
    ...(config.verificationToken === undefined ? {} : { verificationToken: config.verificationToken }),
    config,
  }
}

/** Every enabled account that has usable credentials. */
export function listEnabledFeishuAccounts(config: FeishuConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(config)
    .map(accountId => resolveFeishuAccount({ config, accountId }))
    .filter(account => account.enabled && account.configured)
}

/**
 * Normalized inbound subscription for one account, or `null` when the operator
 * did not opt into event routing (the channel then stays outbound-only).
 */
export function resolveFeishuInboundSettings(
  config: FeishuMergedConfig,
  accountId: string,
): FeishuInboundSettings | null {
  const inbound: FeishuInboundRouting | undefined = config.inbound
  if (inbound === undefined)
    return null
  const shared = {
    accountId,
    // The base schema defaults `webhookPath`; host and port stay optional
    // because Giclaw reuses the host web server instead of binding here.
    webhookPath: config.webhookPath,
    webhookHost: config.webhookHost ?? DEFAULT_FEISHU_WEBHOOK_HOST,
    webhookPort: config.webhookPort ?? DEFAULT_FEISHU_WEBHOOK_PORT,
    inbound,
  }
  if (config.connectionMode === 'webhook') {
    // The config schema (`superRefine`) guarantees both credentials in this
    // mode, and `connectionMode` is a plain field rather than a discriminant.
    return {
      ...shared,
      connectionMode: 'webhook',
      verificationToken: config.verificationToken as string,
      encryptKey: config.encryptKey as string,
    }
  }
  return {
    ...shared,
    connectionMode: 'websocket',
    ...(config.verificationToken === undefined ? {} : { verificationToken: config.verificationToken }),
    ...(config.encryptKey === undefined ? {} : { encryptKey: config.encryptKey }),
  }
}

/** Accounts that both receive events and have credentials to receive them with. */
export function listFeishuInboundAccounts(config: FeishuConfig): Array<{
  account: ResolvedFeishuAccount
  settings: FeishuInboundSettings
}> {
  const entries: Array<{ account: ResolvedFeishuAccount, settings: FeishuInboundSettings }> = []
  for (const account of listFeishuAccountIds(config).map(accountId => resolveFeishuAccount({ config, accountId }))) {
    if (!account.enabled)
      continue
    const settings = resolveFeishuInboundSettings(account.config, account.accountId)
    if (settings === null)
      continue
    entries.push({ account, settings })
  }
  return entries
}
