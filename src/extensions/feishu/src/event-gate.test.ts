import type { PluginLogger, PluginRuntime } from '../../../plugin-sdk/index.js'
import type { FeishuEventGateOptions } from './event-gate.js'
import { describe, expect, it, vi } from 'vitest'
import { FEISHU_MESSAGE_EVENT_TYPE, feishuConfigSchema } from './config.js'
import { createFeishuEventGate } from './event-gate.js'

function createLogger(): PluginLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function createRuntime(): PluginRuntime {
  return {
    gateway: {
      getSnapshot: vi.fn(),
      getRunHistory: vi.fn(),
      enqueueRun: vi.fn(async () => ({
        results: [{ taskId: 'welkin-moon', success: true, message: 'ok', durationMs: 1 }],
      })),
      resolveRoutine: vi.fn((name: string) => (name === 'daily' ? ['welkin-moon', 'claim-mail'] : null)),
    },
  } as unknown as PluginRuntime
}

interface GateHarness {
  gate: FeishuEventGateOptions['readPairedSenderIds'] extends never ? never : (body: Record<string, unknown>) => Promise<string>
  runtime: PluginRuntime
  logger: PluginLogger
  onPairingRequired: ReturnType<typeof vi.fn>
  readPairedSenderIds: ReturnType<typeof vi.fn>
}

function createGate(options: {
  config?: Record<string, unknown>
  routing?: Record<string, unknown> | null
  runtime?: PluginRuntime
  now?: () => number
  paired?: string[]
  ownOpenId?: string
  withPairing?: boolean
} = {}): GateHarness {
  const logger = createLogger()
  const runtime = options.runtime ?? createRuntime()
  const config = feishuConfigSchema.parse(options.config ?? {})
  const routing = options.routing === null
    ? undefined
    : feishuConfigSchema.parse({ inbound: options.routing ?? {} }).inbound
  const onPairingRequired = vi.fn()
  const readPairedSenderIds = vi.fn(async () => options.paired ?? [])

  const gate = createFeishuEventGate({
    accountId: 'default',
    config,
    ...(routing === undefined ? {} : { routing }),
    runtime,
    logger,
    ...(options.now ? { now: options.now } : {}),
    ...(options.withPairing === false ? {} : { readPairedSenderIds, onPairingRequired }),
    ...(options.ownOpenId === undefined ? {} : { resolveBotOpenId: async () => options.ownOpenId }),
  }).gate

  return {
    gate: gate as unknown as GateHarness['gate'],
    runtime,
    logger,
    onPairingRequired,
    readPairedSenderIds,
  }
}

/** The event envelope both transports hand to the gates. */
function messageEvent(overrides: {
  chatId?: string
  openId?: string
  userId?: string
  chatType?: string
  senderType?: string
  messageType?: string
  mentions?: unknown
  eventId?: string
  eventType?: string
} = {}): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      event_id: overrides.eventId ?? 'evt-1',
      event_type: overrides.eventType ?? FEISHU_MESSAGE_EVENT_TYPE,
    },
    event: {
      sender: {
        sender_type: overrides.senderType ?? 'user',
        sender_id: {
          open_id: overrides.openId ?? 'ou_1',
          ...(overrides.userId === undefined ? {} : { user_id: overrides.userId }),
        },
      },
      message: {
        chat_id: overrides.chatId ?? 'oc_1',
        chat_type: overrides.chatType ?? 'group',
        message_type: overrides.messageType ?? 'text',
        content: '{"text":"@_user_1 ping"}',
        mentions: overrides.mentions ?? [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      },
    },
  }
}

/** A group message accepted by the `open` group policy. */
function openGroup(overrides: Parameters<typeof messageEvent>[0] = {}): Record<string, unknown> {
  return messageEvent(overrides)
}

