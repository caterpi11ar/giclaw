import { describe, expect, it, vi } from 'vitest'
import { PluginError } from '../plugins/errors.js'
import {
  createChannelPlugin,
  defineChannelPluginEntry,
  definePluginEntry,
  defineSetupPluginEntry,
} from './definitions.js'

describe('definePluginEntry', () => {
  it('returns a frozen copy of the definition', () => {
    const register = vi.fn()
    const definition = definePluginEntry({ name: 'Webhook', register })

    expect(definition.register).toBe(register)
    expect(Object.isFrozen(definition)).toBe(true)
    expect(definition).not.toBe(register)
  })

  it('accepts a definition without an id', () => {
    expect(() => definePluginEntry({})).not.toThrow()
  })

  it('rejects a non-function register', () => {
    expect(() => definePluginEntry({ register: 'nope' as unknown as () => void }))
      .toThrow(/`register` must be a function/)
  })

  it('rejects a config schema without a parse function', () => {
    expect(() => definePluginEntry({ configSchema: {} as { parse: (input: unknown) => Record<string, unknown> } }))
      .toThrow(/must expose a `parse` function/)
  })

  it('accepts a config schema that only declares parse', () => {
    expect(() => definePluginEntry({ configSchema: { parse: () => ({}) } })).not.toThrow()
  })
})

describe('defineChannelPluginEntry', () => {
  it('accepts a valid slug id', () => {
    expect(defineChannelPluginEntry({ id: 'feishu-bot' }).id).toBe('feishu-bot')
  })

  it.each([['', 'missing'], ['Feishu', 'uppercase'], ['-feishu', 'leading dash']])(
    'rejects an invalid id (%s)',
    (id) => {
      expect(() => defineChannelPluginEntry({ id })).toThrow(PluginError)
      expect(() => defineChannelPluginEntry({ id })).toThrow(/lowercase slug/)
    },
  )
})

describe('defineSetupPluginEntry', () => {
  it('validates the definition shape like the plugin entry', () => {
    expect(() => defineSetupPluginEntry({ register: () => {} })).not.toThrow()
    expect(() => defineSetupPluginEntry({ register: 1 as unknown as () => void })).toThrow(PluginError)
  })
})

describe('createChannelPlugin', () => {
  it('builds a channel with a copy of the metadata', () => {
    const meta = { label: 'Webhook', blurb: 'posts notifications', order: 3 }
    const channel = createChannelPlugin({
      id: 'webhook',
      meta,
      outbound: { send: async () => ({ ok: true }) },
    })

    expect(channel.id).toBe('webhook')
    expect(channel.meta).toEqual(meta)
    expect(channel.meta).not.toBe(meta)
    expect(typeof channel.outbound.send).toBe('function')
  })

  it('rejects an invalid channel id', () => {
    expect(() => createChannelPlugin({
      id: 'Webhook',
      meta: { label: 'Webhook' },
      outbound: { send: async () => ({ ok: true }) },
    })).toThrow(/Invalid channel id "Webhook"/)
  })
})
