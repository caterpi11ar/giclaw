import type { Gateway } from '../gateway/gateway.js'
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../utils/logger.js'
import { registerApi } from './api.js'
import { isSelfAuthenticatingPluginRoute, registerPluginRoutes } from './plugin-routes.js'
import { registerWebSecurity } from './security.js'
import { MAX_WEB_SOCKET_PAYLOAD_BYTES, startWebServer } from './server.js'
import { registerWebSocket } from './ws.js'

const mocks = vi.hoisted(() => ({
  app: {
    register: vi.fn(),
    listen: vi.fn(),
    close: vi.fn(),
    server: {
      on: vi.fn(),
      removeListener: vi.fn(),
    },
  },
}))

vi.mock('fastify', () => ({
  default: vi.fn(() => mocks.app),
}))
vi.mock('@fastify/static', () => ({ default: 'static-plugin' }))
vi.mock('@fastify/websocket', () => ({ default: 'websocket-plugin' }))
vi.mock('./api.js', () => ({ registerApi: vi.fn() }))
vi.mock('./security.js', () => ({ registerWebSecurity: vi.fn() }))
vi.mock('./plugin-routes.js', () => ({
  isSelfAuthenticatingPluginRoute: vi.fn(() => true),
  registerPluginRoutes: vi.fn(),
}))
vi.mock('./ws.js', () => ({ registerWebSocket: vi.fn() }))

describe('web server', () => {
  beforeEach(() => {
    mocks.app.register.mockResolvedValue(undefined)
    mocks.app.listen.mockResolvedValue('http://127.0.0.1:4321')
    mocks.app.close.mockResolvedValue(undefined)
  })

  it('mounts plugin routes when a plugin bridge is supplied', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const gateway = {
      config: { web: { port: 4321 } },
    } as unknown as Gateway
    const capabilities = { listRoutes: vi.fn(() => []) }
    const pluginLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const host = { getStatus: vi.fn(() => []) }

    const handle = await startWebServer(gateway, {
      capabilities,
      logger: pluginLogger,
      host,
    } as never)

    expect(registerWebSecurity).toHaveBeenCalledWith(mocks.app, 4321, undefined, {
      isSelfAuthenticating: expect.any(Function),
    })
    const options = vi.mocked(registerWebSecurity).mock.calls.at(-1)?.[3]
    expect(options?.isSelfAuthenticating?.('POST', '/api/ext/example')).toBe(true)
    expect(isSelfAuthenticatingPluginRoute).toHaveBeenCalledWith(capabilities, 'POST', '/api/ext/example')
    expect(registerApi).toHaveBeenCalledWith(mocks.app, gateway, { capabilities, logger: pluginLogger, host })
    expect(registerPluginRoutes).toHaveBeenCalledWith(mocks.app, capabilities, pluginLogger)
    expect(info).toHaveBeenCalledWith('Web panel running at http://127.0.0.1:4321')

    await handle.close()
  })

  it('registers transports and listens on the configured port', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const gateway = {
      config: { web: { port: 4321 } },
    } as unknown as Gateway

    const handle = await startWebServer(gateway)

    const connectionListener = mocks.app.server.on.mock.calls[0]?.[1] as (
      socket: { destroy: () => void, once: (event: string, listener: () => void) => void },
    ) => void
    const closedSocketListener = vi.fn()
    const closedSocket = {
      destroy: vi.fn(),
      once: vi.fn((_event: string, listener: () => void) => closedSocketListener.mockImplementation(listener)),
    }
    const activeSocket = { destroy: vi.fn(), once: vi.fn() }
    connectionListener(closedSocket)
    connectionListener(activeSocket)
    closedSocketListener()

    expect(Fastify).toHaveBeenCalledWith({
      logger: false,
      forceCloseConnections: true,
    })
    expect(registerWebSecurity).toHaveBeenCalledWith(mocks.app, 4321)
    expect(mocks.app.register).toHaveBeenNthCalledWith(1, 'websocket-plugin', {
      options: { maxPayload: MAX_WEB_SOCKET_PAYLOAD_BYTES },
      preClose: expect.any(Function),
    })
    expect(mocks.app.register).toHaveBeenNthCalledWith(2, 'static-plugin', expect.objectContaining({
      prefix: '/',
      root: expect.stringMatching(/src\/web\/public$/),
    }))
    expect(registerApi).toHaveBeenCalledWith(mocks.app, gateway)
    expect(registerWebSocket).toHaveBeenCalledWith(mocks.app, gateway)
    expect(mocks.app.listen).toHaveBeenCalledWith({ port: 4321, host: '127.0.0.1' })
    expect(info).toHaveBeenCalledWith('Web panel running at http://127.0.0.1:4321')

    const pluginOptions = mocks.app.register.mock.calls[0]?.[1] as {
      preClose: (this: {
        websocketServer: {
          clients: Set<{ terminate: () => void }>
          close: (done: () => void) => void
        }
      }, done: () => void) => void
    }
    const terminate = vi.fn()
    const webSocketClose = vi.fn((done: () => void) => done())
    const preCloseDone = vi.fn()
    pluginOptions.preClose.call({
      websocketServer: {
        clients: new Set([{ terminate }]),
        close: webSocketClose,
      },
    }, preCloseDone)
    expect(terminate).toHaveBeenCalledOnce()
    expect(webSocketClose).toHaveBeenCalledWith(preCloseDone)
    expect(preCloseDone).toHaveBeenCalledOnce()

    await handle.close()
    await handle.close()
    expect(mocks.app.close).toHaveBeenCalledOnce()
    expect(mocks.app.server.removeListener).toHaveBeenCalledWith('connection', connectionListener)
    expect(closedSocket.destroy).not.toHaveBeenCalled()
    expect(activeSocket.destroy).toHaveBeenCalledOnce()
  })

  it('propagates listen failures', async () => {
    mocks.app.listen.mockRejectedValue(new Error('address in use'))

    await expect(startWebServer({
      config: { web: { port: 3000 } },
    } as unknown as Gateway)).rejects.toThrow('address in use')
    expect(mocks.app.close).toHaveBeenCalledOnce()
  })

  it('closes partially initialized servers when transport registration fails', async () => {
    mocks.app.register.mockRejectedValueOnce(new Error('plugin failed'))

    await expect(startWebServer({
      config: { web: { port: 3000 } },
    } as unknown as Gateway)).rejects.toThrow('plugin failed')
    expect(mocks.app.listen).not.toHaveBeenCalled()
    expect(mocks.app.close).toHaveBeenCalledOnce()
  })

  it('preserves listen failures when cleanup also fails', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    mocks.app.listen.mockRejectedValue(new Error('address in use'))
    mocks.app.close.mockRejectedValue(new Error('close failed'))

    await expect(startWebServer({
      config: { web: { port: 3000 } },
    } as unknown as Gateway)).rejects.toThrow('address in use')
    expect(error).toHaveBeenCalledWith(
      'Failed to clean up web server after startup error',
      expect.objectContaining({ message: 'close failed' }),
    )
  })
})
