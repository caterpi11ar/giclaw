import type { AddressInfo } from 'node:net'
import type { SmtpDeliveryOptions, SmtpTransport } from './client.js'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:net'
import { Duplex } from 'node:stream'
import { TLSSocket } from 'node:tls'
import { describe, expect, it, vi } from 'vitest'
import {
  createNodeSmtpTransport,
  deliverMail,
  isRetryableReply,
  parseCapabilities,
  SmtpConnection,
  SmtpError,
} from './client.js'
import { buildMimeMessage } from './message.js'

const base: SmtpDeliveryOptions = {
  host: 'smtp.example.com',
  port: 587,
  secure: 'starttls',
  timeoutMs: 1_000,
  rejectUnauthorized: true,
  clientName: 'giclaw',
}

const envelope = {
  from: 'giclaw@example.com',
  to: ['ops@example.com'],
  data: buildMimeMessage({
    from: 'giclaw@example.com',
    to: ['ops@example.com'],
    subject: 'Run ok',
    text: 'all good',
    date: new Date('2026-01-01T00:00:00.000Z'),
  }),
}

/** Duplex whose `_write` hands each client command to a scripted responder. */
class ScriptedSocket extends Duplex {
  readonly written: string[] = []

  constructor(private readonly responder: (line: string, socket: ScriptedSocket) => string | undefined) {
    super()
  }

  _read(): void {}

  _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const line = String(chunk)
    this.written.push(line)
    const reply = this.responder(line, this)
    if (reply)
      this.push(reply)
    callback()
  }
}

interface ScriptedServer {
  /** Capability lines for the `EHLO` reply; `[]` answers with a bare `250`. */
  ehlo?: string[] | string
  starttls?: string
  authPlain?: string
  /** Replies for `AUTH LOGIN`, the username and the password, in order. */
  authLogin?: string[]
  mailFrom?: string
  rcptTo?: string
  data?: string
  body?: string
  quit?: string
}

/** Scripted SMTP server replies: a `STARTTLS` + `AUTH PLAIN LOGIN` EHLO by default. */
function buildResponder(script: ScriptedServer = {}): (line: string, socket?: ScriptedSocket) => string | undefined {
  const capabilities = script.ehlo ?? ['STARTTLS', 'AUTH PLAIN LOGIN']
  let loginStep = 0

  return (line) => {
    if (line.endsWith('\r\n.\r\n'))
      return script.body ?? '250 2.0.0 Ok: queued\r\n'

    const command = line.replace(/\r\n$/u, '')

    if (command.startsWith('EHLO')) {
      if (typeof capabilities === 'string')
        return capabilities
      if (capabilities.length === 0)
        return '250 2.0.0 scripted example\r\n'
      return `${[...capabilities.slice(0, -1).map(value => `250-${value}`), `250 ${capabilities.at(-1)}`].join('\r\n')}\r\n`
    }

    if (command === 'STARTTLS')
      return script.starttls ?? '220 2.0.0 ready to start TLS\r\n'
    if (command.startsWith('AUTH PLAIN'))
      return script.authPlain ?? '235 2.7.0 ok\r\n'
    if (command === 'AUTH LOGIN') {
      loginStep = 1
      return script.authLogin?.[0] ?? '334 VXNlcm5hbWU6\r\n'
    }
    if (loginStep === 1) {
      loginStep = 2
      return script.authLogin?.[1] ?? '334 UGFzc3dvcmQ6\r\n'
    }
    if (loginStep === 2) {
      loginStep = 3
      return script.authLogin?.[2] ?? '235 2.7.0 ok\r\n'
    }

    if (command.startsWith('MAIL FROM'))
      return script.mailFrom ?? '250 2.1.0 Ok\r\n'
    if (command.startsWith('RCPT TO'))
      return script.rcptTo ?? '250 2.1.5 Ok\r\n'
    if (command === 'DATA')
      return script.data ?? '354 End data with <CR><LF>.<CR><LF>\r\n'
    if (command === 'QUIT')
      return script.quit ?? '221 2.0.0 Bye\r\n'
    return '500 5.5.1 Command unrecognized\r\n'
  }
}

