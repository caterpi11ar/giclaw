import type { PluginLogger } from '../../../plugin-sdk/index.js'
import type { FeishuEventGate } from './event-gate.js'
import { toError } from '../../../utils/errors.js'
import { sanitizeBoundedText } from '../../../utils/logger.js'
import { FEISHU_EVENT_TYPES } from './config.js'
import { asRecord, stringField } from './record.js'

/** openclaw: start at 1s, double per attempt, cap at 30s. */
export const FEISHU_WS_RECONNECT_INITIAL_DELAY_MS = 1_000
export const FEISHU_WS_RECONNECT_MAX_DELAY_MS = 30_000

/** Seconds the server may stay silent before the SDK treats the socket as dead. */
export const FEISHU_WS_PING_TIMEOUT_SECONDS = 3

/**
 * Errors the SDK will not recover from on its own, so the transport recreates
 * the client instead (openclaw's classifier).
 */
const RECONNECT_EXHAUSTED_RE = /^WebSocket reconnect exhausted after \d+ attempts?/u
const AUTORECONNECT_DISABLED_ERROR = 'WebSocket connect failed and autoReconnect is disabled'

/** Backoff before attempt `attempt` (1-based). */
export function feishuWsReconnectDelayMs(attempt: number): number {
  return Math.min(
    FEISHU_WS_RECONNECT_INITIAL_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    FEISHU_WS_RECONNECT_MAX_DELAY_MS,
  )
}

/** True when the SDK gave up reconnecting internally. */
export function isFeishuWsTerminalError(error: Error): boolean {
  const message = error.message.trim()
  return RECONNECT_EXHAUSTED_RE.test(message) || message.startsWith(AUTORECONNECT_DISABLED_ERROR)
}

/** The slice of `@larksuiteoapi/node-sdk` this transport depends on. */
export interface FeishuWsClient {
  start: (params: { eventDispatcher: unknown }) => Promise<void>
  close: (options?: { force?: boolean }) => void
}

export interface FeishuWsDispatcher {
  register: (handlers: Record<string, (data: unknown) => void | Promise<void>>) => void
}

export interface FeishuWsSdk {
  createClient: (params: {
    appId: string
    appSecret: string
    domain: unknown
    loggerLevel: unknown
    wsConfig: { pingTimeout: number }
    onReady: () => void
    onReconnecting: () => void
    onReconnected: () => void
    onError: (error: Error) => void
  }) => FeishuWsClient
  createDispatcher: (params: { encryptKey?: string, verificationToken?: string }) => FeishuWsDispatcher
  /** Map a configured origin onto the SDK's `Domain` enum. */
  resolveDomain: (baseUrl: string) => unknown
  loggerLevel: unknown
}

export interface FeishuWsTransportOptions {
  appId: string
  appSecret: string
  baseUrl: string
  encryptKey?: string
  verificationToken?: string
  gate: FeishuEventGate['gate']
  logger: PluginLogger
  /** Injected for tests; defaults to a lazy import of the Feishu SDK. */
  loadSdk?: () => Promise<FeishuWsSdk>
  /** Injected for tests so backoff does not slow the suite down. */
  delay?: (ms: number) => Promise<void>
}

/**
 * Resolve the Feishu SDK lazily.
 *
 * Keeping the import behind a function means the dependency-free `webhook`
 * transport keeps working even if the SDK is unavailable at runtime.
 */
export async function loadFeishuWsSdk(): Promise<FeishuWsSdk> {
  const sdk = await import('@larksuiteoapi/node-sdk')
  return {
    createClient: params => new sdk.WSClient(params as never) as unknown as FeishuWsClient,
    createDispatcher: params => new sdk.EventDispatcher(params) as unknown as FeishuWsDispatcher,
    resolveDomain: baseUrl =>
      baseUrl === 'https://open.larksuite.com' ? sdk.Domain.Lark : sdk.Domain.Feishu,
    loggerLevel: sdk.LoggerLevel.info,
  }
}

function describeFeishuWsError(error: Error): string {
  return sanitizeBoundedText(error.message.trim() === '' ? error.name : error.message, 300)
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })
}

/** Default backoff; exported so its timer path is covered by a direct test. */
export const feishuWsSleep = sleep

/**
 * Receive Feishu events over a WebSocket the daemon dials out to.
 *
 * Because the connection is opened from inside the network, the daemon needs no
 * public endpoint, certificate, reverse proxy or tunnel: LAN and NAT hosts work
 * exactly like the openclaw channel. The connection is authenticated by the
 * handshake, so Feishu neither signs nor encrypts events delivered over it — the
 * gates in {@link FeishuEventGate} still apply to every event.
 */
export class FeishuWsTransport {
  private readonly stopSignal: Promise<'stopped'>
  private readonly firstResult: Promise<'ready' | 'stopped' | Error>
  private markStopped!: () => void
  private reportFirst!: (result: 'ready' | 'stopped' | Error) => void
  private stopped = false
  private attempt = 0
  private client?: FeishuWsClient
  private loop?: Promise<void>

  constructor(private readonly options: FeishuWsTransportOptions) {
    this.stopSignal = new Promise<'stopped'>((resolve) => {
      this.markStopped = () => resolve('stopped')
    })
    this.firstResult = new Promise<'ready' | 'stopped' | Error>((resolve) => {
      this.reportFirst = resolve
    })
  }

