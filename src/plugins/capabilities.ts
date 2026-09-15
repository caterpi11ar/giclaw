import type {
  ChannelPlugin,
  PluginHttpRoute,
  PluginService,
  PluginTool,
} from './types.js'
import { PluginError } from './errors.js'

export interface RegisteredChannel {
  pluginId: string
  channel: ChannelPlugin
}

export interface RegisteredService {
  pluginId: string
  service: PluginService
}

export interface RegisteredRoute {
  pluginId: string
  route: PluginHttpRoute
}

export interface RegisteredTool {
  pluginId: string
  tool: PluginTool
}

function routeKey(route: PluginHttpRoute): string {
  return `${route.method ?? 'POST'} ${route.path}`
}

/**
 * Capability sink filled while plugins run `register(api)`.
 *
 * Mirrors openclaw's registration collections: duplicate ids are rejected
 * loudly so a misconfigured plugin cannot silently shadow another one.
 */
export class PluginCapabilities {
  private readonly channelMap = new Map<string, RegisteredChannel>()
  private readonly serviceMap = new Map<string, RegisteredService>()
  private readonly routeList: RegisteredRoute[] = []
  private readonly routeKeys = new Set<string>()
  private readonly toolMap = new Map<string, RegisteredTool>()

  registerChannel(pluginId: string, channel: ChannelPlugin): void {
    if (this.channelMap.has(channel.id))
      throw new PluginError(`Duplicate channel id "${channel.id}"`, pluginId)
    this.channelMap.set(channel.id, { pluginId, channel })
  }

  registerService(pluginId: string, service: PluginService): void {
    if (this.serviceMap.has(service.id))
      throw new PluginError(`Duplicate service id "${service.id}"`, pluginId)
    this.serviceMap.set(service.id, { pluginId, service })
  }

  registerHttpRoute(pluginId: string, route: PluginHttpRoute): void {
    if (!route.path.startsWith('/'))
      throw new PluginError(`HTTP route path must start with "/": ${route.path}`, pluginId)
    const key = routeKey(route)
    if (this.routeKeys.has(key))
      throw new PluginError(`Duplicate HTTP route ${key}`, pluginId)
    this.routeKeys.add(key)
    this.routeList.push({ pluginId, route })
  }

  registerTool(pluginId: string, tool: PluginTool): void {
    if (this.toolMap.has(tool.name))
      throw new PluginError(`Duplicate tool name "${tool.name}"`, pluginId)
    this.toolMap.set(tool.name, { pluginId, tool })
  }

  /** Drop every capability registered by one plugin (used before re-registration). */
  removeByPlugin(pluginId: string): void {
    for (const [id, entry] of this.channelMap) {
      if (entry.pluginId === pluginId)
        this.channelMap.delete(id)
    }
    for (const [id, entry] of this.serviceMap) {
      if (entry.pluginId === pluginId)
        this.serviceMap.delete(id)
    }
    for (const [name, entry] of this.toolMap) {
      if (entry.pluginId === pluginId)
        this.toolMap.delete(name)
    }
    for (let index = this.routeList.length - 1; index >= 0; index--) {
      const entry = this.routeList[index] as RegisteredRoute
      if (entry.pluginId === pluginId) {
        this.routeKeys.delete(routeKey(entry.route))
        this.routeList.splice(index, 1)
      }
    }
  }

  listChannels(): RegisteredChannel[] {
    return [...this.channelMap.values()]
  }

  listServices(): RegisteredService[] {
    return [...this.serviceMap.values()]
  }

  listRoutes(): RegisteredRoute[] {
    return [...this.routeList]
  }

  listTools(): RegisteredTool[] {
    return [...this.toolMap.values()]
  }

  getChannel(id: string): ChannelPlugin | undefined {
    return this.channelMap.get(id)?.channel
  }

  /** Match an inbound request against registered routes (exact wins over prefix). */
  matchRoute(method: string, path: string): RegisteredRoute | null {
    const upperMethod = method.toUpperCase()
    let prefixMatch: RegisteredRoute | null = null
    for (const entry of this.routeList) {
      const routeMethod = entry.route.method ?? 'POST'
      if (routeMethod !== upperMethod)
        continue
      if (entry.route.match === 'prefix') {
        if (path.startsWith(entry.route.path) && !prefixMatch)
          prefixMatch = entry
        continue
      }
      if (path === entry.route.path)
        return entry
    }
    return prefixMatch
  }
}