interface FakeTransportOptions {
  /** Extra bytes pushed before the client attaches its reader (the greeting). */
  prelude?: string
  reply: (line: string, socket: ScriptedSocket) => string | undefined
  upgrade?: { prelude?: string, reply?: (line: string, socket: ScriptedSocket) => string | undefined }
}

function fakeTransport(options: FakeTransportOptions): { transport: SmtpTransport, sockets: ScriptedSocket[] } {
  const sockets: ScriptedSocket[] = []

  const transport: SmtpTransport = {
    connect() {
      const socket = new ScriptedSocket(options.reply)
      if (options.prelude)
        socket.push(options.prelude)
      sockets.push(socket)
      return socket
    },
    upgrade() {
      const socket = new ScriptedSocket(options.upgrade?.reply ?? options.reply)
      const prelude = options.upgrade?.prelude
      if (prelude)
        socket.push(prelude)
      sockets.push(socket)
      return socket
    },
  }

  return { transport, sockets }
}

function delivered(sockets: ScriptedSocket[]): string[] {
  return sockets.flatMap(socket => socket.written)
}

describe('parseCapabilities', () => {
  it('collects capability names and AUTH mechanisms', () => {
    const capabilities = parseCapabilities(['scripted.example', 'STARTTLS', 'AUTH plain login', 'SIZE 1024'])

    expect([...capabilities.names]).toEqual(['SCRIPTED.EXAMPLE', 'STARTTLS', 'AUTH', 'SIZE'])
    expect(capabilities.auth).toEqual(['PLAIN', 'LOGIN'])
  })

  it('ignores blank lines', () => {
    expect([...parseCapabilities(['', '  ']).names]).toEqual([])
  })
})

describe('isRetryableReply', () => {
  it('treats 4xx as transient and 5xx as permanent', () => {
    expect(isRetryableReply(421)).toBe(true)
    expect(isRetryableReply(451)).toBe(true)
    expect(isRetryableReply(499)).toBe(true)
    expect(isRetryableReply(500)).toBe(false)
    expect(isRetryableReply(250)).toBe(false)
  })
})

describe('smtpError', () => {
  it('carries the reply code and retryability', () => {
    const error = new SmtpError('nope', 535, false)
    expect(error.name).toBe('SmtpError')
    expect(error).toMatchObject({ message: 'nope', code: 535, retryable: false })
    expect(error).toBeInstanceOf(Error)
  })
})

describe('createNodeSmtpTransport', () => {
  const socket = new ScriptedSocket(() => undefined)

  it('dials TCP for plain and STARTTLS delivery', () => {
    const tcp = vi.fn(() => socket as Duplex)
    const transport = createNodeSmtpTransport({ tcp })

    expect(transport.connect(base)).toBe(socket)
    expect(tcp).toHaveBeenCalledWith({ host: 'smtp.example.com', port: 587 })
  })

  it('dials implicit TLS with certificate verification options', () => {
    const tls = vi.fn(() => socket as Duplex)
    const transport = createNodeSmtpTransport({ tls })

    transport.connect({ ...base, secure: 'implicit', rejectUnauthorized: false })

    expect(tls).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      servername: 'smtp.example.com',
      rejectUnauthorized: false,
    })
  })

  it('dials implicit TLS through the real transport factory', () => {
    const socket = createNodeSmtpTransport().connect({ ...base, host: 'localhost', port: 1, secure: 'implicit' })

    expect(socket).toBeInstanceOf(TLSSocket)
    ;(socket as Duplex).destroy()
  })

  it('upgrades an existing socket to TLS', () => {
    const tls = vi.fn(() => socket as Duplex)
    const transport = createNodeSmtpTransport({ tls })

    expect(transport.upgrade(socket, base)).toBe(socket)
    expect(tls).toHaveBeenCalledWith({
      socket,
      servername: 'smtp.example.com',
      rejectUnauthorized: true,
    })
  })
})

