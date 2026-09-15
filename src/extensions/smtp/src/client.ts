import type { Duplex } from 'node:stream'
import type { ConnectionOptions } from 'node:tls'
import { Buffer } from 'node:buffer'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { dotStuff } from './message.js'

/**
 * Minimal SMTP client.
 *
 * This is a Giclaw addition: openclaw integrates mail inbound-only (IMAP), so
 * notification mail needs a small outbound transport. Only the subset Giclaw
 * needs is implemented — `EHLO`, optional `STARTTLS`, `AUTH PLAIN`/`AUTH LOGIN`,
 * `MAIL FROM`, `RCPT TO`, `DATA` and `QUIT`.
 */

export const DEFAULT_SMTP_TIMEOUT_MS = 15_000

export type SmtpSecurity = 'starttls' | 'implicit' | 'none'

export interface SmtpDeliveryOptions {
  host: string
  port: number
  secure: SmtpSecurity
  timeoutMs: number
  rejectUnauthorized: boolean
  clientName: string
  user?: string
  password?: string
}

export interface SmtpEnvelope {
  from: string
  to: string[]
  /** Full RFC 5322 message, as produced by `buildMimeMessage`. */
  data: string
}

export interface SmtpReply {
  code: number
  message: string
  /** Reply text per line, with the status code and separator stripped. */
  lines: string[]
}

export interface SmtpCapabilities {
  names: Set<string>
  auth: string[]
}

export interface SmtpTransport {
  connect: (options: SmtpDeliveryOptions) => Duplex | Promise<Duplex>
  upgrade: (socket: Duplex, options: SmtpDeliveryOptions) => Duplex | Promise<Duplex>
}

export interface SmtpTransportOverrides {
  tcp?: (options: { host: string, port: number }) => Duplex
  tls?: (options: ConnectionOptions) => Duplex
}

export class SmtpError extends Error {
  readonly code: number
  readonly retryable: boolean

  constructor(message: string, code: number, retryable: boolean) {
    super(message)
    this.name = 'SmtpError'
    this.code = code
    this.retryable = retryable
  }
}

/** 4xx replies are transient per RFC 5321; 5xx are permanent. */
export function isRetryableReply(code: number): boolean {
  return code >= 400 && code < 500
}

/** Real transport: TCP for plain/STARTTLS, implicit TLS for `secure: 'implicit'`. */
export function createNodeSmtpTransport(overrides: SmtpTransportOverrides = {}): SmtpTransport {
  const tcp = overrides.tcp ?? ((options: { host: string, port: number }) => netConnect(options))
  const tls = overrides.tls ?? ((options: ConnectionOptions) => tlsConnect(options))

  return {
    connect: options => options.secure === 'implicit'
      ? tls({
          host: options.host,
          port: options.port,
          servername: options.host,
          rejectUnauthorized: options.rejectUnauthorized,
        })
      : tcp({ host: options.host, port: options.port }),
    upgrade: (socket, options) => tls({
      socket,
      servername: options.host,
      rejectUnauthorized: options.rejectUnauthorized,
    }),
  }
}

