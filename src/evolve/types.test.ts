import { describe, expect, it } from 'vitest'
import {
  diagnosisSchema,
  evolveBudgetSchema,
  policyLimitsSchema,
  skillPatchSchema,
} from './types.js'

describe('evolve types', () => {
  it('applies budget and policy defaults', () => {
    expect(evolveBudgetSchema.parse({})).toEqual({
      maxGenerations: 3,
      maxWallClockMs: 1_800_000,
      maxModelCalls: 10,
      regressionFactor: 1.5,
      requireApproval: true,
      maxPatchLines: 40,
    })
    expect(policyLimitsSchema.parse({})).toEqual({ maxSteps: 80, maxTimeoutMs: 900_000 })
  })

  it('rejects malformed patches', () => {
    expect(skillPatchSchema.safeParse({ kind: 'insert-step', position: -1, steps: [{ method: 'wait', prompt: '1s' }] }).success)
      .toBe(false)
    expect(skillPatchSchema.safeParse({ kind: 'insert-step', position: 0, steps: [] }).success)
      .toBe(false)
    expect(skillPatchSchema.safeParse({ kind: 'teleport', step: 1 }).success)
      .toBe(false)
    expect(skillPatchSchema.safeParse({ kind: 'edit-step-prompt', step: 1, prompt: '' }).success)
      .toBe(false)
  })

  it('accepts each supported patch kind', () => {
    const patches = [
      { kind: 'insert-step', position: 0, steps: [{ method: 'wait', prompt: '1s' }] },
      { kind: 'edit-step-prompt', step: 1, prompt: 'Escape' },
      { kind: 'reorder-step', from: 1, to: 2 },
      { kind: 'add-known-issue', issue: 'note' },
      { kind: 'adjust-timeout', timeoutMs: 1000 },
    ]
    for (const patch of patches)
      expect(skillPatchSchema.safeParse(patch).success).toBe(true)
  })

  it('requires a fix kind and clamps confidence', () => {
    const base = {
      failedStep: null,
      method: null,
      rootCauseHypothesis: 'unknown',
      confidence: 0,
    }
    expect(diagnosisSchema.safeParse(base).success).toBe(false)
    expect(diagnosisSchema.safeParse({ ...base, suggestedFixKind: 'no-safe-fix' }).success).toBe(true)
    expect(diagnosisSchema.safeParse({ ...base, confidence: -0.1, suggestedFixKind: 'no-safe-fix' }).success).toBe(false)
  })
})
