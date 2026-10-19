#!/usr/bin/env node

import type { FeishuConfig } from './extensions/feishu/src/config.js'
import type { ProgressEvent } from './utils/progress.js'
import process from 'node:process'
import { Command } from 'commander'
import ora from 'ora'
import { loadConfig } from './config/loader.js'
import { initStateDir, PATHS } from './config/paths.js'
import { Gateway } from './gateway/gateway.js'
import { startGateway } from './gateway/lifecycle.js'
import { STEP_METHODS } from './skills/types.js'
import { toError } from './utils/errors.js'
import { logger } from './utils/logger.js'

const program = new Command()

program
  .name('giclaw')
  .description('AI agent for Genshin Impact cloud gaming')
  .version('0.3.0')
  .option('-c, --config <path>', 'config file path')
  .option('-t, --tasks <ids...>', 'task IDs to run')
  .option('-r, --routine <name>', 'named routine to run')
  .option('--headless', 'force headless mode')
  .option('--no-headless', 'force visible mode')
  .option('--dry-run', 'validate config only, do not execute')
  .option('-v, --verbose', 'enable debug logging')

program
  .command('run', { isDefault: true })
  .description('Run tasks once (default)')
  .action(async () => {
    const opts = program.opts()
    await runOnce(opts)
  })

program
  .command('skills')
  .description('List validated skills, routines, and atomic operations')
  .action(async () => {
    const opts = program.opts()
    const config = await loadConfig({ configPath: opts.config as string | undefined })
    const gateway = new Gateway(config)
    await gateway.init()

    logger.info('Atomic operations:')
    logger.info(`  ${STEP_METHODS.join(', ')}`)
    logger.info('Skills:')
    for (const skill of gateway.getSkillSummaries()) {
      const dependencies = skill.dependsOn.length ? `; depends on ${skill.dependsOn.join(', ')}` : ''
      logger.info(`  ${skill.id} — ${skill.steps} step(s)${dependencies}`)
    }
    logger.info('Routines:')
    for (const [name, ids] of Object.entries(config.tasks.routines))
      logger.info(`  ${name}: ${ids.join(' -> ')}`)
  })

program
  .command('daemon')
  .description('Run as daemon with cron scheduling')
  .option('-p, --port <number>', 'web panel port', '3000')
  .option('--no-web', 'disable web panel')
  .action(async (daemonOpts) => {
    const opts = program.opts()
    await runDaemon(opts, daemonOpts)
  })

program
  .command('evolve')
  .description('Self-iteration loop: diagnose a failing skill, propose a minimal SKILL.md patch, re-run, keep or roll back')
  .option('--skill <id>', 'skill to evolve / accept / reject')
  .option('--status', 'show best-known-good, pending approvals, and recent generations')
  .option('--show <genId>', 'print one generation record as JSON')
  .option('--accept', 'accept the pending candidate for --skill')
  .option('--reject', 'reject the pending candidate for --skill and restore the previous state')
  .option('--apply', 'with --accept, copy the candidate into the committed skills directory')
  .option('--target-dir <dir>', 'directory to apply into (default: ./skills, else ~/.giclaw/skills)')
  .option('--max-generations <n>', 'override evolve.maxGenerations')
  .option('--max-minutes <n>', 'override evolve.maxWallClockMs')
  .option('--no-require-approval', 'auto-accept a passing candidate without human confirmation')
  .option('--dry-run', 'diagnose + propose + validate only; no browser run')
  .action(async (evolveOpts: Record<string, unknown>) => {
    const opts = program.opts()
    const { runEvolveCommand } = await import('./evolve/command.js')
    await runEvolveCommand(opts, evolveOpts)
  })

program
  .command('init')
  .description('Initialize ~/.giclaw/ with interactive setup')
  .option('--non-interactive', 'skip interactive prompts, create defaults only')
  .action(async (initOpts) => {
    const isTTY = process.stdin.isTTY && process.stdout.isTTY
    const nonInteractive = initOpts.nonInteractive || !isTTY

    if (nonInteractive) {
      // Original non-interactive logic
      const { created } = await initStateDir()
      if (created.length === 0) {
        logger.info(`~/.giclaw/ already initialized at ${PATHS.stateDir}`)
      }
      else {
        logger.info(`Initialized ~/.giclaw/ at ${PATHS.stateDir}`)
        for (const f of created) {
          logger.info(`  Created ${f}`)
        }
      }
      return
    }

    // Interactive mode
    const { isModelConfigured, runSetupWizard } = await import(
      './config/wizard.js',
    )

    if (await isModelConfigured()) {
      const { confirm } = await import('@inquirer/prompts')
      const redo = await confirm({
        message:
          'Model is already configured. Do you want to reconfigure?',
        default: false,
      })
      if (!redo) {
        logger.info('No changes made.')
        return
      }
    }

    await runSetupWizard()
  })

