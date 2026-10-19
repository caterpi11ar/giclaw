import type { StepMethod } from '../skills/types.js'
import { z } from 'zod'
import { STEP_METHODS } from '../skills/types.js'

/**
 * Structured contracts for the self-iteration loop.
 *
 * Everything the model produces is validated here before it can reach the
 * browser. The patch schema is intentionally a closed set of SKILL.md edits:
 * the loop may rewrite instructions, but never emit executable code.
 */

export const stepMethodSchema = z.enum(STEP_METHODS as unknown as [StepMethod, ...StepMethod[]])

/** Which kind of minimal edit the diagnosis suggests. */
export const fixKindSchema = z.enum([
  'insert-wait-before-step',
  'insert-step',
  'edit-step-prompt',
  'reorder-step',
  'add-known-issue',
  'adjust-timeout',
  'no-safe-fix',
])

export const diagnosisSchema = z.object({
  failedStep: z.number().int().positive().nullable(),
  method: stepMethodSchema.nullable(),
  rootCauseHypothesis: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1),
  suggestedFixKind: fixKindSchema,
  reasoning: z.string().max(4_000).optional(),
})

export type Diagnosis = z.infer<typeof diagnosisSchema>

const stepPatchSchema = z.object({
  method: stepMethodSchema,
  prompt: z.string().min(1).max(2_000),
})

/**
 * A single, minimal SKILL.md edit. Positions are 1-based step indices unless
 * noted otherwise; `insert-step` uses `position: 0` to mean "before all steps".
 */
export const skillPatchSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('insert-step'),
    position: z.number().int().nonnegative(),
    steps: z.array(stepPatchSchema).min(1).max(2),
  }),
  z.object({
    kind: z.literal('edit-step-prompt'),
    step: z.number().int().positive(),
    prompt: z.string().min(1).max(2_000),
  }),
  z.object({
    kind: z.literal('reorder-step'),
    from: z.number().int().positive(),
    to: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('add-known-issue'),
    issue: z.string().min(1).max(2_000),
  }),
  z.object({
    kind: z.literal('adjust-timeout'),
    timeoutMs: z.number().int().positive().max(3_600_000),
  }),
])

export type SkillPatch = z.infer<typeof skillPatchSchema>

export const policyLimitsSchema = z.object({
  maxSteps: z.number().int().positive().max(1_000).default(80),
  maxTimeoutMs: z.number().int().positive().max(3_600_000).default(900_000),
})

export const evolveBudgetSchema = z.object({
  maxGenerations: z.number().int().positive().max(20).default(3),
  maxWallClockMs: z.number().int().positive().max(3_600_000).default(1_800_000),
  maxModelCalls: z.number().int().positive().max(100).default(10),
  regressionFactor: z.number().min(1).max(5).default(1.5),
  requireApproval: z.boolean().default(true),
  maxPatchLines: z.number().int().positive().max(200).default(40),
})

export type EvolveBudget = z.infer<typeof evolveBudgetSchema>
export type PolicyLimits = z.infer<typeof policyLimitsSchema>

export interface CandidateValidation {
  ok: boolean
  violations: string[]
}

/** Terminal status of one generation attempt. */
export const generationStatusSchema = z.enum([
  'already-passing',
  'no-safe-fix',
  'rejected-validation',
  'model-error',
  'regressed',
  'run-failed',
  'accepted',
  'pending-approval',
  'aborted-budget',
  'proposed',
])

export type GenerationStatus = z.infer<typeof generationStatusSchema>

const runSnapshotSchema = z.object({
  runId: z.string(),
  success: z.boolean(),
  message: z.string().max(4_096),
  durationMs: z.number().finite().nonnegative(),
})

export const generationRecordSchema = z.object({
  genId: z.string().min(1),
  skillId: z.string().min(1),
  parentGenId: z.string().nullable().default(null),
  startedAt: z.string(),
  completedAt: z.string(),
  status: generationStatusSchema,
  trigger: z.literal('manual').default('manual'),
  model: z.object({ name: z.string(), baseUrl: z.string() }).optional(),
  baseline: runSnapshotSchema.optional(),
  diagnosis: diagnosisSchema.optional(),
  patch: z
    .object({
      kind: z.string(),
      changedLines: z.number().int().nonnegative(),
      unified: z.string().max(20_000),
      candidateFile: z.string().optional(),
    })
    .optional(),
  validation: z
    .object({ ok: z.boolean(), violations: z.array(z.string().max(2_000)).max(50) })
    .optional(),
  candidate: runSnapshotSchema.optional(),
  reason: z.string().max(4_096).optional(),
})

export type GenerationRecord = z.infer<typeof generationRecordSchema>

/** State needed to undo or confirm an evolution that is waiting for a human. */
export const pendingApprovalSchema = z.object({
  genId: z.string().min(1),
  skillId: z.string().min(1),
  candidateFile: z.string(),
  createdAt: z.string(),
  /** Content of the override that existed before this session, if any. */
  originalOverride: z.string().nullable().default(null),
})

export type PendingApproval = z.infer<typeof pendingApprovalSchema>

export const bestKnownGoodSchema = z.object({
  skillId: z.string().min(1),
  genId: z.string().min(1),
  acceptedAt: z.string(),
  candidateFile: z.string(),
})

export type BestKnownGood = z.infer<typeof bestKnownGoodSchema>
