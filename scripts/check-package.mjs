import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/**
 * Subpaths a third-party plugin can import, mirroring openclaw's
 * `openclaw/plugin-sdk/*` names for the parts Giclaw implements.
 */
const REQUIRED_EXPORT_SUBPATHS = [
  './plugin-sdk',
  './plugin-sdk/channel-ingress-runtime',
  './plugin-sdk/channel-plugin-common',
  './plugin-sdk/config-contracts',
  './plugin-sdk/plugin-entry',
  './plugin-sdk/types',
]

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const cacheDirectory = mkdtempSync(join(tmpdir(), 'giclaw-package-check-'))

try {
  const output = execFileSync(
    npmCommand,
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cacheDirectory },
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  const reports = JSON.parse(output)
  if (!Array.isArray(reports) || reports.length !== 1 || !Array.isArray(reports[0]?.files))
    throw new Error('npm returned an unexpected package manifest')

  const files = reports[0].files
  const paths = new Set(files.map(file => file.path))
  const violations = []
  const allowedRootFiles = new Set(['README.md', 'THIRD_PARTY_NOTICES.md', 'package.json'])
  const runtimeSegments = new Set([
    '.giclaw',
    'data',
    'midscene_run',
    'screenshots',
    'transcripts',
  ])

  for (const file of files) {
    const filePath = String(file.path).replaceAll('\\', '/')
    const segments = filePath.toLowerCase().split('/')
    const allowed = allowedRootFiles.has(filePath)
      || filePath.startsWith('dist/')
      || filePath.startsWith('skills/')
    if (!allowed)
      violations.push(`${filePath}: unexpected package path`)
    if (segments.some(segment => runtimeSegments.has(segment)))
      violations.push(`${filePath}: runtime data path`)
    if (/(?:^|\/)(?:config|cookies?|session|storage-state|auth-state)(?:[._-].*)?\.json$/i.test(filePath))
      violations.push(`${filePath}: private configuration or session file`)
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filePath) || segments.includes('__tests__'))
      violations.push(`${filePath}: test artifact`)
  }

  for (const required of [
    'THIRD_PARTY_NOTICES.md',
    'dist/cli.js',
    'dist/extensions/feishu/giclaw.plugin.json',
    'dist/extensions/imap/giclaw.plugin.json',
    'dist/extensions/smtp/giclaw.plugin.json',
    'dist/extensions/webhook/giclaw.plugin.json',
    'dist/web/public/index.html',
    'dist/web/public/app.js',
    'dist/web/public/app.css',
    'skills/welkin-moon/SKILL.md',
    'skills/claim-mail/SKILL.md',
    'skills/battle-pass-claim/SKILL.md',
    'skills/claim-achievements/SKILL.md',
    'skills/claim-event-rewards/SKILL.md',
  ]) {
    if (!paths.has(required))
      violations.push(`${required}: required package file is missing`)
  }

  const cli = files.find(file => file.path === 'dist/cli.js')
  if (!cli || (Number(cli.mode) & 0o111) === 0)
    violations.push('dist/cli.js: package executable bit is missing')

  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const exportMap = manifest.exports ?? {}
  for (const subpath of REQUIRED_EXPORT_SUBPATHS) {
    if (!(subpath in exportMap))
      violations.push(`exports["${subpath}"]: SDK subpath is missing`)
  }
  for (const [subpath, value] of Object.entries(exportMap)) {
    const conditions = typeof value === 'string' ? { default: value } : value
    const targets = Object.entries(conditions)
    if (targets.length === 0)
      violations.push(`exports["${subpath}"]: declares no target`)
    for (const [condition, target] of targets) {
      if (typeof target !== 'string' || !target.startsWith('./')) {
        violations.push(`exports["${subpath}"]["${condition}"]: target must be a relative path`)
        continue
      }
      if (!paths.has(target.slice(2)))
        violations.push(`exports["${subpath}"]["${condition}"]: ${target} is not in the package`)
    }
  }

  if (violations.length > 0)
    throw new Error(`Package smoke check failed:\n${violations.join('\n')}`)

  console.log(`Package smoke check passed (${files.length} files).`)
}
finally {
  rmSync(cacheDirectory, { recursive: true, force: true })
}
