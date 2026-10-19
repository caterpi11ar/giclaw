import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSkills } from './loader.js'

const cleanupDirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanupDirs.push(root)
  return root
}

async function writeSkill(
  root: string,
  id: string,
  body: string,
  name: string = id,
): Promise<string> {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'SKILL.md')
  await writeFile(path, `---
id: ${id}
name: ${name}
description: test skill
---

${body}
`, 'utf-8')
  return path
}

describe('loadSkills', () => {
  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('loads executable steps and context', async () => {
    const root = await tempDir('giclaw-skills-')
    await writeSkill(root, 'demo', `## Background
background text

## Goal
goal text

## Steps
- keyPress: Escape
- wait: 1s

## Known Issues
- issue one`)

    const [skill] = await loadSkills([root])
    expect(skill).toMatchObject({
      id: 'demo',
      background: 'background text',
      goal: 'goal text',
      knownIssues: ['issue one'],
      dependsOn: [],
      steps: [
        { method: 'keyPress', prompt: 'Escape' },
        { method: 'wait', prompt: '1s' },
      ],
    })
  })

  it('rejects empty and unknown workflows instead of silently succeeding', async () => {
    const emptyRoot = await tempDir('giclaw-empty-')
    await writeSkill(emptyRoot, 'empty', '## Goal\nNo executable section')
    await expect(loadSkills([emptyRoot])).rejects.toThrow('has no executable steps')

    const invalidRoot = await tempDir('giclaw-invalid-')
    await writeSkill(invalidRoot, 'invalid', '## Steps\n- teleport: somewhere')
    await expect(loadSkills([invalidRoot])).rejects.toThrow('Unknown step method "teleport"')
  })

  it('lets a later skill directory override a built-in skill', async () => {
    const builtins = await tempDir('giclaw-builtins-')
    const custom = await tempDir('giclaw-custom-')
    await writeSkill(builtins, 'demo', '## Steps\n- keyPress: Escape', 'Built in')
    await writeSkill(custom, 'demo', '## Steps\n- keyPress: Enter', 'Custom')

    const skills = await loadSkills([builtins, custom])
    expect(skills).toHaveLength(1)
    expect(skills[0]?.name).toBe('Custom')
    expect(skills[0]?.steps[0]?.prompt).toBe('Enter')
  })

  it('applies frontmatter defaults and parses dependencies', async () => {
    const root = await tempDir('giclaw-defaults-')
    const path = await writeSkill(root, 'demo', '## Steps\n- keyPress: Escape')
    const original = await import('node:fs/promises').then(fs => fs.readFile(path, 'utf-8'))
    await writeFile(path, original.replace('description: test skill', 'description: test skill\ndependsOn:\n  - launch'), 'utf-8')

    const [skill] = await loadSkills([root])
    expect(skill).toMatchObject({
      enabled: true,
      timeoutMs: 600000,
      retries: 0,
      dependsOn: ['launch'],
    })
  })

  it('rejects invalid frontmatter, directory IDs, and self dependencies', async () => {
    const invalidIdRoot = await tempDir('giclaw-invalid-id-')
    await writeSkill(invalidIdRoot, 'Bad_ID', '## Steps\n- keyPress: Escape')
    await expect(loadSkills([invalidIdRoot])).rejects.toThrow('must use kebab-case')

    const mismatchRoot = await tempDir('giclaw-mismatch-')
    const mismatchPath = await writeSkill(mismatchRoot, 'folder', '## Steps\n- keyPress: Escape')
    const mismatch = await import('node:fs/promises').then(fs => fs.readFile(mismatchPath, 'utf-8'))
    await writeFile(mismatchPath, mismatch.replace('id: folder', 'id: other'), 'utf-8')
    await expect(loadSkills([mismatchRoot])).rejects.toThrow('must match its directory name')

    const selfRoot = await tempDir('giclaw-self-dep-')
    const selfPath = await writeSkill(selfRoot, 'self', '## Steps\n- keyPress: Escape')
    const self = await import('node:fs/promises').then(fs => fs.readFile(selfPath, 'utf-8'))
    await writeFile(selfPath, self.replace('description: test skill', 'description: test skill\ndependsOn: [self]'), 'utf-8')
    await expect(loadSkills([selfRoot])).rejects.toThrow('cannot depend on itself')

    const retryRoot = await tempDir('giclaw-retry-')
    const retryPath = await writeSkill(retryRoot, 'retry', '## Steps\n- keyPress: Escape')
    const retry = await import('node:fs/promises').then(fs => fs.readFile(retryPath, 'utf-8'))
    await writeFile(retryPath, retry.replace('description: test skill', 'description: test skill\nretries: 1'), 'utf-8')
    await expect(loadSkills([retryRoot])).rejects.toThrow('retries')
  })

  it('rejects malformed, empty, and invalid machine-readable step arguments', async () => {
    const cases = [
      ['malformed', '## Steps\n- keyPress', 'expected "- method: argument"'],
      ['empty', '## Steps\n- keyPress:', 'Empty argument'],
      ['coords', '## Steps\n- click: center', 'Invalid coordinates'],
      ['duration', '## Steps\n- wait: later', 'Invalid duration'],
      ['input', '## Steps\n- aiInput: missing target', 'expects "value => target description"'],
    ]

    for (const [id, body, message] of cases) {
      const root = await tempDir(`giclaw-${id}-`)
      await writeSkill(root, id!, body!)
      await expect(loadSkills([root])).rejects.toThrow(message!)
    }
  })

  it('ignores absent directories and entries without SKILL.md', async () => {
    const root = await tempDir('giclaw-non-skills-')
    await mkdir(join(root, 'empty-directory'))

    await expect(loadSkills([join(root, 'missing'), root])).resolves.toEqual([])
  })
})

