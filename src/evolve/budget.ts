import type { EvolveBudget } from './types.js'

/**
 * Budget and regression math for the evolution loop. Pure functions so the
 * loop's stop conditions can be unit-tested without a browser or a model.
 */

export interface BudgetUsage {
  generationsUsed: number
  modelCallsUsed: number
  startedAtMs: number
  nowMs: number
}

export interface BudgetCheck {
  ok: boolean
  violations: string[]
}

/** Report every exhausted dimension, not just the first, for a clear report. */
export function checkBudget(budget: EvolveBudget, usage: BudgetUsage): BudgetCheck {
  const violations: string[] = []
  if (usage.generationsUsed >= budget.maxGenerations)
    violations.push(`生成代数 ${usage.generationsUsed}/${budget.maxGenerations} 已用尽`)
  if (usage.modelCallsUsed >= budget.maxModelCalls)
    violations.push(`模型调用 ${usage.modelCallsUsed}/${budget.maxModelCalls} 已用尽`)
  const elapsed = usage.nowMs - usage.startedAtMs
  if (elapsed >= budget.maxWallClockMs)
    violations.push(`墙钟 ${Math.round(elapsed / 1000)}s/${Math.round(budget.maxWallClockMs / 1000)}s 已用尽`)
  return { ok: violations.length === 0, violations }
}

export interface RegressionInput {
  baselineDurationMs: number
  candidateDurationMs: number
  regressionFactor: number
}

/**
 * A candidate that succeeds but is much slower is still a regression: cloud
 * gaming runs cost real queue time and wall clock, so "worked but 3x slower"
 * is not an acceptable outcome to silently keep.
 */
export function isRegression(input: RegressionInput): boolean {
  return input.candidateDurationMs > input.baselineDurationMs * input.regressionFactor
}