describe('createFeishuEventGate', () => {
  it('dispatches a mentioned group message into the configured routine', async () => {
    const harness = createGate({
      config: { groupPolicy: 'open' },
      routing: { routine: 'daily' },
    })

    await expect(harness.gate(openGroup())).resolves.toBe('dispatched')
    await settle()

    expect(harness.runtime.gateway.enqueueRun).toHaveBeenCalledWith(['welkin-moon', 'claim-mail'])
    expect(harness.logger.info).toHaveBeenCalledWith(expect.stringContaining('triggered a run'))
    expect(harness.logger.info).toHaveBeenCalledWith(expect.stringContaining('1 task result(s)'))
  })

  it('ignores a re-delivered event without starting a second run', async () => {
    const harness = createGate({ config: { groupPolicy: 'open' }, routing: {} })
    const body = messageEvent({ eventId: 'evt-dup' })

    await expect(harness.gate(body)).resolves.toBe('dispatched')
    await settle()
    await expect(harness.gate(body)).resolves.toBe('ignored')
    await settle()

    expect(harness.runtime.gateway.enqueueRun).toHaveBeenCalledTimes(1)
    expect(harness.logger.info).toHaveBeenCalledWith(expect.stringContaining('ignoring the redelivery'))
  })

  it('observes a subscribed event type it has no consumer for', async () => {
    const harness = createGate({ config: { groupPolicy: 'open' }, routing: {} })
    const body = messageEvent({ eventType: 'im.message.message_read_v1' })

    await expect(harness.gate(body)).resolves.toBe('ignored')

    expect(harness.runtime.gateway.enqueueRun).not.toHaveBeenCalled()
    expect(harness.logger.debug).toHaveBeenCalledWith(expect.stringContaining('without triggering'))
  })

  it('ignores an event type it never subscribed to', async () => {
    const harness = createGate({ config: { groupPolicy: 'open' }, routing: {} })

    await expect(harness.gate(messageEvent({ eventType: 'im.chat.updated_v1' }))).resolves.toBe('ignored')

    expect(harness.runtime.gateway.enqueueRun).not.toHaveBeenCalled()
    expect(harness.logger.debug).toHaveBeenCalledWith(expect.stringContaining('unsubscribed Feishu event type'))
  })

  it('ignores an envelope without an event type or body', async () => {
    const harness = createGate({ config: { groupPolicy: 'open' }, routing: {} })

    await expect(harness.gate({ header: { event_id: 'e-1' } })).resolves.toBe('ignored')
    expect(harness.logger.debug).toHaveBeenCalledWith(expect.stringContaining('event type unknown'))

    await expect(harness.gate({ header: { event_id: 'e-2', event_type: FEISHU_MESSAGE_EVENT_TYPE } }))
      .resolves
      .toBe('ignored')
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('carries no event body'))
  })

  it('ignores an event whose sender cannot be identified', async () => {
    const harness = createGate({ config: { groupPolicy: 'open' }, routing: {} })
    const body = messageEvent()
    ;(body.event as Record<string, unknown>).sender = {}

    await expect(harness.gate(body)).resolves.toBe('ignored')

    expect(harness.runtime.gateway.enqueueRun).not.toHaveBeenCalled()
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('carries no sender id'))
  })

  it('drops a message type it cannot read', async () => {
    const harness = createGate({ config: { groupPolicy: 'open' }, routing: {} })

    await expect(harness.gate(messageEvent({ messageType: 'image' }))).resolves.toBe('ignored')

    expect(harness.runtime.gateway.enqueueRun).not.toHaveBeenCalled()
    expect(harness.logger.info).toHaveBeenCalledWith(expect.stringContaining('unsupported message type image'))
  })

  it('accepts a direct message that only identifies the sender by user id', async () => {
    const harness = createGate({ config: { dmPolicy: 'open', allowFrom: ['*'] }, routing: {} })

    // No `chat_type` (so a direct message), no `message_type` and no `mentions`:
    // every optional field of the extracted subject is absent at once.
    await expect(harness.gate({
      header: { event_id: 'e-user', event_type: FEISHU_MESSAGE_EVENT_TYPE },
      event: { sender: { sender_id: { user_id: '9001' } }, message: { chat_id: 'oc_1' } },
    })).resolves.toBe('dispatched')

    expect(harness.logger.info).toHaveBeenCalledWith(expect.stringContaining('from 9001 triggered a run'))
  })

  it('observes without triggering when no routing is configured', async () => {
    const harness = createGate({ config: { groupPolicy: 'open' }, routing: null })

    await expect(harness.gate(openGroup())).resolves.toBe('ignored')

    expect(harness.runtime.gateway.enqueueRun).not.toHaveBeenCalled()
    expect(harness.logger.debug).toHaveBeenCalledWith(expect.stringContaining('routing is not configured'))
  })

  it('drops messages that exceed the per-chat rate limit', async () => {
    let current = 0
    const harness = createGate({
      config: { groupPolicy: 'open' },
      routing: { rateLimit: { limit: 1, windowMs: 1_000 } },
      now: () => current,
    })

    await expect(harness.gate(openGroup({ eventId: 'e1' }))).resolves.toBe('dispatched')
    current = 10
    await expect(harness.gate(openGroup({ eventId: 'e2' }))).resolves.toBe('ignored')

    expect(harness.runtime.gateway.enqueueRun).toHaveBeenCalledTimes(1)
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('rate limit reached'))

    current = 2_000
    await expect(harness.gate(openGroup({ eventId: 'e3' }))).resolves.toBe('dispatched')
  })

  it('drops an event that names an unknown routine', async () => {
    const harness = createGate({ config: { groupPolicy: 'open' }, routing: { routine: 'ghost' } })

    await expect(harness.gate(openGroup())).resolves.toBe('ignored')

    expect(harness.runtime.gateway.enqueueRun).not.toHaveBeenCalled()
    expect(harness.logger.error).toHaveBeenCalledWith(expect.stringContaining('is not configured'))
  })

  it('falls back to the configured tasks and then to the gateway defaults', async () => {
    const withTasks = createGate({ config: { groupPolicy: 'open' }, routing: { tasks: ['claim-mail'] } })
    await expect(withTasks.gate(openGroup())).resolves.toBe('dispatched')
    expect(withTasks.runtime.gateway.enqueueRun).toHaveBeenCalledWith(['claim-mail'])

    const withDefaults = createGate({ config: { groupPolicy: 'open' }, routing: {} })
    await expect(withDefaults.gate(openGroup())).resolves.toBe('dispatched')
    expect(withDefaults.runtime.gateway.enqueueRun).toHaveBeenCalledWith(undefined)
  })

  it('reports a run that the queue rejects without failing the callback', async () => {
    const runtime = createRuntime()
    runtime.gateway.enqueueRun = vi.fn(async () => {
      throw new Error('queue is full')
    })
    const harness = createGate({ config: { groupPolicy: 'open' }, routing: {}, runtime })

    await expect(harness.gate(openGroup())).resolves.toBe('dispatched')
    await settle()

    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('queue is full'))
  })
})

