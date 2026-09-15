import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signFeishuWebhook } from './sign.js'

describe('signFeishuWebhook', () => {
  it('matches the documented base64 HMAC-SHA256 algorithm', () => {
    const expected = createHmac('sha256', '1700000000\ns3cret').update('').digest('base64')
    expect(signFeishuWebhook('s3cret', 1_700_000_000)).toBe(expected)
  })

  it('changes with the timestamp', () => {
    expect(signFeishuWebhook('s3cret', 1)).not.toBe(signFeishuWebhook('s3cret', 2))
  })

  it('changes with the secret', () => {
    expect(signFeishuWebhook('a', 1)).not.toBe(signFeishuWebhook('b', 1))
  })
})
