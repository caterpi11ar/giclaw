import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ACCOUNT_ID,
  isBlockedObjectKey,
  listEnabledFeishuAccounts,
  listFeishuAccountIds,
  listFeishuInboundAccounts,
  mergeFeishuAccountConfig,
  normalizeAccountId,
  normalizeOptionalAccountId,
  resolveDefaultFeishuAccountId,
  resolveDefaultFeishuAccountSelection,
  resolveFeishuAccount,
  resolveFeishuInboundSettings,
} from './accounts.js'
import { feishuConfigSchema } from './config.js'

function config(input: Record<string, unknown> = {}) {
  return feishuConfigSchema.parse(input)
}

describe('isBlockedObjectKey', () => {
  it('rejects the keys that would rewrite Object.prototype', () => {
    expect(isBlockedObjectKey('__proto__')).toBe(true)
    expect(isBlockedObjectKey('constructor')).toBe(true)
    expect(isBlockedObjectKey('prototype')).toBe(true)
    expect(isBlockedObjectKey('default')).toBe(false)
  })
})

describe('normalizeAccountId', () => {
  it('lower-cases a valid id and keeps its separators', () => {
    expect(normalizeAccountId('Team-A_1')).toBe('team-a_1')
  })

  it('falls back to the default account for anything unusable', () => {
    expect(normalizeAccountId()).toBe(DEFAULT_ACCOUNT_ID)
    expect(normalizeAccountId(null)).toBe(DEFAULT_ACCOUNT_ID)
    expect(normalizeAccountId('   ')).toBe(DEFAULT_ACCOUNT_ID)
    expect(normalizeAccountId('__proto__')).toBe(DEFAULT_ACCOUNT_ID)
    expect(normalizeAccountId('!!!')).toBe(DEFAULT_ACCOUNT_ID)
  })

  it('rewrites characters a config key cannot carry', () => {
    expect(normalizeAccountId('My Team!')).toBe('my-team')
    expect(normalizeAccountId('--leading')).toBe('leading')
    expect(normalizeAccountId('x!y--')).toBe('x-y')
    // A valid-looking id is returned as-is, even with a trailing separator.
    expect(normalizeAccountId('trailing--')).toBe('trailing--')
    expect(normalizeAccountId(`${'a'.repeat(80)}`)).toHaveLength(64)
  })
})

describe('normalizeOptionalAccountId', () => {
  it('stays absent instead of silently selecting the default account', () => {
    expect(normalizeOptionalAccountId(undefined)).toBeUndefined()
    expect(normalizeOptionalAccountId('  ')).toBeUndefined()
    expect(normalizeOptionalAccountId('__proto__')).toBeUndefined()
    expect(normalizeOptionalAccountId('Alpha')).toBe('alpha')
  })
})

describe('mergeFeishuAccountConfig', () => {
  it('lets an account override the top level and drops the accounts block', () => {
    const merged = mergeFeishuAccountConfig(config({
      appId: 'cli_top',
      appSecret: 'top',
      card: true,
      accounts: { alpha: { name: 'Alpha', appId: 'cli_a', card: false } },
    }), 'alpha')

    expect(merged.appId).toBe('cli_a')
    expect(merged.name).toBe('Alpha')
    expect(merged.card).toBe(false)
    expect((merged as Record<string, unknown>).accounts).toBeUndefined()
  })

  it('returns the top level for an account that has no overrides', () => {
    const merged = mergeFeishuAccountConfig(config({ appId: 'cli_top', appSecret: 'top' }), 'ghost')

    expect(merged.appId).toBe('cli_top')
    expect(merged.name).toBeUndefined()
  })

  it('ignores an explicit undefined override instead of clobbering the top level', () => {
    // zod keeps a key whose value is explicitly `undefined`, so the merge has to
    // skip it; otherwise the top-level credential would be erased.
    const merged = mergeFeishuAccountConfig(config({
      appId: 'cli_top',
      appSecret: 'top',
      accounts: { alpha: { appId: undefined } },
    }), 'alpha')

    expect(merged.appId).toBe('cli_top')
  })

  it('never carries routing keys from a hand-built account entry', () => {
    // The account schema is strict, so this shape can only come from an
    // unparsed object; the merge must still refuse to let it shadow routing.
    const merged = mergeFeishuAccountConfig({
      appId: 'cli_top',
      accounts: { alpha: { appId: 'cli_a', accounts: { ghost: {} }, defaultAccount: 'ghost' } },
    } as never, 'alpha')

    expect(merged.appId).toBe('cli_a')
    expect((merged as Record<string, unknown>).accounts).toBeUndefined()
    expect((merged as Record<string, unknown>).defaultAccount).toBeUndefined()
  })
})

