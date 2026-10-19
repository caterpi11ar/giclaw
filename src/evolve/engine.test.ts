import type { RunSummary } from '../memory/types.js'
import type { EvolveDeps } from './engine.js'
import type { EvolveStore } from './store.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runEvolve } from './engine.js'
import { EvolveStore as Store } from './store.js'
import { evolveBudgetSchema } from './types.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const SKILL = `---
id: demo
name: Demo
description: demo
---

## Steps
- keyPress: Escape
- aiWaitFor: 菜单已打开
`

const DIAG = JSON.stringify({
  failedStep: 2,
  method: 'aiWaitFor',
  rootCauseHypothesis: '界面加载慢',
  confidence: 0.6,
  suggestedFixKind: 'insert-step',
})
const PATCH_WAIT = JSON.stringify({ kind: 'insert-step', position: 0, steps: [{ method: 'wait', prompt: '1s' }] })
const PATCH_ISSUE = JSON.stringify({ kind: 'add-known-issue', issue: 'gen2 fix' })
const PATCH_BAD = JSON.stringify({ kind: 'edit-step-prompt', step: 99, prompt: 'x' })
const DIAG_NO_FIX = JSON.stringify({
  failedStep: 2,
  method: 'aiWaitFor',
  rootCauseHypothesis: '无法安全修复',
  confidence: 0.4,
  suggestedFixKind: 'no-safe-fix',
})

const BUDGET = evolveBudgetSchema.parse({ requireApproval: true })

interface RunPlan {
  success: boolean
  durationMs?: number
  message?: string
  throwError?: string
}

interface Harness {
  deps: EvolveDeps
  store: EvolveStore
  runs: RunPlan[]
  responses: string[]
  history: RunSummary[]
  modelCall: ReturnType<typeof vi.fn>
  setActive: (markdown: string) => void
}

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'evolve-engine-'))
  cleanup.push(root)
  const transcriptsDir = join(root, 'data', 'transcripts')
  const screenshotDir = join(root, 'data', 'screenshots')
  await mkdir(transcriptsDir, { recursive: true })
  await mkdir(screenshotDir, { recursive: true })

  const store = new Store({
    evolveDir: join(root, 'evolve'),
    overrideSkillsDir: join(root, 'skills'),
  })
  await store.ensure()

  const history: RunSummary[] = []
  const runs: RunPlan[] = []
  const responses: string[] = []
  let active = SKILL
  let tick = 0

  const summaryFor = (runId: string, plan: RunPlan): RunSummary => ({
    runId,
    trigger: 'manual',
    startedAt: '2026-08-07T00:00:00.000Z',
    completedAt: '2026-08-07T00:01:00.000Z',
    results: [{
      taskId: 'demo',
      success: plan.success,
      message: plan.message ?? (plan.success ? 'All steps completed' : 'Step 2/2 (aiWaitFor) failed'),
      durationMs: plan.durationMs ?? 1000,
    }],
  })

  const persistRun = async (runId: string, plan: RunPlan): Promise<void> => {
    await writeFile(
      join(transcriptsDir, `${runId}.jsonl`),
      `${JSON.stringify({
        step: 2,
        timestamp: 't',
        method: 'aiWaitFor',
        prompt: '菜单已打开',
        result: plan.success ? 'executed' : 'error',
        errorMessage: plan.success ? undefined : 'timeout',
      })}\n`,
      'utf-8',
    )
  }

  const modelCall = vi.fn(async () => {
    const next = responses.shift()
    if (next === undefined)
      throw new Error('no scripted model response')
    return next
  })

  const deps: EvolveDeps = {
    store,
    transcriptsDir,
    screenshotDir,
    knownSkillIds: ['demo'],
    readActiveSkill: async () => active,
    runSkill: async () => {
      const plan = runs.shift()
      if (!plan)
        throw new Error('unexpected runSkill')
      if (plan.throwError)
        throw new Error(plan.throwError)
      const runId = `run-${history.length + 1}`
      history.push(summaryFor(runId, plan))
      await persistRun(runId, plan)
    },
    latestRun: async () => history.at(-1),
    modelCall,
    modelInfo: { name: 'test-model', baseUrl: 'https://example.com/v1' },
    now: () => new Date(Date.UTC(2026, 7, 7, 0, 0, tick++)),
    log: () => {},
  }

  return {
    deps,
    store,
    runs,
    responses,
    history,
    modelCall,
    setActive: (markdown) => {
      active = markdown
    },
  }
}

/** Seed a run without going through runSkill (for dry-run). */
async function seedRun(harness: Harness, plan: RunPlan): Promise<void> {
  const runId = `run-${harness.history.length + 1}`
  harness.history.push({
    runId,
    trigger: 'manual',
    startedAt: '2026-08-07T00:00:00.000Z',
    completedAt: '2026-08-07T00:01:00.000Z',
    results: [{
      taskId: 'demo',
      success: plan.success,
      message: plan.message ?? 'seeded',
      durationMs: plan.durationMs ?? 1000,
    }],
  })
  await writeFile(join(harness.deps.transcriptsDir, `${runId}.jsonl`), '', 'utf-8')
}

describe('runEvolve', () => {
  it('short-circuits when the baseline already passes', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: true })
    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget: BUDGET })
    expect(outcome.status).toBe('already-passing')
    expect(harness.modelCall).not.toHaveBeenCalled()
    expect(await harness.store.readOverride('demo')).toBeNull()
    expect(await harness.store.readGeneration(outcome.genId)).not.toBeNull()
  })

  it('runs a full generation and parks a passing candidate for approval', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: false, durationMs: 1000 })
    harness.responses.push(DIAG, PATCH_WAIT)
    harness.runs.push({ success: true, durationMs: 1200 })

    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget: BUDGET })

    expect(outcome).toMatchObject({ status: 'pending-approval', accepted: true, pendingApproval: true })
    expect(await harness.store.readOverride('demo')).toContain('- wait: 1s')
    expect(await harness.store.readPending('demo')).not.toBeNull()
    expect(await harness.store.getBestKnownGood('demo')).not.toBeNull()
    const record = await harness.store.readGeneration(outcome.genId)
    expect(record?.patch?.changedLines).toBeGreaterThan(0)
    expect(record?.candidate?.success).toBe(true)
  })

  it('stops after validation in dry-run without installing or running', async () => {
    const harness = await makeHarness()
    await seedRun(harness, { success: false })
    harness.responses.push(DIAG, PATCH_WAIT)

    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget: BUDGET, dryRun: true })

    expect(outcome.status).toBe('proposed')
    expect(harness.runs).toHaveLength(0)
    expect(await harness.store.readOverride('demo')).toBeNull()
    expect(outcome.candidateFile).not.toBeNull()
  })

  it('requires prior evidence for a dry-run', async () => {
    const harness = await makeHarness()
    harness.deps.latestRun = async () => undefined
    await expect(runEvolve(harness.deps, { skillId: 'demo', budget: BUDGET, dryRun: true }))
      .rejects
      .toThrow('至少一次真实运行记录')
  })

  it('honors a no-safe-fix diagnosis', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: false })
    harness.responses.push(DIAG_NO_FIX)
    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget: BUDGET })
    expect(outcome.status).toBe('no-safe-fix')
    expect(harness.modelCall).toHaveBeenCalledOnce()
    expect(await harness.store.readOverride('demo')).toBeNull()
  })

  it('rejects a patch that cannot be applied', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: false })
    harness.responses.push(DIAG, PATCH_BAD)
    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget: BUDGET })
    expect(outcome.status).toBe('rejected-validation')
    expect(await harness.store.readOverride('demo')).toBeNull()
  })

  it('records a model error instead of throwing', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: false })
    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget: BUDGET })
    expect(outcome.status).toBe('model-error')
    expect(outcome.reason).toContain('诊断失败')
  })

  it('rolls back to the original override when the candidate regresses', async () => {
    const harness = await makeHarness()
    await harness.store.writeOverride('demo', 'ORIGINAL')
    harness.runs.push({ success: false, durationMs: 1000 })
    harness.responses.push(DIAG, PATCH_WAIT)
    harness.runs.push({ success: true, durationMs: 5000 })

    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget: BUDGET })

    expect(outcome.status).toBe('regressed')
    expect(await harness.store.readOverride('demo')).toBe('ORIGINAL')
    expect(await harness.store.readPending('demo')).toBeNull()
  })

  it('iterates on a failed candidate and accepts a later generation', async () => {
    const harness = await makeHarness()
    const budget = evolveBudgetSchema.parse({ requireApproval: true, maxGenerations: 3 })
    harness.runs.push({ success: false, durationMs: 1000 })
    harness.responses.push(DIAG, PATCH_WAIT, DIAG, PATCH_ISSUE)
    harness.runs.push({ success: false, durationMs: 2000 })
    harness.runs.push({ success: true, durationMs: 2500 })

    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget })

    expect(outcome.status).toBe('pending-approval')
    expect(await harness.store.listGenerations('demo')).toHaveLength(2)
    expect(await harness.store.readOverride('demo')).toContain('gen2 fix')
  })

  it('aborts on budget before the first generation and still writes a record', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: false })
    const budget = evolveBudgetSchema.parse({ requireApproval: true, maxModelCalls: 1 })
    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget })
    expect(outcome.status).toBe('aborted-budget')
    expect(await harness.store.readGeneration(outcome.genId)).not.toBeNull()
  })

  it('restores the original override when budget runs out after a failed candidate', async () => {
    const harness = await makeHarness()
    await harness.store.writeOverride('demo', 'ORIGINAL')
    const budget = evolveBudgetSchema.parse({ requireApproval: true, maxGenerations: 1 })
    harness.runs.push({ success: false, durationMs: 1000 })
    harness.responses.push(DIAG, PATCH_WAIT)
    harness.runs.push({ success: false, durationMs: 1200 })

    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget })

    expect(outcome.status).toBe('run-failed')
    expect(await harness.store.readOverride('demo')).toBe('ORIGINAL')
  })

  it('rejects an unsafe skill id', async () => {
    const harness = await makeHarness()
    await expect(runEvolve(harness.deps, { skillId: '../x', budget: BUDGET }))
      .rejects
      .toThrow('非法技能 id')
  })
})

const PATCH_EDIT = JSON.stringify({ kind: 'edit-step-prompt', step: 2, prompt: '菜单已打开，请稍候' })
const PATCH_BUY = JSON.stringify({
  kind: 'insert-step',
  position: 0,
  steps: [{ method: 'aiAct', prompt: '点击购买月卡' }],
})
const PATCH_INSERT = JSON.stringify({ kind: 'insert-step', position: 0, steps: [{ method: 'wait', prompt: '1s' }] })

describe('runEvolve edge cases', () => {
  it('requires a run record when not in dry-run', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: false })
    harness.deps.latestRun = async () => undefined
    await expect(runEvolve(harness.deps, { skillId: 'demo', budget: BUDGET }))
      .rejects
      .toThrow('运行后没有找到')
  })

  it('aborts when the wall-clock budget is already exhausted', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: false })
    const budget = evolveBudgetSchema.parse({ requireApproval: true, maxWallClockMs: 1 })
    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget })
    expect(outcome.status).toBe('aborted-budget')
    expect(outcome.reason).toContain('墙钟')
  })

  it('records a proposal model error', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: false })
    harness.responses.push(DIAG, 'not a patch')
    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget: BUDGET })
    expect(outcome.status).toBe('model-error')
    expect(outcome.reason).toContain('提案失败')
  })

  it('rejects a patch larger than the patch-line budget', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: false })
    harness.responses.push(DIAG, PATCH_EDIT)
    const budget = evolveBudgetSchema.parse({ requireApproval: true, maxPatchLines: 1 })
    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget })
    expect(outcome.status).toBe('rejected-validation')
    expect(outcome.reason).toContain('超过上限')
  })

  it('rejects a candidate that violates the red-line policy', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: false })
    harness.responses.push(DIAG, PATCH_BUY)
    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget: BUDGET })
    expect(outcome.status).toBe('rejected-validation')
    expect(outcome.reason).toContain('红线')
    expect(await harness.store.readOverride('demo')).toBeNull()
  })

  it('marks run-failed when the candidate run throws', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: false })
    harness.responses.push(DIAG, PATCH_WAIT)
    harness.runs.push({ success: false, throwError: 'pipeline exploded' })
    const budget = evolveBudgetSchema.parse({ requireApproval: true, maxGenerations: 1 })
    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget })
    expect(outcome.status).toBe('run-failed')
    expect(outcome.reason).toContain('pipeline exploded')
  })

  it('marks run-failed when no candidate summary is produced', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: false })
    harness.responses.push(DIAG, PATCH_WAIT)
    harness.runs.push({ success: true })
    const budget = evolveBudgetSchema.parse({ requireApproval: true, maxGenerations: 1 })
    const real = harness.deps.latestRun
    let calls = 0
    harness.deps.latestRun = async (id) => {
      calls++
      return calls === 1 ? real(id) : undefined
    }
    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget })
    expect(outcome.status).toBe('run-failed')
    expect(outcome.reason).toContain('候选运行失败')
  })

  it('auto-accepts when approval is disabled', async () => {
    const harness = await makeHarness()
    harness.runs.push({ success: false })
    harness.responses.push(DIAG, PATCH_INSERT)
    harness.runs.push({ success: true, durationMs: 1100 })
    const budget = evolveBudgetSchema.parse({ requireApproval: false })
    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget })
    expect(outcome).toMatchObject({ status: 'accepted', accepted: true, pendingApproval: false })
    expect(await harness.store.readPending('demo')).toBeNull()
    expect(await harness.store.readOverride('demo')).toContain('- wait: 1s')
  })
})

describe('runEvolve baseline retention', () => {
  it('keeps the previous baseline when a failed candidate has no evidence', async () => {
    const harness = await makeHarness()
    const budget = evolveBudgetSchema.parse({ requireApproval: true, maxGenerations: 2 })
    harness.runs.push({ success: false, durationMs: 1000 })
    harness.responses.push(DIAG, PATCH_WAIT, DIAG_NO_FIX)
    harness.runs.push({ success: false, throwError: 'boom' })
    const real = harness.deps.latestRun
    let calls = 0
    harness.deps.latestRun = async (id) => {
      calls++
      return calls === 1 ? real(id) : undefined
    }
    const outcome = await runEvolve(harness.deps, { skillId: 'demo', budget })
    expect(outcome.status).toBe('no-safe-fix')
    expect(harness.modelCall).toHaveBeenCalledTimes(3)
  })
})