interface SmtpWaiter {
  resolve: (lines: string[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Line-oriented SMTP conversation over any duplex stream. */
export class SmtpConnection {
  private socket: Duplex
  private buffer = ''
  private current: string[] = []
  private completed: string[][] = []
  private waiters: SmtpWaiter[] = []
  private failure: Error | undefined
  private closed = false

  constructor(socket: Duplex, private readonly timeoutMs: number) {
    this.socket = socket
    this.attach(socket)
  }

  /** Connect and consume the server greeting. */
  static async open(transport: SmtpTransport, options: SmtpDeliveryOptions): Promise<SmtpConnection> {
    const socket = await transport.connect(options)
    const connection = new SmtpConnection(socket, options.timeoutMs)
    try {
      await connection.expect([220], 'SMTP greeting')
      return connection
    }
    catch (error) {
      connection.close()
      throw error
    }
  }

  async command(line: string, expected: number[], label: string): Promise<SmtpReply> {
    this.socket.write(`${line}\r\n`)
    return this.expect(expected, label)
  }

  async expect(expected: number[], label: string): Promise<SmtpReply> {
    const reply = await this.readReply()
    if (!expected.includes(reply.code))
      throw new SmtpError(`${label} failed: ${reply.code} ${reply.message}`, reply.code, isRetryableReply(reply.code))
    return reply
  }

  /** Terminate the body with `CRLF . CRLF`. */
  async data(payload: string): Promise<void> {
    this.socket.write(`${dotStuff(payload)}\r\n.\r\n`)
    await this.expect([250], 'Message body')
  }

  async upgrade(transport: SmtpTransport, options: SmtpDeliveryOptions): Promise<void> {
    const socket = await transport.upgrade(this.socket, options)
    this.detach(this.socket)
    this.socket = socket
    this.buffer = ''
    this.attach(socket)
  }

  close(): void {
    this.closed = true
    this.socket.destroy()
  }

  private attach(socket: Duplex): void {
    socket.setEncoding('utf-8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      this.drain()
    })
    socket.on('error', (error: Error) => this.fail(error))
    socket.on('close', () => this.fail(new SmtpError('SMTP connection closed unexpectedly', 0, true)))
  }

  private detach(socket: Duplex): void {
    socket.removeAllListeners('data')
    socket.removeAllListeners('error')
    socket.removeAllListeners('close')
  }

  private drain(): void {
    let index = this.buffer.indexOf('\r\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      if (!/^\d{3}[ -]/u.test(line)) {
        this.fail(new SmtpError(`Unexpected SMTP response: ${line}`, 0, false))
        return
      }
      this.current.push(line)
      if (line[3] === ' ') {
        this.completed.push(this.current)
        this.current = []
        this.flush()
      }
      index = this.buffer.indexOf('\r\n')
    }
  }

  private flush(): void {
    while (this.completed.length > 0 && this.waiters.length > 0) {
      const waiter = this.waiters.shift() as SmtpWaiter
      const lines = this.completed.shift() as string[]
      clearTimeout(waiter.timer)
      waiter.resolve(lines)
    }
  }

  private fail(error: Error): void {
    if (this.closed)
      return
    this.failure ??= error
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  private readReply(): Promise<SmtpReply> {
    return this.readReplyLines().then((lines) => {
      const first = lines[0] as string
      return {
        code: Number(first.slice(0, 3)),
        message: lines.map(line => line.slice(4)).join(' '),
        lines: lines.map(line => line.slice(4)),
      }
    })
  }

  private readReplyLines(): Promise<string[]> {
    const buffered = this.completed.shift()
    if (buffered)
      return Promise.resolve(buffered)
    if (this.failure)
      return Promise.reject(this.failure)

    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter.timer !== timer)
        reject(new SmtpError(`SMTP server did not respond within ${this.timeoutMs}ms`, 0, true))
      }, this.timeoutMs)
      timer.unref?.()
      this.waiters.push({ resolve, reject, timer })
    })
  }
}

/** Split a multi-line `EHLO` reply into capability names and AUTH mechanisms. */
export function parseCapabilities(lines: string[]): SmtpCapabilities {
  const names = new Set<string>()
  const auth: string[] = []

  for (const line of lines) {
    const [name, ...rest] = line.trim().split(/\s+/u)
    if (!name)
      continue
    names.add(name.toUpperCase())
    if (name.toUpperCase() === 'AUTH')
      auth.push(...rest.map(mechanism => mechanism.toUpperCase()))
  }

  return { names, auth }
}

async function authenticate(
  connection: SmtpConnection,
  capabilities: SmtpCapabilities,
  user: string,
  password: string,
): Promise<void> {
  if (capabilities.auth.includes('PLAIN')) {
    const credentials = Buffer.from(`\0${user}\0${password}`, 'utf-8').toString('base64')
    await connection.command(`AUTH PLAIN ${credentials}`, [235], 'AUTH PLAIN')
    return
  }

  if (capabilities.auth.includes('LOGIN')) {
    await connection.command('AUTH LOGIN', [334], 'AUTH LOGIN')
    await connection.command(Buffer.from(user, 'utf-8').toString('base64'), [334], 'AUTH username')
    await connection.command(Buffer.from(password, 'utf-8').toString('base64'), [235], 'AUTH password')
    return
  }

  throw new SmtpError('SMTP server advertises no supported authentication mechanism', 0, false)
}

export async function deliverMail(
  options: SmtpDeliveryOptions,
  envelope: SmtpEnvelope,
  transport: SmtpTransport = createNodeSmtpTransport(),
): Promise<void> {
  const connection = await SmtpConnection.open(transport, options)

  try {
    let capabilities = parseCapabilities((await connection.command(`EHLO ${options.clientName}`, [250], 'EHLO')).lines)

    if (options.secure === 'starttls') {
      if (!capabilities.names.has('STARTTLS'))
        throw new SmtpError('SMTP server does not advertise STARTTLS', 0, false)
      await connection.command('STARTTLS', [220], 'STARTTLS')
      await connection.upgrade(transport, options)
      capabilities = parseCapabilities((await connection.command(`EHLO ${options.clientName}`, [250], 'EHLO')).lines)
    }

    if (options.user !== undefined)
      await authenticate(connection, capabilities, options.user, options.password ?? '')

    await connection.command(`MAIL FROM:<${envelope.from}>`, [250], 'MAIL FROM')
    for (const recipient of envelope.to)
      await connection.command(`RCPT TO:<${recipient}>`, [250, 251], 'RCPT TO')

    await connection.command('DATA', [354], 'DATA')
    await connection.data(envelope.data)
    await connection.command('QUIT', [221], 'QUIT')
  }
  finally {
    connection.close()
  }
}
