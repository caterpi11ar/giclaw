// validate-skill.ts <skillsDir> [skillsDir...]
//
// Load a skills directory with giclaw's real loader (strict frontmatter, kebab
// id, non-empty steps, valid atomic operations, no dependency cycles) without
// touching the model, the browser, or ~/.giclaw/config.json. This is the
// offline gate every candidate must pass before it is allowed to run.
//
// Exit code 0 = all skills valid; 1 = at least one invalid; 2 = bad usage.

import process from 'node:process'
import { loadSkills } from '../../../../src/skills/loader.js'
import { toError } from '../../../../src/utils/errors.js'

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error('usage: validate-skill.ts <skillsDir> [skillsDir...]')
  process.exit(2)
}

try {
  const skills = await loadSkills(dirs)
  if (skills.length === 0) {
    console.error(`INVALID: no loadable SKILL.md found in ${dirs.join(', ')}`)
    process.exit(1)
  }
  for (const skill of skills) {
    process.stdout.write(`OK ${skill.id} (${skill.steps.length} step(s), ${skill.dependsOn.length} dep(s))\n`)
  }
}
catch (error) {
  console.error(`INVALID: ${toError(error).message}`)
  process.exit(1)
}
