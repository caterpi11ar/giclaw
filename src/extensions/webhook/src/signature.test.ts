import { describe, expect, it } from 'vitest'
import { SIGNATURE_HEADER, signPayload, verifySignature } from './signature.js'

describe('signPayload', () => {
  it('produces a stable prefixed HMAC-SHA256 digest', () => {
    expect(signPayload('secret', '{"a":1}')).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(signPayload('secret', '{"a":1}')).toBe(signPayload('secret', '{"a":1}'))
  })

  it('matches the header name used by the connector', () => {
    expect(SIGNATURE_HEADER).toBe('x-giclaw-signature')
  })

  it('changes when the body or the secret changes', () => {
    expect(signPayload('secret', 'a')).not.toBe(signPayload('secret', 'b'))
    expect(signPayload('one', 'a')).not.toBe(signPayload('two', 'a'))
  })
})

describe('verifySignature', () => {
  it('accepts a correctly signed body', () => {
    const body = '{"command":"status"}'
    expect(verifySignature('secret', body, signPayload('secret', body))).toBe(true)
  })

  it('accepts the first value of a repeated header', () => {
    const body = 'payload'
    expect(verifySignature('secret', body, [signPayload('secret', body), 'junk'])).toBe(true)
  })

  it('rejects a missing or empty header', () => {
    expect(verifySignature('secret', 'body', undefined)).toBe(false)
    expect(verifySignature('secret', 'body', '')).toBe(false)
    expect(verifySignature('secret', 'body', [])).toBe(false)
  })

  it('rejects a mismatched secret, body or length', () => {
    expect(verifySignature('secret', 'body', signPayload('other', 'body'))).toBe(false)
    expect(verifySignature('secret', 'body', signPayload('secret', 'other'))).toBe(false)
    expect(verifySignature('secret', 'body', 'sha256=short')).toBe(false)
  })
})