program
  .command('plugins')
  .description('List installed plugins, their load state and capabilities')
  .action(async () => {
    const opts = program.opts()
    const config = await loadConfig({ configPath: opts.config as string | undefined })
    const gateway = new Gateway(config)
    await gateway.init()
    const { createPluginHost } = await import('./plugins/bootstrap.js')
    const host = await createPluginHost(config, gateway)
    await host.load()

    const entries = host.getStatus()
    if (entries.length === 0) {
      logger.info('No plugins discovered.')
      return
    }

    for (const entry of entries) {
      const marker = entry.enabled ? (entry.loaded ? '[x]' : '[!]') : '[ ]'
      const version = entry.version ? ` v${entry.version}` : ''
      logger.info(`${marker} ${entry.id} — ${entry.name}${version}${entry.bundled ? ' (bundled)' : ''}`)
      if (entry.description)
        logger.info(`    ${entry.description}`)
      if (entry.channels.length > 0)
        logger.info(`    channels: ${entry.channels.join(', ')}`)
      if (entry.services.length > 0)
        logger.info(`    services: ${entry.services.join(', ')}`)
      if (entry.routes.length > 0)
        logger.info(`    routes: ${entry.routes.join(', ')}`)
      if (entry.tools.length > 0)
        logger.info(`    tools: ${entry.tools.join(', ')}`)
      const failure = host.getFailure(entry.id)
      if (failure)
        logger.warn(`    failed: ${failure}`)
    }
    logger.info('Enable plugins with plugins.enabled in ~/.giclaw/config.json')
  })

program
  .command('channels')
  .description('List notification channels registered by enabled plugins')
  .action(async () => {
    const opts = program.opts()
    const config = await loadConfig({ configPath: opts.config as string | undefined })
    const gateway = new Gateway(config)
    await gateway.init()
    const { createPluginHost } = await import('./plugins/bootstrap.js')
    const host = await createPluginHost(config, gateway)
    await host.load()

    const channels = host.capabilities.listChannels()
    if (channels.length === 0) {
      logger.info('No channels registered. Enable a channel plugin and set notifications.routes.')
      return
    }

    for (const { pluginId, channel } of channels) {
      logger.info(`${channel.id} — ${channel.meta.label} (plugin: ${pluginId})`)
      if (channel.meta.blurb)
        logger.info(`    ${channel.meta.blurb}`)
    }
    logger.info('Routes:')
    if (config.notifications.routes.length === 0) {
      logger.info('  (none configured)')
    }
    else {
      for (const route of config.notifications.routes)
        logger.info(`  ${route.channel}${route.target ? ` -> ${route.target}` : ''}`)
    }
  })

program
  .command('pairing')
  .description('Review and resolve inbound pairing requests (list / approve / dismiss / revoke)')
  .argument('[action]', 'list, approve, dismiss, or revoke', 'list')
  .argument('[channel]', 'channel that implements pairing', 'feishu')
  .argument('[value]', 'pairing code (approve / dismiss) or sender id (revoke)')
  .option('--account <id>', 'channel account id (defaults to the plugin default account)')
  .option('--notify', 'tell the approved sender on the same channel')
  .action(async (action: string, channel: string, value: string | undefined, pairingOpts: PairingCommandOptions) => {
    await runPairing(action, channel, value, pairingOpts)
  })

program
  .command('outbox')
  .description('Inspect the durable notification queue (list / clear)')
  .argument('[action]', 'list or clear', 'list')
  .action(async (action: string) => {
    await runOutbox(action)
  })

program
  .command('config')
  .description('Show resolved config paths')
  .action(() => {
    for (const [key, value] of Object.entries(PATHS)) {
      logger.info(`${key}: ${value}`)
    }
  })

interface PairingCommandOptions {
  account?: string
  notify?: boolean
}

/**
 * `giclaw outbox` — inspect or discard run notifications that could not be
 * delivered. The daemon replays them on its next start; this command exists so
 * an operator can see (or give up on) what is still queued.
 */
