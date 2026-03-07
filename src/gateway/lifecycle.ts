import type { AppConfig } from '../config/schema.js'
import process from 'node:process'
import { logger } from '../utils/logger.js'
import { Gateway } from './gateway.js'

/**
 * Start the Gateway in daemon mode with optional Web and TUI.
 */
export async function startGateway(config: AppConfig): Promise<Gateway> {
  const gateway = new Gateway(config)
  await gateway.init()

  // Start web server if enabled
  if (config.web.enabled) {
    try {
      const { startWebServer } = await import('../web/server.js')
      await startWebServer(gateway)
    }
    catch (err) {
      logger.warn('Web server not available, continuing without it', err)
    }
  }

  // Render TUI dashboard if running in a terminal
  if (process.stdout.isTTY) {
    try {
      const { renderDashboard } = await import('../tui/render.js')
      renderDashboard(gateway)
    }
    catch (err) {
      logger.warn('TUI not available, continuing with log output', err)
    }
  }

  // Start scheduler
  await gateway.start()

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutdown signal received')
    await gateway.shutdown()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  logger.info('Daemon running. Press Ctrl+C to stop.')

  // Keep process alive
  await new Promise(() => {
    // Never resolves — daemon stays alive until signal
  })

  return gateway
}