describe('deliverMail over a real loopback relay', () => {
  it('runs a full unauthenticated session', async () => {
    const responder = buildResponder({ ehlo: [] })
    const lines: string[] = []
    const body: string[] = []
    let inBody = false

    const server = createServer((socket) => {
      socket.setEncoding('utf-8')
      socket.write('220 2.0.0 loopback ready\r\n')
      let buffer = ''
      socket.on('data', (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf('\r\n')
        while (index >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)

          if (inBody) {
            if (line === '.') {
              inBody = false
              socket.write(responder('X\r\n.\r\n') as string)
            }
            else {
              body.push(line)
            }
          }
          else {
            lines.push(line)
            const reply = responder(`${line}\r\n`)
            if (reply)
              socket.write(reply)
            if (line === 'DATA')
              inBody = true
          }

          index = buffer.indexOf('\r\n')
        }
      })
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    try {
      await deliverMail({ ...base, host: '127.0.0.1', port, secure: 'none' }, envelope)
    }
    finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }

    expect(lines).toEqual([
      'EHLO giclaw',
      'MAIL FROM:<giclaw@example.com>',
      'RCPT TO:<ops@example.com>',
      'DATA',
      'QUIT',
    ])
    const flattened = body.join('\n')
    expect(flattened).toContain('Subject: Run ok')
    expect(Buffer.from(body.slice(body.indexOf('') + 1).join(''), 'base64').toString('utf-8')).toBe('all good')
  })
})

describe('deliverMail scripting', () => {
  it('upgrades with STARTTLS, authenticates and retries 251 recipients', async () => {
    const responder = buildResponder({ starttls: '220 2.0.0 go ahead\r\n', rcptTo: '251 2.1.5 will forward\r\n' })
    const { transport, sockets } = fakeTransport({
      prelude: '220 2.0.0 scripted ready\r\n',
      reply: responder,
      upgrade: { prelude: '', reply: responder },
    })

    await deliverMail({ ...base, user: 'ops', password: 'secret' }, envelope, transport)

    expect(sockets).toHaveLength(2)
    expect(delivered(sockets)).toEqual([
      'EHLO giclaw\r\n',
      'STARTTLS\r\n',
      'EHLO giclaw\r\n',
      `AUTH PLAIN ${Buffer.from('\0ops\0secret', 'utf-8').toString('base64')}\r\n`,
      'MAIL FROM:<giclaw@example.com>\r\n',
      'RCPT TO:<ops@example.com>\r\n',
      'DATA\r\n',
      `${envelope.data}\r\n.\r\n`,
      'QUIT\r\n',
    ])
  })

  it('falls back to AUTH LOGIN', async () => {
    const responder = buildResponder({ ehlo: ['AUTH LOGIN'] })
    const { transport, sockets } = fakeTransport({
      prelude: '220 2.0.0 scripted ready\r\n',
      reply: responder,
    })

    await deliverMail({ ...base, secure: 'none', user: 'ops', password: 'secret' }, envelope, transport)

    expect(delivered(sockets)).toEqual([
      'EHLO giclaw\r\n',
      'AUTH LOGIN\r\n',
      `${Buffer.from('ops', 'utf-8').toString('base64')}\r\n`,
      `${Buffer.from('secret', 'utf-8').toString('base64')}\r\n`,
      'MAIL FROM:<giclaw@example.com>\r\n',
      'RCPT TO:<ops@example.com>\r\n',
      'DATA\r\n',
      `${envelope.data}\r\n.\r\n`,
      'QUIT\r\n',
    ])
  })

  it('sends an empty password when none is configured', async () => {
    const { transport, sockets } = fakeTransport({
      prelude: '220 2.0.0 scripted ready\r\n',
      reply: buildResponder({ ehlo: ['AUTH PLAIN'] }),
    })

    await deliverMail({ ...base, secure: 'none', user: 'ops' }, envelope, transport)

    expect(delivered(sockets)[1]).toBe(`AUTH PLAIN ${Buffer.from('\0ops\0', 'utf-8').toString('base64')}\r\n`)
  })

  it('reassembles a reply split across two chunks', async () => {
    const responder = buildResponder({ ehlo: ['STARTTLS', 'AUTH PLAIN'] })
    const { transport } = fakeTransport({
      prelude: '220 2.0.0 scripted ready\r\n',
      reply: (line, socket) => {
        if (line.startsWith('EHLO')) {
          socket.push('250-scripted\r\n250 AUTH PLAI')
          setImmediate(() => socket.push('N\r\n'))
          return undefined
        }
        if (line.startsWith('AUTH'))
          return '235 2.7.0 ok\r\n'
        return responder(line)
      },
    })

    await expect(deliverMail({ ...base, secure: 'none', user: 'ops', password: 'x' }, envelope, transport))
      .resolves
      .toBeUndefined()
  })

  it('consumes replies that arrive before they are awaited', async () => {
    const responder = buildResponder({ ehlo: ['AUTH PLAIN'] })
    const { transport } = fakeTransport({
      // Greeting and EHLO reply land in the same chunk; the responder stays
      // quiet for EHLO so the pre-buffered reply is the one that is consumed.
      prelude: '220 2.0.0 scripted ready\r\n250-scripted\r\n250 AUTH PLAIN\r\n',
      reply: line => (line.startsWith('EHLO') ? undefined : responder(line)),
    })

    await expect(deliverMail({ ...base, secure: 'none' }, envelope, transport)).resolves.toBeUndefined()
  })
})

