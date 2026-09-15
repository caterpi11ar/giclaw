import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SMTP_HOST_PORT,
  DEFAULT_SMTP_TIMEOUT_MS,
  isLoopbackHost,
  resolveSmtpRecipients,
  resolveSmtpTarget,
  smtpConfigSchema,
  smtpPluginConfig,
} from './config.js'

const minimal = { host: 'smtp.example.com', from: 'giclaw@example.com' }

describe('smtpConfigSchema', () => {
  it('applies safe defaults', () => {
    const config = smtpConfigSchema.parse(minimal)

    expect(config).toMatchObject({
      port: DEFAULT_SMTP_HOST_PORT,
      secure: 'starttls',
      subjectPrefix: '[Giclaw] ',
      timeoutMs: DEFAULT_SMTP_TIMEOUT_MS,
      rejectUnauthorized: true,
      clientName: 'giclaw',
      to: [],
      targets: {},
    })
  })

  it('parses through the plugin config facade', () => {
    expect(smtpPluginConfig.parse(minimal)).toMatchObject({ port: DEFAULT_SMTP_HOST_PORT })
    expect(smtpPluginConfig.parse({ ...minimal, port: 465, secure: 'implicit' })).toMatchObject({ port: 465, secure: 'implicit' })
  })

  it('requires a relay host and a sender address', () => {
    expect(() => smtpPluginConfig.parse({})).toThrow()
    expect(() => smtpPluginConfig.parse(undefined)).toThrow()
    expect(() => smtpPluginConfig.parse(null)).toThrow()
    expect(smtpConfigSchema.safeParse({ host: 'smtp.example.com' }).success).toBe(false)
    expect(smtpConfigSchema.safeParse({ ...minimal, host: '' }).success).toBe(false)
  })

  it('rejects cleartext submission to a remote relay', () => {
    const result = smtpConfigSchema.safeParse({ ...minimal, secure: 'none' })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['secure'])
    expect(result.error?.issues[0]?.message).toBe('secure "none" is only allowed for a loopback relay host')
  })

  it('accepts cleartext submission to loopback relays', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true)
      expect(smtpConfigSchema.safeParse({ ...minimal, host, secure: 'none' }).success).toBe(true)
    }
    expect(isLoopbackHost('SMTP.EXAMPLE.COM')).toBe(false)
    expect(smtpConfigSchema.safeParse({ ...minimal, host: 'smtp.example.com', secure: 'starttls' }).success).toBe(true)
  })

  it('validates sender and recipient addresses', () => {
    expect(smtpConfigSchema.safeParse({ ...minimal, from: 'nope' }).success).toBe(false)
    expect(smtpConfigSchema.safeParse({ ...minimal, to: ['ops@example.com', 'nope'] }).success).toBe(false)
    expect(smtpConfigSchema.safeParse({ ...minimal, targets: { ops: { to: ['Ops <ops@example.com>'] } } }).success).toBe(false)
  })

  it('requires at least one recipient per target and caps the list', () => {
    expect(smtpConfigSchema.safeParse({ ...minimal, targets: { ops: { to: [] } } }).success).toBe(false)
    const many = Array.from({ length: 101 }, (_, index) => `ops${index}@example.com`)
    expect(smtpConfigSchema.safeParse({ ...minimal, targets: { ops: { to: many } } }).success).toBe(false)
    expect(smtpConfigSchema.safeParse({ ...minimal, to: many }).success).toBe(false)
  })
})

describe('resolveSmtpTarget', () => {
  const config = smtpConfigSchema.parse({
    ...minimal,
    defaultTarget: 'oncall',
    targets: {
      ops: { to: ['ops@example.com'] },
      oncall: { to: ['oncall@example.com'], from: 'alerts@example.com', subjectPrefix: '[Alert] ' },
    },
  })

  it('prefers an explicit target', () => {
    expect(resolveSmtpTarget(config, 'ops')).toMatchObject({ to: ['ops@example.com'] })
  })

  it('falls back to the default target', () => {
    expect(resolveSmtpTarget(config)).toMatchObject({ to: ['oncall@example.com'] })
    expect(resolveSmtpTarget(config, 'missing')).toMatchObject({ to: ['oncall@example.com'] })
  })

  it('falls back to the first target when no default is declared', () => {
    const config = smtpConfigSchema.parse({ ...minimal, targets: { ops: { to: ['ops@example.com'] } } })
    expect(resolveSmtpTarget(config)).toMatchObject({ to: ['ops@example.com'] })
  })

  it('returns undefined when nothing is declared', () => {
    expect(resolveSmtpTarget(smtpConfigSchema.parse(minimal))).toBeUndefined()
  })

  it('ignores prototype keys', () => {
    const config = smtpConfigSchema.parse({ ...minimal, targets: { ops: { to: ['ops@example.com'] } } })
    expect(resolveSmtpTarget(config, 'toString')).toMatchObject({ to: ['ops@example.com'] })
  })
})

describe('resolveSmtpRecipients', () => {
  it('returns null when no recipient is configured', () => {
    expect(resolveSmtpRecipients(smtpConfigSchema.parse(minimal))).toBeNull()
  })

  it('uses the plugin-level defaults', () => {
    const config = smtpConfigSchema.parse({ ...minimal, to: ['ops@example.com'] })

    expect(resolveSmtpRecipients(config)).toEqual({
      from: 'giclaw@example.com',
      to: ['ops@example.com'],
      subjectPrefix: '[Giclaw] ',
    })
  })

  it('lets a named target override every field', () => {
    const config = smtpConfigSchema.parse({
      ...minimal,
      to: ['ops@example.com'],
      targets: {
        finance: { to: ['finance@example.com'], from: 'billing@example.com', subjectPrefix: '[Billing] ' },
      },
    })

    expect(resolveSmtpRecipients(config, 'finance')).toEqual({
      from: 'billing@example.com',
      to: ['finance@example.com'],
      subjectPrefix: '[Billing] ',
    })
  })

  it('lets an unnamed target win over the plugin-level recipients', () => {
    const config = smtpConfigSchema.parse({
      ...minimal,
      to: ['ops@example.com'],
      targets: { finance: { to: ['finance@example.com'] } },
    })

    expect(resolveSmtpRecipients(config)).toMatchObject({ to: ['finance@example.com'], from: 'giclaw@example.com' })
  })
})
