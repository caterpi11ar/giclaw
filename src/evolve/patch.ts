import type { StepMethod } from '../skills/types.js'
import type { SkillPatch } from './types.js'
import { locateSkill, parseStepLine } from '../skills/document.js'
import { validateStepArgument } from '../skills/step-arguments.js'
import { EvolveError } from '../utils/errors.js'

export { locateSkill }
export type { LocatedSkill } from '../skills/document.js'

/**
 * Apply a single, minimal SKILL.md patch as a line-level text edit.
 *
 * Line-level editing (rather than re-serializing through gray-matter) keeps the
 * candidate diff minimal and reviewable, which is the whole point of a
 * bounded, rollbackable evolution step. The document format itself lives in
 * `skills/document.ts`, shared with the loader.
 */

const BULLET_PREFIX = '- '
const TIMEOUT_PREFIX = 'timeoutMs:'

/** Append a block, preserving an existing trailing newline. */
function appendBlock(lines: string[], block: string[]): void {
  const trailing = lines.at(-1) === ''
  const base = trailing ? lines.slice(0, -1) : lines.slice()
  if (base.length > 0 && base.at(-1) !== '')
    base.push('')
  base.push(...block)
  if (trailing)
    base.push('')
  lines.length = 0
  lines.push(...base)
}

/**
 * Apply a validated patch. Throws `EvolveError` when the target step/section
 * does not exist, so a stale model proposal fails locally instead of running.
 */
export function applyPatch(markdown: string, patch: SkillPatch): string {
  const located = locateSkill(markdown)
  const { lines } = located

  switch (patch.kind) {
    case 'insert-step': {
      const rendered = patch.steps.map((step) => {
        validateStepArgument(step.method, step.prompt)
        return `${BULLET_PREFIX}${step.method}: ${step.prompt}`
      })
      if (located.stepsHeading === -1) {
        appendBlock(lines, ['## Steps', ...rendered])
        return lines.join('\n')
      }
      if (patch.position > located.stepLines.length) {
        throw new EvolveError(
          `insert-step 位置 ${patch.position} 超出步骤数 ${located.stepLines.length}`,
        )
      }
      const at = patch.position < located.stepLines.length
        ? located.stepLines[patch.position]!
        : (located.stepLines.length > 0
            ? located.stepLines.at(-1)! + 1
            : located.stepsHeading + 1)
      lines.splice(at, 0, ...rendered)
      return lines.join('\n')
    }

    case 'edit-step-prompt': {
      if (patch.step > located.stepLines.length) {
        throw new EvolveError(
          `edit-step-prompt 目标步骤 ${patch.step} 超出步骤数 ${located.stepLines.length}`,
        )
      }
      const lineIndex = located.stepLines[patch.step - 1]!
      const parsed = parseStepLine(lines[lineIndex]!)!
      const method = parsed.method as StepMethod
      validateStepArgument(method, patch.prompt)
      lines[lineIndex] = `${BULLET_PREFIX}${method}: ${patch.prompt}`
      return lines.join('\n')
    }

    case 'reorder-step': {
      const steps = located.stepLines
      if (patch.from > steps.length || patch.to > steps.length) {
        throw new EvolveError(
          `reorder-step 范围 ${patch.from}->${patch.to} 超出步骤数 ${steps.length}`,
        )
      }
      if (patch.from === patch.to)
        return lines.join('\n')
      const values = steps.map(index => lines[index]!)
      const [moved] = values.splice(patch.from - 1, 1)
      values.splice(patch.to - 1, 0, moved!)
      steps.forEach((index, position) => {
        lines[index] = values[position]!
      })
      return lines.join('\n')
    }

    case 'add-known-issue': {
      const issue = patch.issue.trim().replace(/^-\s*/, '').trim()
      if (!issue)
        throw new EvolveError('add-known-issue 的 issue 为空')
      if (located.knownIssuesHeading === -1) {
        appendBlock(lines, ['## Known Issues', `${BULLET_PREFIX}${issue}`])
        return lines.join('\n')
      }
      const at = located.knownIssueLines.length > 0
        ? located.knownIssueLines.at(-1)! + 1
        : located.knownIssuesHeading + 1
      lines.splice(at, 0, `${BULLET_PREFIX}${issue}`)
      return lines.join('\n')
    }

    case 'adjust-timeout': {
      if (located.frontmatterClose === -1)
        throw new EvolveError('adjust-timeout 需要技能包含 frontmatter')
      for (let i = 1; i < located.frontmatterClose; i++) {
        if (lines[i]!.trim().startsWith(TIMEOUT_PREFIX)) {
          lines[i] = `timeoutMs: ${patch.timeoutMs}`
          return lines.join('\n')
        }
      }
      lines.splice(located.frontmatterClose, 0, `timeoutMs: ${patch.timeoutMs}`)
      return lines.join('\n')
    }
  }
}
