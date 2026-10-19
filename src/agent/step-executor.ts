import type { Page } from 'playwright'
import type { TranscriptEntry } from '../memory/types.js'
import type { AgentResult, StepContext } from './types.js'
import { devNull } from 'node:os'
import { setLogDirectoryResolver } from '@midscene/shared/logger'
import { PlaywrightAgent } from '@midscene/web/playwright'
import {
  parseArrowArgs,
  parseCoordinates,
  parseDuration,
  parseMouseButton,
  parseScrollSpec,
} from '../skills/step-arguments.js'
import { saveScreenshot } from '../tools/screenshot.js'
import { delay } from '../utils/delay.js'
import { StepExecutionError, TimeoutError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import {
  createAbortableOpenAIClient,
  createStreamingOpenAIClient,
} from './streaming-openai-client.js'

const patchedScreenshotPages = new WeakSet<Page>()
const pageAbortSignals = new WeakMap<Page, AbortSignal>()
const emergencyKeyboardUps = new WeakMap<Page, (key: string) => Promise<void>>()
const emergencyMouseUps = new WeakMap<Page, (button: 'left' | 'right' | 'middle') => Promise<void>>()
const CLOUD_MOUSE_HOLD_MS = 100
const CLOUD_KEY_HOLD_MS = 500
const MAX_AI_WAIT_MS = 180_000
const AI_WAIT_CHECK_INTERVAL_MS = 15_000
const AI_WAIT_HEARTBEAT_MS = 15_000
const TASK_CLEANUP_RESERVE_MS = 15_000
const AGENT_DESTROY_TIMEOUT_MS = 5_000
const PENDING_OPERATION = Symbol.for('giclaw.pending-step-operation')
const resolveMidsceneLogDirectory = () => devNull

type OperationOutcome<T>
  = | { status: 'fulfilled', value: T }
    | { status: 'rejected', error: unknown }
    | { status: 'aborted', reason: unknown }
    | { status: 'timed-out' }

type SettledOperationOutcome<T> = Extract<OperationOutcome<T>, { status: 'fulfilled' | 'rejected' }>
type StoppedOperationOutcome<T> = Extract<OperationOutcome<T>, { status: 'aborted' | 'timed-out' }>

function settledOutcome<T>(pending: Promise<T>): Promise<SettledOperationOutcome<T>> {
  return pending.then(
    value => ({ status: 'fulfilled' as const, value }),
    error => ({ status: 'rejected' as const, error }),
  )
}

function attachPendingOperation(error: TimeoutError, pending: Promise<unknown>): TimeoutError {
  Object.defineProperty(error, PENDING_OPERATION, {
    configurable: false,
    enumerable: false,
    value: pending,
    writable: false,
  })
  return error
}

async function runAbortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const pending = Promise.resolve().then(operation)
  const outcome = settledOutcome(pending)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<Extract<OperationOutcome<T>, { status: 'aborted' }>>((resolve) => {
    onAbort = () => resolve({
      status: 'aborted',
      // AbortSignal guarantees a reason after its abort event, defaulting to
      // an AbortError when abort() was called without an explicit value.
      reason: signal.reason,
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const result = await Promise.race([outcome, aborted])
    if (result.status === 'aborted') {
      // Do not abandon a Midscene operation after returning cancellation. The
      // task runner closes the page concurrently and waits for this task to
      // settle; if the underlying operation ignores both cancellation and page
      // closure, its cleanup deadline will quarantine the runner.
      await outcome
      throw result.reason
    }
    if (result.status === 'rejected')
      throw result.error
    return result.value
  }
  finally {
    if (onAbort)
      signal.removeEventListener('abort', onAbort)
  }
}

async function runWithDeadline<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  operationName: string,
  timeoutMs: number,
  terminate: (error: TimeoutError) => void,
): Promise<T> {
  signal.throwIfAborted()
  const pending = Promise.resolve().then(operation)
  const outcome = settledOutcome(pending)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stopped = new Promise<StoppedOperationOutcome<T>>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, { status: 'timed-out' })
    onAbort = () => resolve({
      status: 'aborted',
      reason: signal.reason,
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    const result = await Promise.race([outcome, stopped])
    if (result.status === 'timed-out') {
      const error = attachPendingOperation(
        new TimeoutError(operationName, timeoutMs),
        pending,
      )
      try {
        terminate(error)
      }
      catch (terminationError) {
        logger.warn(`Could not terminate timed-out operation "${operationName}"`, terminationError)
      }
      throw error
    }
    if (result.status === 'aborted') {
      await outcome
      throw result.reason
    }
    if (result.status === 'rejected')
      throw result.error
    return result.value
  }
  finally {
    if (timer)
      clearTimeout(timer)
    if (onAbort)
      signal.removeEventListener('abort', onAbort)
  }
}

function reportProgress(
  onProgress: StepContext['onProgress'],
  step: number,
  elapsed: number,
  action: string,
  reason: string,
): void {
  try {
    onProgress?.(step, elapsed, action, reason)
  }
  catch (error) {
    logger.warn('Could not report step progress', error)
  }
}

async function appendTranscriptSafely(
  transcript: StepContext['transcript'],
  entry: TranscriptEntry,
): Promise<void> {
  try {
    await transcript?.append(entry)
  }
  catch (error) {
    logger.warn('Could not record step in transcript', error)
  }
}

async function waitForAICondition(
  agent: PlaywrightAgent,
  prompt: string,
  timeoutMs: number,
  signal: AbortSignal,
  onHeartbeat: (waitedMs: number, heartbeat: number) => void,
  onDeadline: (error: TimeoutError) => void,
  operationName: string,
): Promise<void> {
  const waitStart = Date.now()
  let heartbeat = 0
  const timer = setInterval(() => {
    heartbeat++
    onHeartbeat(Date.now() - waitStart, heartbeat)
  }, AI_WAIT_HEARTBEAT_MS)
  try {
    await runWithDeadline(
      signal,
      () => agent.aiWaitFor(prompt, {
        timeoutMs,
        checkIntervalMs: Math.min(AI_WAIT_CHECK_INTERVAL_MS, timeoutMs),
      }),
      operationName,
      timeoutMs,
      onDeadline,
    )
  }
  finally {
    clearInterval(timer)
  }
}

async function destroyAgent(agent: PlaywrightAgent): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError('Midscene agent cleanup', AGENT_DESTROY_TIMEOUT_MS)),
      AGENT_DESTROY_TIMEOUT_MS,
    )
  })
  try {
    await Promise.race([Promise.resolve().then(() => agent.destroy()), timeout])
  }
  catch (error) {
    logger.warn('Could not cleanly destroy Midscene agent', error)
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}