describe('deliverMail failures', () => {
  function failing(options: {
    prelude?: string
    reply: (line: string, socket?: ScriptedSocket) => string | undefined
    delivery?: Partial<SmtpDeliveryOptions>
  }) {
    const { transport } = fakeTransport({
      prelude: options.prelude ?? '220 2.0.0 scripted ready\r\n',
      reply: (line, socket) => options.reply(line, socket),
    })
    return deliverMail({ ...base, secure: 'none', ...options.delivery }, envelope, transport)
  }

  it('reports a rejected greeting as retryable', async () => {
    await expect(failing({ prelude: '421 4.3.2 service unavailable\r\n', reply: () => undefined }))
      .rejects
      .toMatchObject({
        name: 'SmtpError',
        message: 'SMTP greeting failed: 421 4.3.2 service unavailable',
        code: 421,
        retryable: true,
      })
  })

  it('reports a rejected EHLO', async () => {
    await expect(failing({ reply: () => '500 5.5.1 command not recognized\r\n' }))
      .rejects
      .toMatchObject({ message: 'EHLO failed: 500 5.5.1 command not recognized', retryable: false })
  })

  it('refuses to continue when STARTTLS is not advertised', async () => {
    const { transport } = fakeTransport({
      prelude: '220 2.0.0 ready\r\n',
      reply: buildResponder({ ehlo: ['AUTH PLAIN'] }),
    })

    await expect(deliverMail(base, envelope, transport))
      .rejects
      .toMatchObject({ message: 'SMTP server does not advertise STARTTLS', code: 0, retryable: false })
  })

  it('reports a rejected STARTTLS as retryable', async () => {
    await expect(failing({
      reply: buildResponder({ ehlo: ['STARTTLS'], starttls: '454 4.7.0 TLS not available\r\n' }),
      delivery: { secure: 'starttls' },
    })).rejects.toMatchObject({ message: 'STARTTLS failed: 454 4.7.0 TLS not available', retryable: true })
  })

  it('refuses to send credentials to a server without AUTH', async () => {
    await expect(failing({
      reply: buildResponder({ ehlo: ['SIZE 1024'] }),
      delivery: { user: 'ops', password: 'secret' },
    })).rejects.toMatchObject({
      message: 'SMTP server advertises no supported authentication mechanism',
      retryable: false,
    })
  })

  it('reports rejected credentials as permanent', async () => {
    await expect(failing({
      reply: buildResponder({ authPlain: '535 5.7.8 authentication failed\r\n' }),
      delivery: { user: 'ops', password: 'wrong' },
    })).rejects.toMatchObject({
      message: 'AUTH PLAIN failed: 535 5.7.8 authentication failed',
      retryable: false,
    })
  })

  it('reports a rejected sender before any recipient', async () => {
    const { transport, sockets } = fakeTransport({
      prelude: '220 ready\r\n',
      reply: buildResponder({ mailFrom: '550 5.1.8 bad sender\r\n' }),
    })

    await expect(deliverMail({ ...base, secure: 'none' }, envelope, transport))
      .rejects
      .toMatchObject({ message: 'MAIL FROM failed: 550 5.1.8 bad sender', retryable: false })
    expect(delivered(sockets)).not.toContain('RCPT TO:<ops@example.com>\r\n')
  })

  it('reports a rejected recipient as permanent', async () => {
    await expect(failing({ reply: buildResponder({ rcptTo: '550 5.1.1 no such user\r\n' }) }))
      .rejects
      .toMatchObject({ message: 'RCPT TO failed: 550 5.1.1 no such user' })
  })

  it('reports a rejected DATA command as retryable', async () => {
    await expect(failing({ reply: buildResponder({ data: '451 4.3.0 try later\r\n' }) }))
      .rejects
      .toMatchObject({ message: 'DATA failed: 451 4.3.0 try later', retryable: true })
  })

  it('reports a rejected message body as permanent', async () => {
    await expect(failing({ reply: buildResponder({ body: '554 5.6.0 message rejected\r\n' }) }))
      .rejects
      .toMatchObject({ message: 'Message body failed: 554 5.6.0 message rejected', retryable: false })
  })

  it('reports a rejected QUIT', async () => {
    await expect(failing({ reply: buildResponder({ quit: '500 5.5.1 unknown\r\n' }) }))
      .rejects
      .toMatchObject({ message: 'QUIT failed: 500 5.5.1 unknown' })
  })

  it('times out when the server never answers', async () => {
    await expect(failing({ reply: () => undefined, delivery: { timeoutMs: 20 } }))
      .rejects
      .toMatchObject({
        name: 'SmtpError',
        message: 'SMTP server did not respond within 20ms',
        code: 0,
        retryable: true,
      })
  })

  it('propagates a socket error', async () => {
    const { transport } = fakeTransport({
      prelude: '220 ready\r\n',
      reply: (line, socket) => {
        if (line.startsWith('EHLO')) {
          socket.destroy(new Error('ECONNRESET'))
          return undefined
        }
        return undefined
      },
    })

    await expect(deliverMail({ ...base, secure: 'none' }, envelope, transport))
      .rejects
      .toThrow('ECONNRESET')
  })

  it('reports a dropped connection as retryable', async () => {
    const { transport } = fakeTransport({
      prelude: '220 ready\r\n',
      reply: (line, socket) => {
        if (line.startsWith('EHLO')) {
          socket.destroy()
          return undefined
        }
        return undefined
      },
    })

    await expect(deliverMail({ ...base, secure: 'none' }, envelope, transport))
      .rejects
      .toMatchObject({ name: 'SmtpError', message: 'SMTP connection closed unexpectedly', retryable: true })
  })

  it('rejects a malformed response line', async () => {
    await expect(failing({ prelude: 'garbage\r\n', reply: () => undefined }))
      .rejects
      .toMatchObject({ message: 'Unexpected SMTP response: garbage', code: 0, retryable: false })
  })

  it('closes the connection when the first reply fails', async () => {
    const { transport, sockets } = fakeTransport({ prelude: '421 4.3.2 unavailable\r\n', reply: () => undefined })

    await expect(deliverMail({ ...base, secure: 'none' }, envelope, transport)).rejects.toThrow(SmtpError)
    expect(sockets[0]?.destroyed).toBe(true)
  })

  it('ignores events received after close', async () => {
    const { transport, sockets } = fakeTransport({ prelude: '220 ready\r\n', reply: buildResponder({ ehlo: [] }) })

    await deliverMail({ ...base, secure: 'none' }, envelope, transport)

    const socket = sockets[0] as ScriptedSocket
    socket.emit('error', new Error('late failure'))
    socket.emit('close')
    expect(socket.destroyed).toBe(true)
  })
})

describe('smtpConnection', () => {
  it('exposes buffered replies across sequential reads', async () => {
    const socket = new ScriptedSocket(() => undefined)
    const connection = new SmtpConnection(socket, 1_000)

    socket.push('250 first\r\n')
    await expect(connection.expect([250], 'first')).resolves.toMatchObject({ message: 'first' })

    // Arrives with nobody waiting: it must be buffered for the next read.
    socket.push('250 second\r\n')
    await expect(connection.expect([250], 'second')).resolves.toMatchObject({ message: 'second' })
    connection.close()
  })

  it('rejects a read after the socket failed', async () => {
    const socket = new ScriptedSocket(() => undefined)
    const connection = new SmtpConnection(socket, 1_000)
    socket.push('220 ready\r\n')
    await connection.expect([220], 'greeting')

    socket.destroy(new Error('boom'))
    await new Promise(resolve => setImmediate(resolve))

    // The failure is already recorded, so the next read fails without waiting.
    await expect(connection.expect([250], 'next')).rejects.toThrow('boom')
  })
})
