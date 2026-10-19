export const STEP_METHODS = [
  // Vision-driven operations (Midscene)
  'aiAct',
  'aiTap',
  'aiRightClick',
  'aiHover',
  'aiInput',
  'aiKeyboardPress',
  'aiScroll',
  'aiWaitFor',
  'aiAssert',
  'aiBoolean',
  // Deterministic browser operations (macro/replay building blocks)
  'click',
  'rightClick',
  'move',
  'scroll',
  'type',
  'keyPress',
  'keyDown',
  'keyUp',
  'mouseDown',
  'mouseUp',
  'wait',
  'screenshot',
] as const

export type StepMethod = typeof STEP_METHODS[number]

export interface SkillStep {
  method: StepMethod
  prompt: string
}

export interface SkillDefinition {
  id: string
  name: string
  description: string
  enabled: boolean
  /** Context skills only contribute Background / Known Issues; they never run. */
  context?: boolean
  /** Context skill tags (empty = core). */
  tags?: string[]
  /** Runnable skill: context tags to inject (core is always injected). */
  contexts?: string[]
  timeoutMs: number
  retries: number
  dependsOn: string[]
  steps: SkillStep[]
  background?: string
  goal?: string
  knownIssues?: string[]
  sourcePath: string
}
