import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findDangerousFlags,
  maskDeclaredSecrets,
  MASKED_SECRET,
  readConfigPath,
  resolveSecretInputs,
  resolveSecretRef,
  SECRET_REF_PATTERN,
  splitConfigPath,
} from './config-contracts.js'
import { PluginError } from './errors.js'

const env = (values: Record<string, string | undefined>) => (name: string) => values[name]

describe('secret references', () => {
  it('matches only env and file references', () => {
    expect(SECRET_REF_PATTERN.test('env:TOKEN')).toBe(true)
    expect(SECRET_REF_PATTERN.test('file:/tmp/secret')).toBe(true)
    expect(SECRET_REF_PATTERN.test('exec:cat /tmp/secret')).toBe(false)
    expect(SECRET_REF_PATTERN.test('plain')).toBe(false)
  })

  it('resolves env references', async () => {
    await expect(resolveSecretRef('env:TOKEN', { env: env({ TOKEN: 'abc' }), file: vi.fn() }))
      .resolves
      .toBe('abc')
  })

  it('rejects missing and empty env references', async () => {
    const resolver = { env: env({ EMPTY: '' }), file: vi.fn() }
    await expect(resolveSecretRef('env:MISSING', resolver)).rejects.toThrow(/env:MISSING is not set/)
    await expect(resolveSecretRef('env:EMPTY', resolver)).rejects.toThrow(/env:EMPTY is not set/)
  })

  it('resolves and trims file references', async () => {
    const file = vi.fn(async () => '  s3cret\n')
    await expect(resolveSecretRef('file:/run/secrets/token', { env: vi.fn(), file }))
      .resolves
      .toBe('s3cret')
    expect(file).toHaveBeenCalledWith('/run/secrets/token')
  })

  it('rejects empty files and wraps read failures', async () => {
    await expect(resolveSecretRef('file:/tmp/empty', { env: vi.fn(), file: async () => ' \n' }))
      .rejects
      .toThrow(/file:\/tmp\/empty is empty/)

    const error = await resolveSecretRef('file:/tmp/missing', {
      env: vi.fn(),
      file: async () => {
        throw new Error('EACCES')
      },
    }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(PluginError)
    expect((error as PluginError).message).toBe('Could not read secret reference file:/tmp/missing')
    expect((error as PluginError).cause).toBeInstanceOf(Error)
  })

  it('returns plain strings unchanged', async () => {
    await expect(resolveSecretRef('plain-value')).resolves.toBe('plain-value')
  })

  it('passes through an existing PluginError from a file resolver', async () => {
    const original = new PluginError('custom failure')
    const file = async (): Promise<string> => {
      throw original
    }
    await expect(resolveSecretRef('file:/tmp/x', { env: vi.fn(), file })).rejects.toBe(original)
  })
})

describe('default resolvers', () => {
  const restore: string[] = []

  afterEach(async () => {
    for (const name of restore.splice(0))
      delete process.env[name]
  })

  it('reads env references from the process environment and file references from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'giclaw-secret-'))
    try {
      const secretPath = join(dir, 'token')
      await writeFile(secretPath, ' from-disk \n', 'utf-8')
      process.env.GICLAW_DEFAULT_SECRET = 'from-env'
      restore.push('GICLAW_DEFAULT_SECRET')

      await expect(resolveSecretRef('env:GICLAW_DEFAULT_SECRET')).resolves.toBe('from-env')
      await expect(resolveSecretRef(`file:${secretPath}`)).resolves.toBe('from-disk')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveSecretInputs', () => {
  it('walks nested objects and arrays', async () => {
    const input = {
      appId: 'cli_x',
      appSecret: 'env:APP_SECRET',
      endpoints: [{ secret: 'env:APP_SECRET' }, { secret: 'literal' }],
      count: 2,
      flag: true,
      nothing: null,
    }

    const resolved = await resolveSecretInputs(input, { env: env({ APP_SECRET: 'resolved' }), file: vi.fn() })

    expect(resolved).toEqual({
      appId: 'cli_x',
      appSecret: 'resolved',
      endpoints: [{ secret: 'resolved' }, { secret: 'literal' }],
      count: 2,
      flag: true,
      nothing: null,
    })
    expect(resolved).not.toBe(input)
  })

  it('refuses to recurse past the depth limit', async () => {
    let nested: unknown = 'env:X'
    for (let index = 0; index < 40; index++)
      nested = { nested }

    await expect(resolveSecretInputs(nested, { env: env({ X: 'x' }), file: vi.fn() }))
      .rejects
      .toThrow(/exceeded the maximum depth/)
  })
})

describe('config paths', () => {
  it('splits paths and ignores empty segments', () => {
    expect(splitConfigPath('accounts.*.password')).toEqual(['accounts', '*', 'password'])
    expect(splitConfigPath('.a..b.')).toEqual(['a', 'b'])
  })

  it('collects values through wildcards', () => {
    const config = {
      accounts: {
        primary: { password: 'one' },
        backup: { password: 'two' },
      },
      other: {},
    }

    expect(readConfigPath(config, 'accounts.*.password')).toEqual(['one', 'two'])
    expect(readConfigPath(config, 'accounts.primary.password')).toEqual(['one'])
    expect(readConfigPath(config, 'accounts.missing.password')).toEqual([])
    expect(readConfigPath(config, '')).toEqual([config])
  })

  it('stops descending through non-objects and arrays', () => {
    expect(readConfigPath({ a: 'string' }, 'a.b')).toEqual([])
    expect(readConfigPath({ a: ['x'] }, 'a.b')).toEqual([])
    expect(readConfigPath({ a: { '*': { b: 'kept' } } }, 'a.*.b')).toEqual(['kept'])
  })
})

describe('maskDeclaredSecrets', () => {
  it('masks declared secrets and clones the tree', () => {
    const config = {
      accounts: { primary: { password: 'one', user: 'me' } },
      token: 'top',
      nested: { deep: 'untouched' },
    }

    const masked = maskDeclaredSecrets(config, {
      secretInputs: { paths: [{ path: 'accounts.*.password' }, { path: 'token' }] },
    }) as typeof config

    expect(masked.accounts.primary.password).toBe(MASKED_SECRET)
    expect(masked.token).toBe(MASKED_SECRET)
    expect(masked.accounts.primary.user).toBe('me')
    expect(masked.nested.deep).toBe('untouched')
    expect(masked.accounts).not.toBe(config.accounts)
    expect(config.accounts.primary.password).toBe('one')
  })

  it('stops at null, primitive and array leaves', () => {
    const config = { nil: null, text: 'plain', list: ['a'] }

    const masked = maskDeclaredSecrets(config, {
      secretInputs: { paths: [{ path: 'nil.token' }, { path: 'text.token' }, { path: 'list.token' }] },
    })

    expect(masked).toEqual(config)
  })

  it('returns the value unchanged without contracts', () => {
    const config = { token: 'top' }
    expect(maskDeclaredSecrets(config)).toBe(config)
  })

  it('leaves non-string leaves and primitives untouched', () => {
    const config = { number: 3, flag: true, nested: { value: 1 } }

    const masked = maskDeclaredSecrets(config, {
      secretInputs: { paths: [{ path: 'number' }, { path: 'flag' }, { path: 'nested' }, { path: 'missing' }] },
    })

    expect(masked).toEqual(config)
  })

  it('masks every entry of an object addressed with a trailing wildcard', () => {
    const masked = maskDeclaredSecrets(
      { accounts: { a: 'one', b: 'two' }, version: 2 },
      { secretInputs: { paths: [{ path: 'accounts.*' }, { path: 'version' }] } },
    )

    expect(masked).toEqual({ accounts: { a: MASKED_SECRET, b: MASKED_SECRET }, version: 2 })
  })
})

describe('findDangerousFlags', () => {
  it('reports paths whose value equals the declared flag', () => {
    const config = { allowAllSenders: true, accounts: { a: { unsafeMode: true }, b: { unsafeMode: false } } }

    expect(findDangerousFlags(config, {
      dangerousFlags: [
        { path: 'allowAllSenders', equals: true },
        { path: 'accounts.*.unsafeMode', equals: true },
        { path: 'missing', equals: true },
        { path: 'allowAllSenders', equals: false },
      ],
    })).toEqual(['allowAllSenders', 'accounts.*.unsafeMode'])
  })

  it('returns nothing when no flags are declared', () => {
    expect(findDangerousFlags({ allowAllSenders: true })).toEqual([])
  })
})
