import type { PluginLogger } from '../../../plugin-sdk/index.js'
import type { FeishuWsSdk } from './ws.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FEISHU_EVENT_TYPES } from './config.js'
import {
  FEISHU_WS_PING_TIMEOUT_SECONDS,
  feishuWsReconnectDelayMs,
  feishuWsSleep,
  FeishuWsTransport,
  isFeishuWsTerminalError,
  loadFeishuWsSdk,
} from './ws.js'

const mocks = vi.hoisted(() => {
  /** Stands in for `Lark.WSClient`; the transport only calls `start`/`close`. */
  class FakeWsClient {
    static instances: FakeWsClient[] = []
    close = vi.fn()
    start = vi.fn(async () => {})
    constructor(readonly params: unknown) {
      FakeWsClient.instances.push(this)
    }
  }

  /** Stands in for `Lark.EventDispatcher`. */
  class FakeDispatcher {
    static instances: FakeDispatcher[] = []
    register = vi.fn()
    constructor(readonly params: unknown) {
      FakeDispatcher.instances.push(this)
    }
  }

  return { FakeWsClient, FakeDispatcher }
})

vi.mock('@larksuiteoapi/node-sdk', () => ({
  WSClient: mocks.FakeWsClient,
  EventDispatcher: mocks.FakeDispatcher,
  Domain: { Feishu: 0, Lark: 1 },
  LoggerLevel: { info: 'info' },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.FakeWsClient.instances.length = 0
  mocks.FakeDispatcher.instances.length = 0
})

function createLogger(): PluginLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** Flush every pending microtask and timer callback that is already due. */
function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50 && !predicate(); index += 1)
    await tick()
}

interface Deferred {
  ms: number
  release: () => void
}

interface HarnessOptions {
  gate?: ReturnType<typeof vi.fn>
  encryptKey?: string
  verificationToken?: string
  /** One entry per `client.start()` call; `undefined` resolves immediately. */
  outcomes?: Array<() => Promise<void>>
  /** Replaces the loader so a test can hold `start()` before it dials out. */
  loadSdk?: () => Promise<FeishuWsSdk>
}

/**
 * A stand-in for `@larksuiteoapi/node-sdk`.
 *
 * The transport only ever sees `createClient` / `createDispatcher`, so the fake
 * records what it was handed and lets the test drive the callbacks the real SDK
 * would fire. The gate is async because the real one consults the pairing store.
 */
function createHarness(options: HarnessOptions = {}) {
  const logger = createLogger()
  const gate = options.gate ?? vi.fn(async () => 'dispatched')
  const outcomes = [...(options.outcomes ?? [])]
  const clients: Array<{
    params: Record<string, unknown>
    start: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }> = []
  const dispatchers: Array<{ encryptKey?: string, verificationToken?: string }> = []
  const handlers: Record<string, (data: unknown) => void> = {}
  const delays: Deferred[] = []

  const sdk = {
    createClient: (params: Record<string, unknown>) => {
      const outcome = outcomes.shift()
      const start = vi.fn(async () => {
        if (outcome)
          await outcome()
      })
      const close = vi.fn()
      clients.push({ params, start, close })
      return { start, close }
    },
    createDispatcher: (params: { encryptKey?: string, verificationToken?: string }) => {
      dispatchers.push(params)
      return {
        register: (registered: Record<string, (data: unknown) => void>) => {
          Object.assign(handlers, registered)
        },
      }
    },
    resolveDomain: (baseUrl: string) => `domain:${baseUrl}`,
    loggerLevel: 'info',
  }

  const transport = new FeishuWsTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    baseUrl: 'https://open.feishu.cn',
    ...(options.encryptKey === undefined ? {} : { encryptKey: options.encryptKey }),
    ...(options.verificationToken === undefined ? {} : { verificationToken: options.verificationToken }),
    gate: gate as never,
    logger,
    loadSdk: options.loadSdk ?? (async () => sdk as never),
    delay: (ms: number) =>
      new Promise<void>((resolve) => {
        delays.push({ ms, release: resolve })
      }),
  })

  return { transport, logger, gate, clients, dispatchers, handlers, delays }
}

