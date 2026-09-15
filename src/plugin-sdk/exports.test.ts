import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface PackageManifest {
  exports: Record<string, string | Record<string, string>>
  files: string[]
}

const manifest = JSON.parse(
  readFileSync(resolve(projectRoot, 'package.json'), 'utf8'),
) as PackageManifest

/**
 * The published subpaths a third-party plugin imports, in openclaw's names for
 * the parts Giclaw implements (`openclaw/plugin-sdk/*`).
 */
const EXPORTS = manifest.exports

/** Each declared subpath must resolve to a module the build actually emits. */
function sourceFor(target: string): string {
  return resolve(projectRoot, target.replace(/^\.\/dist\//u, 'src/').replace(/\.d\.ts$/u, '.ts').replace(/\.js$/u, '.ts'))
}

describe('plugin sdk package exports', () => {
  it('publishes the openclaw subpaths giclaw mirrors', () => {
    expect(Object.keys(EXPORTS).sort()).toEqual([
      './package.json',
      './plugin-sdk',
      './plugin-sdk/channel-ingress-runtime',
      './plugin-sdk/channel-plugin-common',
      './plugin-sdk/config-contracts',
      './plugin-sdk/plugin-entry',
      './plugin-sdk/types',
    ])
  })

  it('keeps the dist directory out of the published file list', () => {
    expect(manifest.files).toContain('dist')
  })

  it('maps every subpath onto a source module that exists', () => {
    for (const [subpath, value] of Object.entries(EXPORTS)) {
      const conditions = typeof value === 'string' ? { default: value } : value
      expect(Object.keys(conditions).length, subpath).toBeGreaterThan(0)
      for (const target of Object.values(conditions)) {
        expect(target, subpath).toMatch(/^\.\/dist\/|^\.\/package\.json$/u)
        if (target === './package.json')
          continue
        const source = sourceFor(target)
        expect(source.startsWith(projectRoot), subpath).toBe(true)
        expect(existsSync(source), `${subpath} → ${target}`).toBe(true)
      }
    }
  })
})
