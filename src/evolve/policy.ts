import type { SkillStep } from '../skills/types.js'
import type { PolicyLimits } from './types.js'
import { policyLimitsSchema } from './types.js'

/**
 * Red-line policy for evolved skills.
 *
 * The loader already guarantees structural validity. This layer answers a
 * different question: is the proposed workflow *safe to run on a real account*?
 * It is deliberately conservative — a rejected candidate only costs a local
 * check, while a bad run can spend real currency or perform an irreversible
 * action.
 */

export const DEFAULT_POLICY_LIMITS: PolicyLimits = policyLimitsSchema.parse({})

const FORBIDDEN_STEP_PATTERNS: Array<{ pattern: RegExp, label: string }> = [
  { pattern: /原石/, label: '消耗原石' },
  { pattern: /购买|付费|充值|支付|下单|结账/, label: '付费/购买' },
  { pattern: /\bprimogem/i, label: 'primogem spend' },
  { pattern: /\b(purchase|checkout|payment|buy)\b/i, label: 'purchase/payment' },
]

export interface PolicySubject {
  id: string
  steps: SkillStep[]
  timeoutMs: number
  dependsOn: string[]
}

export interface PolicyOptions {
  limits?: Partial<PolicyLimits>
  /** When provided, every dependency must exist in this set. */
  knownSkillIds?: string[]
}

export interface PolicyResult {
  ok: boolean
  violations: string[]
}

/**
 * Return every policy violation instead of stopping at the first one, so a
 * rejected candidate explains all of its problems in a single report.
 */
export function checkSkillPolicy(
  subject: PolicySubject,
  options: PolicyOptions = {},
): PolicyResult {
  const limits = { ...DEFAULT_POLICY_LIMITS, ...options.limits }
  const violations: string[] = []

  if (subject.steps.length === 0)
    violations.push('技能没有任何可执行步骤')
  if (subject.steps.length > limits.maxSteps)
    violations.push(`步骤数 ${subject.steps.length} 超过上限 ${limits.maxSteps}`)
  if (subject.timeoutMs > limits.maxTimeoutMs)
    violations.push(`timeoutMs ${subject.timeoutMs} 超过上限 ${limits.maxTimeoutMs}`)

  for (let i = 0; i < subject.steps.length; i++) {
    const step = subject.steps[i]!
    for (const { pattern, label } of FORBIDDEN_STEP_PATTERNS) {
      if (pattern.test(step.prompt))
        violations.push(`第 ${i + 1} 步 (${step.method}) 命中红线「${label}」`)
    }
  }

  if (subject.dependsOn.includes(subject.id))
    violations.push(`技能依赖自身 "${subject.id}"`)

  if (options.knownSkillIds) {
    const known = new Set(options.knownSkillIds)
    for (const dependency of subject.dependsOn) {
      if (dependency !== subject.id && !known.has(dependency))
        violations.push(`依赖未知技能 "${dependency}"`)
    }
  }

  return { ok: violations.length === 0, violations }
}
