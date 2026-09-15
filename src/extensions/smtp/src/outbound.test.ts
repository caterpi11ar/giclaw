import type { AppConfig } from '../../../config/schema.js'
import type { NotificationMessage, PluginLogger } from '../../../plugin-sdk/index.js'
import type { SmtpDeliveryOptions, SmtpEnvelope } from './client.js'
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../../../config/schema.js'
import { SmtpError } from './client.js'
import { smtpConfigSchema } from './config.js'
import { buildSmtpBody, createSmtpOutbound } from './outbound.js'

const message: NotificationMessage = {
  level: 'success',
  title: 'Giclaw 运行成功 (1/1)',
  body: '✓ welkin-moon',
  runId: 'run-1',
  trigger: 'cron',
  occurredAt: '2026-01-01T00:00:00.000Z',
  results: [{ taskId: 'welkin-moon', success: true, message: 'done', durationMs: 12 }],
}

const appConfig: AppConfig = appConfigSchema.parse({})
const logger: PluginLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const context = { config: appConfig, channelConfig: {}, logger }

const baseConfig = smtpConfigSchema.parse({
  host: 'smtp.example.com',
  from: 'giclaw@example.com',
  to: ['ops@example.com'],
})

type DeliverMock = ReturnType<typeof vi.fn<(options: SmtpDeliveryOptions, envelope: SmtpEnvelope) => Promise<void>>>

/** Read the single delivery a mocked client was asked to make. */
function capture(deliver: DeliverMock): { options: SmtpDeliveryOptions, envelope: SmtpEnvelope } {
  const call = deliver.mock.calls[0] as [SmtpDeliveryOptions, SmtpEnvelope]
  const [options, envelope] = call
  return { options, envelope }
}

/** Decode the `Subject` header, RFC 2047 encoded or not. */
function decodeSubject(data: string): string {
  const header = data.split('\r\n').find(value => value.startsWith('Subject: ')) as string
  const encoded = header.slice('Subject: '.length)
  const match = /^=\?UTF-8\?B\?(.+)\?=$/u.exec(encoded)
  return match ? Buffer.from(match[1] as string, 'base64').toString('utf-8') : encoded
}

describe('buildSmtpBody', () => {
  it('includes the run identifiers', () => {
    expect(buildSmtpBody(message)).toBe([
      'Giclaw 运行成功 (1/1)',
      '',
      '✓ welkin-moon',
      '',
      'runId: run-1',
      'trigger: cron',
    ].join('\n'))
  })

  it('omits the run identifiers when they are absent', () => {
    const { runId: _runId, trigger: _trigger, ...rest } = message
    expect(buildSmtpBody(rest as NotificationMessage)).toBe('Giclaw 运行成功 (1/1)\n\n✓ welkin-moon')
  })
})

describe('createSmtpOutbound', () => {
  it('sends a MIME message to the configured recipients', async () => {
    const deliver = vi.fn<(options: SmtpDeliveryOptions, envelope: SmtpEnvelope) => Promise<void>>(async () => {})
    const outbound = createSmtpOutbound({
      config: baseConfig,
      deliver,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    })

    await expect(outbound.send(message, context)).resolves.toEqual({ ok: true, detail: 'sent to 1 recipient(s)' })

    expect(deliver).toHaveBeenCalledTimes(1)
    const { envelope, options } = capture(deliver)
    expect(options).toMatchObject({ host: 'smtp.example.com', port: 587, secure: 'starttls', clientName: 'giclaw' })
    expect(envelope.from).toBe('giclaw@example.com')
    expect(envelope.to).toEqual(['ops@example.com'])
    expect(decodeSubject(envelope.data)).toBe('[Giclaw] Giclaw 运行成功 (1/1)')
    expect(Buffer.from(envelope.data.split('\r\n\r\n')[1] ?? '', 'base64').toString('utf-8'))
      .toBe(buildSmtpBody(message))
  })

  it('honours a named route target', async () => {
    const deliver = vi.fn<(options: SmtpDeliveryOptions, envelope: SmtpEnvelope) => Promise<void>>(async () => {})
    const outbound = createSmtpOutbound({
      config: smtpConfigSchema.parse({
        ...baseConfig,
        targets: { finance: { to: ['finance@example.com'], from: 'billing@example.com', subjectPrefix: '[Billing] ' } },
      }),
      deliver,
    })

    await outbound.send(message, { ...context, target: { name: 'finance' } })

    const { envelope } = capture(deliver)
    expect(envelope.from).toBe('billing@example.com')
    expect(envelope.to).toEqual(['finance@example.com'])
    expect(decodeSubject(envelope.data)).toBe('[Billing] Giclaw 运行成功 (1/1)')
  })

  it('skips when no recipient is configured', async () => {
    const deliver = vi.fn<(options: SmtpDeliveryOptions, envelope: SmtpEnvelope) => Promise<void>>(async () => {})
    const outbound = createSmtpOutbound({
      config: smtpConfigSchema.parse({ host: 'smtp.example.com', from: 'giclaw@example.com' }),
      deliver,
    })

    await expect(outbound.send(message, context))
      .resolves
      .toEqual({ ok: false, detail: 'no SMTP recipient configured', retryable: false })
    expect(deliver).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('SMTP notification skipped: no SMTP recipient configured')
  })

  it('reports a transient SMTP failure as retryable', async () => {
    const outbound = createSmtpOutbound({
      config: baseConfig,
      deliver: async () => {
        throw new SmtpError('MAIL FROM failed: 451 4.3.0 try later', 451, true)
      },
    })

    await expect(outbound.send(message, context))
      .resolves
      .toEqual({ ok: false, detail: 'MAIL FROM failed: 451 4.3.0 try later', retryable: true })
  })

  it('reports a permanent SMTP failure as non-retryable', async () => {
    const outbound = createSmtpOutbound({
      config: baseConfig,
      deliver: async () => {
        throw new SmtpError('AUTH PLAIN failed: 535 5.7.8 nope', 535, false)
      },
    })

    await expect(outbound.send(message, context)).resolves.toMatchObject({ retryable: false })
  })

  it('treats a transport failure as retryable', async () => {
    const outbound = createSmtpOutbound({
      config: baseConfig,
      deliver: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:587')
      },
    })

    await expect(outbound.send(message, context)).resolves.toEqual({
      ok: false,
      detail: 'connect ECONNREFUSED 127.0.0.1:587',
      retryable: true,
    })
  })

  it('stringifies a rejection that is not an Error', async () => {
    const outbound = createSmtpOutbound({
      config: baseConfig,
      deliver: async () => {
        // eslint-disable-next-line prefer-promise-reject-errors -- exercising a non-Error rejection
        return Promise.reject('relay exploded')
      },
    })

    await expect(outbound.send(message, context)).resolves.toEqual({
      ok: false,
      detail: 'relay exploded',
      retryable: true,
    })
  })

  it('defaults the clock when none is injected', async () => {
    const deliver = vi.fn<(options: SmtpDeliveryOptions, envelope: SmtpEnvelope) => Promise<void>>(async () => {})
    const outbound = createSmtpOutbound({ config: baseConfig, deliver })

    await outbound.send(message, context)

    const { envelope } = capture(deliver)
    expect(envelope.data).toMatch(/Date: \w{3} \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000\r\n/u)
  })
})
