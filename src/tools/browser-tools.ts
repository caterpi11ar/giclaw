import type { Page } from 'playwright'
import type { ActionPlan } from '../model/types.js'
import type { ToolResult } from './types.js'
import { delay } from '../utils/delay.js'

/** Click at the given coordinates. */
export async function clickAt(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  await page.mouse.click(x, y)
}

/** Scroll the page up or down. */
export async function scroll(
  page: Page,
  direction: 'up' | 'down',
): Promise<void> {
  const delta = direction === 'up' ? -300 : 300
  await page.mouse.wheel(0, delta)
}

/** Type text using the keyboard. */
export async function typeText(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text)
}

/** Press a single key (e.g. "Escape", "Enter"). */
export async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key)
}

/** Click the center of the viewport (useful for canvas activation). */
export async function clickCenter(page: Page): Promise<void> {
  const viewport = page.viewportSize()
  const w = viewport?.width ?? 1280
  const h = viewport?.height ?? 720
  await page.mouse.click(Math.round(w / 2), Math.round(h / 2))
}

/**
 * Execute an ActionPlan on the page. Returns a ToolResult.
 * Does NOT handle the "done" action — that is the caller's responsibility.
 */
export async function executeAction(
  page: Page,
  plan: ActionPlan,
): Promise<ToolResult> {
  switch (plan.action) {
    case 'click':
      await clickAt(page, plan.x!, plan.y!)
      await delay(2000)
      return { success: true, action: 'click', detail: `(${plan.x}, ${plan.y})` }

    case 'wait':
      await delay(3000)
      return { success: true, action: 'wait' }

    case 'scroll':
      await scroll(page, plan.direction ?? 'down')
      await delay(1000)
      return { success: true, action: 'scroll', detail: plan.direction }

    case 'type':
      await typeText(page, plan.text!)
      await delay(1000)
      return { success: true, action: 'type', detail: plan.text }

    case 'press-key':
      await pressKey(page, plan.key!)
      await delay(1000)
      return { success: true, action: 'press-key', detail: plan.key }

    case 'done':
      return { success: true, action: 'done' }
  }
}