  /**
   * Start receiving events.
   *
   * Resolves once the first handshake settles so a misconfigured app surfaces
   * during plugin startup; the reconnect loop then keeps running in the
   * background and heals a dropped connection on its own.
   */
  async start(): Promise<void> {
    const { loadSdk } = this.options
    const sdk = await (loadSdk ?? loadFeishuWsSdk)()
    this.loop = this.run(sdk)
    const first = await this.firstResult
    if (first === 'stopped')
      return
    if (first !== 'ready') {
      this.options.logger.error(
        `Feishu WebSocket could not connect: ${describeFeishuWsError(first)}; retrying in the background`,
      )
    }
  }

  /**
   * Stop reconnecting, close the socket and wait for the loop to unwind.
   *
   * A stop may arrive while {@link start} is still waiting for its first
   * handshake; settling that wait keeps a shutdown from hanging on a start that
   * will never connect.
   */
  async stop(): Promise<void> {
    this.stopped = true
    this.markStopped()
    this.reportFirst('stopped')
    this.closeClient()
    await this.loop?.then(
      () => undefined,
      () => undefined,
    )
  }

  private async run(sdk: FeishuWsSdk): Promise<void> {
    while (!this.stopped) {
      const isFirst = this.attempt === 0
      const { outcome, terminal } = await this.connect(sdk)
      if (isFirst)
        this.reportFirst(outcome)
      if (outcome === 'ready') {
        const ended = await Promise.race([
          terminal.then((error): Error => error),
          this.stopSignal,
        ])
        if (ended === 'stopped')
          break
        this.closeClient()
        this.options.logger.error(
          `Feishu WebSocket connection ended, reconnecting: ${describeFeishuWsError(ended)}`,
        )
      }
      else if (!isFirst) {
        this.options.logger.error(
          `Feishu WebSocket connection attempt failed: ${describeFeishuWsError(outcome)}`,
        )
      }

      this.attempt += 1
      const delayMs = feishuWsReconnectDelayMs(this.attempt)
      this.options.logger.info(`Feishu WebSocket reconnecting in ${delayMs}ms`)
      const delay = this.options.delay ?? sleep
      const waited = await Promise.race([
        delay(delayMs).then((): 'elapsed' => 'elapsed'),
        this.stopSignal,
      ])
      if (waited === 'stopped')
        break
    }
    this.closeClient()
  }

  private async connect(sdk: FeishuWsSdk): Promise<{ outcome: 'ready' | Error, terminal: Promise<Error> }> {
    const { logger } = this.options
    const terminal = new Promise<Error>((resolve) => {
      this.reportTerminal = resolve
    })
    const dispatcher = sdk.createDispatcher({
      ...(this.options.encryptKey === undefined ? {} : { encryptKey: this.options.encryptKey }),
      ...(this.options.verificationToken === undefined ? {} : { verificationToken: this.options.verificationToken }),
    })
    dispatcher.register(Object.fromEntries(
      FEISHU_EVENT_TYPES.map(eventType => [eventType, (data: unknown) => {
        this.handleEvent(eventType, data)
      }]),
    ))
    const client = sdk.createClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      domain: sdk.resolveDomain(this.options.baseUrl),
      loggerLevel: sdk.loggerLevel,
      wsConfig: { pingTimeout: FEISHU_WS_PING_TIMEOUT_SECONDS },
      onReady: () => logger.info('Feishu WebSocket connected; receiving events over the long-lived connection'),
      onReconnecting: () => logger.warn('Feishu WebSocket is reconnecting'),
      onReconnected: () => logger.info('Feishu WebSocket reconnected'),
      onError: (error) => {
        if (isFeishuWsTerminalError(error))
          this.reportTerminal(error)
        else
          logger.warn(`Feishu WebSocket reported a recoverable error: ${describeFeishuWsError(error)}`)
      },
    })
    this.client = client
    const outcome = await client.start({ eventDispatcher: dispatcher }).then(
      (): 'ready' => 'ready',
      (error: unknown): Error => toError(error),
    )
    return { outcome, terminal }
  }

  private reportTerminal!: (error: Error) => void

  /**
   * Feed one dispatched event into the shared gates.
   *
   * The SDK flattens the envelope before dispatching (`{...header, ...event}`),
   * so the canonical `{ header, event }` shape the gates read has to be rebuilt
   * here. The subscription key is authoritative for the event type because the
   * flattening merges the two halves into one object.
   *
   * This handler must never throw: a thrown error is answered to Feishu as a
   * 500, which makes the platform redeliver the event.
   */
  private handleEvent(eventType: string, data: unknown): void {
    const event = asRecord(data)
    if (!event) {
      this.options.logger.warn('Feishu WebSocket event ignored: payload is not an object')
      return
    }
    const eventId = stringField(event, 'event_id')
    void this.options.gate({
      header: {
        event_type: eventType,
        ...(eventId === undefined ? {} : { event_id: eventId }),
      },
      event,
    }).catch((error: unknown) => {
      this.options.logger.warn(`Feishu WebSocket event handler failed: ${sanitizeBoundedText(toError(error).message, 200)}`)
    })
  }

  private closeClient(): void {
    const client = this.client
    this.client = undefined
    client?.close({ force: true })
  }
}
