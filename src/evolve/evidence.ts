import type { RunSummary, TranscriptEntry } from '../memory/types.js'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { EvolveError } from '../utils/errors.js'
import { sanitizeBoundedText } from '../utils/logger.js'

/**
 * Evidence collection for one run of one skill.
 *
 * giclaw already writes everything the loop needs (transcript JSONL, failure
 * screenshots, state history). This module only reads it back into a compact
 * bundle, so it works without the browser or the model.
 */

export interface SkillRunSnapshot {
  runId: string
  success: boolean
  message: string
  durationMs: number
}

export function snapshotForSkill(
  summary: RunSummary,
  skillId: string,
): SkillRunSnapshot | undefined {
  const result = summary.results.find(entry => entry.taskId === skillId)
  if (!result)
    return undefined
  return {
    runId: summary.runId,
    success: result.success,
    message: sanitizeBoundedText(result.message),
    durationMs: result.durationMs,
  }
}

const SAFE_RUN_ID = /^[\w.-]+$/

export async function readTranscript(
  transcriptsDir: string,
  runId: string,
  limit = 500,
): Promise<TranscriptEntry[]> {
  if (!SAFE_RUN_ID.test(runId) || runId === '.' || runId === '..')
    throw new EvolveError('Invalid run id')

  let raw: string
  try {
    raw = await readFile(join(transcriptsDir, `${runId}.jsonl`), 'utf-8')
  }
  catch {
    return []
  }

  const entries: TranscriptEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim())
      continue
    try {
      const value: unknown = JSON.parse(line)
      if (isTranscriptEntry(value))
        entries.push(value)
    }
    catch {
      // A torn final line is expected if a run was killed; skip it.
    }
  }
  return entries.slice(-limit)
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  return typeof value === 'object'
    && value !== null
    && typeof (value as TranscriptEntry).step === 'number'
    && typeof (value as TranscriptEntry).result === 'string'
}

export async function listSkillScreenshots(
  screenshotDir: string,
  skillId: string,
  limit = 3,
): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(screenshotDir)
  }
  catch {
    return []
  }

  const matching = names.filter(name => name.startsWith(`${skillId}-`) && name.endsWith('.png'))
  const withTime = await Promise.all(
    matching.map(async (name) => {
      const path = join(screenshotDir, name)
      try {
        return { path, mtime: (await stat(path)).mtimeMs }
      }
      catch {
        return { path, mtime: 0 }
      }
    }),
  )
  return withTime
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(entry => entry.path)
}

export interface EvidenceBundle {
  run: SkillRunSnapshot
  transcript: TranscriptEntry[]
  screenshots: string[]
}

export interface CollectEvidenceParams {
  transcriptsDir: string
  screenshotDir: string
  summary: RunSummary
  skillId: string
  maxScreenshots?: number
}

export async function collectEvidence(params: CollectEvidenceParams): Promise<EvidenceBundle> {
  const run = snapshotForSkill(params.summary, params.skillId)
  if (!run)
    throw new EvolveError(`运行记录中没有技能 "${params.skillId}" 的结果`)

  const [transcript, screenshots] = await Promise.all([
    readTranscript(params.transcriptsDir, run.runId),
    listSkillScreenshots(params.screenshotDir, params.skillId, params.maxScreenshots ?? 3),
  ])
  return { run, transcript, screenshots }
}
