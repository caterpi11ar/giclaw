import { describe, expect, it } from 'vitest'
import {
  constantTimeEquals,
  createInFlightLimiter,
  createRateLimiter,
  createRecentKeySet,
  matchesSenderAllowlist,
  readHeader,
  readHeaderValue,
} from './inbound.js'

describe('readHeader', () => {
  it('reads a header by its canonical name', () => {
    expect(readHeader({ 'x-giclaw-signature': 'sha256=abc' }, 'x-giclaw-signature')).toBe('sha256=abc')
  })

  it('falls back to a case-insensitive scan', () => {
    expect(readHeader({ 'X-Lark-Signature': 'deadbeef' }, 'x-lark-signature')).toBe('deadbeef')
    expect(readHeader({ 'X-Lark-Signature': ['one', 'two'] }, 'x-lark-signature')).toEqual(['one', 'two'])
  })

  it('returns undefined when the header is absent', () => {
    expect(readHeader({}, 'x-lark-signature')).toBeUndefined()
  })
})

describe('readHeaderValue', () => {
  it('returns the first value of a repeated header', () => {
    expect(readHeaderValue({ 'content-type': ['application/json', 'text/plain'] }, 'content-type'))
      .toBe('application/json')
  })

  it('treats an absent, non-string or empty header as missing', () => {
    expect(readHeaderValue({}, 'token')).toBeUndefined()
    expect(readHeaderValue({ token: '' }, 'token')).toBeUndefined()
    expect(readHeaderValue({ token: undefined }, 'token')).toBeUndefined()
  })

  it('returns a single header value', () => {
    expect(readHeaderValue({ token: 'abc' }, 'token')).toBe('abc')
  })
})

describe('constantTimeEquals', () => {
  it('accepts identical secrets', () => {
    expect(constantTimeEquals('s3cret', 's3cret')).toBe(true)
  })

  it('rejects a secret of a different length', () => {
    expect(constantTimeEquals('s3cret', 's3cret!')).toBe(false)
  })

  it('rejects a secret with different bytes', () => {
    expect(constantTimeEquals('s3cret', 's3cre7')).toBe(false)
  })
})

describe('matchesSenderAllowlist', () => {
  const entries = ['ops@example.com', '@Example.ORG']

  it('matches an exact address', () => {
    expect(matchesSenderAllowlist('ops@example.com', entries)).toBe(true)
  })

  it('matches a whole domain case-insensitively', () => {
    expect(matchesSenderAllowlist('anyone@example.org', entries)).toBe(true)
  })

  it('rejects a different local part or domain', () => {
    expect(matchesSenderAllowlist('other@example.com', entries)).toBe(false)
    expect(matchesSenderAllowlist('ops@example.net', entries)).toBe(false)
  })

  it('rejects malformed addresses and entries', () => {
    expect(matchesSenderAllowlist('@example.com', entries)).toBe(false)
    expect(matchesSenderAllowlist('ops@example.com', ['example.com'])).toBe(false)
    expect(matchesSenderAllowlist('ops@example.com', [])).toBe(false)
  })
})

describe('createRateLimiter', () => {
  it('allows attempts up to the limit and rejects the rest', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => 0 })

    expect(limiter.allow('chat')).toBe(true)
    expect(limiter.allow('chat')).toBe(true)
    expect(limiter.allow('chat')).toBe(false)
    expect(limiter.size()).toBe(1)
  })

  it('slides the window instead of resetting on a boundary', () => {
    let current = 0
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => current })

    expect(limiter.allow('chat')).toBe(true)
    current = 999
    expect(limiter.allow('chat')).toBe(false)
    current = 1_001
    expect(limiter.allow('chat')).toBe(true)
  })

  it('keeps a rejected attempt out of the window', () => {
    let current = 0
    const limiter = createRateLimiter({ limit: 1, windowMs: 100, now: () => current })

    expect(limiter.allow('chat')).toBe(true)
    current = 50
    expect(limiter.allow('chat')).toBe(false)
    current = 101
    expect(limiter.allow('chat')).toBe(true)
  })

  it('evicts the least recently used key once the key budget is reached', () => {
    let current = 0
    const limiter = createRateLimiter({ limit: 5, windowMs: 10_000, maxKeys: 2, now: () => current })

    expect(limiter.allow('a')).toBe(true)
    current = 1
    expect(limiter.allow('b')).toBe(true)
    current = 2
    // Re-using `a` makes `b` the oldest entry.
    expect(limiter.allow('a')).toBe(true)
    current = 3
    expect(limiter.allow('c')).toBe(true)

    expect(limiter.size()).toBe(2)
  })

  it('clears all state on reset', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => 0 })

    expect(limiter.allow('chat')).toBe(true)
    limiter.reset()
    expect(limiter.size()).toBe(0)
    expect(limiter.allow('chat')).toBe(true)
  })

  it('falls back to the wall clock and a default key budget', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 })

    expect(limiter.allow('chat')).toBe(true)
    expect(limiter.allow('chat')).toBe(false)
  })
})

