export interface QueueItem {
  runId: string
  trigger: 'cron' | 'manual' | 'api'
  taskIds?: string[]
  enqueuedAt: Date
}

export type QueueStatus = 'idle' | 'processing' | 'draining'
