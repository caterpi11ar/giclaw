import type { PluginConfigSchema } from '../../../plugin-sdk/index.js'
import { z } from 'zod'
import { isMailAddress } from '../../../utils/mail.js'

/**
 * SMTP notification transport.
 *
 * Giclaw addition: openclaw only reads mail (IMAP inbound), so an outbound
 * transport is needed for run notifications. Cleartext submission is allowed
 * only against a loopback relay — everything else must encrypt in transit.
 */

export const SMTP_SECURITY_MODES = ['starttls', 'implicit', 'none'] as const
export type SmtpSecurityMode = (typeof SMTP_SECURITY_MODES)[number]

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]'])

export const DEFAULT_SMTP_HOST_PORT = 587
export const DEFAULT_SMTP_TIMEOUT_MS = 15_000

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase())
}

const addressSchema = z
  .string()
  .min(3)
  .max(320)
  .refine(isMailAddress, 'must be a bare email address such as ops@example.com')

const recipientListSchema = z.array(addressSchema).min(1).max(100)

const targetSchema = z.object({
  to: recipientListSchema,
  from: addressSchema.optional(),
  subjectPrefix: z.string().max(200).optional(),
})

export const smtpConfigSchema = z
  .object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65_535).default(DEFAULT_SMTP_HOST_PORT),
    /** `starttls` (default), `implicit` (SMTPS) or `none` for a loopback relay only. */
    secure: z.enum(SMTP_SECURITY_MODES).default('starttls'),
    user: z.string().min(1).max(255).optional(),
    password: z.string().min(1).max(4_096).optional(),
    /** Envelope sender; also the default `From` header. */
    from: addressSchema,
    /** Default recipients when a route does not name a target. */
    to: z.array(addressSchema).max(100).default([]),
    defaultTarget: z.string().min(1).max(100).optional(),
    targets: z.record(targetSchema).default({}),
    subjectPrefix: z.string().max(200).default('[Giclaw] '),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_SMTP_TIMEOUT_MS),
    /** Server certificate verification; disable only for a trusted internal relay. */
    rejectUnauthorized: z.boolean().default(true),
    /** Name announced in `EHLO`. */
    clientName: z.string().min(1).max(255).default('giclaw'),
  })
  .refine(config => config.secure !== 'none' || isLoopbackHost(config.host), {
    message: 'secure "none" is only allowed for a loopback relay host',
    path: ['secure'],
  })

export type SmtpConfig = z.infer<typeof smtpConfigSchema>
export type SmtpTarget = z.infer<typeof targetSchema>

export const smtpPluginConfig: PluginConfigSchema<SmtpConfig> = {
  parse: input => smtpConfigSchema.parse(input ?? {}),
}

export interface ResolvedSmtpRecipients {
  from: string
  to: string[]
  subjectPrefix: string
}

/** Pick the target for a notification route: explicit name, default, then first. */
export function resolveSmtpTarget(config: SmtpConfig, name?: string): SmtpTarget | undefined {
  if (name !== undefined && Object.hasOwn(config.targets, name))
    return config.targets[name] as SmtpTarget
  if (config.defaultTarget !== undefined && Object.hasOwn(config.targets, config.defaultTarget))
    return config.targets[config.defaultTarget] as SmtpTarget
  return Object.values(config.targets)[0]
}

/** Envelope + header values for a send; `null` when no recipient is configured. */
export function resolveSmtpRecipients(config: SmtpConfig, name?: string): ResolvedSmtpRecipients | null {
  const target = resolveSmtpTarget(config, name)
  const to = target?.to ?? config.to
  if (to.length === 0)
    return null

  return {
    from: target?.from ?? config.from,
    to,
    subjectPrefix: target?.subjectPrefix ?? config.subjectPrefix,
  }
}
