import type { FastifyInstance } from 'fastify'
import type { Gateway } from '../gateway/gateway.js'

export function registerApi(app: FastifyInstance, gateway: Gateway): void {
  const config = gateway.config

  // GET /api/status
  app.get('/api/status', async () => {
    const snapshot = gateway.getSnapshot()
    const history = await gateway.getRunHistory(1)
    const lastRun = history.at(-1)

    return {
      running: snapshot.running,
      queueDepth: snapshot.queueDepth,
      lastRun: lastRun
        ? {
            startedAt: lastRun.startedAt,
            completedAt: lastRun.completedAt,
            results: lastRun.results,
          }
        : null,
      schedule: config.schedule,
    }
  })

  // GET /api/tasks
  app.get('/api/tasks', async () => {
    return gateway.getSkillSummaries()
  })

  // GET /api/config
  app.get('/api/config', async () => {
    return {
      ...config,
      model: {
        ...config.model,
        apiKey: config.model.apiKey ? '***' : '',
      },
    }
  })

  // GET /api/history
  app.get('/api/history', async (request) => {
    const query = request.query as { limit?: string }
    const limit = query.limit ? Number(query.limit) : 20
    return gateway.getRunHistory(limit)
  })

  // POST /api/run
  app.post('/api/run', async (_request, reply) => {
    const snapshot = gateway.getSnapshot()
    if (snapshot.running) {
      // Queue instead of reject
      gateway.enqueueRun('api').catch(() => {})
      return reply.status(202).send({ status: 'queued' })
    }

    gateway.enqueueRun('api').catch(() => {})
    return { status: 'started' }
  })
}
