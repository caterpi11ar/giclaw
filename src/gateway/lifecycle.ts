import type { AppConfig } from '../config/schema.js'
import type { PluginBootstrapHandle } from '../plugins/bootstrap.js'
import type { WebServerHandle } from '../web/server.js'
import process from 'node:process'
import { bootstrapPlugins } from '../plugins/bootstrap.js'
import { TimeoutError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { Gateway } from './gateway.js'

const LIFECYCLE_SHUTDOWN_TIMEOUT_MS = 10_000

async function settleShutdown(
  operations: PromiseSettledResult<void>[] | Promise<PromiseSettledResult<void>[]>,
): Promise<PromiseSettledResult<void>[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      reject,
      LIFECYCLE_SHUTDOWN_TIMEOUT_MS,
      new TimeoutError('daemon shutdown', LIFECYCLE_SHUTDOWN_TIMEOUT_MS),
    )
  })
  try {
    return await Promise.race([Promise.resolve(operations), deadline])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}

/**
 * Start the Gateway in daemon mode with optional Web and TUI.
 */
export async function startGateway(config: AppConfig): Promise<never> {
  const gateway = new Gateway(config)
  await gateway.init()

  // Validate and start scheduling before exposing any external surface. If
  // cron/timezone setup fails, no web server or dashboard has been started and
  // there is nothing to roll back.
  await gateway.start()

  let webServer: WebServerHandle | undefined
  let plugins: PluginBootstrapHandle | undefined

  // Plugins load before the web server so inbound routes are mounted with the
  // rest of the API and notification channels exist before the first run.
  try {
    plugins = await bootstrapPlugins(config, gateway)
  }
  catch (err) {
    logger.error('Plugin bootstrap failed; continuing without plugins', err)
  }

  // Start web server if enabled
  if (config.web.enabled) {
    try {
      const { startWebServer } = await import('../web/server.js')
      webServer = await startWebServer(gateway, plugins
        ? { capabilities: plugins.host.capabilities, logger, host: plugins.host }
        : undefined)
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

  // Graceful shutdown
  let shutdownPromise: Promise<void> | undefined
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      logger.info('Shutdown signal received')
      try {
        const operations = Promise.allSettled([
          gateway.shutdown(),
          webServer?.close() ?? Promise.resolve(),
          plugins?.shutdown() ?? Promise.resolve(),
        ])
        const results = await settleShutdown(operations)
        const gatewayResult = results[0]
        if (gatewayResult?.status === 'rejected')
          throw gatewayResult.reason
        const webResult = results[1]
        if (webResult?.status === 'rejected')
          throw webResult.reason
        process.exit(0)
      }
      catch (error) {
        logger.error('Gateway shutdown failed', error)
        process.exit(1)
      }
    })()
    return shutdownPromise
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  logger.info('Daemon running. Press Ctrl+C to stop.')

  // Keep process alive
  return new Promise<never>(() => {
    // Never resolves — daemon stays alive until signal
  })
}
