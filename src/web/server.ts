import type { Gateway } from '../gateway/gateway.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import fastifyWebSocket from '@fastify/websocket'
import Fastify from 'fastify'
import { logger } from '../utils/logger.js'
import { registerApi } from './api.js'
import { registerWebSocket } from './ws.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function startWebServer(gateway: Gateway): Promise<void> {
  const app = Fastify({ logger: false })

  await app.register(fastifyWebSocket)

  await app.register(fastifyStatic, {
    root: resolve(__dirname, 'public'),
    prefix: '/',
  })

  registerApi(app, gateway)
  registerWebSocket(app, gateway)

  const port = gateway.config.web.port
  await app.listen({ port, host: '0.0.0.0' })
  logger.info(`Web panel running at http://localhost:${port}`)
}
