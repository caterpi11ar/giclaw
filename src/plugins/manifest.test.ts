import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginError } from './errors.js'
import {
  parsePluginManifest,
  PLUGIN_ID_PATTERN,
  PLUGIN_MANIFEST_FILENAME,
  readPluginManifest,
} from './manifest.js'

describe('plugin manifest', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'giclaw-manifest-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('exposes the manifest filename and slug pattern', () => {
    expect(PLUGIN_MANIFEST_FILENAME).toBe('giclaw.plugin.json')
    expect(PLUGIN_ID_PATTERN.test('webhook')).toBe(true)
    expect(PLUGIN_ID_PATTERN.test('Webhook')).toBe(false)
    expect(PLUGIN_ID_PATTERN.test('-webhook')).toBe(false)
  })

  it('parses a minimal manifest', () => {
    const manifest = parsePluginManifest({ id: 'webhook', name: 'Webhook' })

    expect(manifest).toEqual({ id: 'webhook', name: 'Webhook' })
  })

  it('parses the full declarative surface', () => {
    const manifest = parsePluginManifest({
      id: 'feishu-connector',
      name: 'Feishu',
      description: 'Feishu connector',
      version: '1.2.3',
      categories: ['integrations'],
      activation: { onStartup: true },
      enabledByDefault: false,
      channels: ['feishu'],
      configSchema: { type: 'object' },
      configContracts: {
        secretInputs: {
          bundledDefaultEnabled: true,
          paths: [{ path: 'appSecret', expected: 'string', ownerKind: 'app' }],
        },
        dangerousFlags: [{ path: 'allowAllSenders', equals: true }],
      },
      uiHints: { appSecret: { label: 'Secret', help: 'App secret', sensitive: true, advanced: true } },
    })

    expect(manifest.channels).toEqual(['feishu'])
    expect(manifest.configContracts?.secretInputs?.paths?.[0]?.path).toBe('appSecret')
    expect(manifest.uiHints?.appSecret?.sensitive).toBe(true)
  })

  it.each([
    [{ name: 'Webhook' }, 'id'],
    [{ id: 'Webhook', name: 'Webhook' }, 'id'],
    [{ id: 'webhook' }, 'name'],
    [{ id: 'webhook', name: '' }, 'name'],
    [{ id: 'webhook', name: 'Webhook', channels: ['Bad Id'] }, 'channels'],
    [{ id: 'webhook', name: 'Webhook', configContracts: { secretInputs: { paths: [] } } }, 'ok'],
    [{ id: 'webhook', name: 'Webhook', uiHints: { a: { sensitive: 'yes' } } }, 'uiHints'],
  ])('rejects invalid manifests (%#)', (input, marker) => {
    if (marker === 'ok') {
      expect(parsePluginManifest(input).configContracts?.secretInputs?.paths).toEqual([])
      return
    }
    expect(() => parsePluginManifest(input)).toThrow(PluginError)
    expect(() => parsePluginManifest(input, 'custom.json')).toThrow(/custom\.json/)
  })

  it('reports the failing path in the error message', () => {
    expect(() => parsePluginManifest({ id: 'Webhook', name: 'Webhook' }))
      .toThrow(/id: must be a lowercase slug/)
  })

  it('reports the root when the manifest is not an object', () => {
    expect(() => parsePluginManifest('nope')).toThrow(/<root>/)
  })

  it('reads and validates a manifest from disk', async () => {
    const path = join(directory, PLUGIN_MANIFEST_FILENAME)
    await writeFile(path, JSON.stringify({ id: 'webhook', name: 'Webhook' }))

    await expect(readPluginManifest(path)).resolves.toEqual({ id: 'webhook', name: 'Webhook' })
  })

  it('fails when the manifest is missing', async () => {
    await expect(readPluginManifest(join(directory, 'missing.json')))
      .rejects
      .toThrow(/Could not read plugin manifest/)
  })

  it('fails when the manifest is not JSON', async () => {
    const path = join(directory, PLUGIN_MANIFEST_FILENAME)
    await writeFile(path, '{ not json')

    await expect(readPluginManifest(path)).rejects.toThrow(/not valid JSON/)
  })

  it('fails when the manifest content is invalid', async () => {
    const path = join(directory, PLUGIN_MANIFEST_FILENAME)
    await writeFile(path, JSON.stringify({ id: 'webhook' }))

    await expect(readPluginManifest(path)).rejects.toThrow(/Invalid plugin manifest/)
  })
})
