import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import webhook from '../extensions/webhook/index.js'
import { discoverBundledPlugins, discoverExternalPlugins } from './discovery.js'
import { readPluginManifest } from './manifest.js'

/**
 * `plugins.dirs` may name an installed package, which is resolved from Giclaw's
 * own `node_modules`. The map below stands in for that resolution so the test
 * does not have to install a package.
 */
const installedPackages = new Map<string, string>()

vi.mock('node:module', () => ({
  createRequire: () => ({
    resolve: (specifier: string) => {
      const target = installedPackages.get(specifier)
      if (target === undefined)
        throw new Error(`Cannot find module '${specifier}'`)
      return target
    },
  }),
}))

const webhookManifestPath = fileURLToPath(
  new URL('../extensions/webhook/giclaw.plugin.json', import.meta.url),
)

interface WritablePlugin {
  id: string
  name?: string
  entry?: string
  indexSource?: string
  packageJson?: unknown
  manifest?: string | null
}

describe('discoverBundledPlugins', () => {
  it('reads the shipped manifest and attaches the module definition', async () => {
    const discovered = await discoverBundledPlugins([
      { manifestPath: webhookManifestPath, definition: webhook, source: 'bundled' },
    ])

    expect(discovered).toHaveLength(1)
    expect(discovered[0]?.manifest.id).toBe('webhook')
    expect(discovered[0]?.definition).toBe(webhook)
    expect(discovered[0]?.bundled).toBe(true)
  })

  it('rejects two bundled plugins sharing an id', async () => {
    await expect(discoverBundledPlugins([
      { manifestPath: webhookManifestPath, definition: webhook, source: 'a' },
      { manifestPath: webhookManifestPath, definition: webhook, source: 'b' },
    ])).rejects.toThrow(/Duplicate bundled plugin id "webhook"/)
  })
})

