import type { BundledPluginModule } from '../plugins/discovery.js'
import feishu, { manifestPath as feishuManifestPath } from './feishu/index.js'
import imap, { manifestPath as imapManifestPath } from './imap/index.js'
import smtp, { manifestPath as smtpManifestPath } from './smtp/index.js'
import webhook, { manifestPath as webhookManifestPath } from './webhook/index.js'

/**
 * Bundled plugins, statically imported so `tsc` emits them into `dist/`.
 *
 * `manifestPath` points at the real `giclaw.plugin.json`, so discovery
 * validates the same manifest that ships to users.
 */
export const bundledPluginModules: BundledPluginModule[] = [
  {
    manifestPath: webhookManifestPath,
    definition: webhook,
    source: 'src/extensions/webhook',
  },
  {
    manifestPath: feishuManifestPath,
    definition: feishu,
    source: 'src/extensions/feishu',
  },
  {
    manifestPath: smtpManifestPath,
    definition: smtp,
    source: 'src/extensions/smtp',
  },
  {
    manifestPath: imapManifestPath,
    definition: imap,
    source: 'src/extensions/imap',
  },
]
