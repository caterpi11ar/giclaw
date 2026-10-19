/* eslint-disable regexp/no-dupe-characters-character-class, regexp/optimal-quantifier-concatenation, regexp/prefer-w */
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const MAX_SCANNED_FILE_BYTES = 8 * 1024 * 1024
const BINARY_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.webp',
  '.woff',
  '.woff2',
])
const EXCLUDED_CONTENT_FILES = new Set(['pnpm-lock.yaml', 'docs/pnpm-lock.yaml'])
const RUNTIME_DIRECTORIES = new Set([
  '.giclaw',
  'data',
  'midscene_run',
  'runtime-data',
  'screenshots',
  'transcripts',
])
const SAFE_TEMPLATE_MARKERS = /(?:^|[._-])(?:example|fixture|sample|template)(?:[._-]|$)/i

const SECRET_RULES = [
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{30,}\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['stripe-live-key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['huggingface-token', /\bhf_[A-Za-z0-9]{30,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['credential-assignment', /(?:password|passphrase|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|authorization)["']?[\t ]*(?::|=)[\t ]*["']?(?!\[REDACTED\]|your[-_]|example[-_]|test[-_]|fake[-_]|placeholder|this\.|process\.|config\.)[A-Za-z0-9_~+/-][A-Za-z0-9._~+/-]{19,}/i],
  ['credential-url', /\b(?:https?|postgres(?:ql)?|mongodb(?:\+srv)?):\/\/(?!user:password@example(?:\.com|\.test|\.org)(?:[/:]|$))[^\s/:@]{1,128}:[^\s/@]{8,}@/i],
]

function normalizeTrackedPath(filePath) {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function runtimePathRules(filePath) {
  const normalized = normalizeTrackedPath(filePath)
  const lower = normalized.toLowerCase()
  const segments = lower.split('/')
  const basename = segments.at(-1) ?? ''
  const violations = []

  if (segments.some(segment => RUNTIME_DIRECTORIES.has(segment)))
    violations.push('runtime-directory')
  if (basename === 'config.json' || (/^giclaw(?:[._-].+)?\.json$/.test(basename) && !basename.endsWith('.plugin.json')))
    violations.push('runtime-config')
  if (/^(?:cookies?|session|storage-state|auth-state)(?:[._-].*)?\.json$/.test(basename))
    violations.push('browser-session')
  if (/^\.env(?:\..+)?$/.test(basename) && !SAFE_TEMPLATE_MARKERS.test(basename))
    violations.push('environment-file')
  if (/\.(?:jks|key|keystore|p12|pfx|pem)$/i.test(basename) && !SAFE_TEMPLATE_MARKERS.test(basename))
    violations.push('private-key-file')

  return violations
}

function contentRules(text) {
  const violations = []
  for (const [rule, expression] of SECRET_RULES) {
    if (expression.test(text))
      violations.push(rule)
  }

  // Cookie exports frequently use arbitrary names, so recognize their stable
  // structure rather than relying only on cookies.json/session.json paths.
  if (/"name"\s*:\s*"[^"]+"/.test(text)
    && /"value"\s*:\s*"[^"]+"/.test(text)
    && /"domain"\s*:\s*"[^"]+"/.test(text)) {
    violations.push('cookie-jar-content')
  }
  return violations
}

function configuredRuntimeTargets(text) {
  const targets = []
  const expression = /["']?(cookieFilePath|dataDir)["']?[\t ]*(?::|=)[\t ]*["'`]([^"'`\r\n]+)["'`]/g
  for (const match of text.matchAll(expression)) {
    const kind = match[1]
    const rawTarget = match[2]?.trim()
    if (!kind || !rawTarget || path.isAbsolute(rawTarget) || rawTarget.includes('\0'))
      continue
    const normalized = normalizeTrackedPath(path.posix.normalize(rawTarget.replaceAll('\\', '/')))
    if (!normalized || normalized === '..' || normalized.startsWith('../'))
      continue
    targets.push({ kind, path: normalized })
  }
  return targets
}

function isLikelyBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0)
}

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return output.split('\0').filter(Boolean).map(normalizeTrackedPath)
}

function scanRepository() {
  const files = trackedFiles()
  const findings = new Map()
  const configuredTargets = []

  const addFinding = (file, rules) => {
    if (rules.length === 0)
      return
    const existing = findings.get(file) ?? new Set()
    for (const rule of rules)
      existing.add(rule)
    findings.set(file, existing)
  }

  for (const file of files) {
    addFinding(file, runtimePathRules(file))
    if (EXCLUDED_CONTENT_FILES.has(file) || BINARY_EXTENSIONS.has(path.extname(file).toLowerCase()))
      continue

    const stat = lstatSync(file)
    let buffer
    if (stat.isSymbolicLink()) {
      buffer = Buffer.from(readlinkSync(file), 'utf8')
    }
    else if (stat.size > MAX_SCANNED_FILE_BYTES) {
      addFinding(file, ['oversized-unscanned-file'])
      continue
    }
    else {
      buffer = readFileSync(file)
    }
    if (isLikelyBinary(buffer))
      continue

    const text = buffer.toString('utf8')
    addFinding(file, contentRules(text))
    configuredTargets.push(...configuredRuntimeTargets(text))
  }

  for (const target of configuredTargets) {
    for (const file of files) {
      const matches = target.kind === 'cookieFilePath'
        ? file === target.path
        : file === target.path || file.startsWith(`${target.path}/`)
      if (matches)
        addFinding(file, [`configured-${target.kind}`])
    }
  }

  return findings
}

const findings = scanRepository()
if (findings.size > 0) {
  console.error('Sensitive material policy violations were found in tracked files:')
  for (const [file, rules] of [...findings].sort(([left], [right]) => left.localeCompare(right)))
    console.error(`- ${file}: ${[...rules].sort().join(', ')}`)
  process.exitCode = 1
}
else {
  console.log('Sensitive material scan passed.')
}
