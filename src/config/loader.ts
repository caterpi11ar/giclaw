import type { AppConfig } from './schema.js'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ConfigError } from '../utils/errors.js'
import { PATHS } from './paths.js'
import { appConfigSchema } from './schema.js'

/**
 * Deep-merge two objects. `b` values override `a` values.
 * Arrays are replaced, not concatenated.
 */
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...a }
  for (const key of Object.keys(b)) {
    const bVal = b[key]
    const aVal = a[key]
    if (
      bVal !== null
      && typeof bVal === 'object'
      && !Array.isArray(bVal)
      && aVal !== null
      && typeof aVal === 'object'
      && !Array.isArray(aVal)
    ) {
      result[key] = deepMerge(
        aVal as Record<string, unknown>,
        bVal as Record<string, unknown>,
      )
    }
    else if (bVal !== undefined) {
      result[key] = bVal
    }
  }
  return result
}

/**
 * Read a JSON config file. Returns empty object if file doesn't exist.
 */
async function loadJsonFile(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(resolve(path), 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw new ConfigError(`Failed to parse config file: ${path}`, err)
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

export interface LoadConfigOptions {
  configPath?: string
  cliOverrides?: Record<string, unknown>
}

// --- Config snapshot cache ---

let _snapshot: AppConfig | null = null

/**
 * Return the cached config snapshot.
 * Throws if loadConfig() has not been called yet.
 */
export function getConfig(): AppConfig {
  if (!_snapshot) {
    throw new ConfigError('Config not loaded. Call loadConfig() first.')
  }
  return _snapshot
}

/**
 * Resolve which config.json file to use.
 *
 * Priority:
 * 1. Explicit CLI --config path (if provided)
 * 2. CWD ./config.json (if it exists — backward compat)
 * 3. ~/.giclaw/config.json (global default)
 */
async function resolveConfigPath(explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    return explicit
  }
  if (await fileExists(resolve('./config.json'))) {
    return './config.json'
  }
  return PATHS.configPath
}

/**
 * Load config with priority: config.json < CLI args.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  const { configPath, cliOverrides = {} } = options
  const resolvedPath = await resolveConfigPath(configPath)

  // Layer 1: JSON file
  const fileConfig = await loadJsonFile(resolvedPath)

  // Layer 2: CLI overrides
  const merged = deepMerge(fileConfig, cliOverrides)

  // Validate
  const result = appConfigSchema.safeParse(merged)
  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
    )
  }

  _snapshot = result.data
  return _snapshot
}
