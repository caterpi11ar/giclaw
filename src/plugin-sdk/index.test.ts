import { describe, expect, it } from 'vitest'
import * as sdk from './index.js'

describe('plugin sdk facade', () => {
  it('exposes the entry constructors', () => {
    expect(typeof sdk.definePluginEntry).toBe('function')
    expect(typeof sdk.defineChannelPluginEntry).toBe('function')
    expect(typeof sdk.defineSetupPluginEntry).toBe('function')
    expect(typeof sdk.createChannelPlugin).toBe('function')
  })

  it('re-exports the shared plugin constants', () => {
    expect(sdk.MASKED_SECRET).toBe('***')
    expect(sdk.PLUGIN_MANIFEST_FILENAME).toBe('giclaw.plugin.json')
    expect(sdk.PLUGIN_ID_PATTERN.test('feishu')).toBe(true)
    expect(sdk.SECRET_REF_PATTERN.test('env:TOKEN')).toBe(true)
  })

  it('re-exports the inbound connector helpers', () => {
    expect(typeof sdk.readHeader).toBe('function')
    expect(typeof sdk.readHeaderValue).toBe('function')
    expect(typeof sdk.constantTimeEquals).toBe('function')
    expect(typeof sdk.matchesSenderAllowlist).toBe('function')
    expect(typeof sdk.createRateLimiter).toBe('function')
    expect(typeof sdk.createRecentKeySet).toBe('function')
  })

  it('produces a usable definition end to end', () => {
    const definition = sdk.definePluginEntry({
      id: 'demo',
      register: (api) => {
        api.registerChannel(sdk.createChannelPlugin({
          id: 'demo',
          meta: { label: 'Demo' },
          outbound: { send: async () => ({ ok: true }) },
        }))
      },
    })

    expect(definition.id).toBe('demo')
  })
})