async function runOutbox(action: string): Promise<void> {
  const knownActions = ['list', 'clear']
  if (!knownActions.includes(action)) {
    logger.error(`Unknown outbox action "${action}". Use ${knownActions.join(' or ')}.`)
    process.exitCode = 1
    return
  }

  const { NotificationOutbox } = await import('./plugins/outbox.js')
  const outbox = await NotificationOutbox.open()

  if (action === 'clear') {
    const cleared = await outbox.clear()
    logger.info(cleared === 0 ? 'Nothing was queued.' : `Discarded ${cleared} queued notification(s).`)
    return
  }

  const entries = await outbox.list()
  if (entries.length === 0) {
    logger.info('No queued notifications. Failed sends are queued here until the next daemon start.')
    return
  }
  for (const entry of entries) {
    const route = entry.target ? `${entry.channel} -> ${entry.target}` : entry.channel
    logger.info(`${entry.id}  ${route}  attempts=${entry.attempts}  ${entry.createdAt}  run=${entry.message.runId}`)
  }
}

/** Channels that own a pairing store today. */
const PAIRING_CHANNELS = ['feishu']

/**
 * `giclaw pairing` — the CLI half of openclaw's pairing surface (openclaw also
 * exposes the same queue in its Control UI). Only the Feishu connector keeps a
 * pairing store today, so the command talks to that store directly; another
 * channel joins by declaring its own store here.
 */
async function runPairing(
  action: string,
  channel: string,
  value: string | undefined,
  options: PairingCommandOptions,
): Promise<void> {
  const knownActions = ['list', 'approve', 'dismiss', 'revoke']
  if (!knownActions.includes(action)) {
    logger.error(`Unknown pairing action "${action}". Use ${knownActions.join(', ')}.`)
    process.exitCode = 1
    return
  }
  if (!PAIRING_CHANNELS.includes(channel)) {
    logger.error(`Channel "${channel}" does not implement pairing. Known channels: ${PAIRING_CHANNELS.join(', ')}.`)
    process.exitCode = 1
    return
  }

  const opts = program.opts()
  const feishuConfig = await loadFeishuPluginConfig(opts.config as string | undefined)
  const { FeishuPairingStore } = await import('./extensions/feishu/src/pairing.js')
  const store = await FeishuPairingStore.open()
  const account = options.account ?? feishuConfig?.defaultAccount ?? 'default'

  if (action === 'list') {
    const stored = await store.listAccountIds()
    const accounts = options.account === undefined ? Array.from(new Set([...stored, account])) : [account]
    for (const id of accounts) {
      logger.info(`${channel}/${id}:`)
      const pending = await store.listPending(id)
      const pendingCodes = Object.keys(pending)
      if (pendingCodes.length === 0)
        logger.info('  pending: (none)')
      for (const code of pendingCodes) {
        const request = pending[code]
        if (request)
          logger.info(`  pending ${code} -> ${request.subjects.join(', ')}`)
      }
      const approved = await store.readApproved(id)
      logger.info(approved.length === 0 ? '  approved: (none)' : `  approved: ${approved.join(', ')}`)
    }
    return
  }

  if (value === undefined) {
    logger.error(`Usage: giclaw pairing ${action} ${channel} <${action === 'revoke' ? 'sender id' : 'code'}> [--account <id>]`)
    process.exitCode = 1
    return
  }

  if (action === 'approve') {
    const result = await store.approve(account, value)
    if (!result.ok) {
      logger.error(`Cannot approve ${value}: unknown or expired pairing code`)
      process.exitCode = 1
      return
    }
    logger.info(
      result.alreadyApproved
        ? `${result.subjects.join(', ')} were already allowed on ${channel}/${account}`
        : `Approved ${result.subjects.join(', ')} on ${channel}/${account}`,
    )
    if (options.notify)
      await notifyPairedSenders({ config: feishuConfig, account, subjects: result.subjects })
    return
  }

  if (action === 'dismiss') {
    const dismissed = await store.dismiss(account, value)
    if (!dismissed) {
      logger.error(`Cannot dismiss ${value}: unknown or expired pairing code`)
      process.exitCode = 1
      return
    }
    logger.info(`Dismissed pairing request ${value} on ${channel}/${account}`)
    return
  }

  if (action === 'revoke') {
    const revoked = await store.revoke(account, value)
    if (!revoked) {
      logger.error(`Cannot revoke ${value}: the sender is not paired on ${channel}/${account}`)
      process.exitCode = 1
      return
    }
    logger.info(`Revoked ${value} on ${channel}/${account}`)
  }
}

