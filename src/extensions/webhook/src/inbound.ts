import type {
  PluginHttpHandler,
  PluginHttpResponse,
  PluginLogger,
  PluginRuntime,
} from '../../../plugin-sdk/index.js'
import type { InboundCommand, WebhookInboundConfig } from './config.js'
import { Buffer } from 'node:buffer'
import { readHeader } from '../../../plugin-sdk/index.js'
import { toError } from '../../../utils/errors.js'
import { sanitizeBoundedText } from '../../../utils/logger.js'
import { verifySignature } from './signature.js'

export interface InboundHandlerOptions {
  inbound: WebhookInboundConfig
  runtime: PluginRuntime
  logger: PluginLogger
}

function json(status: number, body: unknown): PluginHttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

interface InboundPayload {
  command?: unknown
  routine?: unknown
  tasks?: unknown
  limit?: unknown
}

/**
 * Authenticated inbound webhook.
 *
 * Only fixed verbs are accepted — free text is never mapped to task ids, so a
 * leaked secret cannot be turned into arbitrary prompt execution.
 */
export function createWebhookInboundHandler(options: InboundHandlerOptions): PluginHttpHandler {
  const { inbound, runtime, logger } = options
  const allowed = new Set<InboundCommand>(inbound.commands)

  return async (request) => {
    if (request.method.toUpperCase() !== 'POST')
      return json(405, { error: 'Method not allowed' })

    const contentLength = readHeader(request.headers, 'content-length')
    if (typeof contentLength === 'string') {
      const declared = Number(contentLength)
      if (Number.isFinite(declared) && declared > inbound.maxBodyBytes)
        return json(413, { error: 'Payload too large' })
    }
    if (Buffer.byteLength(request.rawBody, 'utf-8') > inbound.maxBodyBytes)
      return json(413, { error: 'Payload too large' })

    if (!verifySignature(inbound.secret, request.rawBody, readHeader(request.headers, 'x-giclaw-signature'))) {
      logger.warn(`Inbound webhook rejected: invalid signature (remote=${request.remoteAddress ?? 'unknown'})`)
      return json(401, { error: 'Invalid signature' })
    }

    let payload: InboundPayload
    try {
      payload = JSON.parse(request.rawBody) as InboundPayload
    }
    catch {
      return json(400, { error: 'Body must be valid JSON' })
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
      return json(400, { error: 'Body must be a JSON object' })

    const command = payload.command
    if (typeof command !== 'string' || !allowed.has(command as InboundCommand))
      return json(400, { error: `command must be one of: ${inbound.commands.join(', ')}` })

    try {
      if (command === 'status')
        return json(200, { ok: true, command, snapshot: runtime.gateway.getSnapshot() })

      if (command === 'history') {
        const rawLimit = payload.limit === undefined ? 20 : Number(payload.limit)
        if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100)
          return json(400, { error: 'limit must be an integer between 1 and 100' })
        return json(200, { ok: true, command, history: await runtime.gateway.getRunHistory(rawLimit) })
      }

      const resolved = resolveRunTarget(runtime, payload)
      if ('error' in resolved)
        return json(400, { error: resolved.error })
      logger.info(`Inbound webhook triggering run: ${resolved.description}`)
      const result = await runtime.gateway.enqueueRun(resolved.taskIds)
      return json(200, {
        ok: true,
        command,
        runId: null,
        results: result.results.map(item => ({
          taskId: item.taskId,
          success: item.success,
          message: sanitizeBoundedText(item.message),
          durationMs: item.durationMs,
        })),
      })
    }
    catch (error) {
      const message = sanitizeBoundedText(toError(error).message)
      logger.warn(`Inbound webhook command "${command}" failed: ${message}`)
      return json(500, { error: message })
    }
  }
}

type ResolvedRunTarget
  = | { taskIds: string[] | undefined, description: string }
    | { error: string }

function resolveRunTarget(runtime: PluginRuntime, payload: InboundPayload): ResolvedRunTarget {
  if (payload.routine !== undefined) {
    if (typeof payload.routine !== 'string' || payload.routine.length === 0)
      return { error: 'routine must be a non-empty string' }
    const taskIds = runtime.gateway.resolveRoutine(payload.routine)
    if (!taskIds)
      return { error: `Unknown routine "${sanitizeBoundedText(payload.routine, 100)}"` }
    return { taskIds, description: `routine=${payload.routine}` }
  }

  if (payload.tasks !== undefined) {
    if (!Array.isArray(payload.tasks) || payload.tasks.length === 0)
      return { error: 'tasks must be a non-empty array of task ids' }
    const taskIds: string[] = []
    for (const task of payload.tasks) {
      if (typeof task !== 'string' || task.length === 0)
        return { error: 'tasks must be a non-empty array of task ids' }
      taskIds.push(task)
    }
    return { taskIds, description: `tasks=${taskIds.join(',')}` }
  }

  return { taskIds: undefined, description: 'configured defaults' }
}
