import { describe, expect, it } from 'vitest'
import * as barrel from './index.js'

describe('plugins barrel', () => {
  it('re-exports the plugin kernel surface', () => {
    expect(barrel.PluginError).toBeDefined()
    expect(barrel.PluginHost).toBeDefined()
    expect(barrel.PluginCapabilities).toBeDefined()
    expect(barrel.NotificationDispatcher).toBeDefined()
    expect(barrel.ServiceManager).toBeDefined()
    expect(barrel.PLUGIN_MANIFEST_FILENAME).toBe('giclaw.plugin.json')
    expect(barrel.MASKED_SECRET).toBe('***')
    expect(barrel.bundledPluginModules.length).toBeGreaterThan(0)
    expect(typeof barrel.bootstrapPlugins).toBe('function')
    expect(typeof barrel.createPluginHost).toBe('function')
    expect(typeof barrel.createPluginRuntime).toBe('function')
    expect(typeof barrel.discoverAllPlugins).toBe('function')
    expect(typeof barrel.discoverBundledPlugins).toBe('function')
    expect(typeof barrel.discoverExternalPlugins).toBe('function')
    expect(typeof barrel.maskDeclaredSecrets).toBe('function')
    expect(typeof barrel.parsePluginManifest).toBe('function')
    expect(typeof barrel.readPluginManifest).toBe('function')
    expect(typeof barrel.resolveSecretInputs).toBe('function')
  })
})
