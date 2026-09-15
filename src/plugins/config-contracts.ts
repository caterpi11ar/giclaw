import type { JsonValue, PluginConfigContracts } from './types.js'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { PluginError } from './errors.js'

/** Sentinel written into API/CLI output in place of secret values. */
export const MASKED_SECRET = '***'

/** Matches the string form of a secret reference: `env:NAME` / `file:/abs/path`. */
export const SECRET_REF_PATTERN = /^(env|file):(.+)$/u

export interface SecretResolver {
  env: (name: string) => string | undefined
  file: (path: string) => Promise<string>
}

const DEFAULT_RESOLVER: SecretResolver = {
  env: name => process.env[name],
  file: async path => readFile(path, 'utf-8'),
}

/**
 * Resolve one secret reference.
 *
 * Giclaw deliberately supports only `env:` and `file:` sources. Unlike
 * openclaw, `exec:` is rejected: configuration must never turn into arbitrary
 * command execution inside the daemon.
 */
export async function resolveSecretRef(
  reference: string,
  resolver: SecretResolver = DEFAULT_RESOLVER,
): Promise<string> {
  const match = SECRET_REF_PATTERN.exec(reference)
  if (!match)
    return reference

  const [, source, target] = match as unknown as [string, 'env' | 'file', string]
  if (source === 'env') {
    const value = resolver.env(target)
    if (value === undefined || value === '')
      throw new PluginError(`Secret reference env:${target} is not set`)
    return value
  }

  try {
    const value = (await resolver.file(target)).trim()
    if (value === '')
      throw new PluginError(`Secret reference file:${target} is empty`)
    return value
  }
  catch (error) {
    if (error instanceof PluginError)
      throw error
    throw new PluginError(`Could not read secret reference file:${target}`, undefined, error)
  }
}

/**
 * Recursively resolve `env:` / `file:` references anywhere in a config tree.
 * Arrays and objects are cloned; depth is bounded so a cyclic value cannot hang.
 */
export async function resolveSecretInputs<T>(
  value: T,
  resolver: SecretResolver = DEFAULT_RESOLVER,
  depth = 0,
): Promise<T> {
  if (depth > 32)
    throw new PluginError('Config secret resolution exceeded the maximum depth')

  if (typeof value === 'string') {
    if (!SECRET_REF_PATTERN.test(value))
      return value
    return (await resolveSecretRef(value, resolver)) as unknown as T
  }

  if (Array.isArray(value)) {
    const resolved: unknown[] = []
    for (const item of value)
      resolved.push(await resolveSecretInputs(item, resolver, depth + 1))
    return resolved as unknown as T
  }

  if (value !== null && typeof value === 'object') {
    const resolved: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      resolved[key] = await resolveSecretInputs(item, resolver, depth + 1)
    return resolved as unknown as T
  }

  return value
}

/** Split a contract path such as `accounts.*.password` into segments. */
export function splitConfigPath(path: string): string[] {
  return path.split('.').filter(segment => segment.length > 0)
}

function collectAtPath(value: unknown, segments: string[], index: number, found: unknown[]): void {
  if (index === segments.length) {
    found.push(value)
    return
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return

  const segment = segments[index] as string
  const record = value as Record<string, unknown>
  if (segment === '*') {
    for (const item of Object.values(record))
      collectAtPath(item, segments, index + 1, found)
    return
  }

  if (!Object.hasOwn(record, segment))
    return
  collectAtPath(record[segment], segments, index + 1, found)
}

/** Collect every value addressed by a wildcard path. */
export function readConfigPath(value: unknown, path: string): unknown[] {
  const found: unknown[] = []
  collectAtPath(value, splitConfigPath(path), 0, found)
  return found
}

function maskAtPath(value: unknown, segments: string[], index: number): unknown {
  if (index === segments.length) {
    if (typeof value === 'string')
      return MASKED_SECRET
    return value
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return value

  const segment = segments[index] as string
  const record = value as Record<string, unknown>
  const clone: Record<string, unknown> = { ...record }

  if (segment === '*') {
    for (const key of Object.keys(clone))
      clone[key] = maskAtPath(clone[key], segments, index + 1)
    return clone
  }

  if (Object.hasOwn(clone, segment))
    clone[segment] = maskAtPath(clone[segment], segments, index + 1)
  return clone
}

/**
 * Return a copy of the config with declared secret values replaced by `***`.
 * Used for every API/CLI surface that echoes plugin or channel configuration.
 */
export function maskDeclaredSecrets<T>(value: T, contracts?: PluginConfigContracts): T {
  const paths = contracts?.secretInputs?.paths ?? []
  let masked: unknown = value
  for (const entry of paths)
    masked = maskAtPath(masked, splitConfigPath(entry.path), 0)
  return masked as T
}

/** Report config values that enable a documented dangerous flag. */
export function findDangerousFlags(
  value: unknown,
  contracts?: PluginConfigContracts,
): string[] {
  const flags = contracts?.dangerousFlags ?? []
  const matched: string[] = []
  for (const flag of flags) {
    const equals = flag.equals as JsonValue
    for (const found of readConfigPath(value, flag.path)) {
      if (JSON.stringify(found) === JSON.stringify(equals))
        matched.push(flag.path)
    }
  }
  return matched
}
