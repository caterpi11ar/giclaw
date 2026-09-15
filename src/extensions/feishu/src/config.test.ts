import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FEISHU_BASE_URL,
  DEFAULT_FEISHU_INBOUND_PATH,
  DEFAULT_FEISHU_LARK_BASE_URL,
  FEISHU_HTTP_TIMEOUT_MS,
  feishuConfigSchema,
  feishuPluginConfig,
  normalizeFeishuWebhookPath,
  resolveAllowFrom,
  resolveFeishuBaseUrl,
  resolveFeishuDomainName,
  resolveFeishuMode,
  resolveFeishuTarget,
  resolveWebhookUrl,
} from './config.js'

describe('feishu config schema', () => {
  it('applies openclaw defaults', () => {
    const config = feishuPluginConfig.parse(undefined)

    expect(config).toMatchObject({
      domain: 'feishu',
      connectionMode: 'websocket',
      webhookPath: DEFAULT_FEISHU_INBOUND_PATH,
      card: true,
      targets: {},
      httpTimeoutMs: FEISHU_HTTP_TIMEOUT_MS,
      dmPolicy: 'pairing',
      groupPolicy: 'allowlist',
    })
    expect(config.mode).toBeUndefined()
    expect(config.inbound).toBeUndefined()
  })

  it('accepts a loopback HTTP base URL but rejects plain HTTP elsewhere', () => {
    expect(feishuConfigSchema.parse({ domain: 'http://127.0.0.1:8080' }).domain)
      .toBe('http://127.0.0.1:8080')
    expect(() => feishuConfigSchema.parse({ domain: 'http://open.feishu.cn' }))
      .toThrow(/must use HTTPS unless the host is loopback/)
  })

  it('rejects URLs carrying credentials', () => {
    expect(() => feishuConfigSchema.parse({ webhookUrl: 'https://user:pass@example.test/hook' }))
      .toThrow(/must not contain credentials/)
  })

  it('bounds the timeout and target shape', () => {
    expect(() => feishuConfigSchema.parse({ httpTimeoutMs: 10 })).toThrow()
    expect(() => feishuConfigSchema.parse({ httpTimeoutMs: 300_001 })).toThrow()
    expect(() => feishuConfigSchema.parse({ targets: { ops: { receiveIdType: 'nope' } } })).toThrow()
    expect(() => feishuConfigSchema.parse({ targets: { ops: { chatId: '' } } })).toThrow()
    expect(feishuConfigSchema.parse({ targets: { ops: {} } }).targets.ops?.receiveIdType)
      .toBe('chat_id')
  })

  it('rejects unknown keys instead of silently dropping them', () => {
    expect(() => feishuConfigSchema.parse({ verifyToken: 'typo' })).toThrow()
  })
})

describe('accounts', () => {
  it('accepts a top-level-only deployment with no accounts block', () => {
    const config = feishuConfigSchema.parse({ appId: 'cli_x', appSecret: 's' })
    expect(config.accounts).toBeUndefined()
  })

  it('keeps per-account overrides for credentials and transport keys', () => {
    const config = feishuConfigSchema.parse({
      appId: 'cli_root',
      appSecret: 'root',
      accounts: {
        work: { appId: 'cli_work', appSecret: 'work', domain: 'lark' },
      },
    })

    expect(config.accounts?.work?.appId).toBe('cli_work')
    expect(config.accounts?.work?.domain).toBe('lark')
    expect(config.accounts?.work?.httpTimeoutMs).toBeUndefined()
  })

  it('requires defaultAccount to name a configured account', () => {
    expect(() => feishuConfigSchema.parse({
      defaultAccount: 'ghost',
      accounts: { work: { appId: 'a', appSecret: 'b' } },
    })).toThrow(/does not match a configured account key/)

    expect(feishuConfigSchema.parse({
      defaultAccount: 'work',
      accounts: { work: { appId: 'a', appSecret: 'b' } },
    }).defaultAccount).toBe('work')
  })

  it('does not require an accounts block for defaultAccount', () => {
    expect(feishuConfigSchema.parse({ defaultAccount: 'default' }).defaultAccount).toBe('default')
  })

  it('tolerates an account entry that parses to undefined', () => {
    // zod keeps a key whose value is explicitly `undefined`, so the cross-field
    // refinements have to skip such an entry instead of reading through it.
    const config = feishuConfigSchema.parse({ accounts: { ghost: undefined } })
    expect(Object.keys(config.accounts ?? {})).toEqual(['ghost'])
    expect(config.accounts?.ghost).toBeUndefined()
  })
})

