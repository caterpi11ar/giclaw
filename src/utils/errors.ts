export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

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

export class StepExecutionError extends AppError {
  constructor(
    message: string,
    public readonly step: number,
    public readonly screenshotPath?: string,
    cause?: unknown,
  ) {
    super(message, 'STEP_EXECUTION_ERROR', cause)
    this.name = 'StepExecutionError'
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

export class CancellationError extends AppError {
  constructor(operation: string, cause?: unknown) {
    super(`Operation "${operation}" was cancelled`, 'CANCELLED', cause)
    this.name = 'CancellationError'
  }
}

export class QuarantinedError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'QUARANTINED', cause)
    this.name = 'QuarantinedError'
  }
}

export function cancellationError(operation: string, reason?: unknown): CancellationError {
  return reason instanceof CancellationError
    ? reason
    : new CancellationError(operation, reason)
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

export class EvolveError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'EVOLVE_ERROR', cause)
    this.name = 'EvolveError'
  }
}
