import type { AppConfig } from '../config/schema.js'
import type { EvolveOutcome } from './engine.js'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { loadConfig } from '../config/loader.js'
import { atomicWritePrivateFile, PATHS } from '../config/paths.js'
import { Gateway } from '../gateway/gateway.js'
import { EvolveError, toError } from '../utils/errors.js'
import { logger, sanitizeBoundedText } from '../utils/logger.js'
import { runEvolve } from './engine.js'
import { createChatCall } from './model-client.js'
import { EvolveStore } from './store.js'
import { evolveBudgetSchema } from './types.js'

/**
 * `giclaw evolve` command handler.
 *
 * Keeps the CLI thin: it resolves config/paths, builds the real dependencies
 * (Gateway runs, OpenAI-compatible model call, on-disk store), and delegates the
 * state machine to `runEvolve`. Subcommands (`--status`, `--show`, `--accept`,
 * `--reject`) only read or restore state and never launch a browser.
 */

export interface EvolveGlobalOptions {
  config?: string
  headless?: boolean
  verbose?: boolean
  dryRun?: boolean
}

export interface EvolveCommandOptions {
  skill?: string
  status?: boolean
  show?: string
  accept?: boolean
  reject?: boolean
  apply?: boolean
  targetDir?: string
  maxGenerations?: string
  maxMinutes?: string
  requireApproval?: boolean
  dryRun?: boolean
}

export async function runEvolveCommand(
  globalOptions: EvolveGlobalOptions,
  options: EvolveCommandOptions,
): Promise<void> {
  const cliOverrides: Record<string, unknown> = {}
  if (globalOptions.headless !== undefined)
    cliOverrides.browser = { headless: globalOptions.headless }

  const config = await loadConfig({
    configPath: globalOptions.config,
    cliOverrides,
  })
  logger.setLevel(config.logLevel)
  if (globalOptions.verbose)
    logger.setLevel('debug')

  const store = new EvolveStore({
    evolveDir: join(PATHS.stateDir, 'evolve'),
    overrideSkillsDir: PATHS.skillsDir,
  })
  await store.ensure()

  if (options.show !== undefined) {
    await showGeneration(store, options.show)
    return
  }
  if (options.status) {
    await showStatus(store)
    return
  }

  const skillId = options.skill
  if (!skillId) {
    logger.error('Specify --skill <id>, or use --status / --show <genId>.')
    process.exitCode = 2
    return
  }

  try {
    if (options.accept) {
      await acceptCandidate(store, skillId, options)
      return
    }
    if (options.reject) {
      await rejectCandidate(store, skillId)
      return
    }
    await evolveOne(config, store, skillId, {
      ...options,
      // `--dry-run` is a global option, so commander may attach it to the
      // program rather than the subcommand. Honour either location.
      dryRun: options.dryRun ?? globalOptions.dryRun ?? false,
    })
  }
  catch (error) {
    logger.error(`evolve failed: ${sanitizeBoundedText(toError(error).message, 2_000)}`)
    process.exitCode = 1
  }
}

async function evolveOne(
  config: AppConfig,
  store: EvolveStore,
  skillId: string,
  options: EvolveCommandOptions,
): Promise<void> {
  if (!config.model.name || !config.model.baseUrl || !config.model.apiKey) {
    logger.error('Model not configured. Run `giclaw init` before evolving skills.')
    process.exitCode = 1
    return
  }
  const allowed = config.evolve.allowedSkills
  if (allowed.length > 0 && !allowed.includes(skillId)) {
    logger.error(`Skill "${skillId}" is not in evolve.allowedSkills (${allowed.join(', ')}).`)
    process.exitCode = 1
    return
  }

  const budget = buildBudget(config, options)
  const gateway = new Gateway(config)
  await gateway.init()

  const definition = gateway.getSkillDefinition(skillId)
  if (!definition) {
    logger.error(`Unknown skill "${skillId}". Run \`giclaw skills\` to list available skills.`)
    process.exitCode = 1
    return
  }
  if (definition.context) {
    logger.error(`"${skillId}" is a context skill (context: true) and cannot be evolved.`)
    process.exitCode = 1
    return
  }
  if (!config.evolve.enabled)
    logger.warn('evolve.enabled is false; continuing because `giclaw evolve` was invoked explicitly.')

  const modelCall = createChatCall({
    name: config.model.name,
    baseUrl: config.model.baseUrl,
    apiKey: config.model.apiKey,
    timeoutMs: config.evolve.modelTimeoutMs,
  })

  logger.info(`Evolving "${skillId}" (max ${budget.maxGenerations} generation(s), approval=${budget.requireApproval ? 'required' : 'auto'})`)
  const outcome = await runEvolve(
    {
      store,
      transcriptsDir: join(config.memory.dataDir, 'transcripts'),
      screenshotDir: join(config.memory.dataDir, 'screenshots'),
      knownSkillIds: gateway.getSkillSummaries().map(skill => skill.id),
      readActiveSkill: async (id) => {
        const override = await store.readOverride(id)
        if (override !== null)
          return override
        return readFile(definition.sourcePath, 'utf-8')
      },
      runSkill: async (id) => {
        // Skills are loaded at init; re-read from disk so the freshly installed
        // candidate override is what actually runs.
        await gateway.reloadSkills()
        await gateway.runOnce([id])
      },
      latestRun: async (id) => {
        // A run may be partial or cover other skills; find the most recent
        // persisted run that actually contains this skill.
        const history = await gateway.getRunHistory(20)
        for (let i = history.length - 1; i >= 0; i--) {
          const entry = history[i]!
          if (entry.results.some(result => result.taskId === id))
            return entry
        }
        return undefined
      },
      modelCall,
      modelInfo: { name: config.model.name, baseUrl: config.model.baseUrl },
      now: () => new Date(),
      log: message => logger.info(message),
    },
    { skillId, budget, dryRun: options.dryRun },
  )

  printOutcome(outcome)
}