describe('listFeishuAccountIds', () => {
  it('lists the implicit default when the top level holds app credentials', () => {
    expect(listFeishuAccountIds(config({ appId: 'cli_1', appSecret: 's' }))).toEqual([DEFAULT_ACCOUNT_ID])
  })

  it('lists the implicit default for an inbound-only deployment', () => {
    // The callback transport needs no app credentials; without the account the
    // configured subscription would have nothing to attach to.
    expect(listFeishuAccountIds(config({ inbound: {} }))).toEqual([DEFAULT_ACCOUNT_ID])
  })

  it('lists configured accounts and keeps the default first', () => {
    expect(listFeishuAccountIds(config({
      appId: 'cli_1',
      appSecret: 's',
      accounts: { alpha: {}, beta: {} },
    }))).toEqual([DEFAULT_ACCOUNT_ID, 'alpha', 'beta'])
  })

  it('lists only the configured accounts when the top level is unused', () => {
    expect(listFeishuAccountIds(config({ accounts: { alpha: { appId: 'cli_a', appSecret: 's' } } })))
      .toEqual(['alpha'])
  })

  it('never returns the same id twice', () => {
    expect(listFeishuAccountIds(config({
      appId: 'cli_1',
      appSecret: 's',
      accounts: { Default: {}, default: {} },
    }))).toEqual([DEFAULT_ACCOUNT_ID])
  })

  it('ignores an account that would collide with Object.prototype', () => {
    // zod keeps `__proto__` out of a parsed object; the guard is exercised
    // directly so the filter cannot silently disappear.
    const parsed = config({ appId: 'cli_1', appSecret: 's' })
    const withProto = { ...parsed, accounts: JSON.parse('{"__proto__":{},"alpha":{}}') as Record<string, unknown> }

    expect(listFeishuAccountIds(withProto as never)).toEqual([DEFAULT_ACCOUNT_ID, 'alpha'])
    expect(Object.hasOwn(withProto.accounts as object, '__proto__')).toBe(true)
  })
})

describe('resolveDefaultFeishuAccountSelection', () => {
  it('prefers an explicit defaultAccount', () => {
    expect(resolveDefaultFeishuAccountSelection(config({
      defaultAccount: 'alpha',
      accounts: { alpha: {}, beta: {} },
    }))).toEqual({ accountId: 'alpha', source: 'explicit-default' })
  })

  it('maps onto the default account when it exists', () => {
    expect(resolveDefaultFeishuAccountSelection(config({ appId: 'cli_1', appSecret: 's' })))
      .toEqual({ accountId: DEFAULT_ACCOUNT_ID, source: 'mapped-default' })
  })

  it('falls back to the first configured account', () => {
    expect(resolveDefaultFeishuAccountSelection(config({ accounts: { alpha: {}, beta: {} } })))
      .toEqual({ accountId: 'alpha', source: 'fallback' })
  })

  it('falls back to the default account when nothing is configured', () => {
    expect(resolveDefaultFeishuAccountSelection(config({})))
      .toEqual({ accountId: DEFAULT_ACCOUNT_ID, source: 'fallback' })
  })

  it('exposes the same id through the shorthand', () => {
    expect(resolveDefaultFeishuAccountId(config({ appId: 'cli_1', appSecret: 's' }))).toBe(DEFAULT_ACCOUNT_ID)
  })
})

describe('resolveFeishuAccount', () => {
  it('resolves the implicit default account', () => {
    const account = resolveFeishuAccount({ config: config({ appId: 'cli_1', appSecret: 's', encryptKey: 'k', verificationToken: 't' }) })

    expect(account).toMatchObject({
      accountId: DEFAULT_ACCOUNT_ID,
      selectionSource: 'mapped-default',
      enabled: true,
      configured: true,
      appId: 'cli_1',
      appSecret: 's',
      encryptKey: 'k',
      verificationToken: 't',
    })
  })

  it('marks an explicit selection and normalizes the id', () => {
    const account = resolveFeishuAccount({
      config: config({ accounts: { alpha: { appId: 'cli_a', appSecret: 's', name: 'Alpha' } } }),
      accountId: ' Alpha ',
    })

    expect(account.accountId).toBe('alpha')
    expect(account.selectionSource).toBe('explicit')
    expect(account.name).toBe('Alpha')
    expect(account.configured).toBe(true)
  })

  it('reports an account without credentials as unconfigured', () => {
    const account = resolveFeishuAccount({ config: config({ accounts: { alpha: {} } }), accountId: 'alpha' })

    expect(account.configured).toBe(false)
    expect(account).not.toHaveProperty('appId')
  })

  it('honours both the top-level and the account-level switch', () => {
    const disabledTop = resolveFeishuAccount({ config: config({ enabled: false }), accountId: 'default' })
    const disabledAccount = resolveFeishuAccount({
      config: config({ accounts: { alpha: { enabled: false } } }),
      accountId: 'alpha',
    })

    expect(disabledTop.enabled).toBe(false)
    expect(disabledAccount.enabled).toBe(false)
  })

  it('treats an empty account id as "not named" and falls back to the default', () => {
    const account = resolveFeishuAccount({ config: config({ appId: 'cli_1', appSecret: 's' }), accountId: '   ' })

    expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID)
    expect(account.selectionSource).toBe('mapped-default')
  })
})

