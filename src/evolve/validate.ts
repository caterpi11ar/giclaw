import type { CandidateValidation, PolicyLimits } from './types.js'
import matter from 'gray-matter'
import { frontmatterSchema, parseSkillBody } from '../skills/loader.js'
import { toError } from '../utils/errors.js'
import { checkSkillPolicy } from './policy.js'

/**
 * In-memory validation of a candidate SKILL.md.
 *
 * This runs the exact frontmatter schema and body parser the loader uses, then
 * the red-line policy, without touching disk or the network. It is the hard
 * gate between "the model proposed an edit" and "we spend a browser run".
 */

export interface ValidateSkillCandidateParams {
  /** Expected skill id; must match the candidate's frontmatter id. */
  id: string
  markdown: string
  knownSkillIds?: string[]
  limits?: Partial<PolicyLimits>
}

export function validateSkillCandidate(
  params: ValidateSkillCandidateParams,
): CandidateValidation {
  let parsed: { data: unknown, content: string }
  try {
    parsed = matter(params.markdown)
  }
  catch (error) {
    return { ok: false, violations: [`frontmatter 解析失败: ${toError(error).message}`] }
  }

  const frontmatter = frontmatterSchema.safeParse(parsed.data)
  if (!frontmatter.success) {
    return {
      ok: false,
      violations: frontmatter.error.issues.map(
        issue => `${issue.path.join('.')}: ${issue.message}`,
      ),
    }
  }

  const violations: string[] = []
  if (frontmatter.data.id !== params.id)
    violations.push(`id "${frontmatter.data.id}" 与目标技能 "${params.id}" 不一致`)

  let body: ReturnType<typeof parseSkillBody>
  try {
    body = parseSkillBody(parsed.content, `candidate:${params.id}`)
  }
  catch (error) {
    return { ok: false, violations: [...violations, toError(error).message] }
  }

  const policy = checkSkillPolicy(
    {
      id: frontmatter.data.id,
      steps: body.steps,
      timeoutMs: frontmatter.data.timeoutMs,
      dependsOn: frontmatter.data.dependsOn,
    },
    { limits: params.limits, knownSkillIds: params.knownSkillIds },
  )
  violations.push(...policy.violations)

  return { ok: violations.length === 0, violations }
}
