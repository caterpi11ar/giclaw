export type Phase = 'login' | 'running' | 'idle' | 'done' | 'error'

export interface ProgressEvent {
  phase: Phase
  taskIndex: number // 1-based, idle = 0
  taskTotal: number
  taskId: string | null
  step: number // agent loop step, 0 when not in agent
  elapsed: number // ms since run started
  action: string | null
  reason: string | null
  timestamp: string
}
