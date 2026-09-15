import type { AppConfig } from '../config/schema.js'
import type { Gateway } from '../gateway/gateway.js'
import type { RunTrigger } from '../queue/types.js'
import type { DiscoveredPlugin, PluginRuntime } from './types.js'
import { bundledPluginModules } from '../extensions/index.js'
import { logger } from '../utils/logger.js'
import { discoverBundledPlugins, discoverExternalPlugins } from './discovery.js'
import { PluginHost } from './host.js'
import { NotificationDispatcher } from './notify.js'
import { NotificationOutbox } from './outbox.js'

export interface PluginBootstrapHandle {
  host: PluginHost
  dispatcher: NotificationDispatcher
  shutdown: () => Promise<void>
}

/** Bind the plugin runtime surface to a live gateway. */
export function createPluginRuntime(gateway: Gateway): PluginRuntime {
  return {
    gateway: {
      getSnapshot: () => gateway.getSnapshot(),
      getRunHistory: limit => gateway.getRunHistory(limit),
      enqueueRun: taskIds => gateway.enqueueRun('extension', taskIds),
      resolveRoutine: name => gateway.resolveRoutine(name),
    },
  }
}

/**
 * Layer 1: bundled plugins first, then configured external directories.
 * Bundled ids always win so a third-party package cannot shadow a connector
 * that ships with Giclaw.
 */
export async function discoverAllPlugins(config: AppConfig): Promise<DiscoveredPlugin[]> {
  const bundled = await discoverBundledPlugins(bundledPluginModules)
  const bundledIds = new Set(bundled.map(plugin => plugin.manifest.id))
  const external = await discoverExternalPlugins(config.plugins.dirs, logger)
  const accepted: DiscoveredPlugin[] = []
  for (const plugin of external) {
    if (bundledIds.has(plugin.manifest.id)) {
      logger.warn(`External plugin "${plugin.manifest.id}" shadows a bundled plugin; ignoring the external copy`)
      continue
    }
    accepted.push(plugin)
  }
  return [...bundled, ...accepted]
}

/** Build a host over the discovered plugin set. */
export async function createPluginHost(config: AppConfig, gateway: Gateway): Promise<PluginHost> {
  return new PluginHost({ config, plugins: await discoverAllPlugins(config), runtime: createPluginRuntime(gateway) })
}

/**
 * Discover, load and start plugins, then bridge gateway run outcomes to the
 * configured notification channels.
 *
 * Bootstrapping must never prevent the daemon from starting: discovery and
 * load failures are logged and the daemon continues without those plugins.
 */
export async function bootstrapPlugins(
  config: AppConfig,
  gateway: Gateway,
): Promise<PluginBootstrapHandle> {
  const host = await createPluginHost(config, gateway)
  const report = await host.load()
  for (const unknown of report.unknown)
    logger.warn(`Plugin "${unknown}" is enabled in config but not installed`)

  const dispatcher = new NotificationDispatcher({
    config,
    getChannel: id => host.capabilities.getChannel(id),
    outbox: NotificationOutbox.create(),
  })

  const triggers = new Map<string, RunTrigger>()
  const onStart = (runId: string, trigger: string): void => {
    triggers.set(runId, trigger as RunTrigger)
  }
  const onComplete = (runId: string, result: Parameters<NotificationDispatcher['buildRunMessage']>[2]): void => {
    const trigger = triggers.get(runId) ?? 'cron'
    triggers.delete(runId)
    if (!dispatcher.shouldNotify('run:complete'))
      return
    dispatcher.dispatchSafe(dispatcher.buildRunMessage(runId, trigger, result))
  }
  const onError = (runId: string, error: Error): void => {
    const trigger = triggers.get(runId) ?? 'cron'
    triggers.delete(runId)
    if (!dispatcher.shouldNotify('run:error'))
      return
    dispatcher.dispatchSafe(dispatcher.buildErrorMessage(runId, trigger, error))
  }

  gateway.state.on('run:start', onStart)
  gateway.state.on('run:complete', onComplete)
  gateway.state.on('run:error', onError)

  const started = await host.startServices()
  for (const entry of started) {
    if (!entry.ok)
      logger.warn(`Plugin service "${entry.id}" (${entry.pluginId}) did not start: ${entry.detail}`)
  }

  // Replay anything a previous run could not deliver. This must not delay the
  // daemon: the queue is a best-effort side effect of runs that already committed.
  dispatcher.redeliverPending().then(
    (summary) => {
      if (summary.pending > 0)
        logger.warn(`${summary.pending} notification(s) could not be redelivered and stay queued`)
    },
    (error: unknown) => {
      logger.warn('Notification redelivery failed', error)
    },
  )

  return {
    host,
    dispatcher,
    shutdown: async () => {
      gateway.state.off('run:start', onStart)
      gateway.state.off('run:complete', onComplete)
      gateway.state.off('run:error', onError)
      triggers.clear()
      await host.shutdown()
    },
  }
}
