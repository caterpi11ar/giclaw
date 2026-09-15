import type { Socket } from 'node:net'
import type { Gateway } from '../gateway/gateway.js'
import type { PluginCapabilities } from '../plugins/capabilities.js'
import type { PluginHost } from '../plugins/host.js'
import type { PluginLogger } from '../plugins/types.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import fastifyWebSocket from '@fastify/websocket'
import Fastify from 'fastify'
import { logger } from '../utils/logger.js'
import { registerApi } from './api.js'
import { isSelfAuthenticatingPluginRoute, registerPluginRoutes } from './plugin-routes.js'
import { registerWebSecurity } from './security.js'
import { registerWebSocket } from './ws.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const MAX_WEB_SOCKET_PAYLOAD_BYTES = 64 * 1024

/** Plugin bridge handed to the web layer so inbound plugin routes can be mounted. */
export interface WebPluginBridge {
  capabilities: PluginCapabilities
  logger: PluginLogger
  host: PluginHost
}

export interface WebServerHandle {
  close: () => Promise<void>
}

export async function startWebServer(
  gateway: Gateway,
  plugins?: WebPluginBridge,
): Promise<WebServerHandle> {
  const app = Fastify({
    logger: false,
    // Daemon shutdown already stops accepting work before closing transports.
    // Force any stale keep-alive or upgraded socket closed so app.close()
    // cannot wait forever on a disconnected dashboard client.
    forceCloseConnections: true,
  })
  const port = gateway.config.web.port
  const sockets = new Set<Socket>()
  const onConnection = (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  }
  app.server.on('connection', onConnection)
  let closePromise: Promise<void> | undefined
  const handle: WebServerHandle = {
    close: () => {
      if (!closePromise) {
        closePromise = app.close()
        app.server.removeListener('connection', onConnection)
        // Rejected WebSocket upgrades are raw TCP sockets and are not always
        // retained by Fastify's normal connection tracker. Destroy every
        // socket owned by this server so shutdown remains bounded.
        for (const socket of sockets)
          socket.destroy()
        sockets.clear()
      }
      return closePromise
    },
  }

  try {
    if (plugins) {
      registerWebSecurity(app, port, undefined, {
        isSelfAuthenticating: (method, path) => isSelfAuthenticatingPluginRoute(plugins.capabilities, method, path),
      })
    }
    else {
      registerWebSecurity(app, port)
    }

    await app.register(fastifyWebSocket, {
      options: { maxPayload: MAX_WEB_SOCKET_PAYLOAD_BYTES },
      preClose(done) {
        // The plugin's default uses a graceful WebSocket close handshake,
        // which can wait forever for a suspended or non-cooperative client.
        // Daemon shutdown needs a hard transport boundary.
        for (const client of this.websocketServer.clients)
          client.terminate()
        this.websocketServer.close(done)
      },
    })

    await app.register(fastifyStatic, {
      root: resolve(__dirname, 'public'),
      prefix: '/',
    })

    if (plugins) {
      registerApi(app, gateway, plugins)
      registerPluginRoutes(app, plugins.capabilities, plugins.logger)
    }
    else {
      registerApi(app, gateway)
    }
    registerWebSocket(app, gateway)

    await app.listen({ port, host: '127.0.0.1' })
  }
  catch (error) {
    try {
      await handle.close()
    }
    catch (closeError) {
      logger.error('Failed to clean up web server after startup error', closeError)
    }
    throw error
  }
  logger.info(`Web panel running at http://127.0.0.1:${port}`)
  return handle
}
