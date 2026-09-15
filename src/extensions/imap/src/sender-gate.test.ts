import type { AuthenticateResult } from 'mailauth'
import type { ParsedMail } from 'mailparser'
import type { ImapAccount } from './config.js'
import type { DnsResolverLike, MailAuthenticator } from './sender-gate.js'
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { imapConfigSchema } from './config.js'
import { dnsAdapter, evaluateImapSender } from './sender-gate.js'

const NOW = Date.parse('2026-05-05T05:05:05.000Z')
const FRESH = new Date(NOW - 60_000)

const minimal = { host: 'imap.example.com', user: 'ops', password: 'secret', allowedSenders: ['ops@example.com'] }

function account(overrides: Record<string, unknown> = {}): ImapAccount {
  return imapConfigSchema.parse({ accounts: { main: { ...minimal, ...overrides } } }).accounts.main!
}

function mail(overrides: {
  from?: string
  extraFromHeaders?: number
  fromValues?: number
  to?: unknown
  deliveredTo?: unknown
  authResults?: string[]
  badAuthResults?: string[]
} = {}): ParsedMail {
  const fromValues = Array.from({ length: overrides.fromValues ?? 1 }).fill({ address: overrides.from ?? 'ops@example.com', name: '' })
  const headerLines = [
    ...Array.from({ length: 1 + (overrides.extraFromHeaders ?? 0) }).fill({ key: 'From', line: `From: ${overrides.from ?? 'ops@example.com'}` }),
    ...(overrides.authResults ?? []).map(value => ({ key: 'Authentication-Results', line: `Authentication-Results: ${value}` })),
    ...(overrides.badAuthResults ?? []).map(value => ({ key: 'Authentication-Results', line: value })),
  ]
  return {
    from: overrides.fromValues === 0 ? undefined : { value: fromValues },
    to: overrides.to,
    headerLines,
    headers: new Map(overrides.deliveredTo === undefined ? [] : [['delivered-to', overrides.deliveredTo]]),
  } as unknown as ParsedMail
}

function authenticating(result: unknown): { authenticator: MailAuthenticator, spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async () => result as AuthenticateResult)
  return { authenticator: spy as unknown as MailAuthenticator, spy }
}

const failing: MailAuthenticator = () => Promise.reject(new Error('resolver down'))

interface AuthenticateOverrides {
  dmarc?: 'pass' | 'fail' | 'none' | 'temperror'
  underSized?: number
  spf?: 'pass' | 'fail'
}

function authResult(overrides: AuthenticateOverrides = {}): unknown {
  return {
    dmarc: overrides.dmarc === undefined
      ? false
      : {
          status: { result: overrides.dmarc },
          alignment: { dkim: { underSized: overrides.underSized } },
        },
    spf: overrides.spf === undefined ? false : { status: { result: overrides.spf } },
  }
}

async function evaluate(
  options: {
    mail?: ParsedMail
    account?: ImapAccount
    authenticator?: MailAuthenticator
    resolver?: DnsResolverLike
    internalDate?: Date
    /** `false` omits the injected clock, exercising the real one. */
    now?: boolean
  } = {},
) {
  return await evaluateImapSender({
    mail: options.mail ?? mail(),
    raw: Buffer.from('raw'),
    internalDate: options.internalDate ?? FRESH,
    account: options.account ?? account(),
    ...(options.now === false ? {} : { now: () => NOW }),
    ...(options.resolver ? { resolver: options.resolver } : {}),
    // Never let a test reach the real DNS resolver.
    authenticator: options.authenticator ?? failing,
  })
}

interface FakeResolver extends DnsResolverLike {
  resolve: ReturnType<typeof vi.fn>
  resolveTxt: ReturnType<typeof vi.fn>
}

function fakeResolver(txt: string[][] = [], addresses: string[] = []): FakeResolver {
  return { resolve: vi.fn(async () => addresses), resolveTxt: vi.fn(async () => txt) }
}

