import type { ChannelPlugin, PluginDefinition } from '../plugins/types.js'
import { PluginError } from '../plugins/errors.js'
import { PLUGIN_ID_PATTERN } from '../plugins/manifest.js'

function assertDefinition(definition: PluginDefinition, requireId: boolean): void {
  if (requireId) {
    if (typeof definition.id !== 'string' || !PLUGIN_ID_PATTERN.test(definition.id))
      throw new PluginError('defineChannelPluginEntry requires a lowercase slug `id`', definition.id)
  }
  if (definition.register !== undefined && typeof definition.register !== 'function')
    throw new PluginError('Plugin `register` must be a function', definition.id)
  if (definition.configSchema !== undefined && typeof definition.configSchema.parse !== 'function')
    throw new PluginError('Plugin `configSchema` must expose a `parse` function', definition.id)
}

/**
 * Typed identity helper mirroring openclaw's `definePluginEntry`.
 *
 * It validates the definition shape at module load so a malformed bundled
 * plugin fails fast during discovery instead of at first use.
 */
export function definePluginEntry(definition: PluginDefinition): PluginDefinition {
  assertDefinition(definition, false)
  return Object.freeze({ ...definition })
}

/** Channel plugin entry: same as `definePluginEntry`, but `id` is required. */
export function defineChannelPluginEntry(definition: PluginDefinition & { id: string }): PluginDefinition {
  assertDefinition(definition, true)
  return Object.freeze({ ...definition })
}

/**
 * Setup-stage entry (openclaw: `defineSetupPluginEntry`). Setup runs with
 * `registrationMode: "metadata"`, so registering services here is skipped by
 * plugins that honour the mode.
 */
export function defineSetupPluginEntry(definition: PluginDefinition): PluginDefinition {
  assertDefinition(definition, false)
  return Object.freeze({ ...definition })
}

export interface CreateChannelPluginInput {
  id: string
  meta: ChannelPlugin['meta']
  outbound: ChannelPlugin['outbound']
}

/** Build a channel plugin after validating that its id is a lowercase slug. */
export function createChannelPlugin(input: CreateChannelPluginInput): ChannelPlugin {
  if (!PLUGIN_ID_PATTERN.test(input.id))
    throw new PluginError(`Invalid channel id "${input.id}"`, input.id)
  return {
    id: input.id,
    meta: { ...input.meta },
    outbound: input.outbound,
  }
}