/** The Feishu plugin config, or `null` when the plugin is not configured. */
async function loadFeishuPluginConfig(configPath: string | undefined): Promise<FeishuConfig | null> {
  const config = await loadConfig({ configPath })
  const raw = config.plugins.entries.feishu?.config
  if (raw === undefined)
    return null
  const { feishuConfigSchema } = await import('./extensions/feishu/src/config.js')
  const parsed = feishuConfigSchema.safeParse(raw)
  if (!parsed.success) {
    logger.warn('Feishu plugin config is invalid; using the pairing store only.')
    return null
  }
  return parsed.data
}

/**
 * `--notify`: tell each newly approved sender that pairing succeeded. A failed
 * message is reported but never turns a successful approval into a failure.
 */
async function notifyPairedSenders(params: {
  config: FeishuConfig | null
  account: string
  subjects: string[]
}): Promise<void> {
  if (params.config === null) {
    logger.warn('Cannot notify the requester: the Feishu plugin is not configured.')
    return
  }
  const { resolveFeishuAccount } = await import('./extensions/feishu/src/accounts.js')
  const { createTenantTokenProvider, sendAppMessage } = await import('./extensions/feishu/src/client.js')
  const { resolveFeishuBaseUrl } = await import('./extensions/feishu/src/config.js')
  const resolved = resolveFeishuAccount({ config: params.config, accountId: params.account })
  const { appId, appSecret, httpTimeoutMs } = resolved.config
  if (!appId || !appSecret) {
    logger.warn('Cannot notify the requester: this Feishu account has no app credentials.')
    return
  }
  const baseUrl = resolveFeishuBaseUrl(resolved.config)
  const token = await createTenantTokenProvider({ baseUrl, appId, appSecret, timeoutMs: httpTimeoutMs }).getToken()
  for (const subject of params.subjects) {
    const target = feishuReceiveIdForSubject(subject)
    if (target === null)
      continue
    try {
      await sendAppMessage({
        baseUrl,
        token,
        timeoutMs: httpTimeoutMs,
        receiveIdType: target.receiveIdType,
        receiveId: target.receiveId,
        msgType: 'text',
        content: JSON.stringify({ text: '已通过配对，现在可以向机器人发送指令了。' }),
      })
      logger.info(`Notified ${subject} of the approval.`)
    }
    catch (error) {
      logger.warn(`Approved ${subject}, but the notification failed: ${toError(error).message}`)
    }
  }
}

/** Pairing subjects are stored as `user:<id>`; only a DM target makes sense. */
function feishuReceiveIdForSubject(subject: string): { receiveId: string, receiveIdType: 'open_id' | 'user_id' } | null {
  const prefix = 'user:'
  if (!subject.startsWith(prefix))
    return null
  const receiveId = subject.slice(prefix.length)
  if (receiveId === '')
    return null
  return { receiveId, receiveIdType: receiveId.startsWith('ou_') ? 'open_id' : 'user_id' }
}

function isModelConfigured(config: Awaited<ReturnType<typeof loadConfig>>): boolean {
  return Boolean(config.model.apiKey && config.model.baseUrl && config.model.name)
}

