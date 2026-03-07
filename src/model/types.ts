export type Locale = 'zh' | 'en'

export interface VisionModelConfig {
  name: string
  baseUrl: string
  apiKey: string
  viewport?: { width: number, height: number }
  locale?: Locale
}

export interface Coordinates {
  x: number
  y: number
}

export type ActionType
  = | 'click'
    | 'wait'
    | 'scroll'
    | 'type'
    | 'press-key'
    | 'done'

export interface ActionPlan {
  action: ActionType
  reason: string
  // click
  x?: number
  y?: number
  // scroll
  direction?: 'up' | 'down'
  // type
  text?: string
  // press-key
  key?: string
  // done
  success?: boolean
}

export interface RecentAction {
  step: number
  action: ActionType
  x?: number
  y?: number
  key?: string
  reason: string
}

export interface TaskDescription {
  background: string
  goal: string
  knownIssues: string[]
}

export interface IVisionModel {
  analyze: (imageBase64: string, prompt: string) => Promise<string>
  findCoordinates: (
    imageBase64: string,
    goal: string,
  ) => Promise<Coordinates | null>
  planNextAction: (
    imageBase64: string,
    goal: string | TaskDescription,
    recentActions?: RecentAction[],
  ) => Promise<ActionPlan>
  checkCondition: (imageBase64: string, condition: string) => Promise<boolean>
  query: <T>(imageBase64: string, prompt: string) => Promise<T>
}