describe('dmPolicy and allowFrom cross-field rules', () => {
  it('rejects dmPolicy "open" without a wildcard', () => {
    expect(() => feishuConfigSchema.parse({ dmPolicy: 'open' }))
      .toThrow(/requires feishu.allowFrom to include/)
    expect(() => feishuConfigSchema.parse({ dmPolicy: 'open', allowFrom: ['ou_x'] }))
      .toThrow(/requires feishu.allowFrom to include/)
    expect(feishuConfigSchema.parse({ dmPolicy: 'open', allowFrom: ['*'] }).dmPolicy).toBe('open')
  })

  it('rejects dmPolicy "allowlist" without entries', () => {
    expect(() => feishuConfigSchema.parse({ dmPolicy: 'allowlist' }))
      .toThrow(/requires feishu.allowFrom to contain at least one sender ID/)
    expect(feishuConfigSchema.parse({ dmPolicy: 'allowlist', allowFrom: ['ou_x'] }).dmPolicy).toBe('allowlist')
  })

  it('applies the same rule per account, inheriting the top level', () => {
    expect(() => feishuConfigSchema.parse({
      accounts: { work: { dmPolicy: 'allowlist' } },
    })).toThrow(/requires feishu.accounts.\*.allowFrom/)

    expect(() => feishuConfigSchema.parse({
      accounts: { work: { dmPolicy: 'open' } },
    })).toThrow(/requires feishu.accounts.\*.allowFrom/)

    expect(feishuConfigSchema.parse({
      allowFrom: ['ou_root'],
      accounts: { work: { dmPolicy: 'allowlist' } },
    }).accounts?.work?.dmPolicy).toBe('allowlist')
  })

  it('leaves the pairing default alone', () => {
    expect(feishuConfigSchema.parse({}).dmPolicy).toBe('pairing')
  })
})

describe('groupPolicy and per-chat overrides', () => {
  it('keeps the shipped allowall alias working', () => {
    expect(feishuConfigSchema.parse({ groupPolicy: 'allowall' }).groupPolicy).toBe('open')
    expect(feishuConfigSchema.parse({ groupPolicy: 'disabled' }).groupPolicy).toBe('disabled')
  })

  it('rejects an unknown group policy and unknown group keys', () => {
    expect(() => feishuConfigSchema.parse({ groupPolicy: 'everyone' })).toThrow()
    expect(() => feishuConfigSchema.parse({ groups: { oc_1: { tools: {} } } })).toThrow()
  })

  it('parses per-chat overrides', () => {
    const config = feishuConfigSchema.parse({
      groups: { oc_1: { enabled: false, requireMention: false, allowFrom: ['ou_a'] } },
    })

    expect(config.groups?.oc_1).toEqual({ enabled: false, requireMention: false, allowFrom: ['ou_a'] })
  })
})

