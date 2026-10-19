import type { RunSummary } from '../memory/types.js'
import type { DiagnosisCall } from './diagnose.js'
import type { EvidenceBundle } from './evidence.js'
import type { EvolveStore } from './store.js'
import type {
  EvolveBudget,
  GenerationRecord,
  GenerationStatus,
  PendingApproval,
  SkillPatch,
} from './types.js'
import { randomUUID } from 'node:crypto'
import { EvolveError, toError } from '../utils/errors.js'
import { checkBudget, isRegression } from './budget.js'
import { buildDiagnosisPrompt, parseDiagnosis } from './diagnose.js'
import { summarizeDiff } from './diff.js'
import { collectEvidence } from './evidence.js'
import { applyPatch } from './patch.js'
import { buildProposalPrompt, parseProposal } from './propose.js'
import { assertSafeSkillId } from './store.js'
import { validateSkillCandidate } from './validate.js'

/**
 * Evolution state machine:
 *   OBSERVE -> DIAGNOSE -> PROPOSE -> VALIDATE -> APPLY -> RE-RUN -> EVALUATE
 *
 * Every dependency with a side effect (browser run, model call, clock, store)
 * is injected, so the full loop is unit-testable without a browser or network.
 * The loop is bounded, rolls back on any non-accepted outcome, and never edits
 * the committed skills directory by itself.
 */

export interface EvolveDeps {
  store: EvolveStore
  transcriptsDir: string
  screenshotDir: string
  knownSkillIds: string[]
  /** Read the SKILL.md giclaw currently loads (override first, then committed). */
  readActiveSkill: (skillId: string) => Promise<string>
  /** Run one skill end-to-end through the real pipeline. */
  runSkill: (skillId: string) => Promise<void>
  /** Most recent run containing this skill, or undefined when none exists. */
  latestRun: (skillId: string) => Promise<RunSummary | undefined>
  modelCall: DiagnosisCall
  modelInfo: { name: string, baseUrl: string }
  now: () => Date
  log: (message: string) => void
}

export interface RunEvolveOptions {
  skillId: string
  budget: EvolveBudget
  dryRun?: boolean
  parentGenId?: string | null
}

export interface EvolveOutcome {
  genId: string
  skillId: string
  status: GenerationStatus
  accepted: boolean
  pendingApproval: boolean
  reason: string
  recordPath: string | null
  candidateFile: string | null
}

function makeGenId(skillId: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '')
  return `${skillId}-${stamp}-${randomUUID().slice(0, 8)}`
}

function errorMessage(error: unknown): string {
  return toError(error).message
}

