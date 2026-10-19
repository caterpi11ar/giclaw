import { describe, expect, it } from 'vitest'
import { summarizeDiff } from './diff.js'

describe('summarizeDiff', () => {
  it('reports nothing changed for identical text', () => {
    const result = summarizeDiff('a\nb\n', 'a\nb\n')
    expect(result).toMatchObject({ added: 0, removed: 0, changedLines: 0 })
  })

  it('isolates a middle change with common prefix and suffix', () => {
    const result = summarizeDiff('a\nb\nc\n', 'a\nB\nc\n')
    expect(result).toMatchObject({ added: 1, removed: 1, changedLines: 2 })
    expect(result.unified).toContain('-b')
    expect(result.unified).toContain('+B')
  })

  it('counts pure insertions and deletions', () => {
    expect(summarizeDiff('a\nc\n', 'a\nb\nc\n').added).toBe(1)
    expect(summarizeDiff('a\nb\nc\n', 'a\nc\n').removed).toBe(1)
  })
})