/** The flattened payload the SDK dispatches, as `RequestHandle.parse` builds it. */
function flattenedEvent(overrides: { eventId?: string } = {}): Record<string, unknown> {
  return {
    event_id: overrides.eventId ?? 'evt-1',
    event_type: 'im.message.receive_v1',
    sender: { sender_id: { open_id: 'ou_1' } },
    message: { chat_id: 'oc_1', message_type: 'text', mentions: [{ key: '@_user_1' }] },
  }
}

describe('feishuWsReconnectDelayMs', () => {
  it('doubles the delay per attempt and caps it at 30s', () => {
    expect(feishuWsReconnectDelayMs(0)).toBe(1_000)
    expect(feishuWsReconnectDelayMs(1)).toBe(1_000)
    expect(feishuWsReconnectDelayMs(2)).toBe(2_000)
    expect(feishuWsReconnectDelayMs(3)).toBe(4_000)
    expect(feishuWsReconnectDelayMs(10)).toBe(30_000)
    expect(feishuWsReconnectDelayMs(99)).toBe(30_000)
  })
})

describe('isFeishuWsTerminalError', () => {
  it('recognises the errors the SDK cannot recover from', () => {
    expect(isFeishuWsTerminalError(new Error('WebSocket reconnect exhausted after 5 attempts'))).toBe(true)
    expect(isFeishuWsTerminalError(new Error('WebSocket reconnect exhausted after 1 attempt'))).toBe(true)
    expect(isFeishuWsTerminalError(new Error('  WebSocket connect failed and autoReconnect is disabled'))).toBe(true)
    expect(isFeishuWsTerminalError(new Error('socket hang up'))).toBe(false)
    expect(isFeishuWsTerminalError(new Error('WebSocket reconnect exhausted after many attempts'))).toBe(false)
  })
})

describe('feishuWsSleep', () => {
  it('resolves once the timer fires', async () => {
    await expect(feishuWsSleep(1)).resolves.toBeUndefined()
  })
})

describe('loadFeishuWsSdk', () => {
  it('constructs the SDK client, dispatcher and domain enum', async () => {
    const sdk = await loadFeishuWsSdk()

    expect(sdk.resolveDomain('https://open.larksuite.com')).toBe(1)
    expect(sdk.resolveDomain('https://open.feishu.cn')).toBe(0)
    expect(sdk.loggerLevel).toBe('info')

    const client = sdk.createClient({ appId: 'cli_1' } as never)
    expect(mocks.FakeWsClient.instances[0]?.params).toEqual({ appId: 'cli_1' })
    expect(client).toBe(mocks.FakeWsClient.instances[0])

    const dispatcher = sdk.createDispatcher({ encryptKey: 'key' })
    expect(mocks.FakeDispatcher.instances[0]?.params).toEqual({ encryptKey: 'key' })
    expect(dispatcher).toBe(mocks.FakeDispatcher.instances[0])
  })
})

