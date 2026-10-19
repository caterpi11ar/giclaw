import type { AppConfig } from '../config/schema.js'
import type { RunSummary } from '../memory/types.js'
import type { RunTrigger } from '../queue/types.js'
import type { RunResult } from '../tasks/task-runner.js'
import type { Phase, ProgressEvent } from '../utils/progress.js'
import type { EnqueuedRunReceipt, GatewaySnapshot, IGateway } from './types.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { loginFlow } from '../browser/login.js'
import { SessionManager } from '../browser/session-manager.js'
import { enforceArtifactRetention } from '../memory/artifact-retention.js'
import { StateStore } from '../memory/state-store.js'
import { TranscriptWriter } from '../memory/transcript.js'
import { TaskQueue } from '../queue/task-queue.js'
import { SkillRegistry } from '../skills/registry.js'
import { TaskRunner } from '../tasks/task-runner.js'
import { cancellationError, CancellationError, QuarantinedError, TimeoutError, toError } from '../utils/errors.js'
import { logger, sanitizeBoundedText } from '../utils/logger.js'
import { Scheduler } from './scheduler.js'
import { GatewayState } from './state.js'

export class Gateway implements IGateway {
  readonly state: GatewayState
  readonly config: AppConfig

  private queue: TaskQueue
  private taskRunner: TaskRunner
  private skillRegistry: SkillRegistry
  private scheduler: Scheduler | null = null
  private stateStore: StateStore
  private readonly activeControllers = new Map<string, AbortController>()
  private readonly activeSessions = new Set<SessionManager>()
  private shutdownPromise: Promise<void> | null = null

  private static readonly SHUTDOWN_TIMEOUT_MS = 7_000

  constructor(config: AppConfig) {
    this.config = config
    this.state = new GatewayState()
    this.queue = new TaskQueue(config.queue.maxDepth)
    this.taskRunner = new TaskRunner()
    this.skillRegistry = new SkillRegistry()
    this.stateStore = new StateStore(config.memory.dataDir, config.memory.maxHistory)

    this.attachRunnerEvents(this.taskRunner)

    // Keep queue depth in sync
    this.queue.on('enqueue', () => {
      this.state.update({ queueDepth: this.queue.getDepth() })
    })
    this.queue.on('processing', () => {
      this.state.update({ queueDepth: this.queue.getDepth() })
    })
    this.queue.on('complete', () => {
      this.state.update({ queueDepth: this.queue.getDepth() })
    })
    this.queue.on('error', () => {
      this.state.update({ queueDepth: this.queue.getDepth() })
    })
  }

  /** Forward task-runner events into gateway state. Reused by reloadSkills(). */
  private attachRunnerEvents(runner: TaskRunner): void {
    runner.on('task:start', (data: { taskId: string }) => {
      this.state.update({ currentTask: data.taskId })
    })
    runner.on('task:complete', () => {
      this.state.update({ currentTask: null, currentStep: 0, currentAction: null, currentReason: null })
    })
    runner.on('task:index', (data: { taskIndex: number, taskTotal: number, taskId: string }) => {
      this.state.update({ taskIndex: data.taskIndex, taskTotal: data.taskTotal })
    })
    runner.on('quarantine', (error: QuarantinedError) => {
      // A stopped attempt may still own browser/model work. Close admission in
      // the same synchronous event turn so TaskQueue cannot dequeue a waiting
      // run that would launch another browser before TaskRunner rejects it.
      this.queue.close(error)
      void this.scheduler?.stop().catch((stopError) => {
        logger.warn('Could not stop scheduler after task runner quarantine', stopError)
      })
    })
  }

