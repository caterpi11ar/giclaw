import type { EvolveDeps } from './engine.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EvolveStore } from './store.js'

const mocks = vi.hoisted(() => {
  const gateway = {
    init: vi.fn(),
    getSkillDefinition: vi.fn(),
    getSkillSummaries: vi.fn(),
    reloadSkills: vi.fn(),
    runOnce: vi.fn(),
    getRunHistory: vi.fn(),
  }
  const logger = {
    setLevel: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  return {
    gateway,
    logger,
    PATHS: { stateDir: '', skillsDir: '', dataDir: '' } as Record<string, string>,
    loadConfig: vi.fn(),
    runEvolve: vi.fn(),
    createChatCall: vi.fn(() => vi.fn(async () => '{}')),
    Gateway: vi.fn(() => {
      return gateway
    }),
  }
})

vi.mock('../config/loader.js', () => ({ loadConfig: mocks.loadConfig }))
vi.mock('../gateway/gateway.js', () => ({ Gateway: mocks.Gateway }))
vi.mock('../utils/logger.js', () => ({
  logger: mocks.logger,
  sanitizeBoundedText: (value: string, max?: number) => String(value).slice(0, max ?? 4096),
}))
vi.mock('./model-client.js', () => ({ createChatCall: mocks.createChatCall }))
vi.mock('./engine.js', () => ({ runEvolve: mocks.runEvolve }))
vi.mock('../config/paths.js', async () => {
  const { mkdir: mkdirImpl, writeFile: writeFileImpl } = await import('node:fs/promises')
  const { dirname: dirnameImpl } = await import('node:path')
  return {
    PATHS: mocks.PATHS,
    ensurePrivateDir: async (path: string) => {
      await mkdirImpl(path, { recursive: true })
    },
    atomicWritePrivateFile: async (path: string, data: string) => {
      await mkdirImpl(dirnameImpl(path), { recursive: true })
      await writeFileImpl(path, data)
    },
  }
})

const { runEvolveCommand } = await import('./command.js')

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    logLevel: 'info',
    model: { name: 'gpt-5.6', baseUrl: 'https://example.com/v1', apiKey: 'key' },
    memory: { dataDir: join(mocks.PATHS.stateDir!, 'data') },
    evolve: {
      enabled: true,
      maxGenerations: 3,
      maxWallClockMs: 1_800_000,
      maxModelCalls: 10,
      regressionFactor: 1.5,
      requireApproval: true,
      maxPatchLines: 40,
      modelTimeoutMs: 120_000,
      allowedSkills: [],
    },
    ...overrides,
  }
}

const roots: string[] = []
function mockStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
}
let stdoutSpy: ReturnType<typeof mockStdout>
const originalCwd = process.cwd()

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'evolve-cmd-'))
  roots.push(root)
  return root
}

function store(): EvolveStore {
  return new EvolveStore({
    evolveDir: join(mocks.PATHS.stateDir!, 'evolve'),
    overrideSkillsDir: mocks.PATHS.skillsDir!,
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  process.exitCode = undefined
  const root = await tempRoot()
  mocks.PATHS.stateDir = join(root, 'state')
  mocks.PATHS.skillsDir = join(root, 'skills')
  mocks.PATHS.dataDir = join(root, 'data')
  mocks.loadConfig.mockResolvedValue(makeConfig())
  mocks.gateway.init.mockResolvedValue(undefined)
  mocks.gateway.getSkillSummaries.mockReturnValue([{ id: 'demo' }])
  mocks.gateway.getSkillDefinition.mockReturnValue({ sourcePath: join(root, 'repo', 'demo', 'SKILL.md') })
  mocks.gateway.reloadSkills.mockResolvedValue(undefined)
  mocks.gateway.runOnce.mockResolvedValue({ results: [] })
  mocks.gateway.getRunHistory.mockResolvedValue([])
  mocks.runEvolve.mockResolvedValue({
    genId: 'demo-1',
    skillId: 'demo',
    status: 'pending-approval',
    accepted: true,
    pendingApproval: true,
    reason: 'ok',
    recordPath: '/tmp/record.json',
    candidateFile: '/tmp/candidate/SKILL.md',
  })
  stdoutSpy = mockStdout()
})

afterEach(async () => {
  stdoutSpy.mockRestore()
  process.chdir(originalCwd)
  process.exitCode = undefined
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('runEvolveCommand read-only views', () => {
  it('prints a generation record with --show', async () => {
    const s = store()
    await s.writeGeneration({
      genId: 'demo-1',
      skillId: 'demo',
      parentGenId: null,
      startedAt: '2026-08-07T00:00:00.000Z',
      completedAt: '2026-08-07T00:01:00.000Z',
      status: 'accepted',
      trigger: 'manual',
    })
    await runEvolveCommand({}, { show: 'demo-1' })
    expect(stdoutSpy.mock.calls.map(c => String(c[0])).join('')).toContain('"genId": "demo-1"')
  })

  it('reports a missing generation', async () => {
    await runEvolveCommand({}, { show: 'nope' })
    expect(process.exitCode).toBe(1)
    expect(mocks.logger.error).toHaveBeenCalled()
  })

  it('prints status including best-known-good, pending, and generations', async () => {
    const s = store()
    await s.setBestKnownGood({ skillId: 'demo', genId: 'demo-1', acceptedAt: 't', candidateFile: 'f' })
    await s.writePending({ genId: 'demo-1', skillId: 'demo', candidateFile: 'f', createdAt: 't', originalOverride: null })
    await s.writeGeneration({
      genId: 'demo-1',
      skillId: 'demo',
      parentGenId: null,
      startedAt: '2026-08-07T00:00:00.000Z',
      completedAt: '2026-08-07T00:01:00.000Z',
      status: 'pending-approval',
      trigger: 'manual',
    })
    await runEvolveCommand({}, { status: true })
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('Best known good'))
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('Pending approval'))
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('Generations: 1'))
  })

  it('requires a skill id', async () => {
    await runEvolveCommand({}, {})
    expect(process.exitCode).toBe(2)
  })
})

