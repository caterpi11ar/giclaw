import { describe, expect, it } from 'vitest'
import { feishuConfigSchema } from './config.js'
import {
  detectFeishuIdType,
  evaluateDmPolicyAllowFromDependency,
  evaluateFeishuIngress,
  FEISHU_PAIRING_DENIED_REASON,
  hasExplicitFeishuGroupConfig,
  isFeishuDirectChatType,
  normalizeAllowFrom,
  normalizeFeishuAllowEntry,
  normalizeFeishuAllowList,
  normalizeFeishuDmPolicy,
  normalizeFeishuGroupPolicy,
  resolveFeishuGroupConfig,
  resolveFeishuReplyPolicy,
  stripFeishuProviderPrefix,
} from './policy.js'

function config(input: Record<string, unknown> = {}) {
  return feishuConfigSchema.parse(input)
}

describe('detectFeishuIdType', () => {
  it('reads the kind from the id prefix, and user ids have none', () => {
    expect(detectFeishuIdType(' oc_1 ')).toBe('chat_id')
    expect(detectFeishuIdType('ou_1')).toBe('open_id')
    expect(detectFeishuIdType('u_1')).toBe('user_id')
    expect(detectFeishuIdType('123456')).toBe('user_id')
    expect(detectFeishuIdType('')).toBeNull()
    expect(detectFeishuIdType('not an id')).toBeNull()
  })
})

describe('stripFeishuProviderPrefix', () => {
  it('drops repeated provider prefixes in either case', () => {
    expect(stripFeishuProviderPrefix(' feishu:ou_1 ')).toBe('ou_1')
    expect(stripFeishuProviderPrefix('LARK:feishu:ou_1')).toBe('ou_1')
    expect(stripFeishuProviderPrefix('ou_1')).toBe('ou_1')
  })
})

describe('normalizeFeishuAllowEntry', () => {
  it('canonicalizes every documented shape', () => {
    expect(normalizeFeishuAllowEntry('   ')).toBe('')
    expect(normalizeFeishuAllowEntry('*')).toBe('*')
    expect(normalizeFeishuAllowEntry('feishu:*')).toBe('*')
    expect(normalizeFeishuAllowEntry('feishu:oc_1')).toBe('chat:oc_1')
    expect(normalizeFeishuAllowEntry('chat:oc_1')).toBe('chat:oc_1')
    expect(normalizeFeishuAllowEntry('group:oc_1')).toBe('chat:oc_1')
    expect(normalizeFeishuAllowEntry('channel:oc_1')).toBe('chat:oc_1')
    expect(normalizeFeishuAllowEntry('open_id:ou_1')).toBe('user:ou_1')
    expect(normalizeFeishuAllowEntry('dm:ou_1')).toBe('user:ou_1')
    expect(normalizeFeishuAllowEntry('user:123')).toBe('user:123')
    expect(normalizeFeishuAllowEntry('chat:*')).toBe('*')
    expect(normalizeFeishuAllowEntry('oc_1')).toBe('chat:oc_1')
    expect(normalizeFeishuAllowEntry('ou_1')).toBe('user:ou_1')
    expect(normalizeFeishuAllowEntry('u_1')).toBe('user:u_1')
  })

  it('drops entries that cannot name anything', () => {
    expect(normalizeFeishuAllowEntry('feishu:')).toBe('')
    expect(normalizeFeishuAllowEntry('user:')).toBe('')
    expect(normalizeFeishuAllowEntry('!!!')).toBe('')
  })
})

describe('normalizeAllowFrom', () => {
  it('coerces, trims and keeps only the entries with content', () => {
    expect(normalizeAllowFrom()).toEqual([])
    expect(normalizeAllowFrom(null)).toEqual([])
    expect(normalizeAllowFrom([' ou_1 ', 42, '', '   '])).toEqual(['ou_1', '42'])
  })
})

describe('normalizeFeishuAllowList', () => {
  it('canonicalizes and de-duplicates while keeping the first occurrence order', () => {
    expect(normalizeFeishuAllowList(['ou_1', 'user:ou_1', 'feishu:oc_1', 'chat:oc_1', 'nope!']))
      .toEqual(['user:ou_1', 'chat:oc_1'])
  })
})

