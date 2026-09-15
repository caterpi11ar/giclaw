import type { PluginHttpRequest } from '../plugins/types.js'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'

/**
 * Inbound connector helpers (openclaw: `plugin-sdk/*-runtime`).
 *
 * Every inbound path — webhook, Feishu events, IMAP — needs the same control
 * loop: authenticate the caller, decide whether the sender is allowed, and cap
 * how often an accepted message may start work. Keeping that here means a
 * connector cannot forget one of the three, and there is a single place to
 * audit.
 */

/** Case-insensitive header lookup; repeated headers stay as an array. */
export function readHeader(
  headers: PluginHttpRequest['headers'],
  name: string,
): string | string[] | undefined {
  const direct = headers[name]
  if (direct !== undefined)
    return direct
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower)
      return value
  }
  return undefined
}

/** First value of a header, or `undefined` when absent or empty. */
export function readHeaderValue(
  headers: PluginHttpRequest['headers'],
  name: string,
): string | undefined {
  const value = readHeader(headers, name)
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first !== '' ? first : undefined
}

/** Length-independent comparison so a wrong secret cannot be probed by timing. */
export function constantTimeEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf-8')
  const expectedBytes = Buffer.from(expected, 'utf-8')
  return actualBytes.byteLength === expectedBytes.byteLength
    && timingSafeEqual(actualBytes, expectedBytes)
}

/** Order of trust for one identifier claim, weakest first. Ported from openclaw. */
export type IdentifierAuthentication = 'mutable' | 'unverified' | 'asserted' | 'verified'

const IDENTIFIER_AUTHENTICATION_RANK: Record<IdentifierAuthentication, number> = {
  mutable: 0,
  unverified: 1,
  asserted: 2,
  verified: 3,
}

/** Every connector that makes no claim is treated as `asserted`, as in openclaw. */
export const DEFAULT_IDENTIFIER_AUTHENTICATION: IdentifierAuthentication = 'asserted'

/** Does `actual` clear the configured floor? */
export function meetsIdentifierAuthentication(
  actual: IdentifierAuthentication,
  minimum: IdentifierAuthentication,
): boolean {
  return IDENTIFIER_AUTHENTICATION_RANK[actual] >= IDENTIFIER_AUTHENTICATION_RANK[minimum]
}

/**
 * Match a sender address against `local@domain` entries.
 *
 * An entry starting with `@` matches the whole domain; anything else must match
 * the local part exactly. Domains compare case-insensitively (mail domains are
 * not case sensitive), local parts do not, because the sender's own server
 * decides whether they are.
 */
export function matchesSenderAllowlist(address: string, entries: readonly string[]): boolean {
  const at = address.lastIndexOf('@')
  if (at < 1)
    return false
  const local = address.slice(0, at)
  const domain = address.slice(at + 1).toLowerCase()
  return entries.some((entry) => {
    if (entry.startsWith('@'))
      return entry.slice(1).toLowerCase() === domain
    const entryAt = entry.lastIndexOf('@')
    return entryAt > 0
      && entry.slice(0, entryAt) === local
      && entry.slice(entryAt + 1).toLowerCase() === domain
  })
}

export interface RateLimiterOptions {
  /** Accepted messages per window, per key. */
  limit: number
  windowMs: number
  /** Bound on tracked keys; the least recently used key is evicted first. */
  maxKeys?: number
  now?: () => number
}

export interface RateLimiter {
  /** Record one attempt for `key`; `false` means the caller is over the limit. */
  allow: (key: string) => boolean
  reset: () => void
  size: () => number
}

/**
 * Sliding-window limiter.
 *
 * A rejected attempt is not recorded, so a noisy sender cannot extend its own
 * lockout, and the window slides instead of resetting on a fixed boundary.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const maxKeys = options.maxKeys ?? 1_000
  const now = options.now ?? Date.now
  const hits = new Map<string, number[]>()

  return {
    allow: (key) => {
      const current = now()
      const cutoff = current - options.windowMs
      const recent = (hits.get(key) ?? []).filter(timestamp => timestamp > cutoff)
      if (recent.length >= options.limit)
        return false
      recent.push(current)
      // Re-inserting keeps Map iteration order aligned with recency.
      hits.delete(key)
      hits.set(key, recent)
      if (hits.size > maxKeys) {
        const oldest = hits.keys().next().value
        if (oldest !== undefined)
          hits.delete(oldest)
      }
      return true
    },
    reset: () => {
      hits.clear()
    },
    size: () => hits.size,
  }
}

export interface InFlightLimiterOptions {
  /** Concurrent handlers allowed for one key. */
  maxInFlightPerKey: number
  /** Bound on tracked keys; the least recently used key is evicted first. */
  maxTrackedKeys?: number
}

export interface InFlightLimiter {
  /** Take one slot for `key`; `false` means the key is already at capacity. */
  tryAcquire: (key: string) => boolean
  /** Give a slot back; must run on every path that acquired one. */
  release: (key: string) => void
  size: () => number
  clear: () => void
}

/**
 * Per-key in-flight limiter for untrusted inbound work (openclaw:
 * `createWebhookInFlightLimiter`).
 *
 * A rate limiter bounds how *often* a caller may try; this bounds how *many*
 * attempts may be held at once, which is what an unauthenticated slow upload
 * ties up. Pruning keeps it bounded under a key-spray attack.
 */
export function createInFlightLimiter(options: InFlightLimiterOptions): InFlightLimiter {
  const maxTrackedKeys = options.maxTrackedKeys ?? 1_000
  const active = new Map<string, number>()

  return {
    tryAcquire: (key) => {
      const current = active.get(key) ?? 0
      if (current >= options.maxInFlightPerKey)
        return false
      // Re-inserting keeps Map iteration order aligned with recency.
      active.delete(key)
      active.set(key, current + 1)
      if (active.size > maxTrackedKeys) {
        const oldest = active.keys().next().value
        if (oldest !== undefined)
          active.delete(oldest)
      }
      return true
    },
    release: (key) => {
      const current = active.get(key)
      if (current === undefined)
        return
      if (current <= 1) {
        active.delete(key)
        return
      }
      active.set(key, current - 1)
    },
    size: () => active.size,
    clear: () => {
      active.clear()
    },
  }
}

export interface RecentKeySet {
  /** `true` exactly once per key, until the entry is evicted. */
  add: (key: string) => boolean
  has: (key: string) => boolean
  size: () => number
}

/**
 * Bounded recency set used to drop re-delivered messages.
 *
 * IMAP and Feishu both re-send on retry, and a connector that triggers a run
 * twice for one message is worse than one that never answers.
 */
export function createRecentKeySet(maxEntries: number): RecentKeySet {
  const keys = new Set<string>()
  return {
    add: (key) => {
      if (keys.has(key))
        return false
      keys.add(key)
      if (keys.size > maxEntries) {
        const oldest = keys.values().next().value
        if (oldest !== undefined)
          keys.delete(oldest)
      }
      return true
    },
    has: key => keys.has(key),
    size: () => keys.size,
  }
}