describe('runEvolveCommand accept / reject', () => {
  it('errors when accepting without a pending candidate', async () => {
    await runEvolveCommand({}, { skill: 'demo', accept: true })
    expect(process.exitCode).toBe(1)
  })

  it('accepts and applies into an explicit target directory', async () => {
    const root = await tempRoot()
    const candidate = join(root, 'cand.md')
    await writeFile(candidate, 'CANDIDATE\n')
    const s = store()
    await s.writePending({
      genId: 'demo-1',
      skillId: 'demo',
      candidateFile: candidate,
      createdAt: 't',
      originalOverride: 'ORIG\n',
    })
    const target = join(root, 'out')
    await runEvolveCommand({}, { skill: 'demo', accept: true, apply: true, targetDir: target })
    expect(await readFile(join(target, 'demo', 'SKILL.md'), 'utf-8')).toBe('CANDIDATE\n')
    expect(await s.readPending('demo')).toBeNull()
    expect(await s.readOverride('demo')).toBeNull()
  })

  it('defaults the apply directory to ./skills when it exists', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'skills'), { recursive: true })
    process.chdir(root)
    const candidate = join(root, 'cand.md')
    await writeFile(candidate, 'CAND1\n')
    const s = store()
    await s.writePending({ genId: 'demo-1', skillId: 'demo', candidateFile: candidate, createdAt: 't', originalOverride: null })
    await runEvolveCommand({}, { skill: 'demo', accept: true, apply: true })
    expect(await readFile(join(root, 'skills', 'demo', 'SKILL.md'), 'utf-8')).toBe('CAND1\n')
  })

  it('falls back to the state skills directory when ./skills is absent', async () => {
    const root = await tempRoot()
    process.chdir(root)
    const candidate = join(root, 'cand.md')
    await writeFile(candidate, 'CAND2\n')
    const s = store()
    await s.writePending({ genId: 'demo-1', skillId: 'demo', candidateFile: candidate, createdAt: 't', originalOverride: null })
    await runEvolveCommand({}, { skill: 'demo', accept: true, apply: true })
    expect(await readFile(join(mocks.PATHS.skillsDir!, 'demo', 'SKILL.md'), 'utf-8')).toBe('CAND2\n')
  })

  it('rejects a pending candidate by restoring the previous override', async () => {
    const root = await tempRoot()
    const s = store()
    await s.writeOverride('demo', 'CURRENT\n')
    await s.writePending({
      genId: 'demo-1',
      skillId: 'demo',
      candidateFile: join(root, 'f'),
      createdAt: 't',
      originalOverride: 'ORIGINAL\n',
    })
    await runEvolveCommand({}, { skill: 'demo', reject: true })
    expect(await s.readOverride('demo')).toBe('ORIGINAL\n')
    expect(await s.readPending('demo')).toBeNull()
  })

  it('rejects with no pending candidate by removing the override', async () => {
    const s = store()
    await s.writeOverride('demo', 'CURRENT\n')
    await runEvolveCommand({}, { skill: 'demo', reject: true })
    expect(await s.readOverride('demo')).toBeNull()
  })
})

