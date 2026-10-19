import { describe, expect, it } from 'vitest'
import { extractJsonObject, parseJsonObject } from './json.js'

describe('extractJsonObject', () => {
  it('returns a plain object unchanged', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}')
  })

  it('unwraps fenced blocks, with or without a language tag', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('extracts the object embedded in prose', () => {
    expect(extractJsonObject('answer: {"a":1} done')).toBe('{"a":1}')
  })

  it('throws when there is no object', () => {
    expect(() => extractJsonObject('nothing')).toThrow('没有 JSON 对象')
  })
})

describe('parseJsonObject', () => {
  it('parses valid JSON and rejects malformed JSON', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(() => parseJsonObject('{ not json }')).toThrow('不是合法 JSON')
  })
})

describe('extractJsonObject unclosed fence', () => {
  it('parses a fenced block without a closing fence', () => {
    expect(extractJsonObject('```json\n{"a":1}')).toBe('{"a":1}')
  })
})