describe('connection modes', () => {
  it('defaults to the websocket transport', () => {
    expect(feishuConfigSchema.parse({}).connectionMode).toBe('websocket')
  })

  it('requires both callback credentials in webhook mode', () => {
    expect(() => feishuConfigSchema.parse({ connectionMode: 'webhook' }))
      .toThrow(/requires feishu.verificationToken/)
    expect(() => feishuConfigSchema.parse({ connectionMode: 'webhook', verificationToken: 't' }))
      .toThrow(/requires feishu.encryptKey/)
    const config = feishuConfigSchema.parse({
      connectionMode: 'webhook',
      verificationToken: 't',
      encryptKey: 'k',
    })
    expect(config.encryptKey).toBe('k')
  })

  it('requires callback credentials per webhook account too', () => {
    expect(() => feishuConfigSchema.parse({
      accounts: { work: { connectionMode: 'webhook' } },
    })).toThrow(/requires a verificationToken/)

    expect(() => feishuConfigSchema.parse({
      verificationToken: 't',
      accounts: { work: { connectionMode: 'webhook' } },
    })).toThrow(/requires an encryptKey/)

    const config = feishuConfigSchema.parse({
      verificationToken: 't',
      encryptKey: 'k',
      accounts: { work: { connectionMode: 'webhook' } },
    })
    expect(config.accounts?.work?.connectionMode).toBe('webhook')
  })

  it('allows a websocket account next to a webhook account', () => {
    const config = feishuConfigSchema.parse({
      connectionMode: 'webhook',
      verificationToken: 't',
      encryptKey: 'k',
      accounts: { chat: { appId: 'a', appSecret: 'b' } },
    })
    expect(config.accounts?.chat?.connectionMode).toBeUndefined()
  })

  it('rejects an unknown connection mode', () => {
    expect(() => feishuConfigSchema.parse({ connectionMode: 'longpoll' })).toThrow()
  })

  it('rejects a callback path that is not a canonical request path', () => {
    expect(() => feishuConfigSchema.parse({ webhookPath: 'feishu/events' })).toThrow()
    expect(feishuConfigSchema.parse({ webhookPath: '/custom/events' }).webhookPath).toBe('/custom/events')
  })

  it('keeps a query and normalizes an absolute URL to a path', () => {
    expect(feishuConfigSchema.parse({ webhookPath: '/feishu/events?x=1' }).webhookPath)
      .toBe('/feishu/events?x=1')
    expect(normalizeFeishuWebhookPath('https://host.test/feishu/events?x=1'))
      .toBe('/feishu/events?x=1')
    expect(normalizeFeishuWebhookPath(undefined)).toBe(DEFAULT_FEISHU_INBOUND_PATH)
    expect(normalizeFeishuWebhookPath('   ')).toBe(DEFAULT_FEISHU_INBOUND_PATH)
    expect(normalizeFeishuWebhookPath('mailto:a@b.test')).toBeNull()
    expect(normalizeFeishuWebhookPath('http://[')).toBeNull()
    expect(normalizeFeishuWebhookPath('ftp://host/feishu/events')).toBeNull()
    expect(feishuConfigSchema.safeParse({ webhookPath: 'http://[' }).success).toBe(false)
    expect(normalizeFeishuWebhookPath('https://host.test/feishu/events?')).toBe('/feishu/events?')
    expect(normalizeFeishuWebhookPath('https://host.test/feishu/events?#frag')).toBe('/feishu/events')
  })

  it('bounds webhookHost and webhookPort', () => {
    expect(feishuConfigSchema.parse({ webhookHost: '0.0.0.0', webhookPort: 8080 }))
      .toMatchObject({ webhookHost: '0.0.0.0', webhookPort: 8080 })
    expect(() => feishuConfigSchema.parse({ webhookPort: 0 })).toThrow()
    expect(() => feishuConfigSchema.parse({ webhookPort: 70_000 })).toThrow()
    expect(() => feishuConfigSchema.parse({ webhookHost: '' })).toThrow()
  })
})

describe('inbound routing', () => {
  it('is off unless configured', () => {
    expect(feishuConfigSchema.parse({}).inbound).toBeUndefined()
  })

  it('applies the default task list and rate limit', () => {
    expect(feishuConfigSchema.parse({ inbound: {} }).inbound)
      .toEqual({ tasks: [], rateLimit: { limit: 6, windowMs: 60_000 } })
  })

  it('bounds the rate limit and the task list', () => {
    expect(() => feishuConfigSchema.parse({ inbound: { rateLimit: { limit: 0 } } })).toThrow()
    expect(() => feishuConfigSchema.parse({ inbound: { rateLimit: { windowMs: 10 } } })).toThrow()
    expect(() => feishuConfigSchema.parse({ inbound: { tasks: [''] } })).toThrow()
  })
})

