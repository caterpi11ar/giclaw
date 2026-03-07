import type { TaskDescription } from '../model/types.js'

export interface SkillDefinition {
  id: string
  name: string
  description: string
  enabled: boolean
  timeoutMs: number
  retries: number
  taskDescription: TaskDescription
  sourcePath: string
}
