import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const WEB_SESSION_COOKIE = 'giclaw_session'

const PROCESS_SESSION_TOKEN = randomBytes(32).toString('base64url')

function hasSessionCookie(cookieHeader: string | undefined, sessionToken: string): boolean {
  if (!cookieHeader)
    return false

  const expected = Buffer.from(sessionToken)
  return cookieHeader.split(';').some((part) => {
    const [name, ...valueParts] = part.trim().split('=')
    if (name !== WEB_SESSION_COOKIE)
      return false
    const actual = Buffer.from(valueParts.join('='))
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  })
}

function setSecurityHeaders(reply: FastifyReply, port: number): void {
  reply.headers({
    'cache-control': 'no-store',
    'content-security-policy': [
      `default-src 'self'`,
      `base-uri 'none'`,
      `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
      `frame-ancestors 'none'`,
      `form-action 'none'`,
      `img-src 'self' data:`,
      `object-src 'none'`,
      `script-src 'self'`,
      `style-src 'self'`,
    ].join('; '),
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), geolocation=(), microphone=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  })
}

function requestPath(request: FastifyRequest): string {
  return request.url.split('?')[0] as string
}

function isProtectedPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/') || path === '/ws'
}

export interface WebSecurityOptions {
  /**
   * Returns true for plugin routes that verify their own credentials.
   * Those routes skip the dashboard session cookie and the host allowlist
   * because their callers are remote services, not the local dashboard.
   */
  isSelfAuthenticating?: (method: string, path: string) => boolean
}

export function registerWebSecurity(
  app: FastifyInstance,
  port: number,
  sessionToken = PROCESS_SESSION_TOKEN,
  options: WebSecurityOptions = {},
): void {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

  app.addHook('onRequest', async (request, reply) => {
    setSecurityHeaders(reply, port)

    const path = requestPath(request)
    const selfAuthenticating = options.isSelfAuthenticating?.(request.method, path) === true

    const host = request.headers.host?.toLowerCase()
    if (!selfAuthenticating && (!host || !allowedHosts.has(host))) {
      return reply.status(403).send({ error: 'Forbidden host' })
    }

    const origin = request.headers.origin?.toLowerCase()
    if (!selfAuthenticating && origin && origin !== `http://${host}`) {
      return reply.status(403).send({ error: 'Forbidden origin' })
    }

    if (!selfAuthenticating && isProtectedPath(path) && !hasSessionCookie(request.headers.cookie, sessionToken)) {
      return reply.status(401).send({ error: 'Authentication required' })
    }

    if (path === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      reply.header(
        'set-cookie',
        `${WEB_SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
      )
    }
  })
}
