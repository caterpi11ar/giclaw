import type { ImapConfig } from './src/config.js'
import { fileURLToPath } from 'node:url'
import { definePluginEntry } from '../../plugin-sdk/index.js'
import { imapPluginConfig, listImapAccounts } from './src/config.js'
import { ImapStateStore } from './src/state.js'
import { ImapAccountWatcher } from './src/watcher.js'

/** Absolute manifest location, used by bundled plugin discovery. */
export const manifestPath = fileURLToPath(new URL('./giclaw.plugin.json', import.meta.url))

/**
 * IMAP inbound connector (mirrors openclaw's `imap` plugin).
 *
 * Unlike openclaw, an accepted message never becomes a prompt: it only selects
 * a configured routine or task list, exactly like the webhook connector's fixed
 * verbs. See `src/watcher.ts` for the polling rules.
 */
const definition = definePluginEntry({
  id: 'imap',
  name: 'Email (IMAP)',
  description: 'Watch IMAP mailboxes and start a configured routine when an allowed sender writes in.',
  version: '0.1.0',
  configSchema: imapPluginConfig,
  register(api) {
    if (api.registrationMode !== 'full')
      return

    const config = api.pluginConfig as unknown as ImapConfig
    const accounts = listImapAccounts(config)

    if (accounts.length === 0) {
      api.logger.warn('IMAP connector is enabled but no mailbox accounts are configured')
      return
    }

    // openclaw's generation guard: a start that was superseded by a newer start
    // or by a stop must not leave its own watchers behind, and a stop may arrive
    // while the first start is still opening the state file.
    let generation = 0
    let watchers: ImapAccountWatcher[] = []

    api.registerService({
      id: 'imap-watch',
      start: async (context) => {
        const previous = watchers
        const activeGeneration = ++generation
        watchers = []
        await Promise.all(previous.map(watcher => watcher.stop()))
        if (activeGeneration !== generation)
          return

        const state = await ImapStateStore.open({ logger: context.logger })
        if (activeGeneration !== generation)
          return

        watchers = accounts.map(({ id, account }) => new ImapAccountWatcher({
          accountId: id,
          account,
          runtime: api.runtime,
          state,
          logger: context.logger,
        }))

        for (const watcher of watchers)
          watcher.start()

        context.logger.info(`IMAP connector watching ${accounts.length} mailbox(es): ${accounts.map(({ id }) => id).join(', ')}`)
      },
      stop: async () => {
        generation += 1
        const active = watchers
        watchers = []
        await Promise.all(active.map(watcher => watcher.stop()))
      },
    })
  },
})

export default definition
