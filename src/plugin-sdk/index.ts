export { MASKED_SECRET, SECRET_REF_PATTERN } from '../plugins/config-contracts.js'

export { PLUGIN_ID_PATTERN, PLUGIN_MANIFEST_FILENAME } from '../plugins/manifest.js'

export type {
  ChannelMeta,
  ChannelOutbound,
  ChannelPlugin,
  ChannelProbeResult,
  ChannelSendContext,
  ChannelSendResult,
  ChannelSendTarget,
  DiscoveredPlugin,
  JsonPrimitive,
  JsonValue,
  NotificationMessage,
  PluginApi,
  PluginConfigContracts,
  PluginConfigSchema,
  PluginDefinition,
  PluginHttpAuth,
  PluginHttpHandler,
  PluginHttpRequest,
  PluginHttpResponse,
  PluginHttpRoute,
  PluginLogger,
  PluginManifest,
  PluginRegistrationMode,
  PluginRuntime,
  PluginSecretPath,
  PluginService,
  PluginServiceContext,
  PluginTool,
} from '../plugins/types.js'
/**
 * Public plugin SDK facade.
 *
 * Plugins import only from here (openclaw: `openclaw/plugin-sdk/*`), which keeps
 * the internal module layout free to change.
 */
export {
  createChannelPlugin,
  defineChannelPluginEntry,
  definePluginEntry,
  defineSetupPluginEntry,
} from './definitions.js'

export type { CreateChannelPluginInput } from './definitions.js'

export {
  constantTimeEquals,
  createInFlightLimiter,
  createRateLimiter,
  createRecentKeySet,
  DEFAULT_IDENTIFIER_AUTHENTICATION,
  matchesSenderAllowlist,
  meetsIdentifierAuthentication,
  readHeader,
  readHeaderValue,
} from './inbound.js'

export type {
  IdentifierAuthentication,
  InFlightLimiter,
  InFlightLimiterOptions,
  RateLimiter,
  RateLimiterOptions,
  RecentKeySet,
} from './inbound.js'
