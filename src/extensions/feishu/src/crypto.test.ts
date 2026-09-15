import { Buffer } from 'node:buffer'
import { createCipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { computeFeishuSignature, decryptFeishuPayload, deriveFeishuKey } from './crypto.js'

/** Mirror of the Feishu producer: `base64(iv || aes-256-cbc(payload))`. */
function encryptFeishuPayload(encryptKey: string, plaintext: string, iv: Buffer): string {
  const cipher = createCipheriv('aes-256-cbc', deriveFeishuKey(encryptKey), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return Buffer.concat([iv, ciphertext]).toString('base64')
}

describe('deriveFeishuKey', () => {
  it('is the sha256 hex of the configured key', () => {
    expect(deriveFeishuKey('key').toString('hex'))
      .toBe('2c70e12b7a0646f92279f427c7b38e7334d8e5389cff167a1dc30e73f826b683')
  })
})

describe('computeFeishuSignature', () => {
  it('hashes timestamp, nonce, key and body without separators', () => {
    // sha256('1' + 'n' + 'k' + '{}') — the four fields are concatenated directly.
    expect(computeFeishuSignature({ timestamp: '1', nonce: 'n', encryptKey: 'k', rawBody: '{}' }))
      .toBe('fbd3ecb62fa42b9df3d6535b48b10c06baffa1d019f207aa63dc69364da02a05')
  })

  it('is stable and 64 hex characters long', () => {
    const input = { timestamp: '1700000000', nonce: 'abc', encryptKey: 'secret', rawBody: '{"a":1}' }
    const signature = computeFeishuSignature(input)

    expect(signature).toMatch(/^[0-9a-f]{64}$/u)
    expect(computeFeishuSignature(input)).toBe(signature)
  })

  it('changes when any single input changes', () => {
    const base = { timestamp: '1', nonce: 'n', encryptKey: 'k', rawBody: '{}' }
    const baseSignature = computeFeishuSignature(base)

    expect(computeFeishuSignature({ ...base, rawBody: '{ }' })).not.toBe(baseSignature)
    expect(computeFeishuSignature({ ...base, timestamp: '2' })).not.toBe(baseSignature)
  })
})

describe('decryptFeishuPayload', () => {
  const key = 'test-encrypt-key'
  const iv = Buffer.from('0123456789abcdef', 'utf-8')

  it('recovers the JSON body written by the Feishu producer', () => {
    const encrypt = encryptFeishuPayload(key, '{"hello":"世界"}', iv)

    expect(decryptFeishuPayload(key, encrypt)).toBe('{"hello":"世界"}')
  })

  it('rejects a payload shorter than one AES block', () => {
    expect(() => decryptFeishuPayload(key, Buffer.alloc(16).toString('base64'))).toThrow(/shorter than one AES block/u)
  })

  it('rejects a payload encrypted with a different key', () => {
    const encrypt = encryptFeishuPayload('other-key', '{"hello":"world"}', iv)

    expect(() => decryptFeishuPayload(key, encrypt)).toThrow()
  })
})
