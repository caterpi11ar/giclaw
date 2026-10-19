import type { TaskContext, TaskDefinition, TaskResult } from '../tasks/base-task.js'
import type { SkillDefinition } from './types.js'
import { executeSteps } from '../agent/step-executor.js'
import { PATHS } from '../config/paths.js'
import { loadSkills } from './loader.js'

export class SkillRegistry {
  private skills: SkillDefinition[] = []

  async loadFromDirs(dirs: string[]): Promise<void> {
    this.skills = await loadSkills(dirs)
  }

  getAll(): SkillDefinition[] {
    return this.skills
  }

  get(id: string): SkillDefinition | undefined {
    return this.skills.find(s => s.id === id)
  }

  toTaskDefinitions(): TaskDefinition[] {
    // Context skills only enrich AI context; they are not runnable tasks.
    return this.skills
      .filter(skill => !skill.context)
      .map(skill => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        defaultEnabled: skill.enabled,
        timeoutMs: skill.timeoutMs,
        retries: skill.retries,
        dependsOn: skill.dependsOn,

        async execute(ctx: TaskContext): Promise<TaskResult> {
          const result = await executeSteps({
            skillId: skill.id,
            page: ctx.page,
            signal: ctx.signal,
            steps: skill.steps,
            modelConfig: ctx.modelConfig,
            streamModelResponses: ctx.streamModelResponses,
            replanningCycleLimit: ctx.config.agent.replanningCycleLimit,
            timeoutMs: skill.timeoutMs,
            background: skill.background,
            goal: skill.goal,
            knownIssues: skill.knownIssues,
            transcript: ctx.transcript,
            screenshotDir: ctx.screenshotDir ?? PATHS.screenshotDir,
            onProgress: ctx.onProgress,
          })

          return {
            taskId: skill.id,
            success: result.success,
            message: result.reason,
            durationMs: result.durationMs,
            completedAt: new Date(),
          }
        },
      }))
  }
}