describe('discoverExternalPlugins', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'giclaw-plugins-'))
  })

  afterEach(async () => {
    installedPackages.clear()
    await rm(directory, { recursive: true, force: true })
  })

  async function writePlugin(spec: WritablePlugin): Promise<string> {
    const pluginDir = join(directory, spec.id)
    await mkdir(pluginDir, { recursive: true })
    const manifest = spec.manifest === undefined
      ? JSON.stringify({ id: spec.id, name: spec.name ?? spec.id })
      : spec.manifest
    if (manifest !== null)
      await writeFile(join(pluginDir, 'giclaw.plugin.json'), manifest)
    if (spec.packageJson !== undefined)
      await writeFile(join(pluginDir, 'package.json'), JSON.stringify(spec.packageJson))
    const entryPath = join(pluginDir, spec.entry ?? 'index.js')
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(
      entryPath,
      spec.indexSource ?? 'export default { id: \'x\', register() {} }\n',
    )
    return pluginDir
  }

  it('ignores directories that do not exist', async () => {
    await expect(discoverExternalPlugins([join(directory, 'nope')])).resolves.toEqual([])
  })

  it('ignores plain files and manifest-less folders', async () => {
    await writeFile(join(directory, 'loose.txt'), 'ignored')
    await mkdir(join(directory, 'empty'))
    await expect(discoverExternalPlugins([directory])).resolves.toEqual([])
  })

  it('loads a plugin with a default entry module', async () => {
    await writePlugin({ id: 'greeter' })

    const discovered = await discoverExternalPlugins([directory])

    expect(discovered).toHaveLength(1)
    expect(discovered[0]?.manifest.id).toBe('greeter')
    expect(discovered[0]?.bundled).toBe(false)
    expect(typeof discovered[0]?.definition.register).toBe('function')
  })

  it('honours the giclaw.entry package field', async () => {
    await writePlugin({
      id: 'greeter',
      entry: 'dist/main.js',
      packageJson: { giclaw: { entry: './dist/main.js' } },
    })

    const discovered = await discoverExternalPlugins([directory])

    expect(discovered).toHaveLength(1)
    expect(discovered[0]?.source).toBe(join(directory, 'greeter'))
  })

  it('falls back to the main package field', async () => {
    await writePlugin({ id: 'greeter', entry: 'lib/main.js', packageJson: { main: 'lib/main.js' } })

    await expect(discoverExternalPlugins([directory])).resolves.toHaveLength(1)
  })

  it('ignores a package.json without a usable entry field', async () => {
    await writePlugin({ id: 'greeter', packageJson: { main: 42 } })

    await expect(discoverExternalPlugins([directory])).resolves.toHaveLength(1)
  })

  it('ignores an unreadable package.json', async () => {
    const pluginDir = await writePlugin({ id: 'greeter', packageJson: { main: 'index.js' } })
    await writeFile(join(pluginDir, 'package.json'), '{ not json')

    await expect(discoverExternalPlugins([directory])).resolves.toHaveLength(1)
  })

  it('accepts a definition that only declares a config schema', async () => {
    await writePlugin({
      id: 'declarative',
      indexSource: 'export default { configSchema: { parse: input => input } }\n',
    })

    await expect(discoverExternalPlugins([directory])).resolves.toHaveLength(1)
  })

  it('skips an entry module without a plugin definition', async () => {
    const logger = { warn: vi.fn() }
    await writePlugin({ id: 'broken', indexSource: 'export default 42\n' })

    await expect(discoverExternalPlugins([directory], logger)).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no default plugin definition'))
  })

  it('skips an invalid manifest', async () => {
    const logger = { warn: vi.fn() }
    await writePlugin({ id: 'broken', manifest: JSON.stringify({ id: 'Nope', name: 'Broken' }) })

    await expect(discoverExternalPlugins([directory], logger)).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping external plugin in'))
  })

  it('skips a plugin whose entry module is missing', async () => {
    const logger = { warn: vi.fn() }
    const pluginDir = await writePlugin({ id: 'broken' })
    await rm(join(pluginDir, 'index.js'))

    await expect(discoverExternalPlugins([directory], logger)).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalled()
  })

  it('keeps only the first copy of a duplicated id across directories', async () => {
    const second = await mkdtemp(join(tmpdir(), 'giclaw-plugins-'))
    try {
      await writePlugin({ id: 'duplicate' })
      const pluginDir = join(second, 'duplicate')
      await mkdir(pluginDir, { recursive: true })
      await writeFile(join(pluginDir, 'giclaw.plugin.json'), JSON.stringify({ id: 'duplicate', name: 'Dup' }))
      await writeFile(join(pluginDir, 'index.js'), 'export default { register() {} }\n')

      const logger = { warn: vi.fn() }
      const discovered = await discoverExternalPlugins([directory, second], logger)

      expect(discovered).toHaveLength(1)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('id already loaded'))
    }
    finally {
      await rm(second, { recursive: true, force: true })
    }
  })

  it('loads a directory that is itself a plugin package', async () => {
    const pluginDir = await writePlugin({ id: 'greeter' })

    const discovered = await discoverExternalPlugins([pluginDir])

    expect(discovered.map(plugin => plugin.manifest.id)).toEqual(['greeter'])
    expect(discovered[0]?.source).toBe(pluginDir)
  })

  it('resolves an installed package through its package.json', async () => {
    const pluginDir = await writePlugin({ id: 'greeter' })
    installedPackages.set('giclaw-plugin-greeter/package.json', join(pluginDir, 'package.json'))

    const discovered = await discoverExternalPlugins(['giclaw-plugin-greeter'])

    expect(discovered.map(plugin => plugin.manifest.id)).toEqual(['greeter'])
    expect(discovered[0]?.source).toBe(pluginDir)
  })

  it('resolves an installed package through its entry point', async () => {
    const pluginDir = await writePlugin({ id: 'greeter' })
    installedPackages.set('giclaw-plugin-greeter', join(pluginDir, 'index.js'))

    const discovered = await discoverExternalPlugins(['giclaw-plugin-greeter'])

    expect(discovered.map(plugin => plugin.manifest.id)).toEqual(['greeter'])
  })

  it('warns when a resolved package holds no manifest', async () => {
    const logger = { warn: vi.fn() }
    await mkdir(join(directory, 'empty-package'))
    await writeFile(join(directory, 'empty-package', 'index.js'), 'export default {}\n')
    installedPackages.set('giclaw-plugin-empty', join(directory, 'empty-package', 'index.js'))

    await expect(discoverExternalPlugins(['giclaw-plugin-empty'], logger)).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping external plugin in'))
  })

  it('warns about a name that is neither a directory nor an installed package', async () => {
    const logger = { warn: vi.fn() }

    await expect(discoverExternalPlugins(['giclaw-plugin-missing'], logger)).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping external plugin source "giclaw-plugin-missing": not a directory and not an installed package',
    )
  })

  it('stays silent about a relative path that does not exist', async () => {
    const logger = { warn: vi.fn() }

    await expect(discoverExternalPlugins(['./nowhere'], logger)).resolves.toEqual([])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('shares the same manifest reader used for bundled plugins', async () => {
    await expect(readPluginManifest(webhookManifestPath)).resolves.toMatchObject({ id: 'webhook' })
  })
})
