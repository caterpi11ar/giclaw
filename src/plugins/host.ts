import type { AppConfig } from '../config/schema.js'
import type { PluginLoggerSource } from './api.js'
import type { ServiceStartResult } from './services.js'
import type {
  DiscoveredPlugin,
  PluginLogger,
  PluginRegistrationMode,
  PluginRuntime,
} from './types.js'
import { toError } from '../utils/errors.js'
import { logger as rootLogger } from '../utils/logger.js'
import { createPluginApi, createPluginLogger } from './api.js'
import { PluginCapabilities } from './capabilities.js'
import { resolveSecretInputs } from './config-contracts.js'
import { PluginError } from './errors.js'
import { ServiceManager } from './services.js'

export interface PluginLoadFailure {
  id: string
  detail: string
}

export interface PluginLoadReport {
  loaded: string[]
  failed: PluginLoadFailure[]
  /** Enabled ids that no discovered plugin provides. */
  unknown: string[]
}

export interface PluginStatusEntry {
  id: string
  name: string
  description?: string
  version?: string
  enabled: boolean
  loaded: boolean
  bundled: boolean
  channels: string[]
  services: string[]
  routes: string[]
  tools: string[]
  /** Why the last load attempt failed, when it did. */
  failure?: string
}

export interface PluginHostOptions {
  config: AppConfig
  plugins: DiscoveredPlugin[]
  runtime: PluginRuntime
  logger?: PluginLoggerSource
}

/**
 * Plugin host: the four-layer load (manifest → validate → register → consume)
 * described in `docs/docs/extensions.md`.
 *
 * Layer 1 (discovery/manifest) happens in `discovery.ts` and is expressed here
 * as the `plugins` list. This class owns layers 2-4.
 */
export class PluginHost {
  readonly capabilities = new PluginCapabilities()

  private readonly config: AppConfig
  private readonly plugins: DiscoveredPlugin[]
  private readonly byId: Map<string, DiscoveredPlugin>
  private readonly runtime: PluginRuntime
  private readonly logger: PluginLogger
  private readonly loggerSource: PluginLoggerSource
  private readonly services: ServiceManager
  private readonly loadedIds = new Set<string>()
  private readonly failures = new Map<string, string>()
  private started = false

  constructor(options: PluginHostOptions) {
    this.config = options.config
    this.plugins = options.plugins
    this.byId = new Map(options.plugins.map(plugin => [plugin.manifest.id, plugin]))
    this.runtime = options.runtime
    this.loggerSource = options.logger ?? rootLogger
    this.logger = createPluginLogger('host', this.loggerSource)
    this.services = new ServiceManager(this.logger)
  }

  /** Ids the config asks for, in config order, de-duplicated. */
  getEnabledIds(): string[] {
    return [...new Set(this.config.plugins.enabled)]
  }

  /**
   * Layers 2-3: resolve config, then import-free `register(api)` for each
   * enabled plugin. A failing plugin is rolled back and reported.
   */
  async load(mode: PluginRegistrationMode = 'full'): Promise<PluginLoadReport> {
    const report: PluginLoadReport = { loaded: [], failed: [], unknown: [] }

    for (const id of this.getEnabledIds()) {
      const plugin = this.byId.get(id)
      if (!plugin) {
        report.unknown.push(id)
        this.logger.warn(`Enabled plugin "${id}" is not installed; ignoring`)
        continue
      }

      this.capabilities.removeByPlugin(id)
      try {
        const pluginConfig = await this.resolvePluginConfig(plugin)
        const api = createPluginApi({
          pluginId: id,
          registrationMode: mode,
          pluginConfig,
          config: this.config,
          logger: createPluginLogger(id, this.loggerSource),
          runtime: this.runtime,
          capabilities: this.capabilities,
        })
        plugin.definition.register?.(api)
        this.loadedIds.add(id)
        this.failures.delete(id)
        report.loaded.push(id)
        this.logger.info(`Loaded plugin "${id}" (${plugin.source})`)
      }
      catch (error) {
        this.capabilities.removeByPlugin(id)
        const detail = toError(error).message
        this.loadedIds.delete(id)
        this.failures.set(id, detail)
        report.failed.push({ id, detail })
        this.logger.error(`Plugin "${id}" failed to load: ${detail}`)
      }
    }

    return report
  }

  private async resolvePluginConfig(plugin: DiscoveredPlugin): Promise<Record<string, unknown>> {
    const raw = (this.config.plugins.entries[plugin.manifest.id]?.config ?? {}) as Record<string, unknown>
    const resolved = await resolveSecretInputs(raw)
    const schema = plugin.definition.configSchema
    if (!schema)
      return resolved
    const parsed = schema.parse(resolved)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new PluginError('configSchema.parse must return an object', plugin.manifest.id)
    return parsed as Record<string, unknown>
  }

  /** Start every registered service. Safe to call once; extra calls are ignored. */
  async startServices(): Promise<ServiceStartResult[]> {
    if (this.started)
      return []
    this.started = true
    return this.services.startAll(this.capabilities.listServices())
  }

  async shutdown(): Promise<void> {
    await this.services.stopAll()
    this.started = false
  }

  getStatus(): PluginStatusEntry[] {
    return this.plugins.map((plugin) => {
      const id = plugin.manifest.id
      const channels = this.capabilities.listChannels().filter(entry => entry.pluginId === id)
      const services = this.capabilities.listServices().filter(entry => entry.pluginId === id)
      const routes = this.capabilities.listRoutes().filter(entry => entry.pluginId === id)
      const tools = this.capabilities.listTools().filter(entry => entry.pluginId === id)
      const failure = this.failures.get(id)
      return {
        id,
        name: plugin.manifest.name,
        ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
        ...(plugin.manifest.version ? { version: plugin.manifest.version } : {}),
        enabled: this.config.plugins.enabled.includes(id),
        loaded: this.loadedIds.has(id),
        bundled: plugin.bundled,
        channels: channels.map(entry => entry.channel.id),
        services: services.map(entry => entry.service.id),
        routes: routes.map(entry => `${entry.route.method ?? 'POST'} ${entry.route.path}`),
        tools: tools.map(entry => entry.tool.name),
        ...(failure ? { failure } : {}),
      }
    })
  }

  getFailure(id: string): string | undefined {
    return this.failures.get(id)
  }
}
