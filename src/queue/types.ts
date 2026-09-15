/**
 * Why a run was started. `extension` covers plugin inbounds (webhook, IMAP,
 * chat control) so the audit trail stays distinguishable from the JSON API.
 */
export type RunTrigger = 'cron' | 'manual' | 'api' | 'extension'

export interface QueueItem {
  runId: string
  trigger: RunTrigger
  taskIds?: string[]
  enqueuedAt: Date
}

export type QueueStatus = 'idle' | 'processing' | 'draining'
