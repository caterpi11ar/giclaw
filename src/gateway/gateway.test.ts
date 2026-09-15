import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../config/schema.js'
import { TaskRunner } from '../tasks/task-runner.js'
import { Gateway } from './gateway.js'

describe('gateway skill catalog', () => {
  it('validates built-ins and expands a selected skill dependency', async () => {
    const config = appConfigSchema.parse({
      model: {
        name: 'test-model',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        family: 'openai',
      },
      tasks: {
        enabled: ['welkin-moon', 'claim-mail'],
        skillsDirs: [resolve('skills')],
        routines: {
          daily: ['claim-mail'],
        },
      },
    })

    const gateway = new Gateway(config)
    await gateway.init()

    expect(gateway.getSkillSummaries()).toHaveLength(6)
    expect(gateway.getTaskRunner().getEnabledTasks(['claim-mail']).map(task => task.id))
      .toEqual(['welkin-moon', 'claim-mail'])
  })

  it('resolves configured routines and rejects unknown names', async () => {
    const config = appConfigSchema.parse({
      model: {
        name: 'test-model',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        family: 'openai',
      },
      tasks: {
        enabled: ['welkin-moon', 'claim-mail'],
        skillsDirs: [resolve('skills')],
        routines: { daily: ['claim-mail'] },
      },
    })

    const gateway = new Gateway(config)
    await gateway.init()

    expect(gateway.resolveRoutine('daily')).toEqual(['claim-mail'])
    expect(gateway.resolveRoutine('missing')).toBeNull()
    expect(gateway.resolveRoutine('toString')).toBeNull()
  })

  it('fails startup when no skills can be loaded', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'giclaw-empty-skills-'))
    const config = appConfigSchema.parse({
      tasks: {
        enabled: ['missing'],
        skillsDirs: [emptyDir],
        routines: {},
      },
    })
    try {
      await expect(new Gateway(config).init()).rejects.toThrow(`No skills found in: ${emptyDir}`)
    }
    finally {
      await rm(emptyDir, { recursive: true, force: true })
    }
  })

  it('fails startup for invalid enabled tasks and invalid named routines', async () => {
    const unknownEnabled = appConfigSchema.parse({
      tasks: {
        enabled: ['missing'],
        skillsDirs: [resolve('skills')],
        routines: {},
      },
    })
    await expect(new Gateway(unknownEnabled).init()).rejects.toThrow('Unknown task "missing"')

    const invalidRoutine = appConfigSchema.parse({
      tasks: {
        enabled: ['welkin-moon'],
        skillsDirs: [resolve('skills')],
        routines: { broken: ['missing'] },
      },
    })
    await expect(new Gateway(invalidRoutine).init()).rejects.toThrow('Invalid routine "broken": Unknown task "missing"')
  })

  it('normalizes non-Error failures while validating named routines', async () => {
    const config = appConfigSchema.parse({
      tasks: {
        enabled: ['welkin-moon'],
        skillsDirs: [resolve('skills')],
        routines: { broken: ['claim-mail'] },
      },
    })
    const resolveTasks = vi.spyOn(TaskRunner.prototype, 'getEnabledTasks')
      .mockReturnValueOnce([])
      .mockImplementationOnce(() => {
        // eslint-disable-next-line no-throw-literal
        throw 'plain routine failure'
      })

    await expect(new Gateway(config).init())
      .rejects
      .toThrow('Invalid routine "broken": plain routine failure')
    expect(resolveTasks).toHaveBeenCalledTimes(2)
  })
})
