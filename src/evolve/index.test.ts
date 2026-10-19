import { describe, expect, it } from 'vitest'
import * as evolve from './index.js'

describe('evolve public API', () => {
  it('exposes the loop building blocks as values', () => {
    const functions = [
      evolve.runEvolve,
      evolve.applyPatch,
      evolve.locateSkill,
      evolve.validateSkillCandidate,
      evolve.checkSkillPolicy,
      evolve.parseDiagnosis,
      evolve.diagnoseSkill,
      evolve.buildDiagnosisPrompt,
      evolve.buildProposalPrompt,
      evolve.parseProposal,
      evolve.proposePatch,
      evolve.parseJsonObject,
      evolve.extractJsonObject,
      evolve.checkBudget,
      evolve.isRegression,
      evolve.summarizeDiff,
      evolve.collectEvidence,
      evolve.listSkillScreenshots,
      evolve.readTranscript,
      evolve.snapshotForSkill,
      evolve.createChatCall,
      evolve.assertSafeSkillId,
    ]
    for (const value of functions)
      expect(typeof value).toBe('function')

    expect(new evolve.EvolveStore({ evolveDir: '/tmp/e', overrideSkillsDir: '/tmp/s' })).toBeInstanceOf(evolve.EvolveStore)
    expect(evolve.DEFAULT_POLICY_LIMITS).toEqual({ maxSteps: 80, maxTimeoutMs: 900_000 })
  })

  it('exposes the validation schemas', () => {
    expect(evolve.skillPatchSchema.safeParse({ kind: 'adjust-timeout', timeoutMs: 1 }).success).toBe(true)
    expect(evolve.diagnosisSchema).toBeDefined()
    expect(evolve.generationRecordSchema).toBeDefined()
    expect(evolve.generationStatusSchema).toBeDefined()
    expect(evolve.pendingApprovalSchema).toBeDefined()
    expect(evolve.bestKnownGoodSchema).toBeDefined()
    expect(evolve.evolveBudgetSchema).toBeDefined()
    expect(evolve.fixKindSchema).toBeDefined()
    expect(evolve.policyLimitsSchema).toBeDefined()
    expect(evolve.stepMethodSchema).toBeDefined()
  })
})
