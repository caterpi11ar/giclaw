import type { AppConfig } from '../config/schema.js'
import type { PluginCapabilities } from './capabilities.js'
import type {
  PluginApi,
  PluginLogger,
  PluginRegistrationMode,
  PluginRuntime,
} from './types.js'
import { logger as rootLogger } from '../utils/logger.js'

export interface PluginLoggerSource {
  debug: (message: string, ...args: unknown[]) => void
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}

/** Wrap the shared logger so every plugin line is attributable to its plugin. */
export function createPluginLogger(
  pluginId: string,
  base: PluginLoggerSource = rootLogger,
): PluginLogger {
  const prefix = `[plugin:${pluginId}]`
  return {
    debug: (message, ...args) => base.debug(`${prefix} ${message}`, ...args),
    info: (message, ...args) => base.info(`${prefix} ${message}`, ...args),
    warn: (message, ...args) => base.warn(`${prefix} ${message}`, ...args),
    error: (message, ...args) => base.error(`${prefix} ${message}`, ...args),
  }
}

export interface PluginApiOptions {
  pluginId: string
  registrationMode: PluginRegistrationMode
  pluginConfig: Record<string, unknown>
  config: AppConfig
  logger: PluginLogger
  runtime: PluginRuntime
  capabilities: PluginCapabilities
}

/** Build the capability registration surface handed to `definition.register(api)`. */
export function createPluginApi(options: PluginApiOptions): PluginApi {
  const { pluginId, capabilities } = options
  return {
    registrationMode: options.registrationMode,
    pluginConfig: options.pluginConfig,
    config: options.config,
    logger: options.logger,
    runtime: options.runtime,
    registerChannel: channel => capabilities.registerChannel(pluginId, channel),
    registerService: service => capabilities.registerService(pluginId, service),
    registerHttpRoute: route => capabilities.registerHttpRoute(pluginId, route),
    registerTool: tool => capabilities.registerTool(pluginId, tool),
  }
}