describe('mention attribution', () => {
  it('requires a mention by default and accepts a group message when it is off', async () => {
    const required = createGate({ config: { groupAllowFrom: ['oc_1'] }, routing: {} })
    await expect(required.gate(openGroup({ mentions: [] }))).resolves.toBe('ignored')
    expect(required.logger.warn).toHaveBeenCalledWith(expect.stringContaining('does not mention the app'))
    expect(required.runtime.gateway.enqueueRun).not.toHaveBeenCalled()

    const relaxed = createGate({ config: { groupAllowFrom: ['oc_1'], requireMention: false }, routing: {} })
    await expect(relaxed.gate(openGroup({ mentions: [] }))).resolves.toBe('dispatched')
  })

  it('never requires a mention in a direct message', async () => {
    const harness = createGate({
      config: { dmPolicy: 'open', allowFrom: ['*'] },
      routing: {},
    })

    await expect(harness.gate(messageEvent({ chatType: 'p2p', mentions: [] }))).resolves.toBe('dispatched')
  })

  it('only counts a mention of this app once its open id is known', async () => {
    const other = createGate({ config: { groupAllowFrom: ['oc_1'] }, routing: {}, ownOpenId: 'ou_self' })
    await expect(other.gate(openGroup({ mentions: [{ id: { open_id: 'ou_other' } }] }))).resolves.toBe('ignored')
    await expect(other.gate(openGroup({ eventId: 'e2', mentions: [{ id: { open_id: 'ou_self' } }] })))
      .resolves
      .toBe('dispatched')

    const unknown = createGate({ config: { groupAllowFrom: ['oc_1'] }, routing: {} })
    await expect(unknown.gate(openGroup({ mentions: [{ key: '@_user_1' }] }))).resolves.toBe('dispatched')
  })

  it('accepts a legacy mention that only carries the open id as a key', async () => {
    const harness = createGate({ config: { groupAllowFrom: ['oc_1'] }, routing: {}, ownOpenId: 'ou_self' })

    await expect(harness.gate(openGroup({ mentions: [{ key: 'ou_self' }] }))).resolves.toBe('dispatched')
  })

  it('honours a per-chat requireMention override', async () => {
    const harness = createGate({
      config: { groupAllowFrom: ['oc_1'], groups: { oc_1: { requireMention: true } } },
      routing: {},
    })

    await expect(harness.gate(openGroup({ mentions: [] }))).resolves.toBe('ignored')
  })
})

