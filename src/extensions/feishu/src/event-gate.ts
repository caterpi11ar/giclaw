import type { PluginLogger, PluginRuntime } from '../../../plugin-sdk/index.js'
import type { FeishuMergedConfig } from './accounts.js'
import type { FeishuInboundRouting } from './config.js'
import { createRateLimiter, createRecentKeySet } from '../../../plugin-sdk/index.js'
import { toError } from '../../../utils/errors.js'
import { sanitizeBoundedText } from '../../../utils/logger.js'
import { FEISHU_MESSAGE_EVENT_TYPE, isFeishuEventType, isFeishuTriggerEventType } from './config.js'
import { evaluateFeishuIngress, FEISHU_PAIRING_DENIED_REASON } from './policy.js'
import { asRecord, stringField } from './record.js'

/**
 * Bounded dedupe memory. Both transports can deliver the same event twice: a
 * webhook because the callback took longer than the ack budget, a long-lived
 * connection because the SDK replays what it could not confirm. A re-delivered
 * event must not start a second run.
 */
const PROCESSED_EVENT_LIMIT = 2_000

/** Out-of-band approval request for one unpaired direct sender. */
export interface FeishuPairingRequest {
  accountId: string
  subjects: string[]
  chatId?: string
}

export interface FeishuEventGateOptions {
  /** Account this gate belongs to; used for logs and the pairing store. */
  accountId: string
  /** Merged account config; the sender policy is evaluated against it. */
  config: FeishuMergedConfig
  /** Routing for accepted events; omit to observe without ever triggering. */
  routing?: FeishuInboundRouting
  runtime: PluginRuntime
  logger: PluginLogger
  now?: () => number
  /** Approved `user:<id>` subjects; consulted only by `dmPolicy: "pairing"`. */
  readPairedSenderIds?: () => Promise<readonly string[]>
  /**
   * Called when an unpaired direct sender needs a code. The callback owns the
   * store write and the reply, so the gate stays a pure decision function.
   */
  onPairingRequired?: (params: FeishuPairingRequest) => void
  /**
   * Resolve this app's own `open_id` so an `@`-mention can be attributed. When
   * unavailable, any mention counts (openclaw falls back the same way).
   */
  resolveBotOpenId?: () => Promise<string | undefined>
}

/** `dispatched` enqueued a run; `ignored` deliberately did not. */
export type FeishuEventOutcome = 'dispatched' | 'ignored'

export interface FeishuEventGate {
  /**
   * Apply event-type, dedupe, policy, message-type, mention and rate-limit
   * gates to an envelope the transport has already authenticated.
   *
   * Never throws and never interprets message text: a validated event maps onto
   * a configured routine or task list, nothing else.
   */
  gate: (body: Record<string, unknown>) => Promise<FeishuEventOutcome>
}

/** Routine first, then explicit tasks, then the gateway defaults. */
function resolveTaskIds(
  runtime: PluginRuntime,
  routing: FeishuInboundRouting,
  logger: PluginLogger,
): string[] | undefined | null {
  if (routing.routine !== undefined) {
    const taskIds = runtime.gateway.resolveRoutine(routing.routine)
    if (!taskIds) {
      logger.error(`Feishu inbound routine "${sanitizeBoundedText(routing.routine, 100)}" is not configured; event ignored`)
      return null
    }
    return taskIds
  }
  return routing.tasks.length > 0 ? routing.tasks : undefined
}

/**
 * The gate chain shared by the webhook route and the WebSocket transport.
 *
 * Authentication is the transport's job: the callback route verifies Feishu's
 * signature and decrypts the body, while a long-lived connection is already
 * authenticated and hands over the decoded envelope.
 */
