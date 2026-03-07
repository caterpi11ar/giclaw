import type { ProgressEvent } from './progress.js'
import { EventEmitter } from 'node:events'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const SENSITIVE_KEYS = /password|token|secret|cookie|authorization|apiKey/i

function sanitizeValue(key: string, value: unknown): unknown {
  if (typeof value === 'string' && SENSITIVE_KEYS.test(key)) {
    return '[REDACTED]'
  }
  return value
}

function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      const sanitized: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(
        arg as Record<string, unknown>,
      )) {
        sanitized[key] = sanitizeValue(key, value)
      }
      return sanitized
    }
    return arg
  })
}

export interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  args: unknown[]
}

class Logger extends EventEmitter {
  private level: LogLevel
  private muted = false

  constructor() {
    super()
    this.level = 'info'
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  mute(): void {
    this.muted = true
  }

  unmute(): void {
    this.muted = false
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (LEVELS[level] < LEVELS[this.level])
      return
    const timestamp = new Date().toISOString()
    const sanitized = sanitizeArgs(args)

    if (!this.muted) {
      const prefix = `[${timestamp}] [${level.toUpperCase()}]`
      if (sanitized.length > 0) {
        console.error(prefix, message, ...sanitized)
      }
      else {
        console.error(prefix, message)
      }
    }

    // Emit for WebSocket / TUI subscribers
    const entry: LogEntry = { timestamp, level, message, args: sanitized }
    this.emit('log', entry)
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, ...args)
  }

  info(message: string, ...args: unknown[]): void {
    this.log('info', message, ...args)
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, ...args)
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, ...args)
  }

  emitProgress(event: ProgressEvent): void {
    this.emit('progress', event)
  }
}

export const logger = new Logger()
