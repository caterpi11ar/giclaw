import type { JsonValue, PluginManifest } from './types.js'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { PluginError } from './errors.js'

/** Manifest filename, mirroring openclaw's `openclaw.plugin.json`. */
export const PLUGIN_MANIFEST_FILENAME = 'giclaw.plugin.json'

/** Plugin ids are used in config keys, routes and log lines, so keep them strict. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const secretPathSchema = z.object({
  path: z.string().min(1).max(500),
  expected: z.literal('string').optional(),
  ownerKind: z.string().min(1).max(100).optional(),
})

const uiHintSchema = z.object({
  label: z.string().max(200).optional(),
  help: z.string().max(2_000).optional(),
  sensitive: z.boolean().optional(),
  advanced: z.boolean().optional(),
})

export const pluginManifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID_PATTERN, 'must be a lowercase slug'),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  version: z.string().min(1).max(100).optional(),
  categories: z.array(z.string().min(1).max(100)).max(50).optional(),
  activation: z.object({ onStartup: z.boolean().optional() }).optional(),
  enabledByDefault: z.boolean().optional(),
  channels: z.array(z.string().regex(PLUGIN_ID_PATTERN)).max(50).optional(),
  configSchema: z.custom<JsonValue>(() => true).optional(),
  configContracts: z
    .object({
      secretInputs: z
        .object({
          bundledDefaultEnabled: z.boolean().optional(),
          paths: z.array(secretPathSchema).max(500),
        })
        .optional(),
      dangerousFlags: z
        .array(z.object({ path: z.string().min(1).max(500), equals: z.custom<JsonValue>(() => true) }))
        .max(200)
        .optional(),
    })
    .optional(),
  uiHints: z.record(uiHintSchema).optional(),
})

/**
 * Validate a manifest object. Reading a manifest must never execute plugin
 * code, so this is a pure, side-effect-free transform.
 */
export function parsePluginManifest(input: unknown, source = PLUGIN_MANIFEST_FILENAME): PluginManifest {
  const result = pluginManifestSchema.safeParse(input)
  if (!result.success) {
    const detail = result.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join(', ')
    throw new PluginError(`Invalid plugin manifest (${source}): ${detail}`)
  }
  return result.data
}

/** Read and validate a `giclaw.plugin.json` file from disk. */
export async function readPluginManifest(manifestPath: string): Promise<PluginManifest> {
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf-8')
  }
  catch (error) {
    throw new PluginError(`Could not read plugin manifest: ${manifestPath}`, undefined, error)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (error) {
    throw new PluginError(`Plugin manifest is not valid JSON: ${manifestPath}`, undefined, error)
  }

  return parsePluginManifest(parsed, manifestPath)
}
