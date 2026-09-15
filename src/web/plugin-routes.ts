import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Buffer } from 'node:buffer'
import type { PluginCapabilities } from '../plugins/capabilities.js'
import type { PluginHttpRequest, PluginHttpResponse, PluginLogger } from '../plugins/types.js'
import { toError } from '../utils/errors.js'

/** Hard ceiling for any plugin request body, enforced by Fastify before the plugin sees it. */
export const PLUGIN_ROUTE_BODY_LIMIT_BYTES = 1024 * 1024

/**
 * True when the request targets a plugin route that authenticates itself.
 * Such routes bypass the dashboard session cookie and host allowlist, and must
 * verify their own signature/token (see `extensions/webhook`).
 */
export function isSelfAuthenticatingPluginRoute(
  capabilities: PluginCapabilities,
  method: string,
  path: string,
): boolean {
  const match = capabilities.matchRoute(method, path)
  return match?.route.auth === 'plugin'
}

export function toPluginRequest(request: FastifyRequest, rawBody: string): PluginHttpRequest {
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries((request.query ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string')
      query[key] = value
  }
  return {
    method: request.method.toUpperCase(),
    path: request.url.split('?')[0] as string,
    headers: request.headers as Record<string, string | string[] | undefined>,
    rawBody,
    query,
    remoteAddress: request.ip ?? null,
  }
}

function applyResponse(reply: FastifyReply, response: PluginHttpResponse): string {
  reply.status(response.status)
  if (response.headers)
    reply.headers(response.headers)
  return response.body ?? ''
}

/**
 * Mount every `registerHttpRoute` capability declared by loaded plugins.
 *
 * Routes are registered inside an encapsulated Fastify context so the raw-body
 * content type parser needed for signature verification does not leak into the
 * dashboard API (which relies on JSON body parsing).
 */
export function registerPluginRoutes(
  app: FastifyInstance,
  capabilities: PluginCapabilities,
  logger: PluginLogger,
): void {
  const routes = capabilities.listRoutes()
  if (routes.length === 0)
    return

  void app.register(async (instance) => {
    // Signature verification needs the exact bytes the sender signed, so drop
    // every built-in parser and keep the body as a raw UTF-8 string.
    instance.removeAllContentTypeParsers()
    instance.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, (body as Buffer).toString('utf-8'))
    })

    for (const { pluginId, route } of routes) {
      const method = route.method ?? 'POST'
      const url = route.match === 'prefix' ? `${route.path}*` : route.path
      instance.route({
        method,
        url,
        bodyLimit: PLUGIN_ROUTE_BODY_LIMIT_BYTES,
        handler: async (request, reply) => {
          const rawBody = typeof request.body === 'string' ? request.body : ''
          let response: PluginHttpResponse
          try {
            response = await route.handler(toPluginRequest(request, rawBody))
          }
          catch (error) {
            logger.error(`Plugin route ${method} ${route.path} (${pluginId}) threw: ${toError(error).message}`)
            response = {
              status: 500,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ error: 'Internal plugin error' }),
            }
          }
          return applyResponse(reply, response)
        },
      })
      logger.debug(`Mounted plugin route ${method} ${url} (${pluginId})`)
    }
  })
}
