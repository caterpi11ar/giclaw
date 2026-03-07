import type { AppConfig } from '../config/schema.js'
import type { RunSummary } from '../memory/types.js'
import type { RunResult } from '../tasks/task-runner.js'
import type { Phase, ProgressEvent } from '../utils/progress.js'
import type { GatewaySnapshot, IGateway } from './types.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { loginFlow } from '../browser/login.js'
import { SessionManager } from '../browser/session-manager.js'
import { StateStore } from '../memory/state-store.js'
import { TranscriptWriter } from '../memory/transcript.js'
import { VisionModel } from '../model/vision-model.js'
import { TaskQueue } from '../queue/task-queue.js'
import { SkillRegistry } from '../skills/registry.js'
import { TaskRunner } from '../tasks/task-runner.js'
import { logger } from '../utils/logger.js'
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

  constructor(config: AppConfig) {
    this.config = config
    this.state = new GatewayState()
    this.queue = new TaskQueue()
    this.taskRunner = new TaskRunner()
    this.skillRegistry = new SkillRegistry()
    this.stateStore = new StateStore(config.memory.dataDir, config.memory.maxHistory)

    // Forward task runner events to gateway state
    this.taskRunner.on('task:start', (data: { taskId: string }) => {
      this.state.update({ currentTask: data.taskId })
    })
    this.taskRunner.on('task:complete', () => {
      this.state.update({ currentTask: null, currentStep: 0, currentAction: null, currentReason: null })
    })
    this.taskRunner.on('task:index', (data: { taskIndex: number, taskTotal: number, taskId: string }) => {
      this.state.update({ taskIndex: data.taskIndex, taskTotal: data.taskTotal })
    })

    // Keep queue depth in sync
    this.queue.on('enqueue', () => {
      this.state.update({ queueDepth: this.queue.getDepth() })
    })
    this.queue.on('complete', () => {
      this.state.update({ queueDepth: this.queue.getDepth() })
    })
    this.queue.on('error', () => {
      this.state.update({ queueDepth: this.queue.getDepth() })
    })
  }

  async init(): Promise<void> {
    await this.skillRegistry.loadFromDirs(this.config.tasks.skillsDirs)
    this.taskRunner.registerAll(this.skillRegistry.toTaskDefinitions())
    logger.info(
      `Loaded ${this.skillRegistry.getAll().length} skill(s) from ${this.config.tasks.skillsDirs.join(', ')}`,
    )
  }

  getSkillSummaries(): {
    id: string
    name: string
    description: string
    enabled: boolean
    timeoutMs: number
  }[] {
    return this.skillRegistry.getAll().map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      enabled: this.config.tasks.enabled.includes(s.id),
      timeoutMs: s.timeoutMs,
    }))
  }

  getSnapshot(): GatewaySnapshot {
    return this.state.getSnapshot()
  }

  getTaskRunner(): TaskRunner {
    return this.taskRunner
  }

  /**
   * Enqueue a run through the FIFO queue. Returns when the run completes.
   */
  async enqueueRun(
    trigger: 'cron' | 'manual' | 'api',
    taskIds?: string[],
  ): Promise<RunResult> {
    const runId = randomUUID()
    const item = { runId, trigger, taskIds, enqueuedAt: new Date() }

    return this.queue.enqueue(item, () =>
      this.executePipeline(runId, trigger, taskIds))
  }

  /**
   * Run once without going through the queue (for CLI `run` command).
   */
  async runOnce(taskIds?: string[]): Promise<RunResult> {
    const runId = randomUUID()
    return this.executePipeline(runId, 'manual', taskIds)
  }

  async getRunHistory(limit?: number): Promise<RunSummary[]> {
    return this.stateStore.getHistory(limit)
  }

  /**
   * Start daemon mode: scheduler + optional web + optional TUI.
   */
  async start(): Promise<void> {
    // Start scheduler
    this.scheduler = new Scheduler({
      cronExpr: this.config.schedule.cron,
      timezone: this.config.schedule.timezone,
      onTick: () => {
        logger.info('Cron triggered — starting task run')
        this.enqueueRun('cron').catch((err) => {
          logger.error('Cron run failed', err)
        })
      },
    })
    this.scheduler.start()

    logger.info('Gateway started in daemon mode')
  }

  async shutdown(): Promise<void> {
    logger.info('Gateway shutting down')
    if (this.scheduler) {
      this.scheduler.stop()
    }
    await this.queue.drain()
    logger.info('Gateway shutdown complete')
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
    this.state.emit('progress', event)
    logger.emitProgress(event)
  }

  /**
   * Core execution pipeline: launch browser → login → run tasks → persist.
   */
  private async executePipeline(
    runId: string,
    trigger: 'cron' | 'manual' | 'api',
    taskIds?: string[],
  ): Promise<RunResult> {
    const pipelineStart = Date.now()
    this.state.update({ running: true, currentRunId: runId, phase: 'login', taskIndex: 0, taskTotal: 0, currentStep: 0, elapsed: 0, currentAction: null, currentReason: null })
    this.state.emit('run:start', runId, trigger)
    this.emitProgress('login', pipelineStart)

    const session = new SessionManager(this.config)
    const transcript = new TranscriptWriter(
      join(this.config.memory.dataDir, 'transcripts'),
      runId,
    )

    try {
      await loginFlow(session, this.config)

      this.state.update({ phase: 'running' })
      this.emitProgress('running', pipelineStart)

      const page = session.getPage()
      const model = new VisionModel({
        ...this.config.model,
        viewport: this.config.browser.viewport,
        locale: this.config.locale,
      })
      const enabledIds = taskIds ?? this.config.tasks.enabled

      const onProgress = (step: number, _elapsed: number, action: string, reason: string) => {
        this.state.update({ currentStep: step, elapsed: Date.now() - pipelineStart, currentAction: action, currentReason: reason })
        this.emitProgress('running', pipelineStart)
      }

      const result = await this.taskRunner.runAll(
        { page, model, config: this.config, transcript, screenshotDir: join(this.config.memory.dataDir, 'screenshots'), onProgress },
        enabledIds,
      )

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
      await this.stateStore.updateAfterRun(summary)

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
      const error = err instanceof Error ? err : new Error(String(err))
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
      await session.close()
    }
  }
}