describe('resolveFeishuMode', () => {
  it('prefers an explicit mode', () => {
    expect(resolveFeishuMode(feishuConfigSchema.parse({ mode: 'webhook', appId: 'a', appSecret: 'b' })))
      .toBe('webhook')
  })

  it('infers app mode from complete credentials', () => {
    expect(resolveFeishuMode(feishuConfigSchema.parse({ appId: 'a', appSecret: 'b' }))).toBe('app')
  })

  it('falls back to webhook mode without credentials', () => {
    expect(resolveFeishuMode(feishuConfigSchema.parse({ appId: 'a' }))).toBe('webhook')
    expect(resolveFeishuMode(feishuConfigSchema.parse({}))).toBe('webhook')
  })
})

describe('resolveFeishuBaseUrl', () => {
  it('maps the named tenant domains', () => {
    expect(resolveFeishuBaseUrl({ domain: 'feishu' })).toBe(DEFAULT_FEISHU_BASE_URL)
    expect(resolveFeishuBaseUrl({ domain: 'lark' })).toBe(DEFAULT_FEISHU_LARK_BASE_URL)
    expect(resolveFeishuBaseUrl({})).toBe(DEFAULT_FEISHU_BASE_URL)
  })

  it('passes an explicit base URL through', () => {
    expect(resolveFeishuBaseUrl({ domain: 'https://proxy.test' })).toBe('https://proxy.test')
  })

  it('reports the SDK domain name only for named domains', () => {
    expect(resolveFeishuDomainName({ domain: 'lark' })).toBe('lark')
    expect(resolveFeishuDomainName({})).toBe('feishu')
    expect(resolveFeishuDomainName({ domain: 'https://proxy.test' })).toBeNull()
  })
})

describe('resolveFeishuTarget', () => {
  const config = feishuConfigSchema.parse({
    defaultTarget: 'ops',
    targets: {
      ops: { chatId: 'oc_ops' },
      daily: { chatId: 'oc_daily' },
    },
  })

  it('prefers the explicitly named target', () => {
    expect(resolveFeishuTarget(config, 'daily')?.chatId).toBe('oc_daily')
  })

  it('falls back to the configured default', () => {
    expect(resolveFeishuTarget(config)?.chatId).toBe('oc_ops')
    expect(resolveFeishuTarget(config, 'missing')?.chatId).toBe('oc_ops')
  })

  it('falls back to the first target and ignores prototype keys', () => {
    const noDefault = feishuConfigSchema.parse({ targets: { only: { chatId: 'oc_only' } } })
    expect(resolveFeishuTarget(noDefault, 'toString')?.chatId).toBe('oc_only')
    expect(resolveFeishuTarget(feishuConfigSchema.parse({}))).toBeUndefined()
  })

  it('ignores a defaultTarget that is not declared', () => {
    const dangling = feishuConfigSchema.parse({
      defaultTarget: 'ghost',
      targets: { only: { chatId: 'oc_only' } },
    })
    expect(resolveFeishuTarget(dangling)?.chatId).toBe('oc_only')
  })
})

describe('resolveWebhookUrl', () => {
  it('prefers the target webhook over the plugin-level one', () => {
    const config = feishuConfigSchema.parse({
      webhookUrl: 'https://example.test/global',
      targets: { ops: { webhookUrl: 'https://example.test/target' } },
    })
    expect(resolveWebhookUrl(config, config.targets.ops)).toBe('https://example.test/target')
    expect(resolveWebhookUrl(config)).toBe('https://example.test/global')
  })

  it('returns undefined without any webhook', () => {
    expect(resolveWebhookUrl(feishuConfigSchema.parse({}))).toBeUndefined()
  })
})

describe('resolveAllowFrom', () => {
  it('canonicalizes and de-duplicates sender ids', () => {
    expect(resolveAllowFrom(feishuConfigSchema.parse({
      allowFrom: ['feishu:ou_a', 'ou_a', 'oc_chat', 42],
    }))).toEqual(['user:ou_a', 'chat:oc_chat', 'user:42'])
  })

  it('returns an empty list when the account has no allowlist', () => {
    expect(resolveAllowFrom(feishuConfigSchema.parse({}))).toEqual([])
  })
})