describe('evaluateImapSender sender identity', () => {
  it('rejects a message with no usable From header', async () => {
    expect(await evaluate({ mail: mail({ fromValues: 0 }) })).toMatchObject({ accepted: false, reason: 'invalid-from', transient: false })
    expect(await evaluate({ mail: mail({ extraFromHeaders: 1 }) })).toMatchObject({ accepted: false, reason: 'invalid-from' })
    expect(await evaluate({ mail: mail({ fromValues: 2 }) })).toMatchObject({ accepted: false, reason: 'invalid-from' })
    expect(await evaluate({ mail: mail({ from: '' }) })).toMatchObject({ accepted: false, reason: 'invalid-from' })
  })

  it('rejects a sender outside the allowlist', async () => {
    expect(await evaluate({ mail: mail({ from: 'stranger@example.com' }) })).toMatchObject({
      accepted: false,
      sender: 'stranger@example.com',
      reason: 'sender-not-allowed',
    })
    expect(await evaluate({ mail: mail({ from: 'ops@other.example.com' }) })).toMatchObject({ accepted: false, reason: 'sender-not-allowed' })
    expect(await evaluate({ mail: mail({ from: 'postmaster' }) })).toMatchObject({ accepted: false, reason: 'sender-not-allowed' })
  })

  it('matches a whole domain entry and the exact local part', async () => {
    const domain = account({ allowedSenders: ['@example.com'] })
    expect(await evaluate({ account: domain, mail: mail({ from: 'anyone@example.com' }), authenticator: authenticating(authResult({ dmarc: 'pass' })).authenticator })).toMatchObject({ accepted: true, strength: 'verified' })
    const other = account({ allowedSenders: ['ops'] })
    expect(await evaluate({ account: other, mail: mail({ from: 'ops@example.com' }) })).toMatchObject({ accepted: false, reason: 'sender-not-allowed' })
  })
})

describe('evaluateImapSender address tokens', () => {
  const tokenAccount = account({ addressTokens: [{ token: 's3cret', senders: ['ops@example.com'] }] })

  it('accepts a plus-address token without any authentication evidence', async () => {
    const verdict = await evaluate({
      account: tokenAccount,
      mail: mail({ to: { value: [{ address: 'ops+s3cret@example.com' }] } }),
      authenticator: failing,
    })

    expect(verdict).toMatchObject({ accepted: true, sender: 'ops@example.com', reason: 'token' })
  })

  it('looks at Delivered-To as well', async () => {
    expect(await evaluate({ account: tokenAccount, mail: mail({ deliveredTo: 'ops+s3cret@example.com' }), authenticator: failing }))
      .toMatchObject({ accepted: true, reason: 'token' })
    expect(await evaluate({ account: tokenAccount, mail: mail({ deliveredTo: ['not-an-address', 'ops+s3cret@example.com'] }), authenticator: failing }))
      .toMatchObject({ accepted: true, reason: 'token' })
  })

  it('ignores a token from a sender the entry does not list, or a wrong token', async () => {
    const verdict = await evaluate({
      account: tokenAccount,
      mail: mail({ to: { value: [{ address: 'ops+wr0ng@example.com' }] } }),
      authenticator: authenticating(authResult({ dmarc: 'fail' })).authenticator,
    })

    expect(verdict).toMatchObject({ accepted: false, reason: 'dmarc-fail' })

    const otherDomain = account({
      allowedSenders: ['ops@example.com'],
      addressTokens: [{ token: 's3cret', senders: ['@other.example.com'] }],
    })
    expect(await evaluate({ account: otherDomain, mail: mail({ to: { value: [{ address: 'ops+s3cret@example.com' }] } }), authenticator: authenticating(authResult({ dmarc: 'fail' })).authenticator }))
      .toMatchObject({ accepted: false, reason: 'dmarc-fail' })
  })

  it('reads an array of To headers and skips an entry with no address', async () => {
    const verdict = await evaluate({
      account: tokenAccount,
      mail: mail({ to: [{ value: [{ name: 'Ops' }] }, { value: [{ address: 'ops+wr0ng@example.com' }] }] }),
      authenticator: failing,
    })

    expect(verdict).toMatchObject({ accepted: false, reason: 'authentication-temperror', transient: true })
  })

  it('ignores a plus-address with no token at all', async () => {
    const verdict = await evaluate({
      account: tokenAccount,
      mail: mail({ to: { value: [{ address: 'ops+@example.com' }, { address: 'ops@example.com' }] } }),
      authenticator: authenticating(authResult({ dmarc: 'pass' })).authenticator,
    })

    expect(verdict).toMatchObject({ accepted: true, strength: 'verified' })
  })

  it('ignores a token whose length differs from the configured one', async () => {
    const verdict = await evaluate({
      account: tokenAccount,
      mail: mail({ to: { value: [{ address: 'ops+s3cret-longer@example.com' }] } }),
      authenticator: authenticating(authResult({ dmarc: 'pass' })).authenticator,
    })

    expect(verdict).toMatchObject({ accepted: true, strength: 'verified' })
  })
})

