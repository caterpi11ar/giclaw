import { describe, expect, it } from 'vitest'
import { validateSkillCandidate } from './validate.js'

const VALID = `---
id: demo
name: Demo
description: demo skill
---

## Goal
do the thing

## Steps
- keyPress: Escape
- wait: 1s
`

describe('validateSkillCandidate', () => {
  it('accepts a valid candidate', () => {
    expect(validateSkillCandidate({ id: 'demo', markdown: VALID }))
      .toEqual({ ok: true, violations: [] })
  })

  it('reports an id mismatch', () => {
    const result = validateSkillCandidate({ id: 'other', markdown: VALID })
    expect(result.ok).toBe(false)
    expect(result.violations.join('\n')).toContain('与目标技能')
  })

  it('reports frontmatter schema and YAML errors', () => {
    const missingDescription = VALID.replace('description: demo skill\n', '')
    expect(validateSkillCandidate({ id: 'demo', markdown: missingDescription }).violations)
      .toEqual(expect.arrayContaining([expect.stringContaining('description')]))

    const brokenYaml = '---\nid: demo\nname: "unterminated\n---\n\n## Steps\n- keyPress: Escape\n'
    const broken = validateSkillCandidate({ id: 'demo', markdown: brokenYaml })
    expect(broken.ok).toBe(false)
    expect(broken.violations[0]).toContain('frontmatter 解析失败')
  })

  it('reports body errors from the real parser', () => {
    const empty = VALID.replace('- keyPress: Escape\n- wait: 1s\n', '')
    expect(validateSkillCandidate({ id: 'demo', markdown: empty }).violations)
      .toEqual(expect.arrayContaining([expect.stringContaining('no executable steps')]))

    const unknown = VALID.replace('- wait: 1s', '- teleport: somewhere')
    expect(validateSkillCandidate({ id: 'demo', markdown: unknown }).violations)
      .toEqual(expect.arrayContaining([expect.stringContaining('Unknown step method')]))
  })

  it('enforces the red-line policy and dependency graph', () => {
    const buying = VALID.replace('- wait: 1s', '- aiAct: 点击购买')
    const policyResult = validateSkillCandidate({ id: 'demo', markdown: buying })
    expect(policyResult.ok).toBe(false)
    expect(policyResult.violations.join('\n')).toContain('红线')

    const withDep = VALID.replace('description: demo skill\n', 'description: demo skill\ndependsOn: [missing]\n')
    expect(validateSkillCandidate({ id: 'demo', markdown: withDep, knownSkillIds: ['demo'] }).violations)
      .toContain('依赖未知技能 "missing"')
  })
})
