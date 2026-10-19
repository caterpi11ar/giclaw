import type { SkillDefinition } from './types.js'
import { describe, expect, it } from 'vitest'
import { applyContextSkills } from './context.js'

function def(overrides: Partial<SkillDefinition>): SkillDefinition {
  return {
    id: 'skill',
    name: 'Skill',
    description: 'skill',
    enabled: true,
    timeoutMs: 1000,
    retries: 0,
    dependsOn: [],
    steps: [],
    background: 'own',
    sourcePath: '/skills/skill/SKILL.md',
    ...overrides,
  }
}

describe('applyContextSkills', () => {
  it('does nothing when there are no context skills', () => {
    const runnable = def({ id: 'a' })
    applyContextSkills([runnable])
    expect(runnable.background).toBe('own')
    expect(runnable.knownIssues).toBeUndefined()
  })

  it('injects core and requested tags, preserving the skill own content', () => {
    const core = def({ id: 'core', context: true, background: 'CORE', knownIssues: ['ci'] })
    const ui = def({ id: 'ui', context: true, tags: ['ui'], background: 'UI' })
    const a = def({ id: 'a', contexts: ['ui'], background: 'own', knownIssues: ['oi'] })

    applyContextSkills([core, ui, a])

    expect(a.background).toBe('CORE\n\nUI\n\nown')
    expect(a.knownIssues).toEqual(['ci', 'oi'])
  })

  it('leaves a skill untouched when no tag matches', () => {
    const other = def({ id: 'other', context: true, tags: ['other'], background: 'X', knownIssues: ['xi'] })
    const b = def({ id: 'b' })

    applyContextSkills([other, b])

    expect(b.background).toBe('own')
    expect(b.knownIssues).toBeUndefined()
  })

  it('skips a context skill that has no background', () => {
    const noBackground = def({ id: 'nb', context: true, background: undefined, knownIssues: [] })
    const c = def({ id: 'c' })

    applyContextSkills([noBackground, c])

    expect(c.background).toBe('own')
    expect(c.knownIssues).toBeUndefined()
  })

  it('creates knownIssues when the skill has none of its own', () => {
    const core = def({ id: 'core', context: true, knownIssues: ['shared'] })
    const e = def({ id: 'e' })

    applyContextSkills([core, e])

    expect(e.knownIssues).toEqual(['shared'])
  })

  it('selects a context skill only once even when two tags match', () => {
    const dup = def({ id: 'dup', context: true, tags: ['core', 'ui'], background: 'DUP' })
    const d = def({ id: 'd', contexts: ['ui'] })

    applyContextSkills([dup, d])

    expect(d.background).toBe('DUP\n\nown')
  })

  it('never injects into context skills themselves', () => {
    const core = def({ id: 'core', context: true, background: 'CORE' })
    const nested = def({ id: 'nested', context: true, background: 'NESTED' })

    applyContextSkills([core, nested])

    expect(nested.background).toBe('NESTED')
  })
})
