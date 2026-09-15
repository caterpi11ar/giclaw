import { describe, expect, it } from 'vitest'
import { asRecord, stringField } from './record.js'

describe('asRecord', () => {
  it('accepts a plain object and rejects every other JSON shape', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord(null)).toBeNull()
    expect(asRecord(undefined)).toBeNull()
    expect(asRecord([])).toBeNull()
    expect(asRecord('text')).toBeNull()
    expect(asRecord(7)).toBeNull()
  })
})

describe('stringField', () => {
  it('reads only non-empty strings and tolerates a missing record', () => {
    expect(stringField({ a: 'x' }, 'a')).toBe('x')
    expect(stringField({ a: '' }, 'a')).toBeUndefined()
    expect(stringField({ a: 1 }, 'a')).toBeUndefined()
    expect(stringField({}, 'a')).toBeUndefined()
    expect(stringField(null, 'a')).toBeUndefined()
  })
})