describe('evaluateImapSender authentication ladder', () => {
  it('uses the wall clock when no clock is injected', async () => {
    // Dating the message "now" keeps it fresh whatever the wall clock says, so
    // the verdict can only come from the gate.
    expect(await evaluate({ now: false, internalDate: new Date() })).toMatchObject({ accepted: false, reason: 'authentication-temperror' })
  })

  it('rejects a message that is too old to authenticate', async () => {
    expect(await evaluate({ internalDate: new Date(NOW - 49 * 60 * 60 * 1_000) })).toMatchObject({
      accepted: false,
      reason: 'message-too-old',
    })
  })

  it('accepts a DMARC pass and reports it as verified', async () => {
    const { authenticator, spy } = authenticating(authResult({ dmarc: 'pass' }))
    const verdict = await evaluate({ authenticator })

    expect(verdict).toMatchObject({ accepted: true, sender: 'ops@example.com', strength: 'verified', reason: 'dmarc-pass' })
    expect(spy).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ disableArc: true, disableBimi: true }))
  })

  it('refuses a signature that leaves part of the body unsigned', async () => {
    const { authenticator } = authenticating(authResult({ dmarc: 'pass', underSized: 512 }))

    expect(await evaluate({ authenticator })).toMatchObject({ accepted: false, strength: 'unverified', reason: 'dkim-unsigned-body', transient: false })
  })

  it('reports the DMARC outcome as the reason', async () => {
    expect(await evaluate({ authenticator: authenticating(authResult({ dmarc: 'fail' })).authenticator }))
      .toMatchObject({ accepted: false, strength: 'unverified', reason: 'dmarc-fail', transient: false })
    expect(await evaluate({ authenticator: authenticating(authResult()).authenticator }))
      .toMatchObject({ accepted: false, reason: 'dmarc-none' })
    expect(await evaluate({ authenticator: authenticating(authResult({ dmarc: 'temperror' })).authenticator }))
      .toMatchObject({ accepted: false, reason: 'authentication-temperror', transient: true })
  })

  it('accepts a passing result from a delivery agent the operator trusts', async () => {
    const trusted = account({
      senderAuth: { min: 'asserted', trustedAuthservIds: ['mx.example.com'], acceptTrustedAuthservId: true },
    })
    const message = mail({ authResults: ['mx.example.com 1; dkim=pass; dmarc=pass'] })

    expect(await evaluate({ account: trusted, mail: message, authenticator: failing })).toMatchObject({
      accepted: true,
      strength: 'asserted',
      reason: 'trusted-authserv-dmarc-pass',
    })
    expect(await evaluate({ account: trusted, mail: mail({ authResults: ['evil.example.com; dmarc=pass'] }), authenticator: failing }))
      .toMatchObject({ accepted: false, reason: 'authentication-temperror', transient: true })
    expect(await evaluate({ account: trusted, mail: mail({ authResults: ['evil.example.com; dmarc=pass'] }), authenticator: authenticating(authResult()).authenticator }))
      .toMatchObject({ accepted: false, reason: 'unverified-authentication', transient: false })
  })

  it('never trusts a delivery agent that is merely listed', async () => {
    const listed = account({ senderAuth: { min: 'verified', trustedAuthservIds: ['mx.example.com'], acceptTrustedAuthservId: false } })
    const message = mail({ authResults: ['mx.example.com; dmarc=pass'] })

    expect(await evaluate({ account: listed, mail: message, authenticator: authenticating(authResult()).authenticator })).toMatchObject({
      accepted: false,
      strength: 'unverified',
      reason: 'unverified-authentication',
      transient: false,
    })
  })

  it('counts an unaligned but passing signature as unverified evidence only', async () => {
    expect(await evaluate({ authenticator: authenticating(authResult({ spf: 'pass' })).authenticator }))
      .toMatchObject({ accepted: false, strength: 'unverified', reason: 'unverified-authentication', transient: false })
    expect(await evaluate({ authenticator: authenticating(authResult({ spf: 'pass', dmarc: 'temperror' })).authenticator }))
      .toMatchObject({ accepted: false, transient: true })
    expect(await evaluate({ mail: mail({ authResults: ['mx.example.com; dmarc=pass'] }), authenticator: authenticating(authResult()).authenticator }))
      .toMatchObject({ accepted: false, reason: 'unverified-authentication' })
    expect(await evaluate({ mail: mail({ authResults: ['mx.example.com; spf=pass'] }), authenticator: authenticating(authResult()).authenticator }))
      .toMatchObject({ accepted: false, reason: 'unverified-authentication' })
  })

  it('accepts a merely unverified sender when the floor allows it', async () => {
    const loose = account({ senderAuth: { min: 'mutable', trustedAuthservIds: [], acceptTrustedAuthservId: false } })

    expect(await evaluate({ account: loose, authenticator: authenticating(authResult()).authenticator }))
      .toMatchObject({ accepted: true, strength: 'unverified', reason: 'dmarc-none' })
  })

  it('treats a resolver outage as transient', async () => {
    expect(await evaluate({ authenticator: failing })).toMatchObject({
      accepted: false,
      strength: 'unverified',
      reason: 'authentication-temperror',
      transient: true,
    })
  })

  it('falls back to trusted delivery-agent evidence when the resolver is down', async () => {
    const trusted = account({
      senderAuth: { min: 'asserted', trustedAuthservIds: ['mx.example.com'], acceptTrustedAuthservId: true },
    })

    expect(await evaluate({ account: trusted, mail: mail({ authResults: ['mx.example.com; dmarc=pass'] }), authenticator: failing }))
      .toMatchObject({ accepted: true, strength: 'asserted' })
    expect(await evaluate({ account: account({ senderAuth: { min: 'asserted', trustedAuthservIds: [], acceptTrustedAuthservId: false } }), authenticator: failing }))
      .toMatchObject({ accepted: false, reason: 'authentication-temperror', transient: true })
  })

  it('ignores an Authentication-Results header it cannot parse', async () => {
    const message = mail({ badAuthResults: ['Authentication-Results: no-semicolon-here', 'Authentication-Results: bad id!; dmarc=pass'] })

    expect(await evaluate({ mail: message, authenticator: authenticating(authResult({ dmarc: 'fail' })).authenticator }))
      .toMatchObject({ accepted: false, reason: 'dmarc-fail' })
  })
})

