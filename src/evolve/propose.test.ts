import type { TranscriptEntry } from '../memory/types.js'
import { describe, expect, it, vi } from 'vitest'
import { buildProposalPrompt, parseProposal, proposePatch } from './propose.js'

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
  { step: 2, timestamp: 't', method: 'aiWaitFor', prompt: '菜单已打开', result: 'error', errorMessage: 'timeout' },
]

const diagnosis = {
  failedStep: 2,
  method: 'aiWaitFor' as const,
  rootCauseHypothesis: '界面加载慢',
  confidence: 0.6,
  suggestedFixKind: 'insert-wait-before-step' as const,
}

describe('buildProposalPrompt', () => {
  it('includes the diagnosis, skill, transcript, and patch examples', () => {
    const prompt = buildProposalPrompt({ skillId: 'demo', skillMarkdown, diagnosis, transcript })
    expect(prompt.system).toContain('insert-step')
    expect(prompt.system).toContain('add-known-issue')
    expect(prompt.user).toContain('"failedStep": 2')
    expect(prompt.user).toContain('aiWaitFor')
    expect(prompt.user).toContain('error=timeout')
  })

  it('handles an empty transcript', () => {
    const prompt = buildProposalPrompt({ skillId: 'demo', skillMarkdown, diagnosis, transcript: [] })
    expect(prompt.user).toContain('(空)')
  })
})

describe('parseProposal', () => {
  it('parses a valid patch and rejects malformed ones', () => {
    expect(parseProposal('{"kind":"adjust-timeout","timeoutMs":1000}'))
      .toEqual({ kind: 'adjust-timeout', timeoutMs: 1000 })
    expect(() => parseProposal('{"kind":"teleport"}')).toThrow('不符合 schema')
  })
})

describe('proposePatch', () => {
  it('uses the injected call and returns the parsed patch', async () => {
    const call = vi.fn(async () => '{"kind":"add-known-issue","issue":"slow UI"}')
    const patch = await proposePatch({ skillId: 'demo', skillMarkdown, diagnosis, transcript }, call)
    expect(call).toHaveBeenCalledOnce()
    expect(patch).toEqual({ kind: 'add-known-issue', issue: 'slow UI' })
  })
})

describe('buildProposalPrompt optional fields', () => {
  it('omits missing method, prompt, and error fields', () => {
    const prompt = buildProposalPrompt({
      skillId: 'demo',
      skillMarkdown,
      diagnosis,
      transcript: [{ step: 1, timestamp: 't', result: 'started' }],
    })
    expect(prompt.user).toContain('step=1 | result=started')
  })
})