describe('listEnabledFeishuAccounts', () => {
  it('keeps only the accounts that are enabled and have credentials', () => {
    const accounts = listEnabledFeishuAccounts(config({
      accounts: {
        alpha: { appId: 'cli_a', appSecret: 's' },
        beta: { appId: 'cli_b' },
        gamma: { appId: 'cli_g', appSecret: 's', enabled: false },
      },
    }))

    expect(accounts.map(account => account.accountId)).toEqual(['alpha'])
  })
})

describe('resolveFeishuInboundSettings', () => {
  it('returns null when the operator did not subscribe to events', () => {
    expect(resolveFeishuInboundSettings(mergeFeishuAccountConfig(config({ appId: 'a', appSecret: 'b' }), 'default'), 'default'))
      .toBeNull()
  })

  it('fills the callback defaults for the default account', () => {
    const merged = mergeFeishuAccountConfig(config({ inbound: {} }), 'default')
    const settings = resolveFeishuInboundSettings(merged, 'default')

    expect(settings).toMatchObject({
      accountId: 'default',
      connectionMode: 'websocket',
      webhookPath: '/feishu/events',
      webhookHost: '127.0.0.1',
      webhookPort: 3000,
    })
    expect(settings).not.toHaveProperty('verificationToken')
    expect(settings).not.toHaveProperty('encryptKey')
  })

  it('carries the callback credentials in webhook mode', () => {
    const merged = mergeFeishuAccountConfig(config({
      connectionMode: 'webhook',
      verificationToken: 't',
      encryptKey: 'k',
      webhookPath: '/hooks/feishu',
      webhookHost: '0.0.0.0',
      webhookPort: 8080,
      inbound: { routine: 'daily' },
    }), 'default')
    const settings = resolveFeishuInboundSettings(merged, 'default')

    expect(settings).toMatchObject({
      connectionMode: 'webhook',
      verificationToken: 't',
      encryptKey: 'k',
      webhookPath: '/hooks/feishu',
      webhookHost: '0.0.0.0',
      webhookPort: 8080,
    })
  })

  it('passes the credentials on in websocket mode when the operator set them', () => {
    const merged = mergeFeishuAccountConfig(config({
      verificationToken: 't',
      encryptKey: 'k',
      inbound: {},
    }), 'default')

    expect(resolveFeishuInboundSettings(merged, 'default')).toMatchObject({
      connectionMode: 'websocket',
      verificationToken: 't',
      encryptKey: 'k',
    })
  })
})

describe('listFeishuInboundAccounts', () => {
  it('returns nothing when no inbound subscription is configured', () => {
    expect(listFeishuInboundAccounts(config({ appId: 'cli_1', appSecret: 's' }))).toEqual([])
  })

  it('returns the inbound subscription of every enabled account', () => {
    const entries = listFeishuInboundAccounts(config({
      appId: 'cli_1',
      appSecret: 's',
      connectionMode: 'webhook',
      verificationToken: 't',
      encryptKey: 'k',
      inbound: { routine: 'daily' },
      accounts: { alpha: { enabled: false }, beta: { webhookPath: '/beta' } },
    }))

    expect(entries.map(entry => entry.account.accountId)).toEqual([DEFAULT_ACCOUNT_ID, 'beta'])
    expect(entries.map(entry => entry.settings.webhookPath)).toEqual(['/feishu/events', '/beta'])
  })

  it('lets one account stay outbound-only', () => {
    const entries = listFeishuInboundAccounts(config({
      appId: 'cli_1',
      appSecret: 's',
      inbound: { routine: 'daily' },
      accounts: { alpha: {} },
    }))

    expect(entries.map(entry => entry.account.accountId)).toEqual([DEFAULT_ACCOUNT_ID, 'alpha'])
  })
})
