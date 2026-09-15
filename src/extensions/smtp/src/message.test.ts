import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  buildMimeMessage,
  dotStuff,
  encodeBody,
  encodeHeaderValue,
  flattenHeaderValue,
  formatMailDate,
} from './message.js'

describe('header helpers', () => {
  it('flattens multi-line header values', () => {
    expect(flattenHeaderValue('  line one\r\nline two\n')).toBe('line one line two')
  })

  it('leaves printable ASCII untouched', () => {
    expect(encodeHeaderValue('[Giclaw] run ok')).toBe('[Giclaw] run ok')
  })

  it('encodes non-ASCII values per RFC 2047', () => {
    expect(encodeHeaderValue('运行成功')).toBe(`=?UTF-8?B?${Buffer.from('运行成功', 'utf-8').toString('base64')}?=`)
  })

  it('formats the date as an RFC 5322 UTC timestamp', () => {
    expect(formatMailDate(new Date('2026-01-01T00:00:00.000Z'))).toBe('Thu 01 Jan 2026 00:00:00 +0000')
    expect(formatMailDate(new Date('2026-12-31T23:59:09.000Z'))).toBe('Thu 31 Dec 2026 23:59:09 +0000')
  })
})

describe('encodeBody', () => {
  it('base64 encodes an empty body', () => {
    expect(encodeBody('')).toBe('')
  })

  it('wraps long bodies at 76 characters', () => {
    const encoded = encodeBody('a'.repeat(200))
    const lines = encoded.split('\r\n')
    expect(lines).toHaveLength(4)
    expect(lines.map(line => line.length)).toEqual([76, 76, 76, 40])
    expect(Buffer.from(lines.join(''), 'base64').toString('utf-8')).toBe('a'.repeat(200))
  })
})

describe('dotStuff', () => {
  it('normalizes line endings and escapes leading dots', () => {
    expect(dotStuff('a\n.b\n..\n.')).toBe('a\r\n..b\r\n...\r\n..')
  })
})

describe('buildMimeMessage', () => {
  const base = {
    from: 'giclaw@example.com',
    to: ['ops@example.com'],
    subject: 'Run ok',
    text: 'all good',
    date: new Date('2026-01-01T00:00:00.000Z'),
  }

  it('builds headers plus a base64 body', () => {
    const message = buildMimeMessage(base)
    const [headers, body] = message.split('\r\n\r\n')

    expect(headers?.split('\r\n')).toEqual([
      'From: giclaw@example.com',
      'To: ops@example.com',
      'Subject: Run ok',
      'Date: Thu 01 Jan 2026 00:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
    ])
    expect(Buffer.from(body ?? '', 'base64').toString('utf-8')).toBe('all good')
  })

  it('joins multiple recipients and flattens the subject', () => {
    const message = buildMimeMessage({
      ...base,
      to: ['ops@example.com', 'oncall@example.com'],
      subject: 'line one\r\nBcc: evil@example.com',
    })

    expect(message).toContain('To: ops@example.com, oncall@example.com\r\n')
    expect(message).toContain('Subject: line one Bcc: evil@example.com\r\n')
    expect(message).not.toContain('\r\nBcc:')
  })

  it('rejects an invalid sender', () => {
    expect(() => buildMimeMessage({ ...base, from: 'not-an-address' })).toThrow('Invalid sender email address: not-an-address')
  })

  it('rejects an invalid recipient', () => {
    expect(() => buildMimeMessage({ ...base, to: ['ok@example.com', 'nope'] })).toThrow('Invalid recipient email address: nope')
  })
})
