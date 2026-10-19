// apply-patch.ts --id <skill-id> --base <SKILL.md> --patch <patch.json> --out <file> [--known-ids a,b,c]
//
// Apply a model-proposed SkillPatch to an existing SKILL.md and validate the
// result with the real loader + red-line policy, WITHOUT launching a browser.
// A candidate is only written when it passes validation.
//
// stdout: JSON { ok, skillId, out, violations }
// stderr: diagnostics
// exit:   0 written | 1 rejected by validation | 2 bad usage / malformed patch

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { applyPatch, skillPatchSchema, validateSkillCandidate } from '../../../../src/evolve/index.js'
import { toError } from '../../../../src/utils/errors.js'
import { sanitizeBoundedText } from '../../../../src/utils/logger.js'

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: apply-patch.ts --id <skill-id> --base <SKILL.md> --patch <patch.json> --out <file> [--known-ids a,b,c]')
  process.exit(0)
}

const id = readOption('--id')
const basePath = readOption('--base')
const patchPath = readOption('--patch')
const out = readOption('--out')
const knownIds = readOption('--known-ids')?.split(',').map(value => value.trim()).filter(Boolean)

if (!id || !basePath || !patchPath || !out) {
  console.error('missing required flag (--id, --base, --patch, --out). Try --help')
  process.exit(2)
}

try {
  const [baseMarkdown, patchJson] = await Promise.all([
    readFile(basePath, 'utf-8'),
    readFile(patchPath, 'utf-8'),
  ])

  const patch = skillPatchSchema.parse(JSON.parse(patchJson))
  const candidate = applyPatch(baseMarkdown, patch)
  const result = validateSkillCandidate({ id, markdown: candidate, knownSkillIds: knownIds })

  if (!result.ok) {
    for (const violation of result.violations)
      console.error(`rejected: ${violation}`)
    console.log(JSON.stringify({ ok: false, skillId: id, out: null, violations: result.violations }))
    process.exit(1)
  }

  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, candidate, { encoding: 'utf-8', mode: 0o600 })
  console.log(JSON.stringify({ ok: true, skillId: id, out, violations: [] }))
}
catch (error) {
  console.error(`apply-patch failed: ${sanitizeBoundedText(toError(error).message, 2_000)}`)
  process.exit(2)
}