describe('runEvolveCommand evolve', () => {
  it('requires a configured model', async () => {
    mocks.loadConfig.mockResolvedValue(makeConfig({ model: { name: '', baseUrl: '', apiKey: '' } }))
    await runEvolveCommand({}, { skill: 'demo' })
    expect(process.exitCode).toBe(1)
    expect(mocks.runEvolve).not.toHaveBeenCalled()
  })

  it('refuses a skill outside evolve.allowedSkills', async () => {
    mocks.loadConfig.mockResolvedValue(makeConfig({ evolve: { ...makeConfig().evolve, allowedSkills: ['other'] } }))
    await runEvolveCommand({}, { skill: 'demo' })
    expect(process.exitCode).toBe(1)
  })

  it('refuses an unknown skill', async () => {
    mocks.gateway.getSkillDefinition.mockReturnValue(undefined)
    await runEvolveCommand({}, { skill: 'demo' })
    expect(process.exitCode).toBe(1)
    expect(mocks.runEvolve).not.toHaveBeenCalled()
  })

  it('warns when evolve is disabled but runs explicitly', async () => {
    mocks.loadConfig.mockResolvedValue(makeConfig({ evolve: { ...makeConfig().evolve, enabled: false } }))
    await runEvolveCommand({}, { skill: 'demo' })
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('evolve.enabled is false'))
  })

  it('wires real dependencies and prints the outcome', async () => {
    const root = await tempRoot()
    const source = join(root, 'repo', 'demo', 'SKILL.md')
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, 'SOURCE\n')
    mocks.gateway.getSkillDefinition.mockReturnValue({ sourcePath: source })
    mocks.gateway.getRunHistory.mockResolvedValue([
      { results: [{ taskId: 'other' }] },
      { results: [{ taskId: 'demo' }] },
    ])

    let captured: { deps: EvolveDeps, options: { dryRun?: boolean } } | undefined
    mocks.runEvolve.mockImplementation(async (deps: EvolveDeps, options: { dryRun?: boolean }) => {
      captured = { deps, options }
      return {
        genId: 'demo-1',
        skillId: 'demo',
        status: 'pending-approval',
        accepted: true,
        pendingApproval: true,
        reason: 'ok',
        recordPath: null,
        candidateFile: 'c',
      }
    })

    await runEvolveCommand({ verbose: true, dryRun: true }, { skill: 'demo' })
    expect(captured?.options.dryRun).toBe(true)
    expect(mocks.createChatCall).toHaveBeenCalledOnce()

    const { deps } = captured!
    // readActiveSkill: override wins, otherwise the committed source file.
    expect(await deps.readActiveSkill('demo')).toBe('SOURCE\n')
    await store().writeOverride('demo', 'OVERRIDE\n')
    expect(await deps.readActiveSkill('demo')).toBe('OVERRIDE\n')
    // runSkill reloads before running.
    await deps.runSkill('demo')
    expect(mocks.gateway.reloadSkills).toHaveBeenCalled()
    expect(mocks.gateway.runOnce).toHaveBeenCalledWith(['demo'])
    // latestRun searches backwards and returns undefined when absent.
    expect((await deps.latestRun('demo'))?.results[0]?.taskId).toBe('demo')
    expect(await deps.latestRun('missing')).toBeUndefined()
    deps.log('hello')
    expect(deps.now()).toBeInstanceOf(Date)

    expect(stdoutSpy.mock.calls.map(c => String(c[0])).join('')).toContain('"status":"pending-approval"')
  })

  it('rejects invalid generation and minute budgets', async () => {
    await runEvolveCommand({}, { skill: 'demo', maxGenerations: 'x' })
    expect(process.exitCode).toBe(1)
    expect(mocks.runEvolve).not.toHaveBeenCalled()

    process.exitCode = undefined
    await runEvolveCommand({}, { skill: 'demo', maxMinutes: '0' })
    expect(process.exitCode).toBe(1)
  })
})

describe('runEvolveCommand option coverage', () => {
  it('applies a headless override and prints empty status lists', async () => {
    await runEvolveCommand({ headless: true }, { status: true })
    expect(mocks.logger.info).toHaveBeenCalledWith('Best known good: (none)')
    expect(mocks.logger.info).toHaveBeenCalledWith('Pending approval: (none)')
  })

  it('honours CLI budget overrides and approval flags', async () => {
    await runEvolveCommand({}, { skill: 'demo', maxGenerations: '2', maxMinutes: '5', requireApproval: false })
    expect(mocks.runEvolve).toHaveBeenCalledOnce()
    const options = mocks.runEvolve.mock.calls[0]![1] as { budget: { maxGenerations: number, maxWallClockMs: number, requireApproval: boolean } }
    expect(options.budget).toMatchObject({ maxGenerations: 2, maxWallClockMs: 300_000, requireApproval: false })
  })

  it('falls back to the configured approval setting', async () => {
    mocks.loadConfig.mockResolvedValue(makeConfig({ evolve: { ...makeConfig().evolve, requireApproval: false } }))
    await runEvolveCommand({}, { skill: 'demo' })
    const options = mocks.runEvolve.mock.calls[0]![1] as { budget: { requireApproval: boolean } }
    expect(options.budget.requireApproval).toBe(false)
  })

  it('rejects a zero generation budget', async () => {
    await runEvolveCommand({}, { skill: 'demo', maxGenerations: '0' })
    expect(process.exitCode).toBe(1)
  })
})
