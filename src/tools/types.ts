import type { ActionPlan } from '../model/types.js'

export interface ToolResult {
  success: boolean
  action: string
  detail?: string
}

export type BrowserAction = Pick<
  ActionPlan,
  'action' | 'x' | 'y' | 'direction' | 'text' | 'key'
>
