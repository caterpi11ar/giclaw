import type { Browser, BrowserContext, Dialog, Page } from 'playwright'
import type { AppConfig } from '../config/schema.js'
import { chromium } from 'playwright'
import { SessionError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { ensureChromium } from './ensure-chromium.js'

export interface SessionOptions {
  headless?: boolean
  viewport?: { width: number, height: number }
}

export class SessionManager {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page_: Page | null = null
  private dialogTimer?: ReturnType<typeof setTimeout>
  private config: AppConfig

  constructor(config: AppConfig) {
    this.config = config
  }

  get isActive(): boolean {
    return this.browser !== null && this.browser.isConnected()
  }

  getPage(): Page {
    if (!this.page_) {
      throw new SessionError('No active session — call launch() first')
    }
    return this.page_
  }

  getContext(): BrowserContext {
    if (!this.context) {
      throw new SessionError('No active session — call launch() first')
    }
    return this.context
  }

  async launch(options?: SessionOptions): Promise<Page> {
    if (this.isActive) {
      throw new SessionError('Session already active — call close() first')
    }

    const headless = options?.headless ?? this.config.browser.headless
    const viewport = options?.viewport ?? this.config.browser.viewport

    logger.info(`Launching browser (headless: ${headless})`)

    ensureChromium()

    this.browser = await chromium.launch({ headless })
    this.context = await this.browser.newContext({ viewport })
    this.page_ = await this.context.newPage()
    await this.page_.goto(this.config.browser.startupUrl)

    this.setupDialogHandler()

    logger.info('Browser session launched')
    return this.page_
  }

  /**
   * Close current session and relaunch with new options.
   * Used for headless ↔ visible switching during login.
   */
  async relaunch(options?: SessionOptions): Promise<Page> {
    await this.close()
    return this.launch(options)
  }

  async close(): Promise<void> {
    if (this.dialogTimer) {
      clearTimeout(this.dialogTimer)
      this.dialogTimer = undefined
    }
    if (this.browser) {
      try {
        await this.browser.close()
      }
      catch (err) {
        logger.error('Error closing browser', err)
      }
      this.browser = null
      this.context = null
      this.page_ = null
      logger.info('Browser session closed')
    }
  }

  private setupDialogHandler(): void {
    if (!this.page_)
      return

    const handleDialog = (dialog: Dialog) => {
      logger.info(
        `Dialog detected: ${dialog.type()} - "${dialog.message()}"`,
      )
      this.dialogTimer = setTimeout(async () => {
        try {
          await dialog.dismiss()
          logger.info('Dialog auto-dismissed')
        }
        catch {
          // Dialog may have been handled already
        }
      }, this.config.browser.dialogAutoDismissMs)
    }

    this.page_.on('dialog', handleDialog)
  }
}
