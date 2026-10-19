import type { TranscriptEntry } from '../memory/types.js'
import type { Diagnosis } from './types.js'
import { STEP_METHODS } from '../skills/types.js'
import { EvolveError } from '../utils/errors.js'
import { sanitizeBoundedText } from '../utils/logger.js'
import { parseJsonObject } from './json.js'
import { diagnosisSchema } from './types.js'

/**
 * Structured diagnosis of a failed skill.
 *
 * The model only *reads* evidence here — it never proposes or applies an edit.
 * That separation keeps a bad diagnosis from directly mutating a skill, and
 * makes the diagnosis independently testable: `buildDiagnosisPrompt` and
 * `parseDiagnosis` are pure, while `diagnoseSkill` takes an injected call so no
 * network is needed in tests (the engine supplies the real client in Slice 4).
 */

export interface DiagnoseInput {
  skillId: string
  skillMarkdown: string
  transcript: TranscriptEntry[]
  runSummary?: { success: boolean, message: string }
  knownIssues?: string[]
}

export interface DiagnosisPrompt {
  system: string
  user: string
}

export type DiagnosisCall = (prompt: DiagnosisPrompt) => Promise<string>

const MAX_SKILL_CHARS = 12_000
const MAX_TRANSCRIPT_ENTRIES = 60
const MAX_ENTRY_CHARS = 1_500

const FIX_KINDS = [
  'insert-wait-before-step',
  'insert-step',
  'edit-step-prompt',
  'reorder-step',
  'add-known-issue',
  'adjust-timeout',
  'no-safe-fix',
]

export function buildDiagnosisPrompt(input: DiagnoseInput): DiagnosisPrompt {
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
    '你是 giclaw 的技能诊断器。giclaw 通过可审计的 SKILL.md 工作流在云原神中执行操作。',
    '你会收到一个失败技能的源码、最近一次运行的逐步记录和运行摘要。',
    '只做诊断，不要提出或应用补丁。输出必须是单个 JSON 对象，不要包含 Markdown 代码块或额外解释。',
    '',
    'JSON 字段：',
    '- failedStep: 失败步骤序号（1 起），无法确定时为 null',
    `- method: 该步骤的原子操作（可选值：${STEP_METHODS.join(', ')}），未知时为 null`,
    '- rootCauseHypothesis: 对根因的具体假设（说明为什么，而不是只说"失败了"）',
    '- confidence: 0 到 1 的置信度',
    `- suggestedFixKind: 建议的修复类型（${FIX_KINDS.join(' | ')}）；无法安全修复时必须选择 no-safe-fix`,
    '- reasoning: 可选的证据引用',
    '',
    '红线：涉及购买、消耗原石/付费货币、不可逆操作时，必须返回 no-safe-fix，不要试图绕过。',
  ].join('\n')

  const userParts = [
    `技能 id：${input.skillId}`,
    '',
    '## SKILL.md',
    sanitizeBoundedText(input.skillMarkdown, MAX_SKILL_CHARS),
  ]
  if (input.knownIssues?.length) {
    userParts.push('', '## Known Issues', input.knownIssues.map(issue => `- ${issue}`).join('\n'))
  }
  if (input.runSummary) {
    userParts.push(
      '',
      '## Run summary',
      `success=${input.runSummary.success}`,
      `message=${sanitizeBoundedText(input.runSummary.message, MAX_ENTRY_CHARS)}`,
    )
  }
  userParts.push('', '## Transcript (最近优先)', transcript || '(空)')

  return { system, user: userParts.join('\n') }
}

export function parseDiagnosis(raw: string): Diagnosis {
  const parsed = diagnosisSchema.safeParse(parseJsonObject(raw))
  if (!parsed.success) {
    throw new EvolveError(
      `诊断输出不符合 schema: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`,
    )
  }
  return parsed.data
}

export async function diagnoseSkill(
  input: DiagnoseInput,
  call: DiagnosisCall,
): Promise<Diagnosis> {
  const prompt = buildDiagnosisPrompt(input)
  return parseDiagnosis(await call(prompt))
}