export function createFeishuEventGate(options: FeishuEventGateOptions): FeishuEventGate {
  const { accountId, config, routing, runtime, logger } = options
  const limiter = createRateLimiter({
    limit: routing?.rateLimit.limit ?? 0,
    windowMs: routing?.rateLimit.windowMs ?? 0,
    ...(options.now ? { now: options.now } : {}),
  })
  const processed = createRecentKeySet(PROCESSED_EVENT_LIMIT)
  let botOpenIdPromise: Promise<string | undefined> | null = null

  const botOpenId = (): Promise<string | undefined> => {
    if (!options.resolveBotOpenId)
      return Promise.resolve(undefined)
    botOpenIdPromise ??= options.resolveBotOpenId().catch(() => undefined)
    return botOpenIdPromise
  }

  async function gate(body: Record<string, unknown>): Promise<FeishuEventOutcome> {
    const header = asRecord(body.header)
    const eventId = stringField(header, 'event_id')
    if (eventId !== undefined && !processed.add(eventId)) {
      logger.info(`Feishu event ${sanitizeBoundedText(eventId, 100)} was already handled; ignoring the redelivery`)
      return 'ignored'
    }

    const eventType = header?.event_type
    if (!isFeishuEventType(eventType)) {
      logger.debug?.(`Ignoring unsubscribed Feishu event type ${sanitizeBoundedText(String(eventType ?? 'unknown'), 100)}`)
      return 'ignored'
    }

    if (!isFeishuTriggerEventType(eventType)) {
      // Observed for parity with openclaw's subscription set, but Giclaw has no
      // agent turn to feed: these events are acknowledged and dropped.
      logger.debug?.(`Observing Feishu event type ${sanitizeBoundedText(eventType, 100)} without triggering`)
      return 'ignored'
    }

    const event = asRecord(body.event)
    if (event === null) {
      logger.warn('Feishu event ignored: the envelope carries no event body')
      return 'ignored'
    }

    const subject = extractSubject(eventType, event)
    if (subject === null) {
      logger.warn(`Feishu ${sanitizeBoundedText(eventType, 100)} event ignored: it carries no sender id`)
      return 'ignored'
    }

    if (subject.messageType !== undefined && subject.messageType !== 'text') {
      logger.info(`Feishu event ignored: unsupported message type ${sanitizeBoundedText(subject.messageType, 50)}`)
      return 'ignored'
    }

    const pairedSenderIds = options.readPairedSenderIds
      ? await options.readPairedSenderIds()
      : undefined

    const decision = evaluateFeishuIngress({
      config,
      chatType: subject.chatType,
      chatId: subject.chatId ?? '',
      ...(subject.senderOpenId === undefined ? {} : { senderOpenId: subject.senderOpenId }),
      ...(subject.senderUserId === undefined ? {} : { senderUserId: subject.senderUserId }),
      ...(subject.senderType === undefined ? {} : { senderType: subject.senderType }),
      mentionedBot: await resolveMentioned(eventType, subject, botOpenId),
      ...(pairedSenderIds === undefined ? {} : { pairedSenderIds }),
    })

    if (!decision.allowed) {
      logger.warn(`Feishu event ignored: ${sanitizeBoundedText(decision.reason, 200)}`)
      handleDenied(subject, decision.reason)
      return 'ignored'
    }

    if (routing === undefined) {
      logger.debug?.('Feishu inbound routing is not configured; the event only updates the observed state')
      return 'ignored'
    }

    const rateLimitKey = subject.chatId ?? subject.senderOpenId ?? accountId
    if (!limiter.allow(rateLimitKey)) {
      logger.warn(`Feishu event dropped: rate limit reached for ${sanitizeBoundedText(rateLimitKey, 100)}`)
      return 'ignored'
    }

    const taskIds = resolveTaskIds(runtime, routing, logger)
    if (taskIds === null)
      return 'ignored'

    logger.info(`Feishu ${sanitizeBoundedText(eventType, 100)} from ${sanitizeBoundedText(senderLabel(subject), 100)} triggered a run`)
    void runtime.gateway.enqueueRun(taskIds).then(
      result => logger.info(`Feishu-triggered run completed with ${result.results.length} task result(s)`),
      (error: unknown) => logger.warn(`Feishu-triggered run failed: ${sanitizeBoundedText(toError(error).message)}`),
    )
    return 'dispatched'
  }

  /**
   * Issue a pairing code for an unpaired direct sender.
   *
   * This is the only gate outcome with a side effect, and it is deliberately
   * narrow: the request is generated only for the `pairing` policy's own denial
   * and never touches the message body.
   */
  function handleDenied(subject: FeishuSubject, reason: string): void {
    if (reason !== FEISHU_PAIRING_DENIED_REASON)
      return
    if (!options.onPairingRequired)
      return
    const subjects = [subject.senderOpenId, subject.senderUserId]
      .filter((value): value is string => Boolean(value))
      .map(value => `user:${value}`)
    options.onPairingRequired({
      accountId,
      subjects,
      ...(subject.chatId === undefined ? {} : { chatId: subject.chatId }),
    })
  }

  return { gate }
}

interface FeishuSubject {
  chatType: string
  chatId?: string
  senderOpenId?: string
  senderUserId?: string
  senderType?: string
  messageType?: string
  mentions: Array<Record<string, unknown>>
}