async function runOnce(opts: Record<string, unknown>): Promise<void> {
  const cliOverrides: Record<string, unknown> = {}
  if (opts.headless !== undefined) {
    cliOverrides.browser = { headless: opts.headless as boolean }
  }

  let config = await loadConfig({
    configPath: opts.config as string | undefined,
    cliOverrides,
  })

  // Config check — prompt setup wizard if the resolved config is not configured.
  if (!isModelConfigured(config)) {
    const isTTY = process.stdin.isTTY && process.stdout.isTTY
    if (isTTY && !opts.config) {
      logger.warn(
        'Model not configured. Starting setup wizard...',
      )
      const { runSetupWizard } = await import('./config/wizard.js')
      await runSetupWizard()
      config = await loadConfig({ cliOverrides })
      if (!isModelConfigured(config)) {
        logger.error('Model still not configured. Aborting.')
        process.exitCode = 1
        return
      }
    }
    else {
      logger.error(
        opts.config
          ? `Model not configured in ${String(opts.config)}.`
          : 'Model not configured. Run `giclaw init` to set up your API key and model.',
      )
      process.exitCode = 1
      return
    }
  }

  logger.setLevel(config.logLevel)
  if (opts.verbose) {
    logger.setLevel('debug')
  }

  const gateway = new Gateway(config)
  await gateway.init()
  const requestedTasks = opts.tasks as string[] | undefined
  const routineName = opts.routine as string | undefined
  if (requestedTasks && routineName) {
    logger.error('Use either --tasks or --routine, not both.')
    process.exitCode = 1
    return
  }
  if (routineName && !Object.hasOwn(config.tasks.routines, routineName)) {
    logger.error(`Unknown routine "${routineName}". Available: ${Object.keys(config.tasks.routines).join(', ')}`)
    process.exitCode = 1
    return
  }
  const taskIds = requestedTasks ?? (routineName ? config.tasks.routines[routineName] : undefined)
  // Resolve once up front to validate explicit CLI selections and show the
  // dependency-expanded order in dry-run mode.
  const resolvedTasks = gateway.getTaskRunner().getEnabledTasks(taskIds ?? config.tasks.enabled)

  if (opts.dryRun) {
    logger.info('Dry run — config and skills validated successfully.')
    logger.info(`Execution order: ${resolvedTasks.map(task => task.id).join(' -> ')}`)
    logger.info(`Atomic operations available: ${STEP_METHODS.length}`)
    logger.info('No browser was launched and no model API request was made.')
    return
  }

  // Real-time progress in TTY mode
  const isTTY = process.stderr.isTTY
  let progressCleanup: (() => void) | undefined

  if (isTTY) {
    const formatElapsed = (ms: number): string => {
      const sec = Math.floor(ms / 1000)
      if (sec < 60)
        return `${sec}s`
      const min = Math.floor(sec / 60)
      const s = sec % 60
      return `${min}m ${s.toString().padStart(2, '0')}s`
    }

    const spinner = ora({ stream: process.stderr }).start('Starting...')

    const onProgress = (event: ProgressEvent) => {
      let text = `[${formatElapsed(event.elapsed)}]`
      if (event.phase === 'login') {
        text += ' Logging in...'
      }
      else if (event.phase === 'running') {
        if (event.taskTotal > 0) {
          text += ` Task ${event.taskIndex}/${event.taskTotal}: ${event.taskId ?? ''}`
        }
        if (event.step > 0) {
          text += ` | Step ${event.step}: ${event.action ?? ''}`
        }
        if (event.reason) {
          text += ` — "${event.reason}"`
        }
      }
      else if (event.phase === 'done') {
        text += ' Done'
      }
      else if (event.phase === 'error') {
        text += ` Error: ${event.reason ?? 'unknown'}`
      }
      spinner.text = text
    }

    logger.on('progress', onProgress)
    logger.mute()
    progressCleanup = () => {
      logger.off('progress', onProgress)
      logger.unmute()
      spinner.stop()
    }
  }

  try {
    const result = await gateway.runOnce(taskIds)
    progressCleanup?.()

    for (const r of result.results) {
      const status = r.success ? 'OK' : 'FAIL'
      logger.info(
        `  [${status}] ${r.taskId}: ${r.message} (${r.durationMs}ms)`,
      )
    }

    const failed = result.results.filter(r => !r.success)
    if (failed.length > 0) {
      process.exitCode = 1
    }
  }
  catch (err) {
    progressCleanup?.()
    logger.error('Run failed', err)
    process.exitCode = 1
  }
}

async function runDaemon(
  opts: Record<string, unknown>,
  daemonOpts: Record<string, unknown>,
): Promise<void> {
  const cliOverrides: Record<string, unknown> = {}
  if (opts.headless !== undefined) {
    cliOverrides.browser = { headless: opts.headless as boolean }
  }

  // Commander always supplies the option default when --port is omitted.
  const webPort = Number(daemonOpts.port)
  const webEnabled = daemonOpts.web !== false
  cliOverrides.web = { port: webPort, enabled: webEnabled }

  const config = await loadConfig({
    configPath: opts.config as string | undefined,
    cliOverrides,
  })

  // Daemon mode cannot run an interactive setup wizard.
  if (!isModelConfigured(config)) {
    logger.error('Model not configured. Run `giclaw init` to set up your API key and model.')
    process.exitCode = 1
    return
  }

  logger.setLevel(config.logLevel)
  if (opts.verbose) {
    logger.setLevel('debug')
  }

  await startGateway(config)
}

await program.parseAsync()
