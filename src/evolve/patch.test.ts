import { describe, expect, it } from 'vitest'
import { applyPatch, locateSkill } from './patch.js'
import { validateSkillCandidate } from './validate.js'

const BASE = `---
id: demo
name: Demo
description: demo skill
timeoutMs: 600000
retries: 0
---

## Background
scene text

## Steps
- keyPress: Escape
- wait: 1s
- aiAct: open menu

## Known Issues
- issue one
`

describe('locateSkill', () => {
  it('finds frontmatter and sections', () => {
    const located = locateSkill(BASE)
    expect(located.frontmatterClose).toBe(6)
    expect(located.stepsHeading).toBe(11)
    expect(located.stepLines).toHaveLength(3)
    expect(located.knownIssuesHeading).toBe(16)
    expect(located.knownIssueLines).toHaveLength(1)
  })

  it('handles a file without frontmatter or sections', () => {
    const located = locateSkill('just text\n')
    expect(located.frontmatterClose).toBe(-1)
    expect(located.stepsHeading).toBe(-1)
    expect(located.knownIssuesHeading).toBe(-1)
  })
})

describe('applyPatch insert-step', () => {
  it('inserts before a step, in the middle, and at the end', () => {
    const atStart = applyPatch(BASE, {
      kind: 'insert-step',
      position: 0,
      steps: [{ method: 'wait', prompt: '500ms' }],
    })
    expect(atStart.indexOf('- wait: 500ms')).toBeLessThan(atStart.indexOf('- keyPress: Escape'))

    const middle = applyPatch(BASE, {
      kind: 'insert-step',
      position: 2,
      steps: [{ method: 'aiWaitFor', prompt: '菜单已打开' }],
    })
    expect(middle.indexOf('- wait: 1s')).toBeLessThan(middle.indexOf('- aiWaitFor: 菜单已打开'))
    expect(middle.indexOf('- aiWaitFor: 菜单已打开')).toBeLessThan(middle.indexOf('- aiAct: open menu'))

    const atEnd = applyPatch(BASE, {
      kind: 'insert-step',
      position: 3,
      steps: [{ method: 'screenshot', prompt: 'done' }],
    })
    expect(atEnd.indexOf('- screenshot: done')).toBeGreaterThan(atEnd.indexOf('- aiAct: open menu'))
  })

  it('creates a Steps section for a valid step', () => {
    const withoutSteps = `---\nid: demo\nname: Demo\ndescription: demo\n---\n\n## Background\ntext\n`
    const patched = applyPatch(withoutSteps, {
      kind: 'insert-step',
      position: 0,
      steps: [{ method: 'keyPress', prompt: 'Escape' }],
    })
    expect(patched).toContain('## Steps\n- keyPress: Escape')
    expect(validateSkillCandidate({ id: 'demo', markdown: patched }).ok).toBe(true)
  })

  it('rejects an out-of-range position', () => {
    expect(() => applyPatch(BASE, {
      kind: 'insert-step',
      position: 9,
      steps: [{ method: 'wait', prompt: '1s' }],
    })).toThrow('超出步骤数')
  })

  it('rejects a step whose argument is invalid for its method', () => {
    expect(() => applyPatch(BASE, {
      kind: 'insert-step',
      position: 0,
      steps: [{ method: 'click', prompt: 'center' }],
    })).toThrow('Invalid coordinates')
  })
})

describe('applyPatch edit-step-prompt', () => {
  it('rewrites the prompt and keeps the method', () => {
    const patched = applyPatch(BASE, {
      kind: 'edit-step-prompt',
      step: 2,
      prompt: '2s',
    })
    expect(patched).toContain('- wait: 2s')
    expect(patched).not.toContain('- wait: 1s')
  })

  it('rejects an out-of-range step and an invalid argument', () => {
    expect(() => applyPatch(BASE, { kind: 'edit-step-prompt', step: 9, prompt: 'x' }))
      .toThrow('超出步骤数')
    expect(() => applyPatch(BASE, { kind: 'edit-step-prompt', step: 2, prompt: 'later' }))
      .toThrow('Invalid duration')
  })
})

