import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import fastifyWebSocket from '@fastify/websocket'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerWebSecurity, WEB_SESSION_COOKIE } from './security.js'

const PORT = 3000
const TOKEN = 'test-session-token-with-fixed-length'
const HOST = `127.0.0.1:${PORT}`
const ORIGIN = `http://${HOST}`

describe('web security integration', () => {
  const apps: ReturnType<typeof Fastify>[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
  })

  async function buildApp(sessionToken?: string) {
    const app = Fastify()
    apps.push(app)
    if (sessionToken === undefined)
      registerWebSecurity(app, PORT)
    else
      registerWebSecurity(app, PORT, sessionToken)
    await app.register(fastifyWebSocket)
    app.get('/', async () => ({ ready: true }))
    app.get('/asset.js', async () => 'asset')
    app.get('/api/status', async () => ({ running: false }))
    app.get('/ws', { websocket: true }, socket => socket.send('connected'))
    await app.ready()
    return app
  }

  async function buildSelfAuthenticatingApp() {
    const app = Fastify()
    apps.push(app)
    registerWebSecurity(app, PORT, TOKEN, {
      isSelfAuthenticating: (method, path) => method === 'POST' && path === '/api/ext/webhook',
    })
    app.post('/api/ext/webhook', async () => ({ accepted: true }))
    app.post('/api/status', async () => ({ accepted: true }))
    await app.ready()
    return app
  }

  async function authenticatedCookie(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: HOST, origin: ORIGIN },
    })
    expect(response.statusCode).toBe(200)
    return response.headers['set-cookie'] as string
  }

  it('issues an HttpOnly strict session cookie and applies defensive headers', async () => {
    const app = await buildApp(TOKEN)
    const response = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } })

    expect(response.headers['set-cookie']).toBe(
      `${WEB_SESSION_COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`,
    )
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'camera=(), geolocation=(), microphone=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })
    expect(response.headers['content-security-policy']).toContain(`script-src 'self'`)
    expect(response.headers['content-security-policy']).toContain(`style-src 'self'`)
    expect(response.headers['content-security-policy']).toContain(`frame-ancestors 'none'`)
    expect(response.headers['content-security-policy']).toContain(`ws://127.0.0.1:${PORT}`)

    const head = await app.inject({ method: 'HEAD', url: '/', headers: { host: HOST } })
    expect(head.headers['set-cookie']).toContain(`${WEB_SESSION_COOKIE}=`)
    const post = await app.inject({ method: 'POST', url: '/', headers: { host: HOST } })
    expect(post.headers['set-cookie']).toBeUndefined()
  })

  it('lets self-authenticating plugin routes bypass host, origin and session checks', async () => {
    const app = await buildSelfAuthenticatingApp()

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/ext/webhook',
      headers: { host: 'evil.example.test', origin: 'https://evil.example.test' },
      payload: { command: 'status' },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toEqual({ accepted: true })

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/status',
      headers: { host: 'evil.example.test', origin: 'https://evil.example.test' },
      payload: {},
    })
    expect(rejected.statusCode).toBe(403)
    expect(rejected.json()).toEqual({ error: 'Forbidden host' })
  })

  it('uses a process-random token when no test token is provided', async () => {
    const app = await buildApp()
    const cookie = await authenticatedCookie(app)
    expect(cookie).toMatch(new RegExp(`^${WEB_SESSION_COOKIE}=[A-Za-z0-9_-]{43};`))
  })

  it.each([
    ['hostile host', { host: `evil.example:${PORT}` }, 403, 'Forbidden host'],
    ['host with the wrong port', { host: '127.0.0.1:3001' }, 403, 'Forbidden host'],
    ['cross-site origin', { host: HOST, origin: 'https://evil.example' }, 403, 'Forbidden origin'],
    ['different loopback origin', { host: HOST, origin: `http://localhost:${PORT}` }, 403, 'Forbidden origin'],
  ])('rejects %s', async (_name, headers, status, error) => {
    const app = await buildApp(TOKEN)
    const response = await app.inject({ method: 'GET', url: '/', headers })
    expect(response.statusCode).toBe(status)
    expect(response.json()).toEqual({ error })
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('accepts both exact loopback hosts and same-origin requests', async () => {
    const app = await buildApp(TOKEN)
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
      const response = await app.inject({
        method: 'GET',
        url: '/asset.js',
        headers: { host, origin: `http://${host}` },
      })
      expect(response.statusCode).toBe(200)
    }
  })

  it.each([
    ['no cookie', undefined],
    ['different cookie', 'other=value'],
    ['short token', `${WEB_SESSION_COOKIE}=bad`],
    ['same-length wrong token', `${WEB_SESSION_COOKIE}=${'x'.repeat(TOKEN.length)}`],
  ])('rejects protected API requests with %s', async (_name, cookie) => {
    const app = await buildApp(TOKEN)
    const response = await app.inject({
      method: 'GET',
      url: '/api/status?detail=1',
      headers: cookie ? { host: HOST, cookie } : { host: HOST },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'Authentication required' })
  })

  it('accepts an authenticated API request and rejects a hostile origin first', async () => {
    const app = await buildApp(TOKEN)
    const cookie = await authenticatedCookie(app)
    const accepted = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: HOST, origin: ORIGIN, cookie },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toEqual({ running: false })

    const rejected = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: HOST, origin: 'http://evil.example', cookie },
    })
    expect(rejected.statusCode).toBe(403)
  })

  it('authenticates real websocket upgrades and rejects invalid upgrade metadata', async () => {
    const app = await buildApp(TOKEN)
    const cookie = await authenticatedCookie(app)

    await expect(app.injectWS('/ws', { headers: { host: HOST } })).rejects.toThrow('401')
    await expect(app.injectWS('/ws', {
      headers: { host: HOST, cookie, origin: 'http://evil.example' },
    })).rejects.toThrow('403')
    await expect(app.injectWS('/ws', {
      headers: { host: `evil.example:${PORT}`, cookie },
    })).rejects.toThrow('403')

    const messages: string[] = []
    const socket = await app.injectWS('/ws', {
      headers: { host: HOST, origin: ORIGIN, cookie },
    }, {
      onInit: client => client.on('message', (data: { toString: () => string }) => messages.push(data.toString())),
    })
    await expect.poll(() => messages).toContain('connected')
    socket.terminate()
  })
})

describe('web public assets', () => {
  it('serves the local dashboard with its cookie and security policy', async () => {
    const app = Fastify()
    registerWebSecurity(app, PORT, TOKEN)
    await app.register(fastifyStatic, {
      root: fileURLToPath(new URL('./public/', import.meta.url)),
    })

    const response = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('<!DOCTYPE html>')
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict')
    expect(response.headers['content-security-policy']).toContain(`default-src 'self'`)
    await app.close()
  })

  it('uses only local assets and avoids HTML string injection sinks', async () => {
    const [html, script] = await Promise.all([
      readFile(new URL('./public/index.html', import.meta.url), 'utf8'),
      readFile(new URL('./public/app.js', import.meta.url), 'utf8'),
    ])

    expect(html).not.toMatch(/https?:\/\//u)
    expect(html).not.toMatch(/<script(?![^>]+\bsrc=)/iu)
    expect(html).not.toMatch(/\son[a-z]+=/iu)
    expect(html).toContain('src="/app.js"')
    expect(html).toContain('href="/app.css"')
    expect(script).not.toContain('innerHTML')
    expect(script).toContain('textContent')
    expect(script).toContain('replaceChildren')
    expect(script).toContain('MAX_RENDERED_LOGS')
    expect(script).toContain('firstElementChild.remove()')
  })
})
