export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class ConfigError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CONFIG_ERROR', cause)
    this.name = 'ConfigError'
  }
}

export class LoginError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'LOGIN_ERROR', cause)
    this.name = 'LoginError'
  }
}

export class TaskError extends AppError {
  constructor(
    message: string,
    public readonly taskId: string,
    cause?: unknown,
  ) {
    super(message, 'TASK_ERROR', cause)
    this.name = 'TaskError'
  }
}

export class TimeoutError extends AppError {
  constructor(operation: string, timeoutMs: number) {
    super(
      `Operation "${operation}" timed out after ${timeoutMs}ms`,
      'TIMEOUT',
    )
    this.name = 'TimeoutError'
  }
}

export class SessionError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'SESSION_ERROR', cause)
    this.name = 'SessionError'
  }
}

export class QueueError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'QUEUE_ERROR', cause)
    this.name = 'QueueError'
  }
}
