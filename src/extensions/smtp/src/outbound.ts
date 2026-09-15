import type { ChannelOutbound, ChannelSendContext, ChannelSendResult, NotificationMessage } from '../../../plugin-sdk/index.js'
import type { SmtpConfig } from './config.js'
import { deliverMail, SmtpError } from './client.js'
import { resolveSmtpRecipients } from './config.js'
import { buildMimeMessage } from './message.js'

/**
 * Outbound SMTP channel: turns a Giclaw run notification into plain-text mail.
 *
 * Failures are reported, never thrown — `dispatchSafe` promises the reward
 * claim already committed, so a broken mail relay must not rewrite the run.
 */

export interface SmtpOutboundOptions {
  config: SmtpConfig
  /** Injectable for tests; defaults to the real SMTP client. */
  deliver?: typeof deliverMail
  /** Injectable clock for the `Date` header. */
  now?: () => Date
}

/** Human-readable body: the summary line plus the per-task detail. */
export function buildSmtpBody(message: NotificationMessage): string {
  const lines = [message.title, '', message.body]
  if (message.runId)
    lines.push('', `runId: ${message.runId}`, `trigger: ${message.trigger}`)
  return lines.join('\n')
}

export function createSmtpOutbound(options: SmtpOutboundOptions): ChannelOutbound {
  const { config } = options
  const deliver = options.deliver ?? deliverMail
  const now = options.now ?? (() => new Date())

  return {
    async send(message: NotificationMessage, context: ChannelSendContext): Promise<ChannelSendResult> {
      const recipients = resolveSmtpRecipients(config, context.target?.name)
      if (!recipients) {
        const detail = 'no SMTP recipient configured'
        context.logger.warn(`SMTP notification skipped: ${detail}`)
        return { ok: false, detail, retryable: false }
      }

      const mail = buildMimeMessage({
        from: recipients.from,
        to: recipients.to,
        subject: `${recipients.subjectPrefix}${message.title}`,
        text: buildSmtpBody(message),
        date: now(),
      })

      try {
        await deliver({
          host: config.host,
          port: config.port,
          secure: config.secure,
          timeoutMs: config.timeoutMs,
          rejectUnauthorized: config.rejectUnauthorized,
          clientName: config.clientName,
          user: config.user,
          password: config.password,
        }, { from: recipients.from, to: recipients.to, data: mail })

        return { ok: true, detail: `sent to ${recipients.to.length} recipient(s)` }
      }
      catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          retryable: error instanceof SmtpError ? error.retryable : true,
        }
      }
    },
  }
}
