import { describe, expect, it } from 'vitest'
import { checkBudget, isRegression } from './budget.js'
import { evolveBudgetSchema } from './types.js'

const budget = evolveBudgetSchema.parse({})

describe('checkBudget', () => {
  it('passes while every dimension has room', () => {
    expect(checkBudget(budget, {
      generationsUsed: 0,
      modelCallsUsed: 0,
      startedAtMs: 0,
      nowMs: 1_000,
    })).toEqual({ ok: true, violations: [] })
  })

  it('reports every exhausted dimension', () => {
    const result = checkBudget(budget, {
      generationsUsed: 3,
      modelCallsUsed: 10,
      startedAtMs: 0,
      nowMs: 2_000_000,
    })
    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(3)
  })
})

describe('isRegression', () => {
  it('flags only candidates slower than the factor allows', () => {
    expect(isRegression({ baselineDurationMs: 1000, candidateDurationMs: 1400, regressionFactor: 1.5 })).toBe(false)
    expect(isRegression({ baselineDurationMs: 1000, candidateDurationMs: 1600, regressionFactor: 1.5 })).toBe(true)
    expect(isRegression({ baselineDurationMs: 0, candidateDurationMs: 1, regressionFactor: 1 })).toBe(true)
  })
})
