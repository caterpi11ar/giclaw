import type { Page } from 'playwright'
import type { AppConfig } from '../config/schema.js'
import type { SessionManager } from './session-manager.js'
import { delay } from '../utils/delay.js'
import { LoginError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { deleteCookies, loadCookies, saveCookies } from './cookie-store.js'

async function checkSelector(page: Page, selector: string): Promise<boolean> {
  try {
    await page.locator(selector).waitFor({ timeout: 0 })
    return true
  }
  catch {
    return false
  }
}

async function pollForLogin(
  page: Page,
  selector: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await checkSelector(page, selector)
    if (found)
      return true
    await delay(pollIntervalMs)
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
): Promise<void> {
  const cookiePath = config.browser.cookieFilePath
  const { successSelector, timeoutMs, pollIntervalMs } = config.login

  // Try cookie restore
  const cookies = await loadCookies(cookiePath)
  if (cookies) {
    logger.info('Cookie file found, attempting headless login')
    const page = await session.launch({ headless: true })
    const ctx = session.getContext()
    await ctx.addCookies(cookies)
    await page.reload()

    const found = await checkSelector(page, successSelector)
    if (found) {
      logger.info('Login restored from cookies')
      return
    }

    // Cookies expired
    logger.info('Cookies expired, deleting cookie file')
    await deleteCookies(cookiePath)
    await session.close()
  }

  // Manual login: open visible browser
  logger.info('Opening visible browser for manual login')
  const page = await session.launch({ headless: false })

  const loggedIn = await pollForLogin(
    page,
    successSelector,
    timeoutMs,
    pollIntervalMs,
  )

  if (!loggedIn) {
    throw new LoginError(
      `Login timed out after ${timeoutMs}ms — selector "${successSelector}" not found`,
    )
  }

  // Save cookies
  const freshCookies = await session.getContext().cookies()
  await saveCookies(cookiePath, freshCookies)

  // Switch to headless
  logger.info('Login successful, switching to headless mode')
  const headlessPage = await session.relaunch({ headless: true })
  const headlessCtx = session.getContext()
  await headlessCtx.addCookies(freshCookies)
  await headlessPage.reload()

  // Verify
  const verified = await checkSelector(headlessPage, successSelector)
  if (!verified) {
    throw new LoginError(
      'Failed to verify login after switching to headless mode',
    )
  }

  logger.info('Login complete — headless session ready')
}