describe('createInFlightLimiter', () => {
  it('caps concurrent slots per key and returns them on release', () => {
    const limiter = createInFlightLimiter({ maxInFlightPerKey: 1 })

    expect(limiter.tryAcquire('default')).toBe(true)
    expect(limiter.tryAcquire('default')).toBe(false)
    expect(limiter.size()).toBe(1)

    limiter.release('default')
    expect(limiter.tryAcquire('default')).toBe(true)
  })

  it('counts slots per key independently', () => {
    const limiter = createInFlightLimiter({ maxInFlightPerKey: 1 })

    expect(limiter.tryAcquire('a')).toBe(true)
    expect(limiter.tryAcquire('b')).toBe(true)
    expect(limiter.tryAcquire('a')).toBe(false)
    expect(limiter.size()).toBe(2)
  })

  it('keeps a key tracked while it still holds slots', () => {
    const limiter = createInFlightLimiter({ maxInFlightPerKey: 2 })

    expect(limiter.tryAcquire('a')).toBe(true)
    expect(limiter.tryAcquire('a')).toBe(true)
    expect(limiter.tryAcquire('a')).toBe(false)

    limiter.release('a')
    expect(limiter.tryAcquire('a')).toBe(true)
    expect(limiter.size()).toBe(1)
  })

  it('ignores a release for a key that holds no slot', () => {
    const limiter = createInFlightLimiter({ maxInFlightPerKey: 1 })

    limiter.release('never-acquired')

    expect(limiter.size()).toBe(0)
  })

  it('evicts the least recently used key once the tracked budget is reached', () => {
    const limiter = createInFlightLimiter({ maxInFlightPerKey: 5, maxTrackedKeys: 2 })

    expect(limiter.tryAcquire('a')).toBe(true)
    expect(limiter.tryAcquire('b')).toBe(true)
    // Re-acquiring `a` makes `b` the oldest entry.
    expect(limiter.tryAcquire('a')).toBe(true)
    expect(limiter.tryAcquire('c')).toBe(true)

    expect(limiter.size()).toBe(2)
  })

  it('drops every tracked key on clear', () => {
    const limiter = createInFlightLimiter({ maxInFlightPerKey: 1 })

    expect(limiter.tryAcquire('a')).toBe(true)
    limiter.clear()

    expect(limiter.size()).toBe(0)
    expect(limiter.tryAcquire('a')).toBe(true)
  })

  it('falls back to a default tracked-key budget', () => {
    const limiter = createInFlightLimiter({ maxInFlightPerKey: 1 })

    expect(limiter.tryAcquire('a')).toBe(true)
    expect(limiter.tryAcquire('a')).toBe(false)
  })
})

describe('createRecentKeySet', () => {
  it('accepts a key exactly once', () => {
    const set = createRecentKeySet(10)

    expect(set.add('m1')).toBe(true)
    expect(set.add('m1')).toBe(false)
    expect(set.has('m1')).toBe(true)
    expect(set.size()).toBe(1)
  })

  it('forgets the oldest key past the bound', () => {
    const set = createRecentKeySet(2)

    set.add('m1')
    set.add('m2')
    set.add('m3')

    expect(set.size()).toBe(2)
    expect(set.has('m1')).toBe(false)
    expect(set.add('m1')).toBe(true)
  })
})
