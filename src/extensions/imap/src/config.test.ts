import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAP_MAILBOX,
  DEFAULT_IMAP_MAX_BYTES,
  DEFAULT_IMAP_POLL_SECONDS,
  DEFAULT_IMAP_PORT,
  imapConfigSchema,
  imapPluginConfig,
  isLoopbackHost,
  listImapAccounts,
  resolveImapTaskIds,
} from './config.js'

const minimal = { host: 'imap.example.com', user: 'ops', password: 'secret', allowedSenders: ['ops@example.com'] }

function parse(accounts: Record<string, unknown>) {
  return imapConfigSchema.parse({ accounts })
}

describe('imapConfigSchema', () => {
  it('starts with no accounts', () => {
    expect(imapConfigSchema.parse({}).accounts).toEqual({})
    expect(imapPluginConfig.parse(undefined).accounts).toEqual({})
    expect(imapPluginConfig.parse(null).accounts).toEqual({})
  })

  it('applies secure defaults', () => {
    const account = parse({ main: minimal }).accounts.main!

    expect(account).toMatchObject({
      port: DEFAULT_IMAP_PORT,
      secure: true,
      rejectUnauthorized: true,
      mailbox: DEFAULT_IMAP_MAILBOX,
      watch: { mode: 'auto', pollSeconds: DEFAULT_IMAP_POLL_SECONDS },
      senderAuth: { min: 'verified', trustedAuthservIds: [], acceptTrustedAuthservId: false },
      addressTokens: [],
      maxBytes: DEFAULT_IMAP_MAX_BYTES,
      tasks: [],
      rateLimit: { limit: 30, windowMs: 3_600_000 },
    })
  })

  it('requires a sender allowlist so no account can accept anyone', () => {
    expect(() => parse({ main: { ...minimal, allowedSenders: [] } })).toThrow()
    expect(() => parse({ main: { host: 'h', user: 'u', password: 'p' } })).toThrow()
  })

  it('rejects an account id that is not simple', () => {
    expect(() => parse({ 'has space': minimal })).toThrow()
    expect(() => parse({ '': minimal })).toThrow()
    expect(parse({ 'ops-1_x': minimal }).accounts['ops-1_x']).toBeDefined()
  })

  it('rejects credentials that could break the IMAP command line', () => {
    expect(() => parse({ main: { ...minimal, password: 'a\r\nb' } })).toThrow()
    expect(() => parse({ main: { ...minimal, user: 'a\nb' } })).toThrow()
  })

  it('allows plaintext only on a loopback host', () => {
    expect(parse({ main: { ...minimal, secure: false, host: '127.0.0.1' } }).accounts.main?.secure).toBe(false)
    expect(parse({ main: { ...minimal, secure: false, host: 'LOCALHOST' } }).accounts.main?.secure).toBe(false)
    expect(() => parse({ main: { ...minimal, secure: false } })).toThrow(/loopback/u)
  })

  it('bounds the watch interval, message size and rate limit', () => {
    expect(() => parse({ main: { ...minimal, watch: { pollSeconds: 5 } } })).toThrow()
    expect(() => parse({ main: { ...minimal, watch: { mode: 'push' } } })).toThrow()
    expect(() => parse({ main: { ...minimal, maxBytes: 10 } })).toThrow()
    expect(() => parse({ main: { ...minimal, rateLimit: { limit: 0 } } })).toThrow()
    expect(parse({ main: { ...minimal, watch: { mode: 'interval', pollSeconds: 15 } } }).accounts.main?.watch.mode).toBe('interval')
  })

  it('accepts the sender-authentication ladder', () => {
    const hardened = parse({
      main: {
        ...minimal,
        senderAuth: { min: 'asserted', trustedAuthservIds: ['mx.example.com'], acceptTrustedAuthservId: true },
        addressTokens: [{ token: 's3cret', senders: ['ops@example.com'] }],
      },
    }).accounts.main!

    expect(hardened.senderAuth).toEqual({
      min: 'asserted',
      trustedAuthservIds: ['mx.example.com'],
      acceptTrustedAuthservId: true,
    })
    expect(hardened.addressTokens).toEqual([{ token: 's3cret', senders: ['ops@example.com'] }])
    expect(() => parse({ main: { ...minimal, senderAuth: { min: 'trusted' } } })).toThrow()
    expect(() => parse({ main: { ...minimal, addressTokens: [{ token: 'x', senders: [] }] } })).toThrow()
  })
})

describe('isLoopbackHost', () => {
  it('recognizes the loopback spellings', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('imap.example.com')).toBe(false)
  })
})

describe('listImapAccounts', () => {
  it('sorts accounts by id', () => {
    const config = parse({ zebra: minimal, alpha: minimal })

    expect(listImapAccounts(config).map(entry => entry.id)).toEqual(['alpha', 'zebra'])
  })
})

describe('resolveImapTaskIds', () => {
  const account = parse({ main: minimal }).accounts.main!
  const routine = (name: string) => (name === 'daily' ? ['welkin-moon'] : null)

  it('prefers a routine', () => {
    expect(resolveImapTaskIds({ ...account, routine: 'daily' }, routine)).toEqual(['welkin-moon'])
    expect(resolveImapTaskIds({ ...account, routine: 'ghost' }, routine)).toBeNull()
  })

  it('falls back to tasks and then to the gateway default', () => {
    expect(resolveImapTaskIds({ ...account, tasks: ['claim-mail'] }, routine)).toEqual(['claim-mail'])
    expect(resolveImapTaskIds(account, routine)).toBeUndefined()
  })
})
