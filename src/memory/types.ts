import type { ActionPlan } from '../model/types.js'

export interface TranscriptEntry {
  step: number
  timestamp: string
  screenshotPath?: string
  plan: ActionPlan
  result: 'executed' | 'done' | 'error'
  errorMessage?: string
}

export interface RunSummary {
  runId: string
  trigger: 'cron' | 'manual' | 'api'
  startedAt: string
  completedAt: string
  results: Array<{
    taskId: string
    success: boolean
    message: string
    durationMs: number
  }>
}

export interface PersistedState {
  lastRunId: string | null
  lastRunAt: string | null
  lastSuccess: boolean | null
  totalRuns: number
  history: RunSummary[]
}
