import { describe, expect, it } from 'vitest'
import { checkSkillPolicy } from './policy.js'

const base = {
  id: 'demo',
  steps: [{ method: 'keyPress' as const, prompt: 'Escape' }],
  timeoutMs: 600_000,
  dependsOn: [] as string[],
}

describe('checkSkillPolicy', () => {
  it('accepts a normal skill', () => {
    expect(checkSkillPolicy(base)).toEqual({ ok: true, violations: [] })
  })

  it('rejects empty workflows, oversized step counts, and long timeouts', () => {
    expect(checkSkillPolicy({ ...base, steps: [] }).violations).toContain('技能没有任何可执行步骤')

    const many = Array.from({ length: 3 }, (_, i) => ({
      method: 'wait' as const,
      prompt: `${i}s`,
    }))
    expect(checkSkillPolicy({ ...base, steps: many }, { limits: { maxSteps: 2 } }).violations)
      .toEqual(expect.arrayContaining([expect.stringContaining('超过上限')]))

    expect(checkSkillPolicy({ ...base, timeoutMs: 2_000_000 }).violations)
      .toEqual(expect.arrayContaining([expect.stringContaining('timeoutMs')]))
  })

  it('flags currency and purchase red lines in step prompts', () => {
    const forbidden = [
      '点击购买月卡',
      '消耗原石抽取',
      'tap the purchase button',
      'complete checkout',
      'spend 100 primogem',
    ]
    for (const prompt of forbidden) {
      const result = checkSkillPolicy({ ...base, steps: [{ method: 'aiAct', prompt }] })
      expect(result.ok).toBe(false)
      expect(result.violations[0]).toContain('红线')
    }
  })

  it('does not scan non-step context for red lines', () => {
    // "领取" (claim) is safe and must stay allowed.
    expect(checkSkillPolicy({ ...base, steps: [{ method: 'aiAct', prompt: '点击领取奖励' }] }).ok)
      .toBe(true)
  })

  it('rejects self and unknown dependencies', () => {
    expect(checkSkillPolicy({ ...base, dependsOn: ['demo'] }).violations)
      .toContain('技能依赖自身 "demo"')

    const unknown = checkSkillPolicy(
      { ...base, dependsOn: ['missing'] },
      { knownSkillIds: ['demo', 'welkin-moon'] },
    )
    expect(unknown.violations).toContain('依赖未知技能 "missing"')

    const known = checkSkillPolicy(
      { ...base, dependsOn: ['welkin-moon'] },
      { knownSkillIds: ['demo', 'welkin-moon'] },
    )
    expect(known.ok).toBe(true)
  })
})