const DIRECT_CHAT_TYPE = 'p2p'
const GROUP_CHAT_TYPE = 'group'

/**
 * The id an event is logged under. Extraction rejects a subject that carries
 * neither id, so one of the two is always present.
 */
function senderLabel(subject: FeishuSubject): string {
  return subject.senderOpenId ?? subject.senderUserId as string
}

function extractSubject(
  eventType: string,
  event: Record<string, unknown>,
): FeishuSubject | null {
  if (eventType === FEISHU_MESSAGE_EVENT_TYPE)
    return extractMessageSubject(event)
  if (eventType === 'application.bot.menu_v6')
    return extractMenuSubject(event)
  return extractCardSubject(event)
}

function extractSenderIds(record: Record<string, unknown> | null): {
  openId?: string
  userId?: string
} {
  const openId = stringField(record, 'open_id')
  const userId = stringField(record, 'user_id')
  return {
    ...(openId === undefined ? {} : { openId }),
    ...(userId === undefined ? {} : { userId }),
  }
}

function extractMessageSubject(event: Record<string, unknown>): FeishuSubject | null {
  const message = asRecord(event.message)
  const sender = asRecord(event.sender)
  const ids = extractSenderIds(asRecord(sender?.sender_id))
  const chatId = stringField(message, 'chat_id')
  if (chatId === undefined || (ids.openId === undefined && ids.userId === undefined))
    return null
  const chatType = stringField(message, 'chat_type')
  const senderType = stringField(sender, 'sender_type')
  const messageType = stringField(message, 'message_type')
  const mentions = Array.isArray(message?.mentions) ? message.mentions.filter(isPlainRecord) : []
  return {
    chatType: chatType ?? DIRECT_CHAT_TYPE,
    chatId,
    ...(ids.openId === undefined ? {} : { senderOpenId: ids.openId }),
    ...(ids.userId === undefined ? {} : { senderUserId: ids.userId }),
    ...(senderType === undefined ? {} : { senderType }),
    ...(messageType === undefined ? {} : { messageType }),
    mentions,
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A menu click is operator-initiated inside a 1:1 chat with the app. */
function extractMenuSubject(event: Record<string, unknown>): FeishuSubject | null {
  const operator = asRecord(event.operator)
  const ids = extractSenderIds(asRecord(operator?.operator_id))
  if (ids.openId === undefined && ids.userId === undefined)
    return null
  return {
    chatType: DIRECT_CHAT_TYPE,
    ...(ids.openId === undefined ? {} : { senderOpenId: ids.openId }),
    ...(ids.userId === undefined ? {} : { senderUserId: ids.userId }),
    mentions: [],
  }
}

/**
 * Card callbacks carry no reliable chat type, so they are gated as a direct
 * interaction: the operator pressed a button the app itself rendered.
 */
function extractCardSubject(event: Record<string, unknown>): FeishuSubject | null {
  const operator = asRecord(event.operator)
  const ids = extractSenderIds(asRecord(operator?.operator_id))
  if (ids.openId === undefined && ids.userId === undefined)
    return null
  const chatId = stringField(event, 'open_chat_id') ?? stringField(asRecord(event.context), 'open_chat_id')
  return {
    chatType: GROUP_CHAT_TYPE,
    ...(chatId === undefined ? {} : { chatId }),
    ...(ids.openId === undefined ? {} : { senderOpenId: ids.openId }),
    ...(ids.userId === undefined ? {} : { senderUserId: ids.userId }),
    mentions: [],
  }
}

/**
 * A message must carry an `@`-mention when the chat requires one; a menu click
 * or a button press already is the operator addressing the app directly.
 */
function resolveMentioned(
  eventType: string,
  subject: FeishuSubject,
  resolveBotOpenId: () => Promise<string | undefined>,
): Promise<boolean> {
  if (eventType !== FEISHU_MESSAGE_EVENT_TYPE)
    return Promise.resolve(true)
  return isBotMentioned(subject, resolveBotOpenId)
}

async function isBotMentioned(
  subject: FeishuSubject,
  resolveBotOpenId: () => Promise<string | undefined>,
): Promise<boolean> {
  if (subject.mentions.length === 0)
    return false
  const ownOpenId = await resolveBotOpenId()
  if (ownOpenId === undefined)
    return true
  return subject.mentions.some(mention =>
    stringField(asRecord(mention.id), 'open_id') === ownOpenId
    || mention.key === ownOpenId)
}