describe('evaluateDmPolicyAllowFromDependency', () => {
  it('rejects the two configurations that would drop every dm', () => {
    expect(evaluateDmPolicyAllowFromDependency({ policy: 'open', allowFrom: [] })).toBe('open_requires_wildcard')
    expect(evaluateDmPolicyAllowFromDependency({ policy: 'allowlist', allowFrom: null }))
      .toBe('allowlist_requires_entries')
  })

  it('accepts a satisfied policy and ignores the other policies', () => {
    expect(evaluateDmPolicyAllowFromDependency({ policy: 'open', allowFrom: ['*'] })).toBeNull()
    expect(evaluateDmPolicyAllowFromDependency({ policy: 'allowlist', allowFrom: ['ou_1'] })).toBeNull()
    expect(evaluateDmPolicyAllowFromDependency({ policy: 'pairing' })).toBeNull()
    expect(evaluateDmPolicyAllowFromDependency({})).toBeNull()
  })
})

describe('normalizeFeishuDmPolicy', () => {
  it('falls back to pairing for anything unknown', () => {
    expect(normalizeFeishuDmPolicy('open')).toBe('open')
    expect(normalizeFeishuDmPolicy('disabled')).toBe('disabled')
    expect(normalizeFeishuDmPolicy('nonsense')).toBe('pairing')
    expect(normalizeFeishuDmPolicy(undefined)).toBe('pairing')
  })
})

describe('normalizeFeishuGroupPolicy', () => {
  it('maps the shipped alias and falls back to allowlist', () => {
    expect(normalizeFeishuGroupPolicy('allowall')).toBe('open')
    expect(normalizeFeishuGroupPolicy('open')).toBe('open')
    expect(normalizeFeishuGroupPolicy('disabled')).toBe('disabled')
    expect(normalizeFeishuGroupPolicy('nonsense')).toBe('allowlist')
    expect(normalizeFeishuGroupPolicy(null)).toBe('allowlist')
  })
})

describe('resolveFeishuGroupConfig', () => {
  const base = config({
    groups: {
      'oc_exact': { requireMention: true },
      'OC_MIXED': { requireMention: false },
      '*': { enabled: true },
    },
  })

  it('returns nothing when the chat is unnamed', () => {
    expect(resolveFeishuGroupConfig({ config: base })).toBeUndefined()
    expect(resolveFeishuGroupConfig({ config: base, groupId: '  ' })).toBeUndefined()
  })

  it('prefers an exact key, then a case-insensitive one, then the catch-all', () => {
    expect(resolveFeishuGroupConfig({ config: base, groupId: 'oc_exact' })).toEqual({ requireMention: true })
    expect(resolveFeishuGroupConfig({ config: base, groupId: 'oc_mixed' })).toEqual({ requireMention: false })
    expect(resolveFeishuGroupConfig({ config: base, groupId: 'oc_other' })).toEqual({ enabled: true })
  })

  it('treats a literal "*" chat id as the catch-all, not as a chat key', () => {
    expect(resolveFeishuGroupConfig({ config: base, groupId: '*' })).toEqual({ enabled: true })
  })

  it('tells an explicit entry apart from the catch-all', () => {
    expect(hasExplicitFeishuGroupConfig({ config: base, groupId: 'oc_exact' })).toBe(true)
    expect(hasExplicitFeishuGroupConfig({ config: base, groupId: 'OC_MIXED' })).toBe(true)
    expect(hasExplicitFeishuGroupConfig({ config: base, groupId: 'oc_other' })).toBe(false)
    expect(hasExplicitFeishuGroupConfig({ config: base, groupId: null })).toBe(false)
    expect(hasExplicitFeishuGroupConfig({ config: config({}), groupId: 'oc_exact' })).toBe(false)
  })
})

describe('resolveFeishuReplyPolicy', () => {
  it('never requires a mention in a direct message', () => {
    expect(resolveFeishuReplyPolicy({ isDirectMessage: true, config: config({ requireMention: true }) }))
      .toEqual({ requireMention: false })
  })

  it('prefers the group entry, then the top level, then the policy', () => {
    const group = config({ groups: { oc_1: { requireMention: false } }, requireMention: true })
    expect(resolveFeishuReplyPolicy({ isDirectMessage: false, config: group, groupId: 'oc_1' }))
      .toEqual({ requireMention: false })

    const top = config({ requireMention: true, groupPolicy: 'open' })
    expect(resolveFeishuReplyPolicy({ isDirectMessage: false, config: top, groupId: 'oc_1' }))
      .toEqual({ requireMention: true })

    // The effective group policy is an explicit input (openclaw parity): the
    // caller has already resolved aliases and per-chat overrides.
    const open = config({})
    expect(resolveFeishuReplyPolicy({ isDirectMessage: false, config: open, groupId: 'oc_1', groupPolicy: 'open' }))
      .toEqual({ requireMention: false })
    expect(resolveFeishuReplyPolicy({ isDirectMessage: false, config: open, groupId: 'oc_1', groupPolicy: 'allowlist' }))
      .toEqual({ requireMention: true })
  })
})

