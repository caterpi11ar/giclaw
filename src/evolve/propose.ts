import type { TranscriptEntry } from '../memory/types.js'
import type { DiagnosisCall, DiagnosisPrompt } from './diagnose.js'
import type { Diagnosis, SkillPatch } from './types.js'
import { EvolveError } from '../utils/errors.js'
import { sanitizeBoundedText } from '../utils/logger.js'
import { parseJsonObject } from './json.js'
import { skillPatchSchema } from './types.js'

/**
 * Patch proposal: turn a diagnosis into one minimal, structured SKILL.md edit.
 *
 * The model emits data, never code or a whole rewritten file. Keeping the
 * proposal structured means the diff stays minimal and every edit can be
 * validated before a browser run.
 */

export interface ProposeInput {
  skillId: string
  skillMarkdown: string
  diagnosis: Diagnosis
  transcript: TranscriptEntry[]
}

const MAX_SKILL_CHARS = 12_000
const MAX_TRANSCRIPT_ENTRIES = 40

const PATCH_EXAMPLES = [
  '{"kind":"insert-step","position":3,"steps":[{"method":"wait","prompt":"1s"}]}',
  '{"kind":"edit-step-prompt","step":24,"prompt":"世界地图显示稻妻区域，并且地图瓦片已完全加载"}',
  '{"kind":"reorder-step","from":5,"to":4}',
  '{"kind":"add-known-issue","issue":"地图区域切换后瓦片加载较慢，需等待 1s"}',
  '{"kind":"adjust-timeout","timeoutMs":900000}',
].join('\n')

export function buildProposalPrompt(input: ProposeInput): DiagnosisPrompt {
  const transcript = input.transcript
    .slice(-MAX_TRANSCRIPT_ENTRIES)
    .map((entry) => {
      const fields = [
        `step=${entry.step}`,
        `result=${entry.result}`,
        entry.method ? `method=${entry.method}` : undefined,
        entry.prompt ? `prompt=${entry.prompt}` : undefined,
        entry.errorMessage ? `error=${entry.errorMessage}` : undefined,
      ].filter(Boolean)
      return fields.join(' | ')
    })
    .join('\n')

  const system = [
    '你是 giclaw 的技能修复器。基于诊断结果，对 SKILL.md 做**一处最小修改**。',
    '只输出一个 JSON 补丁对象，不要输出代码、Markdown 代码块或解释。',
    '',
    '允许的补丁 kind（只选一个，位置为 1 起步骤序号）：',
    '- insert-step: { kind, position, steps:[{method,prompt}] }   # position=0 表示插入到最前',
    '- edit-step-prompt: { kind, step, prompt }',
    '- reorder-step: { kind, from, to }',
    '- add-known-issue: { kind, issue }',
    '- adjust-timeout: { kind, timeoutMs }',
    '',
    '示例：',
    PATCH_EXAMPLES,
    '',
    '约束：',
    '- 一次只改一处，优先 edit-step-prompt / insert-step / add-known-issue。',
    '- 绝不新增购买、消耗原石/付费货币或不可逆操作。',
    '- 只有诊断 suggestedFixKind 为 no-safe-fix 时，不要输出补丁（调用方不会再调用你）。',
  ].join('\n')

  const user = [
    `技能 id：${input.skillId}`,
    '',
    '## 诊断',
    JSON.stringify(input.diagnosis, null, 2),
    '',
    '## SKILL.md',
    sanitizeBoundedText(input.skillMarkdown, MAX_SKILL_CHARS),
    '',
    '## Transcript（最近优先）',
    transcript || '(空)',
  ].join('\n')

  return { system, user }
}

export function parseProposal(raw: string): SkillPatch {
  const parsed = skillPatchSchema.safeParse(parseJsonObject(raw))
  if (!parsed.success) {
    throw new EvolveError(
      `补丁输出不符合 schema: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`,
    )
  }
  return parsed.data
}

export async function proposePatch(
  input: ProposeInput,
  call: DiagnosisCall,
): Promise<SkillPatch> {
  return parseProposal(await call(buildProposalPrompt(input)))
}
