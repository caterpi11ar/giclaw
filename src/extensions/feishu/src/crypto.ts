import { Buffer } from 'node:buffer'
import { createDecipheriv, createHash } from 'node:crypto'

/**
 * Feishu event-callback cryptography.
 *
 * Feishu never HMACs: the `X-Lark-Signature` header is a plain SHA-256 over
 * `timestamp + nonce + encryptKey + rawBody`, and encrypted events are
 * AES-256-CBC with the AES key derived as `sha256(encryptKey)`.
 */

/** AES key derivation used for both signature material and payload decryption. */
export function deriveFeishuKey(encryptKey: string): Buffer {
  return createHash('sha256').update(encryptKey, 'utf-8').digest()
}

export interface FeishuSignatureInput {
  timestamp: string
  nonce: string
  encryptKey: string
  /** Exact bytes of the request body, before any decryption. */
  rawBody: string
}

/** Lowercase hex SHA-256 the receiver compares against `X-Lark-Signature`. */
export function computeFeishuSignature(input: FeishuSignatureInput): string {
  return createHash('sha256')
    .update(input.timestamp, 'utf-8')
    .update(input.nonce, 'utf-8')
    .update(input.encryptKey, 'utf-8')
    .update(input.rawBody, 'utf-8')
    .digest('hex')
}

/**
 * Decrypt the `encrypt` field of an event body.
 *
 * Layout is `base64(iv[16] || aes-256-cbc(payload))`; anything shorter than an
 * IV is rejected before the cipher is constructed.
 */
export function decryptFeishuPayload(encryptKey: string, encrypt: string): string {
  const payload = Buffer.from(encrypt, 'base64')
  if (payload.byteLength <= 16)
    throw new Error('Encrypted payload is shorter than one AES block')
  const decipher = createDecipheriv('aes-256-cbc', deriveFeishuKey(encryptKey), payload.subarray(0, 16))
  return Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]).toString('utf-8')
}