describe('dnsAdapter', () => {
  it('routes TXT lookups to resolveTxt and everything else to resolve', async () => {
    const resolver = fakeResolver([['v=spf1 -all']], ['203.0.113.7'])

    expect(await dnsAdapter(resolver)('example.com', 'TXT')).toEqual([['v=spf1 -all']])
    expect(await dnsAdapter(resolver)('example.com', 'A')).toEqual(['203.0.113.7'])
  })
})

describe('evaluateImapSender bundled verifier', () => {
  it('falls back to mailauth with its own DNS resolver when none is injected', async () => {
    const resolver = fakeResolver()
    const verdict = await evaluateImapSender({
      mail: mail(),
      raw: Buffer.from('From: ops@example.com\r\nSubject: hi\r\n\r\nbody\r\n'),
      internalDate: FRESH,
      // `mutable` accepts the `dmarc-none` the empty DNS zone produces.
      account: account({ senderAuth: { min: 'mutable' } }),
      resolver,
      now: () => NOW,
    })

    expect(verdict).toMatchObject({ accepted: true, sender: 'ops@example.com', strength: 'unverified', reason: 'dmarc-none' })
    expect(resolver.resolveTxt.mock.calls.length + resolver.resolve.mock.calls.length).toBeGreaterThan(0)
  })
})
