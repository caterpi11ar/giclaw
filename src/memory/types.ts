import type { RunTrigger } from '../queue/types.js'
import { z } from 'zod'
import { sanitizeBoundedText } from '../utils/logger.js'

export interface TranscriptEntry {
  step: number
  timestamp: string
  method?: string
  prompt?: string
  result: 'started' | 'executed' | 'done' | 'error'
  errorMessage?: string
  screenshotPath?: string
  output?: string | number | boolean
}

export interface RunSummary {
  runId: string
  trigger: RunTrigger
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

const publicTextSchema = z.string().transform(value => sanitizeBoundedText(value))
const identifierSchema = z.string().transform(value => sanitizeBoundedText(value, 256))

const runResultSchema = z.object({
  taskId: identifierSchema,
  success: z.boolean(),
  message: publicTextSchema,
  durationMs: z.number().finite().nonnegative(),
})

export const runSummarySchema: z.ZodType<RunSummary> = z.object({
  runId: identifierSchema,
  trigger: z.enum(['cron', 'manual', 'api', 'extension']),
  startedAt: z.string(),
  completedAt: z.string(),
  results: z.array(runResultSchema).max(100),
})

export const persistedStateSchema = z.object({
  lastRunId: z.string().nullable().default(null),
  lastRunAt: z.string().nullable().default(null),
  lastSuccess: z.boolean().nullable().default(null),
  totalRuns: z.number().int().nonnegative().default(0),
  history: z.array(runSummarySchema).max(10_000).default([]),
})
