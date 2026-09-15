import { describe, expect, it } from 'vitest'
import { AppError } from '../utils/errors.js'
import { PluginError } from './errors.js'

describe('pluginError', () => {
  it('extends AppError with a stable code and plugin id', () => {
    const error = new PluginError('boom', 'webhook')

    expect(error).toBeInstanceOf(AppError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PluginError')
    expect(error.code).toBe('PLUGIN_ERROR')
    expect(error.pluginId).toBe('webhook')
    expect(error.message).toBe('boom')
  })

  it('keeps the cause and allows an omitted plugin id', () => {
    const cause = new Error('root')
    const error = new PluginError('boom', undefined, cause)

    expect(error.pluginId).toBeUndefined()
    expect(error.cause).toBe(cause)
  })
})