export async function runEvolve(
  deps: EvolveDeps,
  options: RunEvolveOptions,
): Promise<EvolveOutcome> {
  const { skillId, budget } = options
  const dryRun = options.dryRun ?? false
  assertSafeSkillId(skillId)
  await deps.store.ensure()

  const startedAt = deps.now()
  const startedAtMs = startedAt.getTime()
  const originalOverride = await deps.store.readOverride(skillId)
  let activeMarkdown = await deps.readActiveSkill(skillId)
  let parentGenId = options.parentGenId ?? null
  let installed = false

  let generationsUsed = 0
  let modelCallsUsed = 0
  let lastGenId: string | null = null
  let lastRecordPath: string | null = null
  let candidateFile: string | null = null
  let accepted = false
  let pendingApproval = false
  let finalStatus: GenerationStatus = 'aborted-budget'
  let finalReason = '未产生候选'

  const writeRecord = async (record: GenerationRecord): Promise<void> => {
    lastGenId = record.genId
    lastRecordPath = await deps.store.writeGeneration(record)
  }

  const collect = async (summary: RunSummary): Promise<EvidenceBundle> =>
    collectEvidence({
      transcriptsDir: deps.transcriptsDir,
      screenshotDir: deps.screenshotDir,
      summary,
      skillId,
    })

  // --- OBSERVE baseline ----------------------------------------------------
  deps.log(`[evolve] ${skillId}: 采集基线证据${dryRun ? '（dry-run 使用最近一次运行）' : ''}`)
  if (!dryRun)
    await deps.runSkill(skillId)
  const baselineSummary = await deps.latestRun(skillId)
  if (!baselineSummary) {
    throw new EvolveError(
      dryRun
        ? `dry-run 需要 ${skillId} 至少一次真实运行记录`
        : `运行后没有找到 ${skillId} 的运行记录`,
    )
  }
  let baseline = await collect(baselineSummary)

  if (baseline.run.success) {
    const genId = makeGenId(skillId, deps.now())
    await writeRecord({
      genId,
      skillId,
      parentGenId,
      startedAt: startedAt.toISOString(),
      completedAt: deps.now().toISOString(),
      status: 'already-passing',
      trigger: 'manual',
      model: deps.modelInfo,
      baseline: baseline.run,
      reason: '技能当前已通过，无需进化',
    })
    return {
      genId,
      skillId,
      status: 'already-passing',
      accepted: false,
      pendingApproval: false,
      reason: '技能当前已通过，无需进化',
      recordPath: lastRecordPath,
      candidateFile: null,
    }
  }

  // --- generation loop -----------------------------------------------------
  while (true) {
    const budgetCheck = checkBudget(budget, {
      generationsUsed,
      modelCallsUsed,
      startedAtMs,
      nowMs: deps.now().getTime(),
    })
    if (!budgetCheck.ok) {
      finalStatus = 'aborted-budget'
      finalReason = budgetCheck.violations.join('; ')
      break
    }
    if (modelCallsUsed + 2 > budget.maxModelCalls) {
      finalStatus = 'aborted-budget'
      finalReason = '模型调用预算不足以完成一次诊断 + 提案'
      break
    }

    generationsUsed++
    const genId = makeGenId(skillId, deps.now())
    const genStartedAt = deps.now().toISOString()
    const baseRecord = {
      genId,
      skillId,
      parentGenId,
      startedAt: genStartedAt,
      completedAt: deps.now().toISOString(),
      trigger: 'manual' as const,
      model: deps.modelInfo,
      baseline: baseline.run,
    }

    // DIAGNOSE
    deps.log(`[evolve] 第 ${generationsUsed} 代：诊断`)
    let diagnosis
    try {
      const raw = await deps.modelCall(
        buildDiagnosisPrompt({
          skillId,
          skillMarkdown: activeMarkdown,
          transcript: baseline.transcript,
          runSummary: { success: baseline.run.success, message: baseline.run.message },
        }),
      )
      diagnosis = parseDiagnosis(raw)
    }
    catch (error) {
      finalStatus = 'model-error'
      finalReason = `诊断失败: ${errorMessage(error)}`
      await writeRecord({ ...baseRecord, status: 'model-error', reason: finalReason })
      break
    }
    modelCallsUsed++

    if (diagnosis.suggestedFixKind === 'no-safe-fix') {
      finalStatus = 'no-safe-fix'
      finalReason = diagnosis.rootCauseHypothesis
      await writeRecord({ ...baseRecord, status: 'no-safe-fix', diagnosis, reason: finalReason })
      break
    }

    // PROPOSE
    deps.log(`[evolve] 第 ${generationsUsed} 代：提案（${diagnosis.suggestedFixKind}）`)
    let patch: SkillPatch
    try {
      patch = parseProposal(
        await deps.modelCall(
          buildProposalPrompt({ skillId, skillMarkdown: activeMarkdown, diagnosis, transcript: baseline.transcript }),
        ),
      )
    }
    catch (error) {
      finalStatus = 'model-error'
      finalReason = `提案失败: ${errorMessage(error)}`
      await writeRecord({ ...baseRecord, status: 'model-error', diagnosis, reason: finalReason })
      break
    }
    modelCallsUsed++

    // APPLY (text) + VALIDATE
    let candidateMarkdown: string
    try {
      candidateMarkdown = applyPatch(activeMarkdown, patch)
    }
    catch (error) {
      finalStatus = 'rejected-validation'
      finalReason = `补丁无法应用: ${errorMessage(error)}`
      await writeRecord({
        ...baseRecord,
        status: 'rejected-validation',
        diagnosis,
        patch: { kind: patch.kind, changedLines: 0, unified: '' },
        reason: finalReason,
      })
      break
    }

    const diff = summarizeDiff(activeMarkdown, candidateMarkdown)
    candidateFile = await deps.store.saveCandidate(genId, candidateMarkdown)

    if (diff.changedLines > budget.maxPatchLines) {
      finalStatus = 'rejected-validation'
      finalReason = `补丁改动 ${diff.changedLines} 行超过上限 ${budget.maxPatchLines}`
      await writeRecord({
        ...baseRecord,
        status: 'rejected-validation',
        diagnosis,
        patch: { kind: patch.kind, ...diff, candidateFile },
        reason: finalReason,
      })
      break
    }

    const validation = validateSkillCandidate({
      id: skillId,
      markdown: candidateMarkdown,
      knownSkillIds: deps.knownSkillIds,
    })
    if (!validation.ok) {
      finalStatus = 'rejected-validation'
      finalReason = validation.violations.join('; ')
      await writeRecord({
        ...baseRecord,
        status: 'rejected-validation',
        diagnosis,
        patch: { kind: patch.kind, ...diff, candidateFile },
        validation,
        reason: finalReason,
      })
      break
    }

    if (dryRun) {
      finalStatus = 'proposed'
      finalReason = 'dry-run：补丁已通过校验，未安装、未运行'
      await writeRecord({
        ...baseRecord,
        status: 'proposed',
        diagnosis,
        patch: { kind: patch.kind, ...diff, candidateFile },
        validation,
        reason: finalReason,
      })
      break
    }

    // INSTALL + RE-RUN
    await deps.store.writeOverride(skillId, candidateMarkdown)
    installed = true
    deps.log(`[evolve] 第 ${generationsUsed} 代：安装候选并重跑`)

    let runError: string | undefined
    try {
      await deps.runSkill(skillId)
    }
    catch (error) {
      runError = errorMessage(error)
    }
    const candidateSummary = await deps.latestRun(skillId)
    const candidate = candidateSummary ? await collect(candidateSummary).catch(() => null) : null

    // EVALUATE
    if (runError || !candidate || !candidate.run.success) {
      finalStatus = 'run-failed'
      finalReason = runError ?? candidate?.run.message ?? '候选运行失败'
      await writeRecord({
        ...baseRecord,
        status: 'run-failed',
        diagnosis,
        patch: { kind: patch.kind, ...diff, candidateFile },
        validation,
        candidate: candidate?.run,
        reason: finalReason,
      })
      // Keep iterating on the failed candidate if the budget allows.
      if (generationsUsed >= budget.maxGenerations || modelCallsUsed + 2 > budget.maxModelCalls)
        break
      activeMarkdown = candidateMarkdown
      baseline = candidate ?? baseline
      parentGenId = genId
      continue
    }

    if (isRegression({
      baselineDurationMs: baseline.run.durationMs,
      candidateDurationMs: candidate.run.durationMs,
      regressionFactor: budget.regressionFactor,
    })) {
      finalStatus = 'regressed'
      finalReason = `候选成功但耗时 ${candidate.run.durationMs}ms 超过基线 ${baseline.run.durationMs}ms × ${budget.regressionFactor}`
      await writeRecord({
        ...baseRecord,
        status: 'regressed',
        diagnosis,
        patch: { kind: patch.kind, ...diff, candidateFile },
        validation,
        candidate: candidate.run,
        reason: finalReason,
      })
      break
    }

    // ACCEPT
    await deps.store.setBestKnownGood({
      skillId,
      genId,
      acceptedAt: deps.now().toISOString(),
      candidateFile,
    })
    accepted = true
    if (budget.requireApproval) {
      pendingApproval = true
      finalStatus = 'pending-approval'
      finalReason = '候选已通过，等待人工确认（giclaw evolve --accept / --reject）'
      const pending: PendingApproval = {
        genId,
        skillId,
        candidateFile,
        createdAt: deps.now().toISOString(),
        originalOverride,
      }
      await deps.store.writePending(pending)
    }
    else {
      finalStatus = 'accepted'
      finalReason = '候选已通过并自动接受'
    }
    await writeRecord({
      ...baseRecord,
      status: finalStatus,
      diagnosis,
      patch: { kind: patch.kind, ...diff, candidateFile },
      validation,
      candidate: candidate.run,
      reason: finalReason,
    })
    break
  }

  if (!accepted && installed) {
    await deps.store.restoreOverride(skillId, originalOverride)
    deps.log('[evolve] 已回滚到会话前的 SKILL.md 覆盖状态')
  }

  if (lastGenId === null) {
    // The loop budget was already exhausted before the first attempt.
    const genId = makeGenId(skillId, deps.now())
    await writeRecord({
      genId,
      skillId,
      parentGenId,
      startedAt: startedAt.toISOString(),
      completedAt: deps.now().toISOString(),
      status: finalStatus,
      trigger: 'manual',
      model: deps.modelInfo,
      baseline: baseline.run,
      reason: finalReason,
    })
  }

  return {
    genId: lastGenId!,
    skillId,
    status: finalStatus,
    accepted,
    pendingApproval,
    reason: finalReason,
    recordPath: lastRecordPath,
    candidateFile,
  }
}
