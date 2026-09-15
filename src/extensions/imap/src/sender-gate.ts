import type { AuthenticateResult } from 'mailauth'
import type { AddressObject, ParsedMail } from 'mailparser'
import type { IdentifierAuthentication } from '../../../plugin-sdk/index.js'
import type { ImapAccount } from './config.js'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { authenticate } from 'mailauth'
import { meetsIdentifierAuthentication } from '../../../plugin-sdk/index.js'

/**
 * Decide whether an inbound message may start a run.
 *
 * Ported from openclaw's `extensions/imap/src/sender-gate.ts`: the `From`
 * header is attacker-controlled, so a sender is only trusted as far as its
 * authentication evidence goes. Giclaw computes DMARC/SPF itself with
 * `mailauth` (that is what the dependency buys), or — with `senderAuth.min:
 * "asserted"` — accepts a passing result written by a delivery agent the
 * operator listed in `trustedAuthservIds`.
 */

/** How long a message may sit before it is not worth authenticating. */
const AUTH_FRESHNESS_MS = 48 * 60 * 60 * 1_000
const DNS_TIMEOUT_MS = 5_000

type ImapAuthReason
  = | `dmarc-${string}`
    | 'dkim-unsigned-body'
    | 'trusted-authserv-dmarc-pass'
    | 'unverified-authentication'
    | 'authentication-temperror'

export type SenderGateVerdict
  = | { accepted: true, sender: string, reason: 'token' }
    | { accepted: false, sender?: string, reason: 'invalid-from' | 'sender-not-allowed' | 'message-too-old', transient: false }
    | (ImapAuthEvidence & { sender: string } & ({ accepted: true } | { accepted: false, transient: boolean }))

interface ImapAuthEvidence {
  strength: IdentifierAuthentication
  reason: ImapAuthReason
}

/** Injectable so tests never touch DNS. */
export type MailAuthenticator = typeof authenticate

/** The slice of `node:dns/promises`' `Resolver` that `mailauth` needs. */
export interface DnsResolverLike {
  resolve: (domain: string) => Promise<string[]>
  resolveTxt: (domain: string) => Promise<string[][]>
}

/** Adapter from the resolver object to the callback `mailauth` queries. */
export function dnsAdapter(resolver: DnsResolverLike) {
  return async (domain: string, rrtype: string): Promise<string[][] | string[]> =>
    rrtype === 'TXT' ? await resolver.resolveTxt(domain) : await resolver.resolve(domain)
}

function matchesImapSender(sender: string, entries: readonly string[]): boolean {
  const at = sender.lastIndexOf('@')
  if (at < 1)
    return false
  const local = sender.slice(0, at)
  const domain = sender.slice(at + 1).toLowerCase()
  return entries.some((entry) => {
    if (entry.startsWith('@'))
      return entry.slice(1).toLowerCase() === domain
    const entryAt = entry.lastIndexOf('@')
    return entryAt > 0
      && entry.slice(0, entryAt) === local
      && entry.slice(entryAt + 1).toLowerCase() === domain
  })
}

function recipientAddresses(mail: ParsedMail): string[] {
  const to = mail.to ? (Array.isArray(mail.to) ? mail.to : [mail.to]) : []
  const delivered = mail.headers.get('delivered-to')
  const deliveredValues = typeof delivered === 'string'
    ? [delivered]
    : Array.isArray(delivered)
      ? delivered.filter((entry): entry is string => typeof entry === 'string')
      : []
  return [
    ...to.flatMap((address: AddressObject) => address.value.map(entry => entry.address ?? '')),
    ...deliveredValues,
  ]
}

/** `user+token@example.com` proves the sender knew the token. */
function constantTokenMatch(address: string, expected: string): boolean {
  const local = address.slice(0, address.lastIndexOf('@'))
  const plus = local.lastIndexOf('+')
  if (plus < 0)
    return false
  const actualBytes = Buffer.from(local.slice(plus + 1))
  const expectedBytes = Buffer.from(expected)
  return actualBytes.byteLength === expectedBytes.byteLength
    && timingSafeEqual(actualBytes, expectedBytes)
}

function matchingSenderToken(mail: ParsedMail, sender: string, account: ImapAccount): boolean {
  return account.addressTokens.some(({ token, senders }) =>
    matchesImapSender(sender, senders)
    && recipientAddresses(mail).some(address => constantTokenMatch(address, token)))
}

interface AuthenticationHeader {
  authservId: string
  dmarc?: string
  spf?: string
}

/** `Authentication-Results` as written by the receiving agent, if any. */
function parseImapAuthResults(value: string): AuthenticationHeader | undefined {
  const unfolded = value.replace(/\r?\n[\t ]+/gu, ' ')
  const separator = unfolded.indexOf(';')
  if (separator < 1)
    return undefined
  const authservId = unfolded.slice(0, separator).trim().replace(/\s+\d+$/u, '')
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(authservId))
    return undefined
  const methods = unfolded.slice(separator + 1)
  const dmarc = /(?:^|;)\s*dmarc\s*=\s*([a-z]+)/iu.exec(methods)?.[1]?.toLowerCase()
  const spf = /(?:^|;)\s*spf\s*=\s*([a-z]+)/iu.exec(methods)?.[1]?.toLowerCase()
  return { authservId, ...(dmarc ? { dmarc } : {}), ...(spf ? { spf } : {}) }
}

