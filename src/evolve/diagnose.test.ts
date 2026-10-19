import type { TranscriptEntry } from '../memory/types.js'
import { describe, expect, it, vi } from 'vitest'
import { buildDiagnosisPrompt, diagnoseSkill, parseDiagnosis } from './diagnose.js'

const skillMarkdown = `---
id: demo
name: Demo
description: demo
---

## Steps
- keyPress: Escape
- aiWaitFor: 菜单已打开
`

const transcript: TranscriptEntry[] = [
  { step: 1, timestamp: '2026-08-07T00:00:00.000Z', method: 'keyPress', prompt: 'Escape', result: 'executed' },
  { step: 2, timestamp: '2026-08-07T00:00:01.000Z', method: 'aiWaitFor', prompt: '菜单已打开', result: 'error', errorMessage: 'timed out' },
]

describe('buildDiagnosisPrompt', () => {
  it('includes the skill, transcript, summary, and known issues', () => {
    const prompt = buildDiagnosisPrompt({
      skillId: 'demo',
      skillMarkdown,
      transcript,
      runSummary: { success: false, message: 'Step 2 failed' },
      knownIssues: ['sometimes slow'],
    })
    expect(prompt.system).toContain('no-safe-fix')
    expect(prompt.user).toContain('技能 id：demo')
    expect(prompt.user).toContain('aiWaitFor')
    expect(prompt.user).toContain('error=timed out')
    expect(prompt.user).toContain('Step 2 failed')
    expect(prompt.user).toContain('- sometimes slow')
  })

  it('keeps only the most recent transcript entries', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      step: i + 1,
      timestamp: '2026-08-07T00:00:00.000Z',
      method: 'wait' as const,
      prompt: `${i + 1}s`,
      result: 'executed' as const,
    }))
    const prompt = buildDiagnosisPrompt({ skillId: 'demo', skillMarkdown, transcript: many })
    expect(prompt.user).not.toContain('step=1 |')
    expect(prompt.user).toContain('step=70 |')
    expect(prompt.user).toContain('step=11 |')
  })

  it('handles an empty transcript', () => {
    const prompt = buildDiagnosisPrompt({ skillId: 'demo', skillMarkdown, transcript: [] })
    expect(prompt.user).toContain('(空)')
  })
})

describe('parseDiagnosis', () => {
  const valid = JSON.stringify({
    failedStep: 2,
    method: 'aiWaitFor',
    rootCauseHypothesis: 'late load',
    confidence: 0.5,
    suggestedFixKind: 'insert-wait-before-step',
  })

  it('parses plain, fenced, and embedded JSON', () => {
    expect(parseDiagnosis(valid).failedStep).toBe(2)
    expect(parseDiagnosis(`\`\`\`json\n${valid}\n\`\`\``).confidence).toBe(0.5)
    expect(parseDiagnosis(`here you go: ${valid} thanks`).suggestedFixKind)
      .toBe('insert-wait-before-step')
  })

  it('rejects non-JSON, invalid JSON, and schema violations', () => {
    expect(() => parseDiagnosis('no json here')).toThrow('没有 JSON 对象')
    expect(() => parseDiagnosis('{ not json }')).toThrow('不是合法 JSON')
    expect(() => parseDiagnosis(JSON.stringify({ ...JSON.parse(valid), confidence: 2 })))
      .toThrow('不符合 schema')
  })
})

describe('diagnoseSkill', () => {
  it('calls the injected client and returns a validated diagnosis', async () => {
    const call = vi.fn(async () => JSON.stringify({
      failedStep: 1,
      method: 'keyPress',
      rootCauseHypothesis: 'wrong key',
      confidence: 0.9,
      suggestedFixKind: 'edit-step-prompt',
      reasoning: 'screenshot shows the pause menu',
    }))
    const diagnosis = await diagnoseSkill(
      { skillId: 'demo', skillMarkdown, transcript },
      call,
    )
    expect(call).toHaveBeenCalledOnce()
    expect(diagnosis.method).toBe('keyPress')
  })
})

describe('buildDiagnosisPrompt optional fields', () => {
  it('omits method and prompt when a transcript entry lacks them', () => {
    const prompt = buildDiagnosisPrompt({
      skillId: 'demo',
      skillMarkdown,
      transcript: [{ step: 1, timestamp: 't', result: 'started' }],
    })
    expect(prompt.user).toContain('step=1 | result=started')
  })
})
