import { logger } from './logger.js'

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface RetryOptions {
  retries: number
  delayMs?: number
  onRetry?: (attempt: number, error: unknown) => void
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { retries, delayMs = 1000, onRetry } = options
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    }
    catch (err) {
      lastError = err
      if (attempt < retries) {
        logger.warn(
          `Attempt ${attempt + 1}/${retries + 1} failed, retrying in ${delayMs}ms`,
        )
        onRetry?.(attempt + 1, err)
        await delay(delayMs)
      }
    }
  }

  throw lastError
}
