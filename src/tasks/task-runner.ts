import type { TaskContext, TaskDefinition, TaskResult } from './base-task.js'
import { EventEmitter } from 'node:events'
import { retry } from '../utils/delay.js'
import { logger } from '../utils/logger.js'

export interface RunResult {
  results: TaskResult[]
  startedAt: Date
  completedAt: Date
}

export class TaskRunner extends EventEmitter {
  private tasks: TaskDefinition[] = []

  register(task: TaskDefinition): void {
    this.tasks.push(task)
  }

  registerAll(tasks: TaskDefinition[]): void {
    for (const task of tasks) {
      this.register(task)
    }
  }

  getEnabledTasks(enabledIds: string[]): TaskDefinition[] {
    const taskMap = new Map(this.tasks.map(t => [t.id, t]))
    return enabledIds
      .map(id => taskMap.get(id))
      .filter((t): t is TaskDefinition => t != null)
  }

  async runAll(
    ctx: Omit<TaskContext, 'logger'>,
    enabledIds: string[],
  ): Promise<RunResult> {
    const enabled = this.getEnabledTasks(enabledIds)
    const results: TaskResult[] = []
    const startedAt = new Date()

    logger.info(`▶ Starting task run: ${enabled.length} task(s) enabled`)

    for (let i = 0; i < enabled.length; i++) {
      const task = enabled[i]!
      this.emit('task:index', { taskIndex: i + 1, taskTotal: enabled.length, taskId: task.id })
      logger.info(`⏳ [${task.id}] Starting (Task ${i + 1}/${enabled.length}): ${task.name}`)
      const result = await this.runSingle(task, { ...ctx, logger })
      results.push(result)
    }

    const completedAt = new Date()
    const runResult: RunResult = { results, startedAt, completedAt }

    this.emit('run:complete', runResult)
    const passed = results.filter(r => r.success).length
    const total = results.length
    const icon = passed === total ? '🎉' : '⚠️'
    logger.info(
      `${icon} Task run complete: ${passed}/${total} succeeded`,
    )

    return runResult
  }

  private async runSingle(
    task: TaskDefinition,
    ctx: TaskContext,
  ): Promise<TaskResult> {
    this.emit('task:start', { taskId: task.id, name: task.name })

    const start = Date.now()

    const execute = async (): Promise<TaskResult> => {
      // Wrap with timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                `Task "${task.id}" timed out after ${task.timeoutMs}ms`,
              ),
            ),
          task.timeoutMs,
        )
      })

      const result = await Promise.race([task.execute(ctx), timeoutPromise])
      return result
    }

    try {
      const retries = task.retries ?? 0
      let result: TaskResult

      if (retries > 0) {
        result = await retry(execute, {
          retries,
          delayMs: 2000,
          onRetry: (attempt) => {
            logger.warn(`🔄 [${task.id}] Retry attempt ${attempt}`)
          },
        })
      }
      else {
        result = await execute()
      }

      this.emit('task:complete', result)
      if (result.success) {
        logger.info(`✅ [${task.id}] Completed: ${result.message}`)
      }
      else {
        logger.error(`❌ [${task.id}] Failed: ${result.message}`)
      }
      return result
    }
    catch (err) {
      const durationMs = Date.now() - start
      const error = err instanceof Error ? err : new Error(String(err))
      const result: TaskResult = {
        taskId: task.id,
        success: false,
        message: error.message,
        durationMs,
        completedAt: new Date(),
        error: { name: error.name, message: error.message },
      }

      this.emit('task:complete', result)
      logger.error(`❌ [${task.id}] Failed: ${error.message}`)
      return result
    }
  }
}