describe('sender policy', () => {
  it('denies an unlisted group under the default allowlist policy', async () => {
    const harness = createGate({ routing: {} })

    await expect(harness.gate(openGroup())).resolves.toBe('ignored')

    expect(harness.runtime.gateway.enqueueRun).not.toHaveBeenCalled()
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('chat is not in groupAllowFrom'))
  })

  it('allows a chat listed in groupAllowFrom', async () => {
    const harness = createGate({
      config: { groupAllowFrom: ['oc_allowed'], requireMention: false },
      routing: {},
    })

    await expect(harness.gate(openGroup({ chatId: 'oc_other' }))).resolves.toBe('ignored')
    await expect(harness.gate(openGroup({ eventId: 'e2', chatId: 'oc_allowed' }))).resolves.toBe('dispatched')
  })

  it('treats an explicitly configured group as allowlisted', async () => {
    const harness = createGate({
      config: { groups: { oc_1: { requireMention: false } } },
      routing: {},
    })

    await expect(harness.gate(openGroup())).resolves.toBe('dispatched')
  })
  it('drops every group when groupPolicy is disabled', async () => {
    const harness = createGate({
      config: { groupPolicy: 'disabled' },
      routing: {},
    })

    await expect(harness.gate(openGroup())).resolves.toBe('ignored')
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('groupPolicy is disabled'))
  })

  it('drops a group disabled by its own entry', async () => {
    const harness = createGate({
      config: { groups: { oc_1: { enabled: false } } },
      routing: {},
    })

    await expect(harness.gate(openGroup())).resolves.toBe('ignored')
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('disabled in groups'))
  })

  it('filters group senders with groupSenderAllowFrom', async () => {
    const harness = createGate({
      config: { groupAllowFrom: ['oc_1'], groupSenderAllowFrom: ['ou_allowed'] },
      routing: {},
    })

    await expect(harness.gate(openGroup({ openId: 'ou_other' }))).resolves.toBe('ignored')
    await expect(harness.gate(openGroup({ eventId: 'e2', openId: 'ou_allowed' }))).resolves.toBe('dispatched')
  })

  it('lets a per-chat allowFrom replace the top-level sender list', async () => {
    const harness = createGate({
      config: {
        groupAllowFrom: ['oc_1'],
        groupSenderAllowFrom: ['ou_root'],
        groups: { oc_1: { allowFrom: ['ou_chat'] } },
      },
      routing: {},
    })

    await expect(harness.gate(openGroup({ openId: 'ou_root' }))).resolves.toBe('ignored')
    await expect(harness.gate(openGroup({ eventId: 'e2', openId: 'ou_chat' }))).resolves.toBe('dispatched')
  })

  it('gates bot senders behind allowBots', async () => {
    const blocked = createGate({ config: { groupPolicy: 'open', requireMention: false }, routing: {} })
    await expect(blocked.gate(openGroup({ senderType: 'app' }))).resolves.toBe('ignored')
    expect(blocked.logger.warn).toHaveBeenCalledWith(expect.stringContaining('bot-authored messages are disabled'))

    const allowed = createGate({
      config: { groupPolicy: 'open', requireMention: false, allowBots: true },
      routing: {},
    })
    await expect(allowed.gate(openGroup({ senderType: 'app' }))).resolves.toBe('dispatched')
  })
})