describe('applyPatch reorder-step', () => {
  it('moves a step while leaving other lines in place', () => {
    const patched = applyPatch(BASE, { kind: 'reorder-step', from: 3, to: 1 })
    const menu = patched.indexOf('- aiAct: open menu')
    expect(menu).toBeLessThan(patched.indexOf('- keyPress: Escape'))
    expect(patched.indexOf('- keyPress: Escape')).toBeLessThan(patched.indexOf('- wait: 1s'))
  })

  it('is a no-op when from equals to and rejects out-of-range moves', () => {
    expect(applyPatch(BASE, { kind: 'reorder-step', from: 2, to: 2 })).toBe(BASE)
    expect(() => applyPatch(BASE, { kind: 'reorder-step', from: 1, to: 9 }))
      .toThrow('超出步骤数')
  })
})

describe('applyPatch add-known-issue', () => {
  it('appends to an existing Known Issues section', () => {
    const patched = applyPatch(BASE, { kind: 'add-known-issue', issue: 'issue two' })
    expect(patched).toContain('- issue one\n- issue two')
  })

  it('normalizes a leading bullet and creates the section when missing', () => {
    const withoutKnown = BASE.replace(/\n## Known Issues\n- issue one\n$/, '\n')
    const patched = applyPatch(withoutKnown, { kind: 'add-known-issue', issue: '- issue two' })
    expect(patched).toContain('## Known Issues\n- issue two')
  })

  it('rejects an empty issue', () => {
    expect(() => applyPatch(BASE, { kind: 'add-known-issue', issue: ' - ' }))
      .toThrow('issue 为空')
  })
})

describe('applyPatch adjust-timeout', () => {
  it('replaces an existing timeout and inserts one when absent', () => {
    expect(applyPatch(BASE, { kind: 'adjust-timeout', timeoutMs: 900_000 }))
      .toContain('timeoutMs: 900000')

    const withoutTimeout = BASE.replace('timeoutMs: 600000\n', '')
    const patched = applyPatch(withoutTimeout, { kind: 'adjust-timeout', timeoutMs: 42 })
    expect(patched).toContain('timeoutMs: 42')
    expect(validateSkillCandidate({ id: 'demo', markdown: patched }).ok).toBe(true)
  })

  it('rejects files without frontmatter', () => {
    expect(() => applyPatch('## Steps\n- keyPress: Escape\n', { kind: 'adjust-timeout', timeoutMs: 10 }))
      .toThrow('需要技能包含 frontmatter')
  })
})

describe('applyPatch + validateSkillCandidate round trip', () => {
  it('produces a candidate the real loader accepts', () => {
    let patched = applyPatch(BASE, {
      kind: 'insert-step',
      position: 3,
      steps: [{ method: 'wait', prompt: '1s' }],
    })
    patched = applyPatch(patched, { kind: 'add-known-issue', issue: 'new issue' })
    const result = validateSkillCandidate({ id: 'demo', markdown: patched })
    expect(result).toEqual({ ok: true, violations: [] })
  })
})

describe('applyPatch empty sections', () => {
  it('inserts into a Steps section with no steps', () => {
    const md = `---\nid: demo\nname: Demo\ndescription: demo\n---\n\n## Steps\n\n## Known Issues\n- x\n`
    const patched = applyPatch(md, {
      kind: 'insert-step',
      position: 0,
      steps: [{ method: 'keyPress', prompt: 'Escape' }],
    })
    expect(patched).toContain('## Steps\n- keyPress: Escape')
  })

  it('adds the first item to an empty Known Issues section', () => {
    const md = `---\nid: demo\nname: Demo\ndescription: demo\n---\n\n## Steps\n- keyPress: Escape\n\n## Known Issues\n`
    const patched = applyPatch(md, { kind: 'add-known-issue', issue: 'first' })
    expect(patched).toContain('## Known Issues\n- first')
  })
})

describe('applyPatch parser edges', () => {
  it('ignores bullets without a colon or method when locating steps', () => {
    const md = `---\nid: demo\nname: Demo\ndescription: demo\n---\n\n## Steps\n- noColon\n- : empty\n- keyPress: Escape\n`
    expect(locateSkill(md).stepLines).toHaveLength(1)
  })

  it('appends a Known Issues section to a file without a trailing newline', () => {
    const md = `---\nid: demo\nname: Demo\ndescription: demo\n---\n\n## Steps\n- keyPress: Escape`
    const patched = applyPatch(md, { kind: 'add-known-issue', issue: 'note' })
    expect(patched).toContain('## Known Issues\n- note')
    expect(patched.endsWith('\n')).toBe(false)
  })
})
