import type { Page } from 'playwright'
import type { AppConfig } from '../config/schema.js'
import type { SessionManager } from './session-manager.js'
import { cancellationError, LoginError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { loadCookies, saveCookies } from './cookie-store.js'

const COOKIE_RESTORE_CHECK_TIMEOUT_MS = 60_000

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw cancellationError('login', signal.reason)
}

function abortable<T>(operation: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal?.aborted)
    return Promise.reject(cancellationError('login', signal.reason))

  const promise = operation()
  if (!signal)
    return promise

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancellationError('login', signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

function launch(
  session: SessionManager,
  options: { headless: boolean },
  signal: AbortSignal | undefined,
): Promise<Page> {
  return signal ? session.launch(options, signal) : session.launch(options)
}

function relaunch(
  session: SessionManager,
  options: { headless: boolean },
  signal: AbortSignal | undefined,
): Promise<Page> {
  return signal ? session.relaunch(options, signal) : session.relaunch(options)
}

async function checkSelector(
  page: Page,
  selector: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfCancelled(signal)
  try {
    await abortable(() => page.locator(selector).waitFor({ timeout: timeoutMs }), signal)
    return true
  }
  catch (error) {
    throwIfCancelled(signal)
    if (error instanceof Error && error.name === 'TimeoutError')
      return false
    throw new LoginError('Could not check whether login completed', error)
  }
}

async function pollForLogin(
  page: Page,
  selector: string,
  timeoutMs: number,
  pollIntervalMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    throwIfCancelled(signal)
    const remaining = deadline - Date.now()
    const found = await checkSelector(
      page,
      selector,
      Math.max(1, Math.min(pollIntervalMs, remaining)),
      signal,
    )
    if (found)
      return true
  }
  return false
}

/**
 * Cookie-based login flow.
 * 1. If cookies exist, try headless restore.
 * 2. If no cookies or expired, open visible browser for manual login.
 * 3. Save cookies, switch back to headless.
 */
export async function loginFlow(
  session: SessionManager,
  config: AppConfig,
  signal?: AbortSignal,
): Promise<void> {
  const cookiePath = config.browser.cookieFilePath
  const { successSelector, timeoutMs, pollIntervalMs } = config.login

  // Try cookie restore
  throwIfCancelled(signal)
  const cookies = await abortable(() => loadCookies(cookiePath), signal)
  if (cookies) {
    logger.info('Cookie file found, attempting session restore')
    const page = await launch(session, { headless: config.browser.headless }, signal)
    const ctx = session.getContext()
    await abortable(() => ctx.addCookies(cookies), signal)
    await abortable(() => page.reload(), signal)

    const found = await checkSelector(
      page,
      successSelector,
      Math.min(timeoutMs, COOKIE_RESTORE_CHECK_TIMEOUT_MS),
      signal,
    )
    if (found) {
      logger.info('Login restored from cookies')
      return
    }

    // Keep the cookies: a slow cloud-game page can look like an expired
    // session, and deleting them forces a manual login on every transient
    // failure. The manual login below overwrites them on success.
    logger.info('Cookie restore failed; keeping cookies and falling back to manual login')
    await session.close()
    throwIfCancelled(signal)
  }

  // Manual login: open visible browser
  logger.info('Opening visible browser for manual login')
  const page = await launch(session, { headless: false }, signal)

  const loggedIn = await pollForLogin(
    page,
    successSelector,
    timeoutMs,
    pollIntervalMs,
    signal,
  )

  if (!loggedIn) {
    throw new LoginError(
      `Login timed out after ${timeoutMs}ms — selector "${successSelector}" not found`,
    )
  }

  // Save cookies
  const freshCookies = await abortable(() => session.getContext().cookies(), signal)
  await abortable(() => saveCookies(cookiePath, freshCookies), signal)

  if (!config.browser.headless) {
    logger.info('Login complete — keeping visible session')
    return
  }

  // Switch to headless
  logger.info('Login successful, switching to headless mode')
  const headlessPage = await relaunch(session, { headless: true }, signal)
  const headlessCtx = session.getContext()
  await abortable(() => headlessCtx.addCookies(freshCookies), signal)
  await abortable(() => headlessPage.reload(), signal)

  // Verify
  const verified = await checkSelector(
    headlessPage,
    successSelector,
    Math.min(timeoutMs, COOKIE_RESTORE_CHECK_TIMEOUT_MS),
    signal,
  )
  if (!verified) {
    throw new LoginError(
      'Failed to verify login after switching to headless mode',
    )
  }

  logger.info('Login complete — headless session ready')
}