describe('feishuWsTransport', () => {
  it('dials out with the configured credentials and no inbound endpoint', async () => {
    const { transport, logger, clients } = createHarness()

    await transport.start()

    expect(clients).toHaveLength(1)
    expect(clients[0]?.params.appId).toBe('cli_test')
    expect(clients[0]?.params.appSecret).toBe('secret')
    expect(clients[0]?.params.domain).toBe('domain:https://open.feishu.cn')
    expect(clients[0]?.params.loggerLevel).toBe('info')
    expect(clients[0]?.params.wsConfig).toEqual({ pingTimeout: FEISHU_WS_PING_TIMEOUT_SECONDS })

    const params = clients[0]?.params as Record<string, () => void>
    params.onReady?.()
    params.onReconnecting?.()
    params.onReconnected?.()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('receiving events over the long-lived connection'))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('is reconnecting'))
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('reconnected'))

    await transport.stop()
    expect(clients[0]?.close).toHaveBeenCalledWith({ force: true })
  })

  it('hands the dispatcher the callback credentials when they are configured', async () => {
    const { transport, dispatchers } = createHarness({ encryptKey: 'key', verificationToken: 'token' })

    await transport.start()

    expect(dispatchers[0]).toEqual({ encryptKey: 'key', verificationToken: 'token' })
    await transport.stop()
  })

  it('registers every subscribed event and leaves the credentials out when unset', async () => {
    const { transport, dispatchers, handlers } = createHarness()

    await transport.start()

    expect(dispatchers[0]).toEqual({})
    expect(Object.keys(handlers)).toEqual([...FEISHU_EVENT_TYPES])
    // The long connection is authenticated by the handshake, so the callback
    // signature/encryption credentials are not needed to decode WS events.
    expect(Object.keys(handlers)).toHaveLength(11)
    await transport.stop()
  })

  it('routes a non-message event to the gates with its own event type', async () => {
    const { transport, gate, handlers } = createHarness()

    await transport.start()
    handlers['application.bot.menu_v6']?.({ operator: { operator_id: { open_id: 'ou_1', event_key: 'run' } } })

    expect(gate).toHaveBeenCalledWith({
      header: { event_type: 'application.bot.menu_v6' },
      event: { operator: { operator_id: { open_id: 'ou_1', event_key: 'run' } } },
    })
    await transport.stop()
  })

  it('rebuilds the envelope the SDK flattened before running the gates', async () => {
    const { transport, gate, handlers } = createHarness()

    await transport.start()
    handlers['im.message.receive_v1']?.(flattenedEvent({ eventId: 'evt-9' }))

    expect(gate).toHaveBeenCalledWith({
      header: { event_type: 'im.message.receive_v1', event_id: 'evt-9' },
      event: flattenedEvent({ eventId: 'evt-9' }),
    })
    await transport.stop()
  })

  it('passes an event without an id through the gates without a dedupe key', async () => {
    const { transport, gate, handlers } = createHarness()

    await transport.start()
    handlers['im.message.receive_v1']?.({ message: { chat_id: 'oc_1' } })

    expect(gate).toHaveBeenCalledWith({
      header: { event_type: 'im.message.receive_v1' },
      event: { message: { chat_id: 'oc_1' } },
    })
    await transport.stop()
  })

  it('ignores a dispatched payload that is not an object', async () => {
    const { transport, gate, handlers, logger } = createHarness()

    await transport.start()
    handlers['im.message.receive_v1']?.(null)

    expect(gate).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('payload is not an object'))
    await transport.stop()
  })

  it('logs a gate failure instead of failing the delivery', async () => {
    const { transport, handlers, logger } = createHarness({
      gate: vi.fn(() => Promise.reject(new Error('pairing store is unavailable'))),
    })

    await transport.start()
    handlers['im.message.receive_v1']?.(flattenedEvent())

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Feishu WebSocket event handler failed: pairing store is unavailable'),
      )
    })
    await transport.stop()
  })

  it('recreates the client after the connection ends', async () => {
    const { transport, clients, delays, logger } = createHarness()

    await transport.start()
    ;(clients[0]?.params as Record<string, (error: Error) => void>).onError?.(
      new Error('WebSocket reconnect exhausted after 3 attempts'),
    )
    await until(() => delays.length > 0)

    expect(delays[0]?.ms).toBe(1_000)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('connection ended, reconnecting'))
    expect(clients[0]?.close).toHaveBeenCalledWith({ force: true })

    delays[0]?.release()
    await until(() => clients.length > 1)
    expect(clients).toHaveLength(2)

    await transport.stop()
  })

  it('keeps the connection when the SDK reports a recoverable error', async () => {
    const { transport, clients, logger, delays } = createHarness()

    await transport.start()
    ;(clients[0]?.params as Record<string, (error: Error) => void>).onError?.(new Error('socket hang up'))

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('recoverable error'))
    expect(clients).toHaveLength(1)
    expect(delays).toHaveLength(0)

    await transport.stop()
  })

  it('resolves start and retries in the background when the first handshake fails', async () => {
    const { transport, clients, delays, logger } = createHarness({
      outcomes: [async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      }],
    })

    await transport.start()

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not connect'))
    await until(() => delays.length > 0)
    expect(delays[0]?.ms).toBe(1_000)

    delays[0]?.release()
    await until(() => clients.length > 1)
    expect(clients).toHaveLength(2)

    await transport.stop()
  })

  it('logs a failure of a later attempt too', async () => {
    const { transport, clients, delays, logger } = createHarness({
      outcomes: [
        async () => {
          throw new Error('first failure')
        },
        async () => {
          throw new Error('second failure')
        },
      ],
    })

    await transport.start()
    await until(() => delays.length > 0)
    delays[0]?.release()
    await until(() => clients.length > 1)
    await until(() => delays.length > 1)

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('connection attempt failed: second failure'))

    await transport.stop()
  })

  it('stops while it is waiting to reconnect', async () => {
    const { transport, delays } = createHarness({
      outcomes: [async () => {
        throw new Error('unreachable')
      }],
    })

    await transport.start()
    await until(() => delays.length > 0)

    await expect(transport.stop()).resolves.toBeUndefined()
  })

  it('stops before it ever connected', async () => {
    const { transport, clients } = createHarness()

    await expect(transport.stop()).resolves.toBeUndefined()

    expect(clients).toHaveLength(0)
  })

  it('settles an in-flight start when it is stopped before the first handshake', async () => {
    let release!: () => void
    const loading = new Promise<void>((resolve) => {
      release = resolve
    })
    const { transport, logger, clients } = createHarness({
      loadSdk: async () => {
        await loading
        return {} as FeishuWsSdk
      },
    })

    // `stop()` lands before the SDK has even been loaded, so the loop is still
    // unknown to it; the start must still settle instead of waiting forever.
    const start = transport.start()
    await expect(transport.stop()).resolves.toBeUndefined()
    release()

    await expect(start).resolves.toBeUndefined()
    expect(clients).toHaveLength(0)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('loads the real SDK when no loader is injected', async () => {
    const logger = createLogger()
    const transport = new FeishuWsTransport({
      appId: 'cli_real',
      appSecret: 'secret',
      baseUrl: 'https://open.feishu.cn',
      gate: vi.fn(() => 'dispatched') as never,
      logger,
    })

    await transport.start()

    expect(mocks.FakeWsClient.instances[0]?.params).toEqual(expect.objectContaining({ appId: 'cli_real' }))

    // Ends the connection so the default backoff (the real timer) is used.
    mocks.FakeWsClient.instances[0]?.close.mockClear()
    ;(mocks.FakeWsClient.instances[0]?.params as { onError?: (error: Error) => void }).onError?.(
      new Error('WebSocket reconnect exhausted after 1 attempt'),
    )
    await until(() => (logger.error as ReturnType<typeof vi.fn>).mock.calls.length > 0)

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('connection ended, reconnecting'))
    expect(mocks.FakeWsClient.instances[0]?.close).toHaveBeenCalledWith({ force: true })

    // The default delay is a real (unref'd) timer; stopping wins the race.
    await expect(transport.stop()).resolves.toBeUndefined()
  })

  it('reports an error that carries no message by its name', async () => {
    const { transport, logger } = createHarness({
      outcomes: [async () => {
        throw new Error('   ')
      }],
    })

    await transport.start()

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not connect: Error'))
    await transport.stop()
  })
})