function buildBudget(config: AppConfig, options: EvolveCommandOptions) {
  const generations = options.maxGenerations === undefined ? undefined : Number(options.maxGenerations)
  const minutes = options.maxMinutes === undefined ? undefined : Number(options.maxMinutes)
  if (generations !== undefined && (!Number.isFinite(generations) || generations < 1)) {
    throw new EvolveError('--max-generations 必须是正整数')
  }
  if (minutes !== undefined && (!Number.isFinite(minutes) || minutes < 1))
    throw new EvolveError('--max-minutes 必须是正整数')

  return evolveBudgetSchema.parse({
    maxGenerations: generations ?? config.evolve.maxGenerations,
    maxWallClockMs: minutes === undefined ? config.evolve.maxWallClockMs : minutes * 60_000,
    maxModelCalls: config.evolve.maxModelCalls,
    regressionFactor: config.evolve.regressionFactor,
    // commander defaults a --no- flag to true; only an explicit false overrides config.
    requireApproval: options.requireApproval === false ? false : config.evolve.requireApproval,
    maxPatchLines: config.evolve.maxPatchLines,
  })
}

function printOutcome(outcome: EvolveOutcome): void {
  const lines = [
    `status:   ${outcome.status}`,
    `skill:    ${outcome.skillId}`,
    `gen:      ${outcome.genId}`,
    `reason:   ${outcome.reason}`,
  ]
  if (outcome.candidateFile)
    lines.push(`candidate: ${outcome.candidateFile}`)
  if (outcome.pendingApproval)
    lines.push(`next:     giclaw evolve --skill ${outcome.skillId} --accept   (or --reject)`)
  logger.info(lines.join('\n'))
  // Machine-readable summary on the last line.
  process.stdout.write(`${JSON.stringify(outcome)}\n`)
}

async function showStatus(store: EvolveStore): Promise<void> {
  const [best, pending] = await Promise.all([
    store.listBestKnownGood(),
    store.listPending(),
  ])
  if (best.length > 0) {
    logger.info('Best known good:')
    for (const entry of best)
      logger.info(`  ${entry.skillId} — ${entry.genId}  ${entry.acceptedAt}`)
  }
  else {
    logger.info('Best known good: (none)')
  }
  if (pending.length > 0) {
    logger.info('Pending approval:')
    for (const entry of pending)
      logger.info(`  ${entry.skillId} — ${entry.genId}  candidate=${entry.candidateFile}`)
  }
  else {
    logger.info('Pending approval: (none)')
  }

  const generations = await store.listGenerations()
  logger.info(`Generations: ${generations.length}`)
  for (const record of generations.slice(0, 10))
    logger.info(`  ${record.genId}  ${record.status}  ${record.startedAt}`)
}

async function showGeneration(store: EvolveStore, genId: string): Promise<void> {
  const record = await store.readGeneration(genId)
  if (!record) {
    logger.error(`No generation record "${genId}".`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
}

async function acceptCandidate(
  store: EvolveStore,
  skillId: string,
  options: EvolveCommandOptions,
): Promise<void> {
  const pending = await store.readPending(skillId)
  if (!pending) {
    logger.error(`No pending candidate for "${skillId}". Run \`giclaw evolve --status\`.`)
    process.exitCode = 1
    return
  }

  if (options.apply) {
    const targetDir = resolveApplyDir(options.targetDir)
    const markdown = await readFile(pending.candidateFile, 'utf-8')
    const target = join(targetDir, skillId, 'SKILL.md')
    await atomicWritePrivateFile(target, markdown)
    // If the candidate was promoted outside the live override dir, drop the
    // override so the promoted file is authoritative.
    if (resolve(targetDir) !== resolve(store.overrideSkillsDir))
      await store.removeOverride(skillId)
    logger.info(`Applied to ${target}`)
  }

  await store.clearPending(skillId)
  logger.info(`Accepted ${pending.genId} for "${skillId}".`)
  process.stdout.write(`${JSON.stringify({ accepted: pending.genId, skillId, applied: options.apply === true })}\n`)
}

async function rejectCandidate(store: EvolveStore, skillId: string): Promise<void> {
  const pending = await store.readPending(skillId)
  if (pending) {
    await store.restoreOverride(skillId, pending.originalOverride)
    await store.clearPending(skillId)
    logger.info(`Rejected ${pending.genId}; restored the pre-session SKILL.md state for "${skillId}".`)
    process.stdout.write(`${JSON.stringify({ rejected: pending.genId, skillId })}\n`)
    return
  }
  await store.removeOverride(skillId)
  logger.info(`No pending candidate; removed the override for "${skillId}" (committed file is authoritative).`)
  process.stdout.write(`${JSON.stringify({ rejected: null, skillId })}\n`)
}

function resolveApplyDir(targetDir?: string): string {
  if (targetDir)
    return resolve(targetDir)
  const repSkills = resolve(process.cwd(), 'skills')
  if (existsSync(repSkills))
    return repSkills
  return PATHS.skillsDir
}
