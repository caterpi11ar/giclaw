import { describe, expect, it } from 'vitest'
import { bundledPluginModules } from './index.js'

describe('bundled plugin registry', () => {
  it('lists the built-in connectors once', () => {
    const ids = bundledPluginModules.map(module => module.manifestPath)
    expect(new Set(ids).size).toBe(ids.length)
    expect(bundledPluginModules.map(module => module.definition.id)).toEqual(['webhook', 'feishu', 'smtp', 'imap'])
    expect(ids.every(id => id.endsWith('giclaw.plugin.json'))).toBe(true)
    expect(ids[0]?.endsWith('extensions/webhook/giclaw.plugin.json')).toBe(true)
  })

  it('binds every entry to a plugin definition with an id', () => {
    for (const module of bundledPluginModules) {
      expect(typeof module.definition).toBe('object')
      expect(module.definition.id).toMatch(/^[a-z0-9-]+$/)
      expect(module.source).toMatch(/^src\/extensions\//)
    }
  })
})
