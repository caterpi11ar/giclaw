import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Request/response header carrying the HMAC-SHA256 signature. */
export const SIGNATURE_HEADER = 'x-giclaw-signature'

const PREFIX = 'sha256='

export function signPayload(secret: string, body: string): string {
  return `${PREFIX}${createHmac('sha256', secret).update(body, 'utf-8').digest('hex')}`
}

/** Constant-time signature comparison; a missing header is always invalid. */
export function verifySignature(
  secret: string,
  body: string,
  header: string | string[] | undefined,
): boolean {
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string' || value.length === 0)
    return false
  const actual = Buffer.from(value)
  const expected = Buffer.from(signPayload(secret, body))
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
