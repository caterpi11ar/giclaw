import type { AppConfig } from '../config/schema.js'
import type { GatewaySnapshot } from '../gateway/types.js'
import type { RunSummary } from '../memory/types.js'
import type { RunResult } from '../tasks/task-runner.js'

/**
 * Plugin contracts. The shape mirrors openclaw's plugin system so the two
 * projects stay recognisably aligned:
 *
 * - `PluginManifest`      -> `openclaw.plugin.json` (declarative, never executes code)
 * - `PluginDefinition`    -> `openclaw/plugin-sdk/plugin-entry` default export
 * - `PluginApi`           -> `OpenClawPluginApi` (capability registration surface)
 * - `ChannelPlugin`       -> openclaw channel plugin (`createChatChannelPlugin`)
 *
 * Giclaw has no human<->agent conversation layer, so a channel here is a
 * notification + control transport rather than a chat surface.
 */

export type PluginRegistrationMode = 'full' | 'metadata'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** Secret reference kinds accepted by `configContracts.secretInputs`. */
export type SecretSource = 'env' | 'file' | 'exec' | 'literal'

export interface PluginSecretPath {
  /** Dotted path with `*` wildcards, e.g. `accounts.*.password`. */
  path: string
  expected?: 'string'
  ownerKind?: string
}

export interface PluginConfigContracts {
  secretInputs?: {
    bundledDefaultEnabled?: boolean
    paths: PluginSecretPath[]
  }
  /** Flags that materially weaken security; surfaced as warnings by `giclaw plugins doctor`. */
  dangerousFlags?: Array<{ path: string, equals: JsonValue }>
}

export interface PluginUiHint {
  label?: string
  help?: string
  sensitive?: boolean
  advanced?: boolean
}

/** Declarative manifest, loaded from `giclaw.plugin.json` without executing plugin code. */
export interface PluginManifest {
  id: string
  name: string
  description?: string
  version?: string
  categories?: string[]
  activation?: { onStartup?: boolean }
  enabledByDefault?: boolean
  channels?: string[]
  /** Declarative JSON Schema. Metadata only — runtime validation uses `PluginConfigSchema.parse`. */
  configSchema?: JsonValue
  configContracts?: PluginConfigContracts
  uiHints?: Record<string, PluginUiHint>
}

/** Runtime config parser supplied by a plugin (openclaw: `OpenClawPluginConfigSchema`). */
export interface PluginConfigSchema<T = Record<string, unknown>> {
  parse: (input: unknown) => T
}

export interface PluginLogger {
  debug: (message: string, ...args: unknown[]) => void
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}

/** Trusted runtime helpers handed to plugins (openclaw: `PluginRuntime`). */
export interface PluginRuntime {
  gateway: {
    getSnapshot: () => GatewaySnapshot
    getRunHistory: (limit?: number) => Promise<RunSummary[]>
    enqueueRun: (taskIds?: string[]) => Promise<RunResult>
    /** Resolve a configured routine name (`daily`, `rewards`, ...) to task ids. */
    resolveRoutine: (name: string) => string[] | null
  }
}

export interface PluginServiceContext {
  logger: PluginLogger
  signal: AbortSignal
}

/** Long-running plugin work (openclaw: `OpenClawPluginService`), e.g. an IMAP mailbox watcher. */
export interface PluginService {
  id: string
  start: (context: PluginServiceContext) => void | Promise<void>
  stop?: () => void | Promise<void>
}

export interface PluginHttpRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  /** UTF-8 decoded body, bounded by the web layer before reaching plugins. */
  rawBody: string
  query: Record<string, string>
  remoteAddress: string | null
}

export interface PluginHttpResponse {
  status: number
  headers?: Record<string, string>
  body?: string
}

export type PluginHttpHandler = (
  request: PluginHttpRequest,
) => PluginHttpResponse | Promise<PluginHttpResponse>

/** `plugin` routes authenticate themselves (HMAC / token); `loopback` relies on the web layer. */
export type PluginHttpAuth = 'plugin' | 'loopback'

export interface PluginHttpRoute {
  path: string
  method?: 'GET' | 'POST'
  auth?: PluginHttpAuth
  match?: 'exact' | 'prefix'
  handler: PluginHttpHandler
}

export interface PluginTool {
  name: string
  description: string
  handler: (input: JsonValue) => Promise<JsonValue> | JsonValue
}

export interface ChannelMeta {
  label: string
  selectionLabel?: string
  blurb?: string
  docsPath?: string
  aliases?: string[]
  order?: number
}

export interface ChannelSendTarget {
  /** Route target name from `notifications.routes[].target`. */
  name?: string
  /** Account to send from, when the channel supports more than one. */
  accountId?: string
  /** Opaque plugin-defined destination (chat id, mailbox, room, ...). */
  address?: string
}

export interface ChannelSendContext {
  config: AppConfig
  logger: PluginLogger
  /** `config.channels[<channelId>]`, already secret-resolved. */
  channelConfig: Record<string, unknown>
  target?: ChannelSendTarget
}

export interface ChannelSendResult {
  ok: boolean
  /** Sanitized, human-readable detail for logs and the `run:notify` audit trail. */
  detail?: string
  /** True when the failure is worth retrying (network, 5xx, rate limit). */
  retryable?: boolean
}

export interface ChannelProbeResult {
  ok: boolean
  detail?: string
}

/** Notification payload produced from a gateway run (openclaw: reply payload). */
export interface NotificationMessage {
  level: 'success' | 'error' | 'info'
  title: string
  body: string
  runId: string
  trigger: string
  occurredAt: string
  results: Array<{
    taskId: string
    success: boolean
    message: string
    durationMs: number
  }>
}

export interface ChannelOutbound {
  send: (message: NotificationMessage, context: ChannelSendContext) => Promise<ChannelSendResult>
  probe?: (context: ChannelSendContext) => Promise<ChannelProbeResult>
}

export interface ChannelPlugin {
  id: string
  meta: ChannelMeta
  outbound: ChannelOutbound
}

/** Capability sink filled during `register(api)` (openclaw: plugin registration). */
export interface PluginRegistrationSink {
  registerChannel: (channel: ChannelPlugin) => void
  registerService: (service: PluginService) => void
  registerHttpRoute: (route: PluginHttpRoute) => void
  registerTool: (tool: PluginTool) => void
}

export interface PluginApi extends PluginRegistrationSink {
  registrationMode: PluginRegistrationMode
  pluginConfig: Record<string, unknown>
  config: AppConfig
  logger: PluginLogger
  runtime: PluginRuntime
}

export interface PluginDefinition {
  id?: string
  name?: string
  description?: string
  version?: string
  configSchema?: PluginConfigSchema
  register?: (api: PluginApi) => void
}

/** A discovered plugin: manifest file plus its runtime module. */
export interface DiscoveredPlugin {
  manifest: PluginManifest
  definition: PluginDefinition
  source: string
  /** Bundled plugins ship with Giclaw; external plugins live outside the package. */
  bundled: boolean
}
