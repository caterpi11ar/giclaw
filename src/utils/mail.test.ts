import { describe, expect, it } from 'vitest'
import { extractMailAddress, isMailAddress } from './mail.js'

describe('isMailAddress', () => {
  it('accepts bare addresses and rejects everything else', () => {
    expect(isMailAddress('ops@example.com')).toBe(true)
    expect(isMailAddress('giclaw+notify@mail.example.co.uk')).toBe(true)
    expect(isMailAddress('ops@example')).toBe(false)
    expect(isMailAddress('Ops <ops@example.com>')).toBe(false)
    expect(isMailAddress('ops@example.com\r\nBcc: evil@example.com')).toBe(false)
    expect(isMailAddress('ops@example.com, evil@example.com')).toBe(false)
    expect(isMailAddress('')).toBe(false)
  })
})

describe('extractMailAddress', () => {
  it('reads a bare address', () => {
    expect(extractMailAddress('ops@example.com')).toBe('ops@example.com')
  })

  it('reads an address inside a display name', () => {
    expect(extractMailAddress('Ops Team <ops@example.com>')).toBe('ops@example.com')
    expect(extractMailAddress('"Ops" < ops@example.com >')).toBe('ops@example.com')
  })

  it('unwraps a quoted address without angle brackets', () => {
    expect(extractMailAddress('"ops@example.com"')).toBe('ops@example.com')
  })

  it('returns null when no address can be found', () => {
    expect(extractMailAddress('Ops Team')).toBeNull()
    expect(extractMailAddress('')).toBeNull()
    expect(extractMailAddress('<not an address>')).toBeNull()
  })
})