  private async loadSkillsInto(registry: SkillRegistry, runner: TaskRunner): Promise<void> {
    await registry.loadFromDirs(this.config.tasks.skillsDirs)
    runner.registerAll(registry.toTaskDefinitions())
    if (registry.getAll().length === 0)
      throw new Error(`No skills found in: ${this.config.tasks.skillsDirs.join(', ')}`)
    // Resolve configured routines now so typos, missing dependencies and
    // dependency cycles fail during startup instead of during an unattended run.
    runner.getEnabledTasks(this.config.tasks.enabled)
    for (const [name, taskIds] of Object.entries(this.config.tasks.routines)) {
      try {
        runner.getEnabledTasks(taskIds)
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Invalid routine "${name}": ${message}`)
      }
    }
  }

  async init(): Promise<void> {
    await this.loadSkillsInto(this.skillRegistry, this.taskRunner)
    logger.info(
      `Loaded ${this.skillRegistry.getAll().length} skill(s) from ${this.config.tasks.skillsDirs.join(', ')}`,
    )
  }

  /**
   * Re-read SKILL.md files from disk and rebuild the task runner.
   *
   * Used by the evolution loop after installing a candidate override so the
   * next run executes the new steps rather than the definitions cached at
   * startup. Must not be called while a run is in progress.
   */
  async reloadSkills(): Promise<void> {
    const registry = new SkillRegistry()
    const runner = new TaskRunner()
    this.attachRunnerEvents(runner)
    await this.loadSkillsInto(registry, runner)
    this.skillRegistry = registry
    this.taskRunner = runner
    logger.info(`Reloaded ${registry.getAll().length} skill(s) from disk`)
  }

  /** The loaded definition for one skill (steps, source path, context). */
  getSkillDefinition(id: string) {
    return this.skillRegistry.get(id)
  }

  getSkillSummaries(): {
    id: string
    name: string
    description: string
    enabled: boolean
    timeoutMs: number
    defaultEnabled: boolean
    dependsOn: string[]
    steps: number
  }[] {
    return this.skillRegistry.getAll().filter(s => !s.context).map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      enabled: this.config.tasks.enabled.includes(s.id),
      timeoutMs: s.timeoutMs,
      defaultEnabled: s.enabled,
      dependsOn: s.dependsOn,
      steps: s.steps.length,
    }))
  }

  getSnapshot(): GatewaySnapshot {
    return this.state.getSnapshot()
  }

  getTaskRunner(): TaskRunner {
    return this.taskRunner
  }

  /** Resolve a configured routine name (`daily`, `rewards`, ...) to task ids. */
  resolveRoutine(name: string): string[] | null {
    // Guard against prototype keys (`toString`, `constructor`) leaking in as routines.
    const routine = this.config.tasks.routines[name]
    return Array.isArray(routine) ? routine : null
  }

  /**
   * Enqueue a run through the FIFO queue. Returns when the run completes.
   */
  enqueueRun(
    trigger: RunTrigger,
    taskIds?: string[],
  ): Promise<RunResult> {
    try {
      return this.enqueueRunAccepted(trigger, taskIds).completion
    }
    catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Atomically submit a run and return an admission receipt. Unlike
   * enqueueRun(), this does not wait for the browser pipeline to finish.
   */
  enqueueRunAccepted(
    trigger: RunTrigger,
    taskIds?: string[],
  ): EnqueuedRunReceipt {
    const runId = randomUUID()
    const item = { runId, trigger, taskIds, enqueuedAt: new Date() }
    const controller = new AbortController()
    this.activeControllers.set(runId, controller)

    try {
      const receipt = this.queue.submit(item, () =>
        this.executePipeline(runId, trigger, taskIds, controller.signal))
      return {
        status: receipt.status,
        completion: receipt.completion.finally(() => this.activeControllers.delete(runId)),
      }
    }
    catch (error) {
      this.activeControllers.delete(runId)
      throw error
    }
  }

  /**
   * Run once without going through the queue (for CLI `run` command).
   */
  async runOnce(taskIds?: string[]): Promise<RunResult> {
    return this.enqueueRun('manual', taskIds)
  }

  async getRunHistory(limit?: number): Promise<RunSummary[]> {
    return this.stateStore.getHistory(limit)
  }

  /**
   * Start daemon mode: scheduler + optional web + optional TUI.
   */
  async start(): Promise<void> {
    if (this.shutdownPromise)
      throw new Error('Gateway cannot be started after shutdown has begun')
    if (this.scheduler)
      throw new Error('Gateway is already started')

    const scheduler = new Scheduler({
      cronExpr: this.config.schedule.cron,
      timezone: this.config.schedule.timezone,
      onTick: () => {
        logger.info('Cron triggered — starting task run')
        this.enqueueRun('cron').catch((err) => {
          logger.error('Cron run failed', err)
        })
      },
    })
    this.scheduler = scheduler
    try {
      scheduler.start()
    }
    catch (error) {
      try {
        await scheduler.stop()
      }
      catch (stopError) {
        logger.warn('Could not roll back scheduler after startup failure', stopError)
      }
      this.scheduler = null
      throw error
    }

    logger.info('Gateway started in daemon mode')
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise)
      this.shutdownPromise = this.shutdownInternal()
    return this.shutdownPromise
  }

  private async shutdownInternal(): Promise<void> {
    logger.info('Gateway shutting down')
    const errors: Error[] = []
    const deadlineAt = Date.now() + Gateway.SHUTDOWN_TIMEOUT_MS
    try {
      await this.scheduler?.stop()
    }
    catch (error) {
      errors.push(toError(error))
    }

    const cancellation = new CancellationError('gateway shutdown')
    try {
      this.queue.close(cancellation)
    }
    catch (error) {
      errors.push(toError(error))
    }
    for (const controller of this.activeControllers.values()) {
      try {
        controller.abort(cancellation)
      }
      catch (error) {
        errors.push(toError(error))
      }
    }

    const sessionCleanup = Promise.allSettled(
      Array.from(this.activeSessions, async (session) => {
        await session.close()
        this.activeSessions.delete(session)
      }),
    )
    try {
      await this.queue.drain(Math.max(0, deadlineAt - Date.now()))
    }
    catch (error) {
      logger.warn('Gateway shutdown timed out while draining active work', error)
      errors.push(toError(error))
    }
    try {
      const results = await this.waitForSessionCleanup(
        sessionCleanup,
        Math.max(0, deadlineAt - Date.now()),
      )
      for (const result of results) {
        if (result.status === 'rejected')
          errors.push(toError(result.reason))
      }
    }
    catch (error) {
      errors.push(toError(error))
    }

    if (errors.length > 0)
      throw new AggregateError(errors, 'Gateway shutdown did not complete cleanly')
    logger.info('Gateway shutdown complete')
  }

  private async waitForSessionCleanup(
    cleanup: Promise<PromiseSettledResult<void>[]>,
    timeoutMs: number,
  ): Promise<PromiseSettledResult<void>[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        reject,
        timeoutMs,
        new TimeoutError('browser session cleanup', timeoutMs),
      )
    })
    try {
      return await Promise.race([cleanup, deadline])
    }
    finally {
      if (timer)
        clearTimeout(timer)
    }
  }

  private emitProgress(phase: Phase, pipelineStart: number, overrides?: Partial<ProgressEvent>): void {
    const snap = this.state.getSnapshot()
    const event: ProgressEvent = {
      phase,
      taskIndex: snap.taskIndex,
      taskTotal: snap.taskTotal,
      taskId: snap.currentTask,
      step: snap.currentStep,
      elapsed: Date.now() - pipelineStart,
      action: snap.currentAction,
      reason: snap.currentReason,
      timestamp: new Date().toISOString(),
      ...overrides,
    }
    const sanitizedEvent: ProgressEvent = {
      ...event,
      action: event.action === null ? null : sanitizeBoundedText(event.action),
      reason: event.reason === null ? null : sanitizeBoundedText(event.reason),
    }
    this.state.emit('progress', sanitizedEvent)
    logger.emitProgress(sanitizedEvent)
  }

  /**
   * Core execution pipeline: launch browser → login → run tasks → persist.
   */
  private async executePipeline(
    runId: string,
    trigger: RunTrigger,
    taskIds?: string[],
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const pipelineStart = Date.now()
    this.state.update({ running: true, currentRunId: runId, phase: 'login', taskIndex: 0, taskTotal: 0, currentStep: 0, elapsed: 0, currentAction: null, currentReason: null })
    this.state.emit('run:start', runId, trigger)
    this.emitProgress('login', pipelineStart)

    const session = new SessionManager(this.config)
    this.activeSessions.add(session)
    const transcript = new TranscriptWriter(
      join(this.config.memory.dataDir, 'transcripts'),
      runId,
    )
    try {
      await this.enforceArtifactRetention()
      if (signal?.aborted)
        throw cancellationError('gateway pipeline', signal.reason)
      await loginFlow(session, this.config, signal)
      if (signal?.aborted)
        throw cancellationError('gateway pipeline', signal.reason)

      this.state.update({ phase: 'running' })
      this.emitProgress('running', pipelineStart)

      const page = session.getPage()
      const modelConfig: Record<string, string> = {
        MIDSCENE_MODEL_NAME: this.config.model.name,
        MIDSCENE_MODEL_BASE_URL: this.config.model.baseUrl,
        MIDSCENE_MODEL_API_KEY: this.config.model.apiKey,
      }
      // Map the user-facing provider name to Midscene 1.10's model family.
      const family = this.config.model.family.toLowerCase()
      if (family === 'gemini')
        modelConfig.MIDSCENE_MODEL_FAMILY = 'gemini'
      else if (family === 'qwen-vl' || family === 'qwen')
        modelConfig.MIDSCENE_MODEL_FAMILY = 'qwen2.5-vl'
      else if (family === 'doubao')
        modelConfig.MIDSCENE_MODEL_FAMILY = 'doubao-vision'
      else if (family === 'gpt-5' || (family === 'openai' && this.config.model.name.startsWith('gpt-5')))
        modelConfig.MIDSCENE_MODEL_FAMILY = 'gpt-5'
      const enabledIds = taskIds ?? this.config.tasks.enabled

      const onProgress = (step: number, _elapsed: number, action: string, reason: string) => {
        this.state.update({ currentStep: step, elapsed: Date.now() - pipelineStart, currentAction: action, currentReason: reason })
        this.emitProgress('running', pipelineStart)
      }

      const result = await this.taskRunner.runAll(
        { page, modelConfig, streamModelResponses: this.config.model.stream, config: this.config, transcript, screenshotDir: join(this.config.memory.dataDir, 'screenshots'), onProgress },
        enabledIds,
        signal,
      )

      // TaskRunner resolving is the in-game commit point. Cancellation that
      // arrives after it must not rewrite completed side effects as a failed
      // run and invite a duplicate retry. Browser close remains mandatory and
      // fatal, but this close/persist/report phase is intentionally
      // non-cancellable.
      await session.close()
      this.activeSessions.delete(session)
      try {
        await this.enforceArtifactRetention()
      }
      catch (error) {
        // Browser work is already finished and the session is closed. Cleanup
        // metadata must not make a successful claim look failed and encourage
        // the user to repeat side effects.
        logger.warn('Post-run artifact retention failed after browser work completed', error)
      }

      // Persist
      const summary: RunSummary = {
        runId,
        trigger,
        startedAt: result.startedAt.toISOString(),
        completedAt: result.completedAt.toISOString(),
        results: result.results.map(r => ({
          taskId: r.taskId,
          success: r.success,
          message: r.message,
          durationMs: r.durationMs,
        })),
      }
      try {
        await this.stateStore.updateAfterRun(summary)
      }
      catch (error) {
        // Persistence is observability, not part of the in-game transaction.
        // Report the run result accurately even when local history cannot be
        // updated, otherwise callers may retry an already completed claim.
        logger.warn('Could not persist completed run summary', error)
      }

      this.state.update({
        running: false,
        currentRunId: null,
        currentTask: null,
        lastRunAt: result.completedAt.toISOString(),
        lastSuccess: result.results.every(r => r.success),
        phase: 'done',
        taskIndex: 0,
        taskTotal: 0,
        currentStep: 0,
        currentAction: null,
        currentReason: null,
      })
      this.emitProgress('done', pipelineStart)
      this.state.emit('run:complete', runId, result)

      return result
    }
    catch (err) {
      const error = toError(err)
      logger.error(`Run ${runId} failed`, error)
      this.state.update({
        running: false,
        currentRunId: null,
        currentTask: null,
        phase: 'error',
        currentAction: null,
        currentReason: error.message,
      })
      this.emitProgress('error', pipelineStart, { reason: error.message })
      this.state.emit('run:error', runId, error)
      throw error
    }
    finally {
      if (this.activeSessions.has(session)) {
        try {
          await session.close()
          this.activeSessions.delete(session)
        }
        catch (err) {
          const cleanupError = toError(err)
          const quarantine = new QuarantinedError(
            'Gateway stopped accepting work because a browser session could not be closed safely',
            cleanupError,
          )
          logger.error(quarantine.message, cleanupError)
          try {
            await this.scheduler?.stop()
          }
          catch (stopError) {
            logger.warn('Could not stop scheduler after unsafe session cleanup', stopError)
          }
          this.queue.close(quarantine)

          // This cleanup runs only while another pipeline error is already
          // propagating; do not replace that root cause.
        }
      }
    }
  }

  private enforceArtifactRetention(): Promise<unknown> {
    return enforceArtifactRetention(
      [
        join(this.config.memory.dataDir, 'transcripts'),
        join(this.config.memory.dataDir, 'screenshots'),
      ],
      {
        maxFiles: this.config.memory.maxArtifactFiles,
        maxBytes: this.config.memory.maxArtifactBytes,
      },
    )
  }
}
