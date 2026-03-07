import type {
  ActionPlan,
  Coordinates,
  IVisionModel,
  RecentAction,
  TaskDescription,
  VisionModelConfig,
} from './types.js'
import { logger } from '../utils/logger.js'
import {
  checkConditionPrompt,
  findCoordinatesPrompt,
  planNextActionPrompt,
  queryPrompt,
} from './prompts.js'

interface ChatResponse {
  choices: Array<{
    message: {
      content: string
    }
  }>
}

/** Per-request timeout (2 minutes — pro models can be slow). */
const REQUEST_TIMEOUT_MS = 120_000

/** Max retries for transient failures (empty response, timeout, 5xx). */
const MAX_RETRIES = 2

/**
 * Pure model client — accepts base64 images, returns parsed results.
 * No dependency on Playwright Page.
 */
export class VisionModel implements IVisionModel {
  private config: VisionModelConfig

  constructor(config: VisionModelConfig) {
    this.config = config
  }

  /** Convert model coordinates (0-999 normalized) to viewport pixels. */
  private toPixel(x: number, y: number): { x: number, y: number } {
    const vw = this.config.viewport?.width ?? 1280
    const vh = this.config.viewport?.height ?? 720
    return {
      x: Math.round((x / 1000) * vw),
      y: Math.round((y / 1000) * vh),
    }
  }

  /** Raw chat call: send image + text prompt, get text response. */
  async analyze(imageBase64: string, prompt: string): Promise<string> {
    const url
      = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`

    logger.debug(`Vision API call: ${prompt.slice(0, 80)}...`)

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        logger.warn(`Vision API retry ${attempt}/${MAX_RETRIES}`)
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.name,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:image/png;base64,${imageBase64}`,
                    },
                  },
                  { type: 'text', text: prompt },
                ],
              },
            ],
            max_tokens: 4096,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })

        if (response.status >= 500) {
          lastError = new Error(`Vision API error ${response.status}: ${await response.text()}`)
          continue
        }

        if (!response.ok) {
          const text = await response.text()
          throw new Error(`Vision API error ${response.status}: ${text}`)
        }

        const data = (await response.json()) as ChatResponse
        const content = data.choices[0]?.message?.content
        if (!content) {
          lastError = new Error('Vision API returned empty response')
          continue
        }

        logger.debug(`Vision API response: ${content.slice(0, 120)}`)
        return content
      }
      catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
          lastError = new Error(`Vision API timed out after ${REQUEST_TIMEOUT_MS}ms`)
          continue
        }
        throw err
      }
    }

    throw lastError as Error
  }

  async findCoordinates(
    imageBase64: string,
    goal: string,
  ): Promise<Coordinates | null> {
    const prompt = findCoordinatesPrompt(goal, this.config.locale ?? 'zh')
    const result = await this.analyze(imageBase64, prompt)
    try {
      const coords = this.extractJson<Coordinates>(result)
      if (coords.x < 0 || coords.y < 0)
        return null
      return this.toPixel(coords.x, coords.y)
    }
    catch {
      return null
    }
  }

  async planNextAction(
    imageBase64: string,
    goal: string | TaskDescription,
    recentActions?: RecentAction[],
  ): Promise<ActionPlan> {
    const prompt = planNextActionPrompt(goal, recentActions, this.config.locale ?? 'zh')
    const result = await this.analyze(imageBase64, prompt)
    try {
      const plan = this.extractJson<ActionPlan>(result)
      if (plan.action === 'click' && plan.x != null && plan.y != null) {
        const px = this.toPixel(plan.x, plan.y)
        plan.x = px.x
        plan.y = px.y
      }
      return plan
    }
    catch {
      logger.warn(`Failed to parse action plan: ${result.slice(0, 120)}`)
      return {
        action: 'wait',
        reason: 'Failed to parse AI response, retrying',
      }
    }
  }

  /**
   * Extract a JSON object from model output.
   * Handles: markdown fences, multi-line responses, truncated JSON.
   */
  private extractJson<T>(raw: string): T {
    // Strip markdown code fences
    const text = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim()

    // Try full match (first { to last })
    const fullMatch = text.match(/\{[\s\S]*\}/)
    if (fullMatch) {
      try {
        return JSON.parse(fullMatch[0]) as T
      }
      catch {
        // Fall through to repair
      }
    }

    // Try to repair truncated JSON (missing closing "} )
    const braceIdx = text.indexOf('{')
    if (braceIdx >= 0) {
      const fragment = text.slice(braceIdx)
      // Append closing quote + brace if truncated mid-string
      for (const suffix of ['}', '"}', '""}']) {
        try {
          return JSON.parse(fragment + suffix) as T
        }
        catch {
          // Try next suffix
        }
      }
    }

    throw new Error(`No valid JSON found in: ${raw.slice(0, 120)}`)
  }

  async checkCondition(
    imageBase64: string,
    condition: string,
  ): Promise<boolean> {
    const prompt = checkConditionPrompt(condition, this.config.locale ?? 'zh')
    const result = await this.analyze(imageBase64, prompt)
    return /true/i.test(result)
  }

  async query<T>(imageBase64: string, prompt: string): Promise<T> {
    const fullPrompt = queryPrompt(prompt, this.config.locale ?? 'zh')
    const result = await this.analyze(imageBase64, fullPrompt)
    return this.extractJson<T>(result)
  }
}
