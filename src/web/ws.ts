import type { FastifyInstance } from 'fastify'
import type { Gateway } from '../gateway/gateway.js'
import type { LogEntry } from '../utils/logger.js'
import type { ProgressEvent } from '../utils/progress.js'
import { logger } from '../utils/logger.js'

export function registerWebSocket(app: FastifyInstance, gateway: Gateway): void {
  // Circular buffer for recent logs
  const LOG_BUFFER_SIZE = 500
  const logBuffer: LogEntry[] = []

  logger.on('log', (entry: LogEntry) => {
    logBuffer.push(entry)
    if (logBuffer.length > LOG_BUFFER_SIZE) {
      logBuffer.shift()
    }
  })

  app.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (socket) => {
      // Send current snapshot on connect
      try {
        socket.send(JSON.stringify({ type: 'snapshot', data: gateway.getSnapshot() }))
      }
      catch {
        // Client disconnected
      }

      // Send recent logs on connect
      for (const entry of logBuffer) {
        socket.send(JSON.stringify({ type: 'log', data: entry }))
      }

      // Forward new log entries
      const onLog = (entry: LogEntry) => {
        try {
          socket.send(JSON.stringify({ type: 'log', data: entry }))
        }
        catch {
          // Client disconnected
        }
      }

      // Forward progress events
      const onProgress = (event: ProgressEvent) => {
        try {
          socket.send(JSON.stringify({ type: 'progress', data: event }))
        }
        catch {
          // Client disconnected
        }
      }

      logger.on('log', onLog)
      logger.on('progress', onProgress)

      // Heartbeat
      const heartbeat = setInterval(() => {
        try {
          socket.send(JSON.stringify({ type: 'status', data: { alive: true } }))
        }
        catch {
          clearInterval(heartbeat)
        }
      }, 30_000)

      socket.on('close', () => {
        logger.removeListener('log', onLog)
        logger.removeListener('progress', onProgress)
        clearInterval(heartbeat)
      })
    })
  })
}