function authenticationHeaders(mail: ParsedMail): AuthenticationHeader[] {
  return mail.headerLines
    .filter(({ key }) => key.toLowerCase() === 'authentication-results')
    .flatMap(({ line }) => {
      const colon = line.indexOf(':')
      const parsed = parseImapAuthResults(line.slice(colon + 1))
      return parsed ? [parsed] : []
    })
}

function mapImapAuthStrength(
  result: AuthenticateResult | undefined,
  headers: readonly AuthenticationHeader[],
  account: ImapAccount,
): ImapAuthEvidence & { transient: boolean } {
  const dmarc = result?.dmarc && result.dmarc.status.result
  // mailauth omits `alignment` entirely when no DMARC policy exists (verified
  // against 5.0.3), so this guard cannot assume the object is there.
  if (result?.dmarc && result.dmarc.alignment?.dkim?.underSized)
    return { strength: 'unverified', reason: 'dkim-unsigned-body', transient: false }
  if (dmarc === 'pass')
    return { strength: 'verified', reason: 'dmarc-pass', transient: false }
  const trusted = headers.find(header =>
    header.dmarc === 'pass' && account.senderAuth.trustedAuthservIds.includes(header.authservId))
  if (trusted && account.senderAuth.acceptTrustedAuthservId)
    return { strength: 'asserted', reason: 'trusted-authserv-dmarc-pass', transient: false }
  const spfPass = result?.spf && result.spf.status.result === 'pass'
  const untrustedEvidence = headers.some(header => header.dmarc === 'pass' || header.spf === 'pass')
  if (spfPass || untrustedEvidence)
    return { strength: 'unverified', reason: 'unverified-authentication', transient: dmarc === 'temperror' }
  return {
    strength: 'unverified',
    reason: dmarc === 'temperror' ? 'authentication-temperror' : `dmarc-${dmarc || 'none'}`,
    transient: dmarc === 'temperror',
  }
}

export interface EvaluateImapSenderOptions {
  mail: ParsedMail
  /** The raw message bytes; authentication signatures cover exactly these. */
  raw: Buffer
  internalDate: Date
  account: ImapAccount
  authenticator?: MailAuthenticator
  /** Injectable DNS for tests; production builds its own resolver. */
  resolver?: DnsResolverLike
  now?: () => number
}

/**
 * Verdict for one message: `accepted` says whether it may start a run, and
 * `transient` says whether the decision is worth retrying.
 */
export async function evaluateImapSender(params: EvaluateImapSenderOptions): Promise<SenderGateVerdict> {
  const now = params.now ?? Date.now
  const fromValues = params.mail.from?.value ?? []
  const fromHeaders = params.mail.headerLines.filter(({ key }) => key.toLowerCase() === 'from')
  if (fromHeaders.length !== 1 || fromValues.length !== 1 || !fromValues[0]?.address)
    return { accepted: false, reason: 'invalid-from', transient: false }

  const sender = fromValues[0].address
  if (!matchesImapSender(sender, params.account.allowedSenders))
    return { accepted: false, sender, reason: 'sender-not-allowed', transient: false }
  if (matchingSenderToken(params.mail, sender, params.account))
    return { accepted: true, sender, reason: 'token' }
  if (now() - params.internalDate.getTime() > AUTH_FRESHNESS_MS)
    return { accepted: false, sender, reason: 'message-too-old', transient: false }

  const fallback = authenticationHeaders(params.mail)
  const result = await runAuthenticator(params)
  if (result === undefined) {
    const evidence = mapImapAuthStrength(undefined, fallback, params.account)
    if (evidence.strength === 'asserted' && meetsIdentifierAuthentication(evidence.strength, params.account.senderAuth.min))
      return { accepted: true, sender, strength: evidence.strength, reason: evidence.reason }
    return { accepted: false, sender, strength: 'unverified', reason: 'authentication-temperror', transient: true }
  }
  const evidence = mapImapAuthStrength(result, fallback, params.account)
  if (!meetsIdentifierAuthentication(evidence.strength, params.account.senderAuth.min))
    return { accepted: false, sender, ...evidence }
  return { accepted: true, sender, strength: evidence.strength, reason: evidence.reason }
}

/** `undefined` result means "the verifier failed"; a resolution means it ran. */
function runAuthenticator(params: EvaluateImapSenderOptions): Promise<AuthenticateResult | undefined> {
  const resolver = params.resolver ?? new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 })
  return (params.authenticator ?? authenticate)(params.raw, {
    resolver: dnsAdapter(resolver),
    disableArc: true,
    disableBimi: true,
  }).then(
    result => result,
    // A resolver outage is a transport failure, not a forged message: the
    // caller turns it into a transient verdict from the delivery-agent headers.
    () => undefined,
  )
}