describe('direct message policy', () => {
  const dm = { chatType: 'p2p' }

  it('denies every dm when dmPolicy is disabled', async () => {
    const harness = createGate({ config: { dmPolicy: 'disabled' }, routing: {} })

    await expect(harness.gate(messageEvent(dm))).resolves.toBe('ignored')
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('dmPolicy is disabled'))
  })

  it('accepts every dm when dmPolicy is open', async () => {
    const harness = createGate({ config: { dmPolicy: 'open', allowFrom: ['*'] }, routing: {} })

    await expect(harness.gate(messageEvent({ ...dm, openId: 'ou_anyone' }))).resolves.toBe('dispatched')
  })

  it('matches an allowlist entry against either sender id form', async () => {
    const harness = createGate({ config: { dmPolicy: 'allowlist', allowFrom: ['ou_a', '9001'] }, routing: {} })

    await expect(harness.gate(messageEvent({ ...dm, openId: 'ou_a' }))).resolves.toBe('dispatched')
    await expect(harness.gate(messageEvent({ ...dm, eventId: 'e2', openId: 'ou_b', userId: '9001' }))).resolves.toBe('dispatched')
    await expect(harness.gate(messageEvent({ ...dm, eventId: 'e3', openId: 'ou_c' }))).resolves.toBe('ignored')
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('sender is not in allowFrom'))
  })

  it('asks for a pairing code from an unpaired sender', async () => {
    const harness = createGate({ routing: {} })

    await expect(harness.gate(messageEvent(dm))).resolves.toBe('ignored')

    expect(harness.onPairingRequired).toHaveBeenCalledWith({
      accountId: 'default',
      subjects: ['user:ou_1'],
      chatId: 'oc_1',
    })
    expect(harness.readPairedSenderIds).toHaveBeenCalled()
  })

  it('accepts a sender approved out-of-band', async () => {
    const harness = createGate({ routing: {}, paired: ['user:ou_1'] })

    await expect(harness.gate(messageEvent(dm))).resolves.toBe('dispatched')
    expect(harness.onPairingRequired).not.toHaveBeenCalled()
  })

  it('does not pair a sender when no pairing callback is wired', async () => {
    const harness = createGate({ routing: {}, withPairing: false })

    await expect(harness.gate(messageEvent(dm))).resolves.toBe('ignored')

    expect(harness.onPairingRequired).not.toHaveBeenCalled()
    expect(harness.readPairedSenderIds).not.toHaveBeenCalled()
  })

  it('does not ask for pairing under an allowlist policy', async () => {
    const harness = createGate({ config: { dmPolicy: 'allowlist', allowFrom: ['ou_a'] }, routing: {} })

    await expect(harness.gate(messageEvent(dm))).resolves.toBe('ignored')

    expect(harness.onPairingRequired).not.toHaveBeenCalled()
  })
})

