import { execSync } from 'node:child_process'
import { chromium } from 'playwright'
import { logger } from '../utils/logger.js'

export function ensureChromium(): void {
  try {
    chromium.executablePath()
  }
  catch {
    logger.info('Chromium not found, installing...')
    execSync('npx playwright install chromium', { stdio: 'inherit' })
  }
}
