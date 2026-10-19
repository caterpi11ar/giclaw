import type { GenerationRecord } from './types.js'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSafeSkillId, EvolveStore } from './store.js'

const cleanup: string[] = []

async function makeStore(): Promise<{ store: EvolveStore, root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'evolve-store-'))
  cleanup.push(root)
  const store = new EvolveStore({
    evolveDir: join(root, 'evolve'),
    overrideSkillsDir: join(root, 'skills'),
  })
  await store.ensure()
  return { store, root }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function record(overrides: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    genId: 'demo-1',
    skillId: 'demo',
    parentGenId: null,
    startedAt: '2026-08-07T00:00:00.000Z',
    completedAt: '2026-08-07T00:01:00.000Z',
    status: 'accepted',
    trigger: 'manual',
    ...overrides,
  }
}

describe('evolveStore generations', () => {
  it('writes, reads, lists, and finds the latest generation', async () => {
    const { store } = await makeStore()
    expect(await store.readGeneration('missing')).toBeNull()

    await store.writeGeneration(record({ genId: 'demo-1', startedAt: '2026-08-07T00:00:00.000Z' }))
    await store.writeGeneration(record({ genId: 'demo-2', startedAt: '2026-08-07T00:02:00.000Z' }))
    await store.writeGeneration(record({ genId: 'other-1', skillId: 'other', startedAt: '2026-08-07T00:01:00.000Z' }))

    expect((await store.listGenerations()).map(r => r.genId)).toEqual(['demo-2', 'other-1', 'demo-1'])
    expect((await store.listGenerations('demo')).map(r => r.genId)).toEqual(['demo-2', 'demo-1'])
    expect((await store.latestGeneration('demo'))?.genId).toBe('demo-2')
    expect(await store.latestGeneration('missing')).toBeNull()

    const candidate = await store.saveCandidate('demo-1', '# hello')
    expect(await readFile(candidate, 'utf-8')).toBe('# hello')
  })
})

describe('evolveStore pending', () => {
  it('persists, lists, and clears pending approvals', async () => {
    const { store } = await makeStore()
    expect(await store.readPending('demo')).toBeNull()
    expect(await store.listPending()).toEqual([])

    await store.writePending({
      genId: 'demo-1',
      skillId: 'demo',
      candidateFile: '/tmp/x/SKILL.md',
      createdAt: '2026-08-07T00:00:00.000Z',
      originalOverride: null,
    })
    expect((await store.readPending('demo'))?.genId).toBe('demo-1')
    expect(await store.listPending()).toHaveLength(1)

    await store.clearPending('demo')
    expect(await store.readPending('demo')).toBeNull()
  })
})

describe('evolveStore best known good', () => {
  it('stores and lists one entry per skill', async () => {
    const { store } = await makeStore()
    expect(await store.getBestKnownGood('demo')).toBeNull()

    await store.setBestKnownGood({ skillId: 'demo', genId: 'demo-1', acceptedAt: 't', candidateFile: 'f' })
    await store.setBestKnownGood({ skillId: 'other', genId: 'other-1', acceptedAt: 't', candidateFile: 'f' })

    expect((await store.getBestKnownGood('demo'))?.genId).toBe('demo-1')
    expect((await store.listBestKnownGood()).map(e => e.skillId)).toEqual(['demo', 'other'])
  })
})

describe('evolveStore override', () => {
  it('reads, writes, removes, and restores the live override', async () => {
    const { store } = await makeStore()
    expect(await store.readOverride('demo')).toBeNull()

    await store.writeOverride('demo', 'v1')
    expect(await store.readOverride('demo')).toBe('v1')

    await store.restoreOverride('demo', 'v0')
    expect(await store.readOverride('demo')).toBe('v0')

    await store.restoreOverride('demo', null)
    expect(await store.readOverride('demo')).toBeNull()

    await store.removeOverride('demo')
    await expect(access(store.overrideFile('demo'))).rejects.toThrow()
  })
})

describe('assertSafeSkillId', () => {
  it('accepts kebab ids and rejects unsafe ones', () => {
    expect(() => assertSafeSkillId('claim-mail')).not.toThrow()
    expect(() => assertSafeSkillId('../escape')).toThrow('非法技能 id')
    expect(() => assertSafeSkillId('Bad_ID')).toThrow('非法技能 id')
  })
})

describe('evolveStore defensive paths', () => {
  it('rejects unsafe generation ids and tolerates malformed records', async () => {
    const { store, root } = await makeStore()
    await expect(store.writeGeneration(record({ genId: '../escape' }))).rejects.toThrow('非法 generation id')
    expect(await store.readGeneration('../escape')).toBeNull()

    await mkdir(join(root, 'evolve', 'generations', 'broken'), { recursive: true })
    await writeFile(join(root, 'evolve', 'generations', 'broken', 'record.json'), '{ not json }')
    await writeFile(join(root, 'evolve', 'generations', 'stray.txt'), 'x')
    expect(await store.listGenerations()).toEqual([])
  })

  it('skips malformed pending and best-known-good entries', async () => {
    const { store, root } = await makeStore()
    await writeFile(join(root, 'evolve', 'pending', 'notes.txt'), 'x')
    await writeFile(join(root, 'evolve', 'pending', 'demo.json'), '{ not json }')
    await writeFile(join(root, 'evolve', 'best-known-good', 'notes.txt'), 'x')
    await writeFile(join(root, 'evolve', 'best-known-good', 'demo.json'), '{ not json }')

    expect(await store.listPending()).toEqual([])
    expect(await store.listBestKnownGood()).toEqual([])
    expect(await store.readPending('demo')).toBeNull()
    expect(await store.getBestKnownGood('demo')).toBeNull()
  })
})