function safeLabel(value: string): string {
  const sanitized = value.trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '')
  return sanitized || 'checkpoint'
}

function isPageClosed(page: Page): boolean {
  try {
    return page.isClosed()
  }
  catch {
    return false
  }
}

/** Best-effort failure screenshot; never lets capture problems mask the original error. */
async function captureFailureScreenshot(
  page: Page,
  screenshotDir: string | undefined,
  label: string,
): Promise<string | undefined> {
  if (!screenshotDir || isPageClosed(page))
    return undefined
  const pending = saveScreenshot(page, screenshotDir, label).catch((error) => {
    logger.warn('Could not capture failure screenshot', error)
    return undefined
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, 5_000, undefined)
  })
  try {
    return await Promise.race([pending, deadline])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}

function buildAIContext(ctx: StepContext): string | undefined {
  const sections: string[] = []
  if (ctx.background)
    sections.push(`场景背景：\n${ctx.background}`)
  if (ctx.goal)
    sections.push(`任务目标：\n${ctx.goal}`)
  if (ctx.knownIssues?.length)
    sections.push(`已知问题与处理规则：\n${ctx.knownIssues.map(issue => `- ${issue}`).join('\n')}`)
  return sections.length > 0 ? sections.join('\n\n') : undefined
}

function ensureLongScreenshotTimeout(page: Page, signal: AbortSignal): void {
  pageAbortSignals.set(page, signal)
  if (patchedScreenshotPages.has(page))
    return

  // Midscene uses a 10s screenshot timeout internally. Cloud-game canvases
  // can legitimately need longer while WebGL and fonts are loading.
  const originalScreenshot = page.screenshot.bind(page)
  page.screenshot = (options?: Record<string, unknown>) =>
    originalScreenshot({ ...options, timeout: 60_000 })

  // Cloud-game clients sample input on render frames. Playwright's default
  // zero-duration key presses and mouse clicks can be dropped or interpreted
  // as focus-only events, so keep them down long enough to cross a frame.
  const originalMouseClick = page.mouse.click.bind(page.mouse)
  page.mouse.click = (x, y, options) => originalMouseClick(x, y, {
    ...options,
    delay: Math.max(options?.delay ?? 0, CLOUD_MOUSE_HOLD_MS),
  })

  const originalKeyboardUp = page.keyboard.up.bind(page.keyboard)
  emergencyKeyboardUps.set(page, originalKeyboardUp)
  page.keyboard.up = async (key) => {
    await delay(CLOUD_KEY_HOLD_MS, pageAbortSignals.get(page))
    return originalKeyboardUp(key)
  }
  const originalMouseUp = page.mouse.up.bind(page.mouse)
  emergencyMouseUps.set(page, button => originalMouseUp({ button }))
  patchedScreenshotPages.add(page)
}

