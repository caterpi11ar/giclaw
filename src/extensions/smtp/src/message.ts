import { Buffer } from 'node:buffer'
import { isMailAddress } from '../../../utils/mail.js'

/**
 * RFC 5322 / MIME message assembly.
 *
 * Giclaw sends plain-text UTF-8 mail only: the body is base64 encoded (so no
 * content-transfer or 8-bit hazards) and every header value is flattened to a
 * single line so a task message can never inject extra headers.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const ASCII_PRINTABLE = /^[\u0020-\u007E]*$/u

export interface MailMessage {
  from: string
  to: string[]
  subject: string
  text: string
  date: Date
}

function assertAddress(value: string, label: string): void {
  if (!isMailAddress(value))
    throw new Error(`Invalid ${label} email address: ${value}`)
}

/** Collapse CR/LF so a header value cannot start a new header. */
export function flattenHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').trim()
}

/** RFC 2047 encode a header value that is not pure printable ASCII. */
export function encodeHeaderValue(value: string): string {
  if (ASCII_PRINTABLE.test(value))
    return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`
}

/** RFC 5322 date in the fixed `+0000` zone. */
export function formatMailDate(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0')
  return `${WEEKDAYS[date.getUTCDay()]} ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]}`
    + ` ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
}

/** Base64 the body, wrapped at 76 characters as MIME requires. */
export function encodeBody(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64').match(/.{1,76}/gu)?.join('\r\n') ?? ''
}

/**
 * Normalize line endings and escape leading dots, as required after `DATA`.
 * A line that is exactly `.` would otherwise terminate the message early.
 */
export function dotStuff(text: string): string {
  return text
    .replace(/\r?\n/gu, '\r\n')
    .split('\r\n')
    .map(line => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n')
}

export function buildMimeMessage(message: MailMessage): string {
  assertAddress(message.from, 'sender')
  for (const recipient of message.to)
    assertAddress(recipient, 'recipient')

  const headers = [
    `From: ${message.from}`,
    `To: ${message.to.join(', ')}`,
    `Subject: ${encodeHeaderValue(flattenHeaderValue(message.subject))}`,
    `Date: ${formatMailDate(message.date)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ]

  return `${headers.join('\r\n')}\r\n\r\n${encodeBody(message.text)}`
}