describe('isFeishuDirectChatType', () => {
  it('recognizes the direct conversation chat types', () => {
    expect(isFeishuDirectChatType('p2p')).toBe(true)
    expect(isFeishuDirectChatType('private')).toBe(true)
    expect(isFeishuDirectChatType('group')).toBe(false)
  })
})

function evaluate(overrides: Partial<Parameters<typeof evaluateFeishuIngress>[0]> = {}) {
  return evaluateFeishuIngress({
    config: config({}),
    chatType: 'p2p',
    chatId: 'oc_1',
    senderOpenId: 'ou_1',
    mentionedBot: false,
    ...overrides,
  })
}

describe('evaluateFeishuIngress', () => {
  it('drops bot senders unless allowBots is on', () => {
    expect(evaluate({ senderType: 'bot' })).toEqual({ allowed: false, reason: 'bot-authored messages are disabled' })
    expect(evaluate({ senderType: 'app' })).toEqual({ allowed: false, reason: 'bot-authored messages are disabled' })
    expect(evaluate({ senderType: 'bot', config: config({ allowBots: true, dmPolicy: 'open', allowFrom: ['*'] }) }))
      .toEqual({ allowed: true })
    expect(evaluate({ senderType: 'user', config: config({ dmPolicy: 'open', allowFrom: ['*'] }) }))
      .toEqual({ allowed: true })
  })

  it('honours dmPolicy: disabled', () => {
    expect(evaluate({ config: config({ dmPolicy: 'disabled' }) }))
      .toEqual({ allowed: false, reason: 'dmPolicy is disabled' })
  })

  it('lets dmPolicy: open through with no further checks', () => {
    expect(evaluate({ config: config({ dmPolicy: 'open', allowFrom: ['*'] }) })).toEqual({ allowed: true })
  })

  it('matches a dm sender against dmPolicy: allowlist', () => {
    const allowlisted = config({ dmPolicy: 'allowlist', allowFrom: ['feishu:ou_1'] })
    const byUserId = config({ dmPolicy: 'allowlist', allowFrom: ['u_1'] })
    const stranger = config({ dmPolicy: 'allowlist', allowFrom: ['ou_other'] })

    expect(evaluate({ config: allowlisted })).toEqual({ allowed: true })
    expect(evaluate({ config: byUserId, senderOpenId: undefined, senderUserId: 'u_1' })).toEqual({ allowed: true })
    expect(evaluate({ config: stranger })).toEqual({ allowed: false, reason: 'sender is not in allowFrom' })
  })

  it('drops an unpaired dm under the default pairing policy', () => {
    expect(evaluate({ config: config({}) }))
      .toEqual({ allowed: false, reason: FEISHU_PAIRING_DENIED_REASON })
  })

  it('admits a paired dm, normalizing the stored subjects', () => {
    expect(evaluate({ config: config({}), pairedSenderIds: ['feishu:ou_1'] })).toEqual({ allowed: true })
    expect(evaluate({ config: config({}), senderOpenId: undefined, senderUserId: 'u_1', pairedSenderIds: ['u_1'] }))
      .toEqual({ allowed: true })
    expect(evaluate({ config: config({}), pairedSenderIds: ['ou_other'] }))
      .toEqual({ allowed: false, reason: FEISHU_PAIRING_DENIED_REASON })
  })

  it('treats an empty sender identity as unpaired', () => {
    expect(evaluate({ config: config({}), senderOpenId: undefined }))
      .toEqual({ allowed: false, reason: FEISHU_PAIRING_DENIED_REASON })
  })

  it('honours groupPolicy: disabled', () => {
    expect(evaluate({ chatType: 'group', config: config({ groupPolicy: 'disabled' }) }))
      .toEqual({ allowed: false, reason: 'groupPolicy is disabled' })
  })

  it('drops a chat that is switched off in groups', () => {
    expect(evaluate({
      chatType: 'group',
      config: config({ groupPolicy: 'open', requireMention: false, groups: { oc_1: { enabled: false } } }),
    })).toEqual({ allowed: false, reason: 'this group is disabled in groups' })
  })

  it('requires an allowlist entry for groupPolicy: allowlist', () => {
    const base = { chatType: 'group', mentionedBot: true }
    expect(evaluate({ ...base, config: config({}) }))
      .toEqual({ allowed: false, reason: 'chat is not in groupAllowFrom' })
    expect(evaluate({ ...base, config: config({ groupAllowFrom: ['*'] }) })).toEqual({ allowed: true })
    expect(evaluate({ ...base, config: config({ groupAllowFrom: ['chat:oc_1'] }) })).toEqual({ allowed: true })
  })

  it('allows a chat that has its own group entry without listing it twice', () => {
    expect(evaluate({
      chatType: 'group',
      config: config({ groups: { oc_1: { requireMention: false } } }),
    })).toEqual({ allowed: true })
  })

  it('drops a sender outside groupSenderAllowFrom', () => {
    const base = { chatType: 'group' }
    const allowlist = { groupAllowFrom: ['*'], requireMention: false }
    expect(evaluate({ ...base, config: config({ ...allowlist, groupSenderAllowFrom: ['ou_other'] }) }))
      .toEqual({ allowed: false, reason: 'sender is not in groupSenderAllowFrom' })
    expect(evaluate({ ...base, config: config({ ...allowlist, groupSenderAllowFrom: ['ou_1'] }) }))
      .toEqual({ allowed: true })
    expect(evaluate({
      ...base,
      config: config({ ...allowlist, groupSenderAllowFrom: ['u_1'] }),
      senderOpenId: undefined,
      senderUserId: 'u_1',
    })).toEqual({ allowed: true })
  })

  it('lets a group-level allowFrom replace the top-level sender list', () => {
    // Group allowFrom takes precedence; it is not merged with the top level.
    const groupWins = config({
      groupAllowFrom: ['*'],
      requireMention: false,
      groupSenderAllowFrom: ['ou_other'],
      groups: { oc_1: { allowFrom: ['ou_1'] } },
    })
    const groupDenies = config({
      groupAllowFrom: ['*'],
      requireMention: false,
      groupSenderAllowFrom: ['ou_1'],
      groups: { oc_1: { allowFrom: ['ou_other'] } },
    })

    expect(evaluate({ chatType: 'group', config: groupWins })).toEqual({ allowed: true })
    expect(evaluate({ chatType: 'group', config: groupDenies }))
      .toEqual({ allowed: false, reason: 'sender is not in groupSenderAllowFrom' })
  })

  it('ignores an empty group allowFrom and falls back to the top level', () => {
    const emptyGroupList = config({
      groupAllowFrom: ['*'],
      requireMention: false,
      groupSenderAllowFrom: ['ou_1'],
      groups: { oc_1: { allowFrom: [] } },
    })

    expect(evaluate({ chatType: 'group', config: emptyGroupList })).toEqual({ allowed: true })
  })

  it('applies the mention requirement to groups only', () => {
    const open = config({ groupPolicy: 'open', requireMention: false })
    expect(evaluate({ chatType: 'group', config: open })).toEqual({ allowed: true })
    expect(evaluate({ chatType: 'group', config: open, mentionedBot: true })).toEqual({ allowed: true })

    const defaultPolicy = config({ groupPolicy: 'open', requireMention: true })
    expect(evaluate({ chatType: 'group', config: defaultPolicy }))
      .toEqual({ allowed: false, reason: 'message does not mention the app' })
    expect(evaluate({ chatType: 'group', config: defaultPolicy, mentionedBot: true })).toEqual({ allowed: true })

    expect(evaluate({ chatType: 'group', config: open, mentionedBot: false })).toEqual({ allowed: true })
  })

  it('scopes the mention requirement to the chat that asked for it', () => {
    const perGroup = config({
      groupPolicy: 'allowlist',
      groupAllowFrom: ['*'],
      requireMention: false,
      groups: { oc_1: { requireMention: true } },
    })

    expect(evaluate({ chatType: 'group', config: perGroup }))
      .toEqual({ allowed: false, reason: 'message does not mention the app' })
    expect(evaluate({ chatType: 'group', config: perGroup, chatId: 'oc_2' })).toEqual({ allowed: true })
  })
})
