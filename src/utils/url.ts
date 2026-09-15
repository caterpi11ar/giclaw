/**
 * Outbound URL policy shared by configuration and plugins.
 *
 * Giclaw only talks to HTTPS endpoints, with a loopback HTTP escape hatch for
 * local development. Credentials are never allowed to travel inside a URL.
 */
export function isHttpsOrLoopbackHttp(value: string): boolean {
  if (value === '')
    return true

  if (value !== value.trim() || !/^https?:\/\//iu.test(value))
    return false

  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  }
  catch {
    return false
  }
}

export function hasNoUrlCredentials(value: string): boolean {
  if (value === '')
    return true

  try {
    const url = new URL(value)
    const authority = value.slice(value.indexOf('://') + 3).split(/[/?#]/u, 1)[0]!
    return !authority.includes('@') && !url.username && !url.password
  }
  catch {
    return false
  }
}