describe('menu and card triggers', () => {
  it('treats a menu click as an operator-initiated direct interaction', async () => {
    const harness = createGate({ config: { dmPolicy: 'open', allowFrom: ['*'] }, routing: {} })

    await expect(harness.gate({
      header: { event_id: 'm-1', event_type: 'application.bot.menu_v6' },
      event: { operator: { operator_id: { open_id: 'ou_operator' } }, event_key: 'run_daily' },
    })).resolves.toBe('dispatched')
  })

  it('applies the dm policy to a menu click', async () => {
    const harness = createGate({ routing: {} })

    await expect(harness.gate({
      header: { event_id: 'm-2', event_type: 'application.bot.menu_v6' },
      event: { operator: { operator_id: { open_id: 'ou_stranger' } }, event_key: 'run_daily' },
    })).resolves.toBe('ignored')

    expect(harness.onPairingRequired).toHaveBeenCalledWith(expect.objectContaining({
      subjects: ['user:ou_stranger'],
    }))
  })

  it('ignores a menu click without an operator', async () => {
    const harness = createGate({ config: { dmPolicy: 'open', allowFrom: ['*'] }, routing: {} })

    await expect(harness.gate({
      header: { event_id: 'm-3', event_type: 'application.bot.menu_v6' },
      event: {},
    })).resolves.toBe('ignored')
  })

  it('treats a card action as an interaction in its chat, not as an unmentioned message', async () => {
    const harness = createGate({
      config: { groupPolicy: 'allowlist', groupAllowFrom: ['oc_card'] },
      routing: {},
    })

    await expect(harness.gate({
      header: { event_id: 'c-1', event_type: 'card.action.trigger' },
      event: {
        operator: { operator_id: { open_id: 'ou_operator' } },
        open_chat_id: 'oc_card',
        action: { value: {} },
      },
    })).resolves.toBe('dispatched')
  })

  it('reads the chat id from the card context when the payload nests it', async () => {
    const harness = createGate({
      config: { groupPolicy: 'allowlist', groupAllowFrom: ['oc_nested'] },
      routing: {},
    })

    await expect(harness.gate({
      header: { event_id: 'c-2', event_type: 'card.action.trigger' },
      event: {
        operator: { operator_id: { user_id: '9001' } },
        context: { open_chat_id: 'oc_nested' },
      },
    })).resolves.toBe('dispatched')
  })

  it('accepts a menu click that identifies the operator only by user id', async () => {
    const harness = createGate({ config: { dmPolicy: 'open', allowFrom: ['*'] }, routing: {} })

    await expect(harness.gate({
      header: { event_id: 'm-4', event_type: 'application.bot.menu_v6' },
      event: { operator: { operator_id: { user_id: '9002' } }, event_key: 'run_daily' },
    })).resolves.toBe('dispatched')

    expect(harness.logger.info).toHaveBeenCalledWith(expect.stringContaining('from 9002 triggered a run'))
  })

  it('gates a card action that names neither a chat nor an open id', async () => {
    const harness = createGate({ config: { groupPolicy: 'open' }, routing: {} })

    // Without a chat id the rate limit has to fall back to the account itself.
    await expect(harness.gate({
      header: { event_id: 'c-4', event_type: 'card.action.trigger' },
      event: { operator: { operator_id: { user_id: '9003' } } },
    })).resolves.toBe('dispatched')

    expect(harness.logger.info).toHaveBeenCalledWith(expect.stringContaining('from 9003 triggered a run'))
  })

  it('ignores a card action without an operator', async () => {
    const harness = createGate({ config: { groupPolicy: 'open' }, routing: {} })

    await expect(harness.gate({
      header: { event_id: 'c-3', event_type: 'card.action.trigger' },
      event: { open_chat_id: 'oc_1' },
    })).resolves.toBe('ignored')
  })
})

/** Let the background `enqueueRun` promise settle before asserting on it. */
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}
