import type { SmtpConfig } from './src/config.js'
import { fileURLToPath } from 'node:url'
import { createChannelPlugin, definePluginEntry } from '../../plugin-sdk/index.js'
import { smtpPluginConfig } from './src/config.js'
import { createSmtpOutbound } from './src/outbound.js'

/** Absolute manifest location, used by bundled plugin discovery. */
export const manifestPath = fileURLToPath(new URL('./giclaw.plugin.json', import.meta.url))

/**
 * SMTP outbound connector (Giclaw addition — openclaw has no outbound mail
 * channel; its email integration is inbound IMAP only).
 */
const definition = definePluginEntry({
  id: 'smtp',
  name: 'Email (SMTP)',
  description: 'Email Giclaw run notifications over SMTP (STARTTLS, implicit TLS or a loopback relay).',
  version: '0.1.0',
  configSchema: smtpPluginConfig,
  register(api) {
    if (api.registrationMode !== 'full')
      return

    const config = api.pluginConfig as unknown as SmtpConfig

    api.registerChannel(
      createChannelPlugin({
        id: 'smtp',
        meta: {
          label: 'Email',
          selectionLabel: 'Email (SMTP)',
          blurb: 'Email run notifications to one or more recipients through an SMTP relay.',
          docsPath: '/extensions',
          aliases: ['mail', 'email'],
          order: 90,
        },
        outbound: createSmtpOutbound({ config }),
      }),
    )

    api.logger.info(`SMTP connector registered against ${config.host}:${config.port} (${config.secure})`)
  },
})

export default definition
