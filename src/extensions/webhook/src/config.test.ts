import { describe, expect, it } from 'vitest'
import { INBOUND_COMMANDS, resolveEndpoint, webhookConfigSchema, webhookPluginConfig } from './config.js'

describe('webhookConfigSchema', () => {
  it('applies inbound defaults', () => {
    const config = webhookConfigSchema.parse({
      inbound: { path: '/api/ext/webhook', secret: 's3cret' },
    })

    expect(config.endpoints).toEqual({})
    expect(config.inbound?.commands).toEqual([...INBOUND_COMMANDS])
    expect(config.inbound?.maxBodyBytes).toBe(65_536)
  })

  it('accepts a fully specified config', () => {
    const config = webhookConfigSchema.parse({
      endpoints: {
        ops: {
          url: 'https://example.test/hook',
          secret: 's3cret',
          headers: { 'x-trace': 'abc' },
        },
      },
      defaultEndpoint: 'ops',
      inbound: {
        path: '/api/ext/webhook',
        secret: 's3cret',
        commands: ['status', 'run'],
        maxBodyBytes: 1_024,
      },
    })

    expect(config.defaultEndpoint).toBe('ops')
    expect(config.inbound?.commands).toEqual(['status', 'run'])
  })

  it.each([
    ['http', 'http://example.test/hook'],
    ['embedded credentials', 'https://user:pass@example.test/hook'],
  ])('rejects an insecure endpoint url (%s)', (_label, url) => {
    expect(() => webhookConfigSchema.parse({ endpoints: { ops: { url } } })).toThrow()
  })

  it('allows loopback http endpoints', () => {
    expect(() => webhookConfigSchema.parse({ endpoints: { local: { url: 'http://127.0.0.1:9/hook' } } }))
      .not
      .toThrow()
  })

  it('rejects an endpoint without a url', () => {
    expect(() => webhookConfigSchema.parse({ endpoints: { ops: {} } })).toThrow()
  })

  it('rejects an inbound path that is not absolute', () => {
    expect(() => webhookConfigSchema.parse({ inbound: { path: 'relative', secret: 's' } })).toThrow(/must start with/)
  })

  it('rejects an unknown inbound command', () => {
    expect(() => webhookConfigSchema.parse({
      inbound: { path: '/x', secret: 's', commands: ['nope'] },
    })).toThrow()
  })

  it('rejects an empty command list', () => {
    expect(() => webhookConfigSchema.parse({
      inbound: { path: '/x', secret: 's', commands: [] },
    })).toThrow()
  })

  it('rejects an out-of-range body limit', () => {
    expect(() => webhookConfigSchema.parse({
      inbound: { path: '/x', secret: 's', maxBodyBytes: 2_000_000 },
    })).toThrow()
  })

  it('exposes a plugin config schema that defaults to an empty config', () => {
    expect(webhookPluginConfig.parse(undefined)).toEqual({ endpoints: {} })
    expect(webhookPluginConfig.parse(null)).toEqual({ endpoints: {} })
  })
})

describe('resolveEndpoint', () => {
  const config = webhookConfigSchema.parse({
    endpoints: {
      first: { url: 'https://example.test/1' },
      second: { url: 'https://example.test/2' },
    },
    defaultEndpoint: 'second',
  })

  it('prefers the explicit target', () => {
    expect(resolveEndpoint(config, 'first')?.url).toBe('https://example.test/1')
  })

  it('falls back to the configured default', () => {
    expect(resolveEndpoint(config, 'missing')?.url).toBe('https://example.test/2')
  })

  it('falls back to the first endpoint', () => {
    expect(resolveEndpoint(webhookConfigSchema.parse({ endpoints: { only: { url: 'https://example.test/1' } } }))
      ?.url).toBe('https://example.test/1')
  })

  it('returns undefined when nothing is configured', () => {
    expect(resolveEndpoint(config, undefined)).toBeDefined()
    expect(resolveEndpoint(webhookConfigSchema.parse({}))).toBeUndefined()
  })

  it('ignores a default endpoint that is not declared', () => {
    const orphaned = webhookConfigSchema.parse({
      endpoints: { only: { url: 'https://example.test/1' } },
      defaultEndpoint: 'ghost',
    })
    expect(resolveEndpoint(orphaned, 'ghost')?.url).toBe('https://example.test/1')
  })
})
