import type { ChannelPlugin, PluginHttpRoute, PluginService, PluginTool } from './types.js'
import { describe, expect, it, vi } from 'vitest'
import { PluginCapabilities } from './capabilities.js'
import { PluginError } from './errors.js'

function channel(id: string): ChannelPlugin {
  return {
    id,
    meta: { label: id },
    outbound: { send: vi.fn(async () => ({ ok: true })) },
  }
}

function service(id: string): PluginService {
  return { id, start: vi.fn(), stop: vi.fn() }
}

function route(path: string, extra: Partial<PluginHttpRoute> = {}): PluginHttpRoute {
  return { path, handler: () => ({ status: 200 }), ...extra }
}

function tool(name: string): PluginTool {
  return { name, description: name, handler: () => null }
}

describe('pluginCapabilities', () => {
  it('registers and lists every capability kind', () => {
    const capabilities = new PluginCapabilities()
    capabilities.registerChannel('webhook', channel('webhook'))
    capabilities.registerService('imap', service('imap-watcher'))
    capabilities.registerHttpRoute('webhook', route('/api/ext/webhook'))
    capabilities.registerTool('webhook', tool('send'))

    expect(capabilities.listChannels().map(entry => entry.channel.id)).toEqual(['webhook'])
    expect(capabilities.listServices().map(entry => entry.service.id)).toEqual(['imap-watcher'])
    expect(capabilities.listRoutes().map(entry => entry.route.path)).toEqual(['/api/ext/webhook'])
    expect(capabilities.listTools().map(entry => entry.tool.name)).toEqual(['send'])
    expect(capabilities.getChannel('webhook')?.id).toBe('webhook')
    expect(capabilities.getChannel('missing')).toBeUndefined()
  })

  it('rejects duplicate ids and overlapping routes', () => {
    const capabilities = new PluginCapabilities()
    capabilities.registerChannel('a', channel('dup'))
    capabilities.registerService('a', service('dup'))
    capabilities.registerHttpRoute('a', route('/api/ext/dup'))
    capabilities.registerTool('a', tool('dup'))

    expect(() => capabilities.registerChannel('b', channel('dup'))).toThrow(PluginError)
    expect(() => capabilities.registerService('b', service('dup'))).toThrow(PluginError)
    expect(() => capabilities.registerHttpRoute('b', route('/api/ext/dup'))).toThrow(PluginError)
    expect(() => capabilities.registerTool('b', tool('dup'))).toThrow(PluginError)
  })

  it('rejects routes that do not start with a slash', () => {
    const capabilities = new PluginCapabilities()
    expect(() => capabilities.registerHttpRoute('a', route('api/ext'))).toThrow(/must start with/)
  })

  it('treats a different method on the same path as a distinct route', () => {
    const capabilities = new PluginCapabilities()
    capabilities.registerHttpRoute('a', route('/api/ext/x', { method: 'POST' }))
    expect(() => capabilities.registerHttpRoute('b', route('/api/ext/x', { method: 'GET' }))).not.toThrow()
    expect(capabilities.listRoutes()).toHaveLength(2)
  })

  it('drops every capability registered by one plugin', () => {
    const capabilities = new PluginCapabilities()
    capabilities.registerChannel('a', channel('a-channel'))
    capabilities.registerChannel('b', channel('b-channel'))
    capabilities.registerService('a', service('a-service'))
    capabilities.registerHttpRoute('a', route('/api/ext/a'))
    capabilities.registerHttpRoute('b', route('/api/ext/b'))
    capabilities.registerTool('a', tool('a-tool'))

    capabilities.removeByPlugin('a')

    expect(capabilities.listChannels().map(entry => entry.channel.id)).toEqual(['b-channel'])
    expect(capabilities.listServices()).toEqual([])
    expect(capabilities.listRoutes().map(entry => entry.route.path)).toEqual(['/api/ext/b'])
    expect(capabilities.listTools()).toEqual([])
  })

  it('allows the removed route to be registered again', () => {
    const capabilities = new PluginCapabilities()
    capabilities.registerHttpRoute('a', route('/api/ext/a'))
    capabilities.removeByPlugin('a')
    expect(() => capabilities.registerHttpRoute('a', route('/api/ext/a'))).not.toThrow()
  })

  it('matches routes by method, preferring exact over prefix', () => {
    const capabilities = new PluginCapabilities()
    capabilities.registerHttpRoute('a', route('/api/ext/hook', { match: 'prefix' }))
    capabilities.registerHttpRoute('b', route('/api/ext/hook/exact'))

    expect(capabilities.matchRoute('POST', '/api/ext/hook/exact')?.pluginId).toBe('b')
    expect(capabilities.matchRoute('post', '/api/ext/hook/other')?.pluginId).toBe('a')
    expect(capabilities.matchRoute('GET', '/api/ext/hook/exact')).toBeNull()
    expect(capabilities.matchRoute('POST', '/api/ext/other')).toBeNull()
  })

  it('uses POST as the default route method', () => {
    const capabilities = new PluginCapabilities()
    capabilities.registerHttpRoute('a', route('/api/ext/default'))
    expect(capabilities.matchRoute('POST', '/api/ext/default')?.pluginId).toBe('a')
  })

  it('keeps the first prefix match when several could apply', () => {
    const capabilities = new PluginCapabilities()
    capabilities.registerHttpRoute('a', route('/api/ext/', { match: 'prefix' }))
    capabilities.registerHttpRoute('b', route('/api/ext/hook', { match: 'prefix' }))

    expect(capabilities.matchRoute('POST', '/api/ext/hook/deep')?.pluginId).toBe('a')
  })
})
