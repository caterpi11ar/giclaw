import type { FastifyInstance } from 'fastify'
import type { ChannelPlugin, PluginHttpRequest, PluginLogger } from '../plugins/types.js'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginCapabilities } from '../plugins/capabilities.js'
import {
  isSelfAuthenticatingPluginRoute,
  PLUGIN_ROUTE_BODY_LIMIT_BYTES,
  registerPluginRoutes,
  toPluginRequest,
} from './plugin-routes.js'

const apps: FastifyInstance[] = []

function createLogger(): PluginLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

async function createApp(
  configure: (capabilities: PluginCapabilities) => void,
  logger: PluginLogger = createLogger(),
): Promise<FastifyInstance> {
  const app = Fastify()
  const capabilities = new PluginCapabilities()
  configure(capabilities)
  registerPluginRoutes(app, capabilities, logger)
  await app.ready()
  apps.push(app)
  return app
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
})

describe('plugin route bridge', () => {
  it('exports the body limit', () => {
    expect(PLUGIN_ROUTE_BODY_LIMIT_BYTES).toBe(1024 * 1024)
  })

  it('does nothing when no route is registered', async () => {
    const app = await createApp(() => {})
    expect(app.printRoutes()).not.toContain('/api/ext')
  })

  it('flags self-authenticating routes only', () => {
    const capabilities = new PluginCapabilities()
    capabilities.registerHttpRoute('webhook', {
      path: '/api/ext/webhook',
      auth: 'plugin',
      handler: () => ({ status: 200 }),
    })
    capabilities.registerHttpRoute('dashboard', {
      path: '/api/ext/dashboard',
      auth: 'loopback',
      handler: () => ({ status: 200 }),
    })

    expect(isSelfAuthenticatingPluginRoute(capabilities, 'POST', '/api/ext/webhook')).toBe(true)
    expect(isSelfAuthenticatingPluginRoute(capabilities, 'POST', '/api/ext/dashboard')).toBe(false)
    expect(isSelfAuthenticatingPluginRoute(capabilities, 'GET', '/api/ext/webhook')).toBe(false)
  })

  it('serves an exact route and passes the raw body through', async () => {
    const seen: PluginHttpRequest[] = []
    const app = await createApp((capabilities) => {
      capabilities.registerHttpRoute('webhook', {
        path: '/api/ext/webhook',
        auth: 'plugin',
        handler: (request) => {
          seen.push(request)
          return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }
        },
      })
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/ext/webhook?debug=1',
      payload: '{"command":"status"}',
      headers: { 'content-type': 'application/json' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.body).toBe('{"ok":true}')
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/api/ext/webhook',
      rawBody: '{"command":"status"}',
      query: { debug: '1' },
    })
  })

  it('returns an empty body when the handler omits one', async () => {
    const app = await createApp((capabilities) => {
      capabilities.registerHttpRoute('webhook', { path: '/api/ext/empty', handler: () => ({ status: 204 }) })
    })

    const response = await app.inject({ method: 'POST', url: '/api/ext/empty' })
    expect(response.statusCode).toBe(204)
    expect(response.body).toBe('')
  })

  it('serves prefix routes', async () => {
    const app = await createApp((capabilities) => {
      capabilities.registerHttpRoute('webhook', {
        path: '/api/ext/hook',
        match: 'prefix',
        handler: request => ({ status: 200, body: request.path }),
      })
    })

    const response = await app.inject({ method: 'POST', url: '/api/ext/hook/deep/path' })
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('/api/ext/hook/deep/path')
  })

  it('defaults the route method to POST', async () => {
    const app = await createApp((capabilities) => {
      capabilities.registerHttpRoute('webhook', { path: '/api/ext/default', handler: () => ({ status: 200 }) })
    })

    expect((await app.inject({ method: 'GET', url: '/api/ext/default' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/ext/default' })).statusCode).toBe(200)
  })

  it('honours an explicit GET method', async () => {
    const app = await createApp((capabilities) => {
      capabilities.registerHttpRoute('webhook', {
        path: '/api/ext/status',
        method: 'GET',
        handler: () => ({ status: 200, body: 'ready' }),
      })
    })

    expect((await app.inject({ method: 'GET', url: '/api/ext/status' })).body).toBe('ready')
  })

  it('turns a thrown handler into a 500 without leaking the error', async () => {
    const logger = createLogger()
    const app = await createApp((capabilities) => {
      capabilities.registerHttpRoute('webhook', {
        path: '/api/ext/boom',
        handler: () => {
          throw new Error('secret internal detail')
        },
      })
    }, logger)

    const response = await app.inject({ method: 'POST', url: '/api/ext/boom' })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: 'Internal plugin error' })
    expect(response.body).not.toContain('secret internal detail')
    expect(logger.error).toHaveBeenCalledWith(
      'Plugin route POST /api/ext/boom (webhook) threw: secret internal detail',
    )
  })

  it('rejects a body above the hard limit', async () => {
    const app = await createApp((capabilities) => {
      capabilities.registerHttpRoute('webhook', { path: '/api/ext/limit', handler: () => ({ status: 200 }) })
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/ext/limit',
      payload: 'x'.repeat(PLUGIN_ROUTE_BODY_LIMIT_BYTES + 1),
    })

    expect(response.statusCode).toBe(413)
  })

  it('mounts several routes from several plugins', async () => {
    const logger = createLogger()
    const app = await createApp((capabilities) => {
      capabilities.registerHttpRoute('a', { path: '/api/ext/a', handler: () => ({ status: 200, body: 'a' }) })
      capabilities.registerHttpRoute('b', { path: '/api/ext/b', handler: () => ({ status: 200, body: 'b' }) })
    }, logger)

    expect((await app.inject({ method: 'POST', url: '/api/ext/a' })).body).toBe('a')
    expect((await app.inject({ method: 'POST', url: '/api/ext/b' })).body).toBe('b')
    expect(logger.debug).toHaveBeenCalledWith('Mounted plugin route POST /api/ext/a (a)')
  })

  it('reports the plugin id on a channel capability', () => {
    const capabilities = new PluginCapabilities()
    const channel: ChannelPlugin = {
      id: 'webhook',
      meta: { label: 'Webhook' },
      outbound: { send: async () => ({ ok: true }) },
    }
    capabilities.registerChannel('webhook', channel)
    expect(capabilities.listChannels()[0]?.pluginId).toBe('webhook')
  })
})

describe('toPluginRequest', () => {
  it('normalizes a fastify request into a plugin request', () => {
    const request = toPluginRequest({
      method: 'post',
      url: '/api/ext/hook?a=1&b=2',
      headers: { 'x-giclaw-signature': 'sha256=abc' },
      query: { a: '1', b: 2, c: undefined },
      ip: '127.0.0.1',
    } as never, 'raw')

    expect(request).toEqual({
      method: 'POST',
      path: '/api/ext/hook',
      headers: { 'x-giclaw-signature': 'sha256=abc' },
      rawBody: 'raw',
      query: { a: '1' },
      remoteAddress: '127.0.0.1',
    })
  })

  it('falls back to a null remote address when fastify omits it', () => {
    const request = toPluginRequest({
      method: 'POST',
      url: '/x',
      headers: {},
      query: undefined,
    } as never, '')

    expect(request.remoteAddress).toBeNull()
    expect(request.query).toEqual({})
  })
})
