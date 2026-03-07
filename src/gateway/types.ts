import type { RunSummary } from '../memory/types.js'
import type { RunResult } from '../tasks/task-runner.js'
import type { Phase, ProgressEvent } from '../utils/progress.js'

export interface GatewayEvents {
  'change': (state: GatewaySnapshot) => void
  'run:start': (runId: string, trigger: string) => void
  'run:complete': (runId: string, result: RunResult) => void
  'run:error': (runId: string, error: Error) => void
  'progress': (event: ProgressEvent) => void
}

export interface GatewaySnapshot {
  running: boolean
  currentRunId: string | null
  currentTask: string | null
  queueDepth: number
  lastRunAt: string | null
  lastSuccess: boolean | null
  phase: Phase
  taskIndex: number
  taskTotal: number
  currentStep: number
  elapsed: number
  currentAction: string | null
  currentReason: string | null
}

export interface IGateway {
  getSnapshot: () => GatewaySnapshot
  enqueueRun: (
    trigger: 'cron' | 'manual' | 'api',
    taskIds?: string[],
  ) => Promise<RunResult>
  runOnce: (taskIds?: string[]) => Promise<RunResult>
  getRunHistory: (limit?: number) => Promise<RunSummary[]>
  start: () => Promise<void>
  shutdown: () => Promise<void>
}
