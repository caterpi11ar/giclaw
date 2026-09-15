export { bundledPluginModules } from '../extensions/index.js'
export type { PluginBootstrapHandle } from './bootstrap.js'
export {
  bootstrapPlugins,
  createPluginHost,
  createPluginRuntime,
  discoverAllPlugins,
} from './bootstrap.js'
export { PluginCapabilities } from './capabilities.js'
export { maskDeclaredSecrets, MASKED_SECRET, resolveSecretInputs } from './config-contracts.js'
export { discoverBundledPlugins, discoverExternalPlugins } from './discovery.js'
export type { BundledPluginModule, DiscoveryLogger } from './discovery.js'
export { PluginError } from './errors.js'
export { PluginHost } from './host.js'

export type { PluginHostOptions, PluginLoadFailure, PluginLoadReport, PluginStatusEntry } from './host.js'
export { parsePluginManifest, PLUGIN_MANIFEST_FILENAME, readPluginManifest } from './manifest.js'
export { NotificationDispatcher } from './notify.js'
export type { NotificationDispatchEntry, NotificationDispatcherOptions, NotificationEvent, RedeliverySummary } from './notify.js'
export {
  MAX_OUTBOX_AGE_MS,
  MAX_OUTBOX_ATTEMPTS,
  MAX_OUTBOX_ENTRIES,
  NotificationOutbox,
  OUTBOX_VERSION,
} from './outbox.js'
export type {
  NotificationOutboxOptions,
  OutboxAppendResult,
  OutboxEntry,
  OutboxFailureResult,
  OutboxFile,
} from './outbox.js'
export { ServiceManager } from './services.js'
export type { ServiceStartResult } from './services.js'
