import type { RunSummary, TranscriptEntry } from '../memory/types.js'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectEvidence,
  listSkillScreenshots,
  readTranscript,
  snapshotForSkill,
} from './evidence.js'

const cleanup: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const summary: RunSummary = {
  runId: 'run-1',
  trigger: 'manual',
  startedAt: '2026-08-07T00:00:00.000Z',
  completedAt: '2026-08-07T00:01:00.000Z',
  results: [
    { taskId: 'launch', success: true, message: 'ok', durationMs: 100 },
    { taskId: 'demo', success: false, message: 'Step 2 failed', durationMs: 200 },
  ],
}

describe('snapshotForSkill', () => {
  it('finds the skill result and returns null when absent', () => {
    const found = snapshotForSkill(summary, 'demo')
    expect(found).toEqual({ runId: 'run-1', success: false, message: 'Step 2 failed', durationMs: 200 })
    expect(snapshotForSkill(summary, 'missing')).toBeUndefined()
  })
})

describe('readTranscript', () => {
  it('parses entries and skips torn or invalid lines', async () => {
    const dir = await tempDir('evolve-tr-')
    const entries: TranscriptEntry[] = [
      { step: 1, timestamp: 't', method: 'keyPress', prompt: 'Escape', result: 'executed' },
      { step: 2, timestamp: 't', method: 'wait', prompt: '1s', result: 'error', errorMessage: 'boom' },
    ]
    await writeFile(
      join(dir, 'run-1.jsonl'),
      `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n{"torn":\nnot json\n42\n`,
      'utf-8',
    )

    const parsed = await readTranscript(dir, 'run-1')
    expect(parsed).toHaveLength(2)
    expect(parsed[1]?.errorMessage).toBe('boom')
  })

  it('returns empty for a missing file and rejects unsafe run ids', async () => {
    const dir = await tempDir('evolve-tr2-')
    expect(await readTranscript(dir, 'nope')).toEqual([])
    await expect(readTranscript(dir, '../escape')).rejects.toThrow('Invalid run id')
  })

  it('keeps only the most recent entries when over the limit', async () => {
    const dir = await tempDir('evolve-tr3-')
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ step: i + 1, timestamp: 't', result: 'executed' })).join('\n')
    await writeFile(join(dir, 'run-1.jsonl'), `${lines}\n`, 'utf-8')
    const parsed = await readTranscript(dir, 'run-1', 3)
    expect(parsed.map(entry => entry.step)).toEqual([8, 9, 10])
  })
})

describe('listSkillScreenshots', () => {
  it('filters by skill prefix and returns newest first', async () => {
    const dir = await tempDir('evolve-shots-')
    const older = join(dir, 'demo-step-1-failure.png')
    const newer = join(dir, 'demo-step-2-failure.png')
    await writeFile(older, 'x')
    await writeFile(newer, 'x')
    await writeFile(join(dir, 'other-step-1-failure.png'), 'x')
    await utimes(older, new Date(1000), new Date(1000))
    await utimes(newer, new Date(2000), new Date(2000))

    expect(await listSkillScreenshots(dir, 'demo', 1)).toEqual([newer])
    expect(await listSkillScreenshots(join(dir, 'missing'), 'demo')).toEqual([])
  })
})

describe('collectEvidence', () => {
  it('bundles the run, transcript, and screenshots', async () => {
    const root = await tempDir('evolve-ev-')
    const transcriptsDir = join(root, 'transcripts')
    const screenshotDir = join(root, 'screenshots')
    await mkdir(transcriptsDir, { recursive: true })
    await mkdir(screenshotDir, { recursive: true })
    await writeFile(
      join(transcriptsDir, 'run-1.jsonl'),
      `${JSON.stringify({ step: 1, timestamp: 't', result: 'error', errorMessage: 'x' })}\n`,
      'utf-8',
    )

    const bundle = await collectEvidence({ transcriptsDir, screenshotDir, summary, skillId: 'demo' })
    expect(bundle.run.success).toBe(false)
    expect(bundle.transcript).toHaveLength(1)
    expect(bundle.screenshots).toEqual([])

    await expect(collectEvidence({ transcriptsDir, screenshotDir, summary, skillId: 'missing' }))
      .rejects
      .toThrow('没有技能')
  })
})

describe('listSkillScreenshots resilience', () => {
  it('falls back to mtime 0 for unreadable entries', async () => {
    const dir = await tempDir('evolve-shots-broken-')
    const link = join(dir, 'demo-broken.png')
    await symlink(join(dir, 'missing-target'), link)
    expect(await listSkillScreenshots(dir, 'demo')).toEqual([link])
  })
})
