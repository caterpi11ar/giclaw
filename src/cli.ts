import type { ProgressEvent } from './utils/progress.js'
import process from 'node:process'
import { Command } from 'commander'
import ora from 'ora'
import { loadConfig } from './config/loader.js'
import { initStateDir, PATHS } from './config/paths.js'
import { Gateway } from './gateway/gateway.js'
import { startGateway } from './gateway/lifecycle.js'
import { logger } from './utils/logger.js'

const program = new Command()

program
  .name('giclaw')
  .description('AI agent for Genshin Impact cloud gaming')
  .version('0.3.0')
  .option('-c, --config <path>', 'config file path')
  .option('-t, --tasks <ids...>', 'task IDs to run')
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
  .command('daemon')
  .description('Run as daemon with cron scheduling')
  .option('-p, --port <number>', 'web panel port', '3000')
  .option('--no-web', 'disable web panel')
  .action(async (daemonOpts) => {
    const opts = program.opts()
    await runDaemon(opts, daemonOpts)
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
  .command('config')
  .description('Show resolved config paths')
  .action(() => {
    for (const [key, value] of Object.entries(PATHS)) {
      logger.info(`${key}: ${value}`)
    }
  })

async function checkModelConfig(): Promise<boolean> {
  const { isModelConfigured } = await import('./config/wizard.js')
  return isModelConfigured()
}

async function runOnce(opts: Record<string, unknown>): Promise<void> {
  // Config check — prompt setup wizard if not configured
  if (!(await checkModelConfig())) {
    const isTTY = process.stdin.isTTY && process.stdout.isTTY
    if (isTTY) {
      logger.warn(
        'Model not configured. Starting setup wizard...',
      )
      const { runSetupWizard } = await import('./config/wizard.js')
      await runSetupWizard()
      // Re-check after wizard
      if (!(await checkModelConfig())) {
        logger.error('Model still not configured. Aborting.')
        process.exit(1)
      }
    }
    else {
      logger.error(
        'Model not configured. Run `giclaw init` to set up your API key and model.',
      )
      process.exit(1)
    }
  }

  const cliOverrides: Record<string, unknown> = {}
  if (opts.headless !== undefined) {
    cliOverrides.browser = { headless: opts.headless as boolean }
  }

  const config = await loadConfig({
    configPath: opts.config as string | undefined,
    cliOverrides,
  })

  logger.setLevel(config.logLevel)
  if (opts.verbose) {
    logger.setLevel('debug')
  }

  if (opts.dryRun) {
    logger.info('Dry run — config validated successfully:')
    logger.info(JSON.stringify(config, null, 2))
    return
  }

  const gateway = new Gateway(config)
  await gateway.init()
  const taskIds = opts.tasks as string[] | undefined

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
  // Config check — daemon mode cannot run interactive wizard
  if (!(await checkModelConfig())) {
    logger.error(
      'Model not configured. Run `giclaw init` to set up your API key and model.',
    )
    process.exit(1)
  }

  const cliOverrides: Record<string, unknown> = {}
  if (opts.headless !== undefined) {
    cliOverrides.browser = { headless: opts.headless as boolean }
  }

  const webPort = Number(daemonOpts.port ?? 3000)
  const webEnabled = daemonOpts.web !== false
  cliOverrides.web = { port: webPort, enabled: webEnabled }

  const config = await loadConfig({
    configPath: opts.config as string | undefined,
    cliOverrides,
  })

  logger.setLevel(config.logLevel)
  if (opts.verbose) {
    logger.setLevel('debug')
  }

  await startGateway(config)
}

program.parse()