describe('context skills', () => {
  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('merges context background and issues into runnable skills', async () => {
    const root = await tempDir('giclaw-context-')
    const ctxDir = join(root, 'ctx')
    await mkdir(ctxDir, { recursive: true })
    await writeFile(join(ctxDir, 'SKILL.md'), `---
id: ctx
name: Context
description: context only
enabled: false
context: true
---

## Known Issues
- shared issue
`, 'utf-8')

    const demoDir = join(root, 'demo')
    await mkdir(demoDir, { recursive: true })
    await writeFile(join(demoDir, 'SKILL.md'), `---
id: demo
name: Demo
description: demo
---

## Background
own bg

## Steps
- keyPress: Escape

## Known Issues
- own issue
`, 'utf-8')

    const skills = await loadSkills([root])
    const demo = skills.find(skill => skill.id === 'demo')!
    // The context skill has no Background, so the skill's own background is kept.
    expect(demo.background).toBe('own bg')
    expect(demo.knownIssues).toEqual(['shared issue', 'own issue'])
    expect(demo.steps).toHaveLength(1)
    expect(skills.find(skill => skill.id === 'ctx')?.context).toBe(true)
  })

  it('prepends context background ahead of the skill background', async () => {
    const root = await tempDir('giclaw-context-bg-')
    const ctxDir = join(root, 'ctx')
    await mkdir(ctxDir, { recursive: true })
    await writeFile(join(ctxDir, 'SKILL.md'), `---
id: ctx
name: Context
description: context only
context: true
---

## Background
shared bg
`, 'utf-8')

    const demoDir = join(root, 'demo')
    await mkdir(demoDir, { recursive: true })
    await writeFile(join(demoDir, 'SKILL.md'), `---
id: demo
name: Demo
description: demo
---

## Background
own bg

## Steps
- keyPress: Escape
`, 'utf-8')

    const demo = (await loadSkills([root])).find(skill => skill.id === 'demo')!
    expect(demo.background).toBe('shared bg\n\nown bg')
  })
})
