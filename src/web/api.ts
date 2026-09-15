import type { FastifyInstance } from 'fastify'
import type { Gateway } from '../gateway/gateway.js'
import type { TaskDefinition } from '../tasks/base-task.js'
import type { WebPluginBridge } from './server.js'
import { QueueError } from '../utils/errors.js'
import { logger, sanitizeBoundedText } from '../utils/logger.js'

export function registerApi(
  app: FastifyInstance,
  gateway: Gateway,
  plugins?: WebPluginBridge,
): void {
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

  // GET /api/plugins
  app.get('/api/plugins', async () => {
    return plugins ? plugins.host.getStatus() : []
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
  app.get('/api/history', async (request, reply) => {
    const query = request.query as { limit?: string }
    const limit = query.limit ? Number(query.limit) : 20
    if (!Number.isInteger(limit) || limit < 1) {
      return reply.status(400).send({ error: 'limit must be a positive integer' })
    }
    return gateway.getRunHistory(limit)
  })

  // POST /api/run
  app.post('/api/run', async (request, reply) => {
    const body = request.body === undefined ? {} : request.body
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({ error: 'Request body must be an object' })
    }
    const { tasks, routine } = body as { tasks?: unknown, routine?: unknown }
    if (
      tasks !== undefined
      && (!Array.isArray(tasks) || tasks.length === 0 || tasks.some(id => typeof id !== 'string' || id.length === 0))
    ) {
      return reply.status(400).send({ error: 'tasks must be a non-empty array of task IDs' })
    }
    if (routine !== undefined && (typeof routine !== 'string' || routine.length === 0)) {
      return reply.status(400).send({ error: 'routine must be a non-empty string' })
    }
    if (tasks && routine) {
      return reply.status(400).send({ error: 'Use either tasks or routine, not both' })
    }

    let taskIds = tasks as string[] | undefined
    if (routine) {
      taskIds = config.tasks.routines[routine as string]
      if (!taskIds) {
        return reply.status(400).send({
          error: `Unknown routine "${routine as string}"`,
          availableRoutines: Object.keys(config.tasks.routines),
        })
      }
    }
    let enabledTasks: TaskDefinition[]
    try {
      enabledTasks = gateway.getTaskRunner().getEnabledTasks(taskIds ?? config.tasks.enabled)
    }
    catch (err) {
      const message = sanitizeBoundedText(err instanceof Error ? err.message : String(err))
      return reply.status(400).send({ error: message })
    }

    let receipt
    try {
      receipt = gateway.enqueueRunAccepted('api', taskIds)
    }
    catch (error) {
      if (error instanceof QueueError && error.message.startsWith('Queue is full')) {
        return reply.status(429).send({
          error: `Queue is full (${config.queue.maxDepth}/${config.queue.maxDepth})`,
        })
      }
      if (error instanceof QueueError)
        return reply.status(503).send({ error: 'Queue is not accepting work' })
      throw error
    }

    receipt.completion.catch((err) => {
      logger.error('API-triggered run failed', err)
    })
    return reply.status(receipt.status === 'queued' ? 202 : 200).send({
      status: receipt.status,
      tasks: enabledTasks.map(task => task.id),
    })
  })
}
