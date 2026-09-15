import { createHmac } from 'node:crypto'

/**
 * Feishu custom-bot signature.
 *
 * The documented algorithm is `base64(HMAC-SHA256(key = "<timestamp>\n<secret>", data = ""))`
 * where `timestamp` is in seconds. We keep it in one place so both the sender
 * and its tests cannot drift apart.
 */
export function signFeishuWebhook(secret: string, timestamp: number): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
}
