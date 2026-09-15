import type { DiscoveredPlugin, PluginDefinition } from './types.js'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PluginError } from './errors.js'
import { PLUGIN_MANIFEST_FILENAME, readPluginManifest } from './manifest.js'

/** A bundled plugin module: manifest location plus its statically imported definition. */
export interface BundledPluginModule {
  manifestPath: string
  definition: PluginDefinition
  source: string
}

export interface DiscoveryLogger {
  warn: (message: string, ...args: unknown[]) => void
}

const silentLogger: DiscoveryLogger = { warn: () => {} }

function isPluginDefinition(value: unknown): value is PluginDefinition {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  const candidate = value as PluginDefinition
  return typeof candidate.register === 'function'
    || (candidate.configSchema !== undefined && typeof candidate.configSchema.parse === 'function')
}

/** Layer 1 for bundled plugins: read and validate each manifest, attach its definition. */
export async function discoverBundledPlugins(
  modules: BundledPluginModule[],
): Promise<DiscoveredPlugin[]> {
  const discovered: DiscoveredPlugin[] = []
  const seen = new Set<string>()
  for (const entry of modules) {
    const manifest = await readPluginManifest(entry.manifestPath)
    if (seen.has(manifest.id))
      throw new PluginError(`Duplicate bundled plugin id "${manifest.id}"`, manifest.id)
    seen.add(manifest.id)
    discovered.push({
      manifest,
      definition: entry.definition,
      source: entry.source,
      bundled: true,
    })
  }
  return discovered
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  }
  catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  }
  catch {
    return false
  }
}

const requireFromGiclaw = createRequire(import.meta.url)

/**
 * Resolve an installed package (or a path inside one) to the directory that
 * holds its `package.json`, so `plugins.dirs` may name a package instead of a
 * filesystem location.
 */
function resolveInstalledPackage(specifier: string): string | null {
  for (const candidate of [specifier, `${specifier}/package.json`]) {
    try {
      return dirname(requireFromGiclaw.resolve(candidate))
    }
    catch {
      // Try the next candidate.
    }
  }
  return null
}

/** True when a `plugins.dirs` value can only be meant as a filesystem path. */
function looksLikePath(specifier: string): boolean {
  return isAbsolute(specifier) || specifier.startsWith('.') || specifier.includes(sep)
}

async function readEntrySpecifier(pluginDir: string): Promise<string> {
  try {
    const raw = await readFile(join(pluginDir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { giclaw?: { entry?: unknown }, main?: unknown }
    const entry = pkg.giclaw?.entry ?? pkg.main
    if (typeof entry === 'string' && entry.length > 0)
      return entry
  }
  catch {
    // No package.json, or unreadable: fall through to the default entry name.
  }
  return 'index.js'
}

/**
 * Layer 1 for external plugins. Each `plugins.dirs` entry is either:
 *
 * - a plugin package itself (it holds a `giclaw.plugin.json`),
 * - a directory of `<id>/` plugin packages, or
 * - the name of an installed package, resolved from Giclaw's own `node_modules`.
 *
 * A malformed plugin is reported and skipped so one bad third-party package
 * cannot prevent the daemon from starting.
 */
export async function discoverExternalPlugins(
  dirs: string[],
  logger: DiscoveryLogger = silentLogger,
): Promise<DiscoveredPlugin[]> {
  const discovered: DiscoveredPlugin[] = []
  const seen = new Set<string>()

  for (const dir of dirs) {
    const folder = resolve(dir)
    if (await isDirectory(folder)) {
      if (await isFile(join(folder, PLUGIN_MANIFEST_FILENAME))) {
        const plugin = await loadPluginDirectory(folder, logger, seen)
        if (plugin)
          discovered.push(plugin)
        continue
      }

      const entries = await readdir(folder, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory())
          continue
        const plugin = await loadPluginDirectory(join(folder, entry.name), logger, seen)
        if (plugin)
          discovered.push(plugin)
      }
      continue
    }

    const installed = looksLikePath(dir) ? null : resolveInstalledPackage(dir)
    if (installed === null) {
      if (!looksLikePath(dir))
        logger.warn(`Skipping external plugin source "${dir}": not a directory and not an installed package`)
      continue
    }
    const plugin = await loadPluginDirectory(installed, logger, seen)
    if (plugin)
      discovered.push(plugin)
  }

  return discovered
}

/** Load one plugin package directory; failures are reported, never thrown. */
async function loadPluginDirectory(
  pluginDir: string,
  logger: DiscoveryLogger,
  seen: Set<string>,
): Promise<DiscoveredPlugin | null> {
  try {
    const manifest = await readPluginManifest(join(pluginDir, PLUGIN_MANIFEST_FILENAME))
    if (seen.has(manifest.id)) {
      logger.warn(`Skipping external plugin "${manifest.id}" from ${pluginDir}: id already loaded`)
      return null
    }
    const entrySpecifier = await readEntrySpecifier(pluginDir)
    const moduleUrl = pathToFileURL(resolve(pluginDir, entrySpecifier)).href
    const imported = (await import(moduleUrl)) as { default?: unknown }
    if (!isPluginDefinition(imported.default))
      throw new PluginError(`Entry module ${entrySpecifier} has no default plugin definition`, manifest.id)
    seen.add(manifest.id)
    return {
      manifest,
      definition: imported.default,
      source: pluginDir,
      bundled: false,
    }
  }
  catch (error) {
    logger.warn(`Skipping external plugin in ${pluginDir}: ${(error as Error).message}`)
    return null
  }
}
