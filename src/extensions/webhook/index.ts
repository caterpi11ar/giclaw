import type { WebhookConfig } from './src/config.js'
import { fileURLToPath } from 'node:url'
import { createChannelPlugin, defineChannelPluginEntry } from '../../plugin-sdk/index.js'
import { webhookPluginConfig } from './src/config.js'
import { createWebhookInboundHandler } from './src/inbound.js'
import { createWebhookOutbound } from './src/outbound.js'

/** Absolute manifest location, used by bundled plugin discovery. */
export const manifestPath = fileURLToPath(new URL('./giclaw.plugin.json', import.meta.url))

/**
 * Reference connector: signed outbound notifications plus an authenticated
 * inbound route that can trigger runs with fixed verbs.
 */
const definition = defineChannelPluginEntry({
  id: 'webhook',
  name: 'Webhook',
  description:
    'Signed outbound notifications and an authenticated inbound webhook that can trigger Giclaw runs.',
  version: '0.1.0',
  configSchema: webhookPluginConfig,
  register(api) {
    // Services and routes only make sense once the runtime is live.
    if (api.registrationMode !== 'full')
      return

    const config = api.pluginConfig as unknown as WebhookConfig

    api.registerChannel(
      createChannelPlugin({
        id: 'webhook',
        meta: {
          label: 'Webhook',
          blurb: 'POST run notifications as JSON to an HTTPS endpoint, signed with HMAC-SHA256.',
          order: 90,
        },
        outbound: createWebhookOutbound({ config }),
      }),
    )

    if (config.inbound) {
      api.registerHttpRoute({
        path: config.inbound.path,
        method: 'POST',
        auth: 'plugin',
        match: 'exact',
        handler: createWebhookInboundHandler({
          inbound: config.inbound,
          runtime: api.runtime,
          logger: api.logger,
        }),
      })
      api.logger.info(`Inbound webhook listening on ${config.inbound.path}`)
    }
  },
})

export default definition
