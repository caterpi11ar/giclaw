import type { Page } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { logger } from '../utils/logger.js'

/**
 * Capture a screenshot from the page and return the base64-encoded PNG.
 */
export async function captureScreenshot(page: Page): Promise<string> {
  const buffer = await page.screenshot()
  return buffer.toString('base64')
}

/**
 * Capture a screenshot and save it to disk. Returns the file path.
 */
export async function saveScreenshot(
  page: Page,
  dir: string,
  label: string,
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const path = `${dir}/${label}-${ts}.png`
  await page.screenshot({ path })
  logger.info(`Screenshot saved: ${path}`)
  return path
}