function assertPointInViewport(page: Page, point: [number, number]): void {
  const viewport = page.viewportSize()
  if (!viewport)
    return
  const [x, y] = point
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
    throw new Error(
      `Coordinates ${x},${y} are outside the ${viewport.width}x${viewport.height} viewport`,
    )
  }
}

/**
 * Execute a validated skill workflow.
 *
 * AI-prefixed methods use Midscene vision. The remaining methods are exact
 * Playwright keyboard/mouse operations, which makes recorded macro-style
 * routines possible without spending a model call on every action.
 */
export async function executeSteps(ctx: StepContext): Promise<AgentResult> {
  const {
    skillId,
    page,
    signal,
    steps,
    modelConfig,
    timeoutMs,
    transcript,
    screenshotDir,
    onProgress,
  } = ctx

  signal.throwIfAborted()
  const agentController = new AbortController()
  const forwardTaskAbort = () => agentController.abort(signal.reason)
  signal.addEventListener('abort', forwardTaskAbort, { once: true })
  const agentSignal = agentController.signal
  ensureLongScreenshotTimeout(page, agentSignal)
  // Midscene's file logger is best-effort but enabled by default. Resolving its
  // log directory to the platform null device before each agent is constructed
  // makes its append stream fail safely, without creating an unbounded output
  // tree or changing process environment variables.
  setLogDirectoryResolver(resolveMidsceneLogDirectory)
  let agent: PlaywrightAgent
  try {
    agent = new PlaywrightAgent(page, {
      groupName: skillId,
      groupDescription: ctx.goal ?? ctx.background,
      // giclaw already writes bounded transcripts and explicit screenshots.
      // Midscene's default self-contained HTML report duplicates screenshots on
      // every update and can grow to hundreds of megabytes per run.
      generateReport: false,
      persistExecutionDump: false,
      autoPrintReportMsg: false,
      aiActionContext: buildAIContext(ctx),
      modelConfig,
      replanningCycleLimit: ctx.replanningCycleLimit,
      createOpenAIClient: async (client: unknown) => ctx.streamModelResponses
        ? createStreamingOpenAIClient(client, agentSignal)
        : createAbortableOpenAIClient(client, agentSignal),
    })
  }
  catch (error) {
    signal.removeEventListener('abort', forwardTaskAbort)
    if (!agentController.signal.aborted)
      agentController.abort(error)
    throw error
  }
  const start = Date.now()
  const heldKeys = new Set<string>()
  const heldButtons = new Set<'left' | 'right' | 'middle'>()

  try {
    for (let i = 0; i < steps.length; i++) {
      signal.throwIfAborted()
      const elapsed = Date.now() - start
      if (elapsed >= timeoutMs)
        throw new TimeoutError(`skill:${skillId}`, timeoutMs)

      const step = steps[i]!
      logger.info(`Step ${i + 1}/${steps.length}: ${step.method}("${step.prompt}")`)
      reportProgress(onProgress, i + 1, elapsed, step.method, step.prompt)
      await appendTranscriptSafely(transcript, {
        step: i + 1,
        timestamp: new Date().toISOString(),
        method: step.method,
        prompt: step.prompt,
        result: 'started',
      })

      let output: string | number | boolean | undefined
      let checkpointPath: string | undefined
      try {
        const remaining = timeoutMs - (Date.now() - start)

        switch (step.method) {
          case 'aiAct':
            await runAbortable(signal, () => agent.aiAction(step.prompt))
            break
          case 'aiTap':
            await runAbortable(signal, () => agent.aiTap(step.prompt))
            break
          case 'aiRightClick':
            await runAbortable(signal, () => agent.aiRightClick(step.prompt))
            break
          case 'aiHover':
            await runAbortable(signal, () => agent.aiHover(step.prompt))
            break
          case 'aiInput': {
            const [value, target] = parseArrowArgs(step.prompt, step.method)
            await runAbortable(signal, () => agent.aiInput(value, target!))
            break
          }
          case 'aiKeyboardPress': {
            const [key, target] = parseArrowArgs(step.prompt, step.method, true)
            await runAbortable(signal, () => agent.aiKeyboardPress(key, target))
            break
          }
          case 'aiScroll': {
            const [spec, target] = parseArrowArgs(step.prompt, step.method, true)
            const { direction, distance } = parseScrollSpec(spec, step.method)
            await runAbortable(signal, () => agent.aiScroll({
              direction,
              scrollType: 'once',
              distance,
            }, target))
            break
          }
          case 'aiWaitFor': {
            const reservable = remaining > TASK_CLEANUP_RESERVE_MS
              ? remaining - TASK_CLEANUP_RESERVE_MS
              : remaining
            const waitTimeoutMs = Math.max(1, Math.min(MAX_AI_WAIT_MS, reservable))
            await waitForAICondition(
              agent,
              step.prompt,
              waitTimeoutMs,
              signal,
              (waitedMs, heartbeat) => {
                const reason = `${step.prompt}（仍在等待，${Math.round(waitedMs / 1000)} 秒，心跳 ${heartbeat}，本步剩余约 ${Math.max(0, Math.ceil((waitTimeoutMs - waitedMs) / 1000))} 秒）`
                reportProgress(onProgress, i + 1, Date.now() - start, step.method, reason)
                logger.info(`Step ${i + 1}/${steps.length} is still waiting (${Math.round(waitedMs / 1000)}s, heartbeat ${heartbeat})`)
              },
              (error) => {
                if (!agentController.signal.aborted)
                  agentController.abort(error)
                // Keep the page open long enough for the failure screenshot in
                // the catch block; TaskRunner still closes it during cleanup
                // once the attached Midscene operation settles.
              },
              `skill:${skillId}:step:${i + 1}:aiWaitFor`,
            )
            break
          }
          case 'aiAssert':
            await runAbortable(signal, () => agent.aiAssert(step.prompt))
            break
          case 'aiBoolean':
            output = await runAbortable(signal, () => agent.aiBoolean(step.prompt))
            break
          case 'click': {
            const point = parseCoordinates(step.prompt)
            assertPointInViewport(page, point)
            await page.mouse.click(...point)
            break
          }
          case 'rightClick': {
            const point = parseCoordinates(step.prompt)
            assertPointInViewport(page, point)
            await page.mouse.click(...point, { button: 'right' })
            break
          }
          case 'move': {
            const point = parseCoordinates(step.prompt)
            assertPointInViewport(page, point)
            await page.mouse.move(...point)
            break
          }
          case 'scroll': {
            const spec = parseScrollSpec(step.prompt, step.method)
            const { direction } = spec
            const distance = spec.distance ?? 500
            const dx = direction === 'left' ? -distance : direction === 'right' ? distance : 0
            const dy = direction === 'up' ? -distance : direction === 'down' ? distance : 0
            await page.mouse.wheel(dx, dy)
            break
          }
          case 'type':
            await page.keyboard.type(step.prompt)
            break
          case 'keyPress':
            await page.keyboard.press(step.prompt)
            break
          case 'keyDown':
            heldKeys.add(step.prompt)
            await page.keyboard.down(step.prompt)
            break
          case 'keyUp':
            await page.keyboard.up(step.prompt)
            heldKeys.delete(step.prompt)
            break
          case 'mouseDown': {
            const button = parseMouseButton(step.prompt)
            heldButtons.add(button)
            await page.mouse.down({ button })
            break
          }
          case 'mouseUp': {
            const button = parseMouseButton(step.prompt)
            await page.mouse.up({ button })
            heldButtons.delete(button)
            break
          }
          case 'wait': {
            const durationMs = parseDuration(step.prompt)
            if (durationMs > remaining)
              throw new Error(`Wait of ${durationMs}ms exceeds the task's remaining ${remaining}ms`)
            await delay(durationMs, signal)
            break
          }
          case 'screenshot':
            if (!screenshotDir)
              throw new Error('No screenshot directory configured')
            checkpointPath = await saveScreenshot(
              page,
              screenshotDir,
              `${safeLabel(skillId)}-step-${i + 1}-${safeLabel(step.prompt)}`,
            )
            output = checkpointPath
            break
          default: {
            const exhaustive: never = step.method
            throw new Error(`Unsupported step method: ${exhaustive}`)
          }
        }
        signal.throwIfAborted()
      }
      catch (err) {
        signal.throwIfAborted()
        const error = err instanceof Error ? err : new Error(String(err))
        logger.error(`Step ${i + 1} failed: ${error.message}`)

        // Capture the failure现场 for every error, including timeouts, before
        // TaskRunner closes the page. This is the screenshot-driven evidence
        // operators rely on to diagnose a failed run.
        const failureScreenshot = await captureFailureScreenshot(
          page,
          screenshotDir,
          `${safeLabel(skillId)}-step-${i + 1}-failure`,
        )

        await appendTranscriptSafely(transcript, {
          step: i + 1,
          timestamp: new Date().toISOString(),
          method: step.method,
          prompt: step.prompt,
          result: 'error',
          errorMessage: error.message,
          screenshotPath: failureScreenshot,
        })

        if (error instanceof TimeoutError) {
          // Preserve the original TimeoutError and its pending-operation
          // cleanup contract for TaskRunner.
          throw error
        }

        throw new StepExecutionError(
          `Step ${i + 1}/${steps.length} (${step.method}) failed: ${error.message}`,
          i + 1,
          failureScreenshot,
          error,
        )
      }

      await appendTranscriptSafely(transcript, {
        step: i + 1,
        timestamp: new Date().toISOString(),
        method: step.method,
        prompt: step.prompt,
        result: 'executed',
        screenshotPath: checkpointPath,
        output,
      })
    }

    return {
      success: true,
      reason: 'All steps completed',
      steps: steps.length,
      durationMs: Date.now() - start,
    }
  }
  finally {
    const releaseKey = emergencyKeyboardUps.get(page)
    for (const key of heldKeys) {
      try {
        await releaseKey?.(key)
      }
      catch (err) {
        logger.warn(`Could not release held key "${key}"`, err)
      }
    }
    const releaseButton = emergencyMouseUps.get(page)
    for (const button of heldButtons) {
      try {
        await releaseButton?.(button)
      }
      catch (err) {
        logger.warn(`Could not release held mouse button "${button}"`, err)
      }
    }
    await destroyAgent(agent)
    signal.removeEventListener('abort', forwardTaskAbort)
    if (!agentController.signal.aborted)
      agentController.abort()
  }
}
