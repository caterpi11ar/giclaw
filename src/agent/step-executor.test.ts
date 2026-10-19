import type { Page } from 'playwright'
import type { TranscriptWriter } from '../memory/transcript.js'
import type { SkillStep } from '../skills/types.js'
import { Buffer } from 'node:buffer'
import { devNull } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StepExecutionError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

import { executeSteps } from './step-executor.js'

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  aiAction: vi.fn(),
  aiTap: vi.fn(),
  aiRightClick: vi.fn(),
  aiHover: vi.fn(),
  aiInput: vi.fn(),
  aiKeyboardPress: vi.fn(),
  aiScroll: vi.fn(),
  aiWaitFor: vi.fn(),
  aiAssert: vi.fn(),
  aiBoolean: vi.fn(),
  destroy: vi.fn(),
  saveScreenshot: vi.fn(),
  delay: vi.fn(),
  createStreamingOpenAIClient: vi.fn(),
  createAbortableOpenAIClient: vi.fn(),
  setLogDirectoryResolver: vi.fn(),
}))

vi.mock('@midscene/shared/logger', () => ({
  setLogDirectoryResolver: mocks.setLogDirectoryResolver,
}))

vi.mock('@midscene/web/playwright', () => ({
  PlaywrightAgent: class MockPlaywrightAgent {
    constructor(page: unknown, options: unknown) {
      mocks.constructor(page, options)
    }

    aiAction(...args: unknown[]) { return mocks.aiAction(...args) }
    aiTap(...args: unknown[]) { return mocks.aiTap(...args) }
    aiRightClick(...args: unknown[]) { return mocks.aiRightClick(...args) }
    aiHover(...args: unknown[]) { return mocks.aiHover(...args) }
    aiInput(...args: unknown[]) { return mocks.aiInput(...args) }
    aiKeyboardPress(...args: unknown[]) { return mocks.aiKeyboardPress(...args) }
    aiScroll(...args: unknown[]) { return mocks.aiScroll(...args) }
    aiWaitFor(...args: unknown[]) { return mocks.aiWaitFor(...args) }
    aiAssert(...args: unknown[]) { return mocks.aiAssert(...args) }
    aiBoolean(...args: unknown[]) { return mocks.aiBoolean(...args) }
    destroy(...args: unknown[]) { return mocks.destroy(...args) }
  },
}))

vi.mock('../tools/screenshot.js', () => ({
  saveScreenshot: mocks.saveScreenshot,
}))

vi.mock('../utils/delay.js', () => ({
  delay: mocks.delay,
}))

vi.mock('./streaming-openai-client.js', () => ({
  createStreamingOpenAIClient: mocks.createStreamingOpenAIClient,
  createAbortableOpenAIClient: mocks.createAbortableOpenAIClient,
}))

function createPage(viewport: { width: number, height: number } | null = { width: 1280, height: 720 }) {
  let closed = false
  const raw = {
    screenshot: vi.fn(async () => Buffer.from('png')),
    click: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    wheel: vi.fn(async () => {}),
    mouseDown: vi.fn(async () => {}),
    mouseUp: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    keyDown: vi.fn(async () => {}),
    keyUp: vi.fn(async () => {}),
    close: vi.fn(async () => { closed = true }),
    isClosed: vi.fn(() => closed),
  }
  const page = {
    screenshot: raw.screenshot,
    close: raw.close,
    isClosed: raw.isClosed,
    viewportSize: vi.fn(() => viewport),
    mouse: {
      click: raw.click,
      move: raw.move,
      wheel: raw.wheel,
      down: raw.mouseDown,
      up: raw.mouseUp,
    },
    keyboard: {
      type: raw.type,
      press: raw.press,
      down: raw.keyDown,
      up: raw.keyUp,
    },
  } as unknown as Page
  return {
    page,
    raw,
    setClosed(value: boolean) {
      closed = value
    },
  }
}

function transcript() {
  return {
    append: vi.fn(async () => {}),
  } as unknown as TranscriptWriter
}

function context(page: Page, steps: SkillStep[], overrides: Record<string, unknown> = {}) {
  return {
    skillId: 'demo-skill',
    page,
    signal: new AbortController().signal,
    steps,
    modelConfig: { MIDSCENE_MODEL_NAME: 'test-model' },
    timeoutMs: 10_000,
    ...overrides,
  }
}

describe('executeSteps', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks))
      mock.mockReset()
    mocks.aiBoolean.mockResolvedValue(true)
    mocks.saveScreenshot.mockResolvedValue('/tmp/checkpoint.png')
    mocks.delay.mockResolvedValue(undefined)
    mocks.createStreamingOpenAIClient.mockReturnValue('wrapped-client')
    mocks.createAbortableOpenAIClient.mockReturnValue('abortable-client')
  })

  it('disables Midscene file logs before constructing an agent', async () => {
    const { page } = createPage()

    await executeSteps(context(page, [{ method: 'keyPress', prompt: 'Escape' }]))

    expect(mocks.setLogDirectoryResolver).toHaveBeenCalledOnce()
    const resolver = mocks.setLogDirectoryResolver.mock.calls[0]?.[0] as () => string
    expect(resolver()).toBe(devNull)
    expect(mocks.setLogDirectoryResolver.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.constructor.mock.invocationCallOrder[0]!)
  })

  it('cleans the abort bridge when agent construction fails', async () => {
    const { page } = createPage()
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const constructionError = new Error('agent construction failed')
    mocks.constructor.mockImplementation(() => {
      throw constructionError
    })

    await expect(executeSteps(context(page, [{ method: 'keyPress', prompt: 'Escape' }], {
      signal: controller.signal,
    }))).rejects.toBe(constructionError)

    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(mocks.destroy).not.toHaveBeenCalled()
    const options = mocks.constructor.mock.calls[0]?.[1] as {
      createOpenAIClient?: (client: unknown) => Promise<unknown>
    }
    await options.createOpenAIClient?.('client-after-construction-failure')
    const agentSignal = mocks.createAbortableOpenAIClient.mock.calls[0]?.[1] as AbortSignal
    expect(agentSignal.aborted).toBe(true)
    expect(agentSignal.reason).toBe(constructionError)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('dispatches every AI method, injects context, and records outputs', async () => {
    const { page } = createPage()
    const log = transcript()
    const onProgress = vi.fn()
    const steps: SkillStep[] = [
      { method: 'aiAct', prompt: 'act' },
      { method: 'aiTap', prompt: 'tap target' },
      { method: 'aiRightClick', prompt: 'context target' },
      { method: 'aiHover', prompt: 'hover target' },
      { method: 'aiInput', prompt: 'hello => search box' },
      { method: 'aiKeyboardPress', prompt: 'Escape' },
      { method: 'aiKeyboardPress', prompt: 'Enter => dialog' },
      { method: 'aiScroll', prompt: 'down 250 => reward list' },
      { method: 'aiWaitFor', prompt: 'loaded' },
      { method: 'aiAssert', prompt: 'safe state' },
      { method: 'aiBoolean', prompt: 'is complete?' },
    ]

    const result = await executeSteps(context(page, steps, {
      background: 'background',
      goal: 'goal',
      knownIssues: ['issue one', 'issue two'],
      replanningCycleLimit: 12,
      transcript: log,
      onProgress,
    }))

    expect(result).toMatchObject({ success: true, steps: steps.length, reason: 'All steps completed' })
    expect(mocks.constructor).toHaveBeenCalledWith(page, expect.objectContaining({
      groupName: 'demo-skill',
      groupDescription: 'goal',
      generateReport: false,
      persistExecutionDump: false,
      autoPrintReportMsg: false,
      replanningCycleLimit: 12,
      modelConfig: { MIDSCENE_MODEL_NAME: 'test-model' },
      aiActionContext: '场景背景：\nbackground\n\n任务目标：\ngoal\n\n已知问题与处理规则：\n- issue one\n- issue two',
    }))
    expect(mocks.aiAction).toHaveBeenCalledWith('act')
    expect(mocks.aiTap).toHaveBeenCalledWith('tap target')
    expect(mocks.aiRightClick).toHaveBeenCalledWith('context target')
    expect(mocks.aiHover).toHaveBeenCalledWith('hover target')
    expect(mocks.aiInput).toHaveBeenCalledWith('hello', 'search box')
    expect(mocks.aiKeyboardPress).toHaveBeenNthCalledWith(1, 'Escape', undefined)
    expect(mocks.aiKeyboardPress).toHaveBeenNthCalledWith(2, 'Enter', 'dialog')
    expect(mocks.aiScroll).toHaveBeenCalledWith({
      direction: 'down',
      scrollType: 'once',
      distance: 250,
    }, 'reward list')
    expect(mocks.aiWaitFor).toHaveBeenCalledWith('loaded', expect.objectContaining({
      checkIntervalMs: expect.any(Number),
      timeoutMs: expect.any(Number),
    }))
    const waitOptions = mocks.aiWaitFor.mock.calls[0]?.[1] as { timeoutMs: number, checkIntervalMs: number }
    expect(waitOptions.timeoutMs).toBeLessThanOrEqual(10_000)
    expect(waitOptions.checkIntervalMs).toBeLessThanOrEqual(15_000)
    expect(mocks.aiAssert).toHaveBeenCalledWith('safe state')
    expect(mocks.aiBoolean).toHaveBeenCalledWith('is complete?')
    expect(onProgress).toHaveBeenCalledTimes(steps.length)
    expect(log.append).toHaveBeenLastCalledWith(expect.objectContaining({
      step: steps.length,
      method: 'aiBoolean',
      output: true,
      result: 'executed',
    }))
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })

  it('dispatches every deterministic keyboard and mouse method', async () => {
    const { page, raw } = createPage()
    const steps: SkillStep[] = [
      { method: 'click', prompt: '10,20' },
      { method: 'rightClick', prompt: '30,40' },
      { method: 'move', prompt: '50,60' },
      { method: 'scroll', prompt: 'up 200' },
      { method: 'scroll', prompt: 'right 300' },
      { method: 'scroll', prompt: 'down' },
      { method: 'scroll', prompt: 'left 400' },
      { method: 'type', prompt: 'hello' },
      { method: 'keyPress', prompt: 'Escape' },
      { method: 'keyDown', prompt: 'W' },
      { method: 'keyUp', prompt: 'W' },
      { method: 'mouseDown', prompt: 'left' },
      { method: 'mouseUp', prompt: 'right' },
      { method: 'wait', prompt: '1.5s' },
    ]

    await expect(executeSteps(context(page, steps))).resolves.toMatchObject({ success: true })

    expect(raw.click).toHaveBeenNthCalledWith(1, 10, 20, { delay: 100 })
    expect(raw.click).toHaveBeenNthCalledWith(2, 30, 40, { button: 'right', delay: 100 })
    expect(raw.move).toHaveBeenCalledWith(50, 60)
    expect(raw.wheel).toHaveBeenNthCalledWith(1, 0, -200)
    expect(raw.wheel).toHaveBeenNthCalledWith(2, 300, 0)
    expect(raw.wheel).toHaveBeenNthCalledWith(3, 0, 500)
    expect(raw.wheel).toHaveBeenNthCalledWith(4, -400, 0)
    expect(raw.type).toHaveBeenCalledWith('hello')
    expect(raw.press).toHaveBeenCalledWith('Escape')
    expect(raw.keyDown).toHaveBeenCalledWith('W')
    expect(raw.keyUp).toHaveBeenCalledWith('W')
    expect(raw.mouseDown).toHaveBeenCalledWith({ button: 'left' })
    expect(raw.mouseUp).toHaveBeenCalledWith({ button: 'right' })
    expect(mocks.delay).toHaveBeenCalledWith(500, expect.any(AbortSignal))
    expect(mocks.delay).toHaveBeenCalledWith(1500, expect.any(AbortSignal))
  })

  it('records named screenshot checkpoints with sanitized labels', async () => {
    const { page } = createPage()
    const log = transcript()
    mocks.saveScreenshot.mockResolvedValue('/tmp/mail.png')

    await executeSteps(context(page, [{ method: 'screenshot', prompt: 'mail opened!' }], {
      transcript: log,
      screenshotDir: '/tmp/screens',
    }))

    expect(mocks.saveScreenshot).toHaveBeenCalledWith(
      page,
      '/tmp/screens',
      'demo-skill-step-1-mail-opened',
    )
    expect(log.append).toHaveBeenCalledWith(expect.objectContaining({
      screenshotPath: '/tmp/mail.png',
      output: '/tmp/mail.png',
    }))
  })

  it('uses fallback labels when screenshot names contain no safe characters', async () => {
    const { page } = createPage()

    await executeSteps(context(page, [{ method: 'screenshot', prompt: '!!!' }], {
      skillId: '???',
      screenshotDir: '/tmp/screens',
    }))

    expect(mocks.saveScreenshot).toHaveBeenCalledWith(
      page,
      '/tmp/screens',
      'checkpoint-step-1-checkpoint',
    )
  })

  it('patches the same Playwright page only once', async () => {
    const { page, raw } = createPage()

    await executeSteps(context(page, [{ method: 'click', prompt: '1,2' }]))
    await page.screenshot({ fullPage: true })
    await executeSteps(context(page, [{ method: 'click', prompt: '3,4' }]))

    expect(raw.screenshot).toHaveBeenCalledWith({ fullPage: true, timeout: 60_000 })
    expect(raw.click).toHaveBeenNthCalledWith(1, 1, 2, { delay: 100 })
    expect(raw.click).toHaveBeenNthCalledWith(2, 3, 4, { delay: 100 })
  })

  it('supplies a dedicated abort signal to regular and streaming model clients', async () => {
    const { page } = createPage()
    const regularController = new AbortController()
    await executeSteps(context(page, [{ method: 'aiAct', prompt: 'act' }], {
      signal: regularController.signal,
    }))

    const regularOptions = mocks.constructor.mock.calls[0]?.[1] as {
      createOpenAIClient?: (client: unknown) => Promise<unknown>
    }
    await expect(regularOptions.createOpenAIClient?.('regular')).resolves.toBe('abortable-client')
    expect(mocks.createAbortableOpenAIClient)
      .toHaveBeenCalledWith('regular', expect.any(AbortSignal))
    const regularSignal = mocks.createAbortableOpenAIClient.mock.calls[0]?.[1] as AbortSignal
    expect(regularSignal).not.toBe(regularController.signal)
    expect(regularSignal.aborted).toBe(true)

    const streamingController = new AbortController()
    await executeSteps(context(page, [{ method: 'aiAct', prompt: 'act' }], {
      streamModelResponses: true,
      signal: streamingController.signal,
    }))

    const options = mocks.constructor.mock.calls[1]?.[1] as {
      createOpenAIClient?: (client: unknown) => Promise<unknown>
    }
    expect(options.createOpenAIClient).toBeTypeOf('function')
    await expect(options.createOpenAIClient?.('client')).resolves.toBe('wrapped-client')
    expect(mocks.createStreamingOpenAIClient)
      .toHaveBeenCalledWith('client', expect.any(AbortSignal))
    const streamingSignal = mocks.createStreamingOpenAIClient.mock.calls[0]?.[1] as AbortSignal
    expect(streamingSignal).not.toBe(streamingController.signal)
    expect(streamingSignal.aborted).toBe(true)
  })

  it('does not execute or record a later step after task cancellation', async () => {
    const { page, raw } = createPage()
    const log = transcript()
    const controller = new AbortController()
    mocks.aiAction.mockImplementation(async () => {
      controller.abort(new Error('task timed out'))
    })

    await expect(executeSteps(context(page, [
      { method: 'aiAct', prompt: 'first' },
      { method: 'keyPress', prompt: 'Enter' },
    ], {
      signal: controller.signal,
      transcript: log,
    }))).rejects.toThrow('task timed out')

    expect(raw.press).not.toHaveBeenCalled()
    expect(log.append).toHaveBeenCalledOnce()
    expect(log.append).toHaveBeenCalledWith(expect.objectContaining({
      step: 1,
      result: 'started',
    }))
  })

  it('caps a visual wait, reports heartbeats, and terminates it at the hard deadline', async () => {
    vi.useFakeTimers()
    const { page, raw } = createPage()
    const log = transcript()
    const onProgress = vi.fn()
    mocks.aiWaitFor.mockImplementation(() => new Promise<void>(() => {}))

    const pending = executeSteps(context(page, [{ method: 'aiWaitFor', prompt: 'world ready' }], {
      timeoutMs: 600_000,
      transcript: log,
      screenshotDir: '/tmp/screens',
      onProgress,
    }))
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'TIMEOUT',
      message: 'Operation "skill:demo-skill:step:1:aiWaitFor" timed out after 180000ms',
    })
    await vi.waitFor(() => expect(mocks.aiWaitFor).toHaveBeenCalledOnce())
    expect(mocks.aiWaitFor).toHaveBeenCalledWith('world ready', {
      timeoutMs: 180_000,
      checkIntervalMs: 15_000,
    })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(onProgress).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      'aiWaitFor',
      expect.stringContaining('心跳 2'),
    )

    const options = mocks.constructor.mock.calls[0]?.[1] as {
      createOpenAIClient?: (client: unknown) => Promise<unknown>
    }
    await options.createOpenAIClient?.('regular')
    const modelSignal = mocks.createAbortableOpenAIClient.mock.calls[0]?.[1] as AbortSignal
    expect(modelSignal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(150_000)
    await rejection
    expect(modelSignal.aborted).toBe(true)
    expect(raw.close).not.toHaveBeenCalled()
    expect(mocks.saveScreenshot).toHaveBeenCalledWith(page, '/tmp/screens', 'demo-skill-step-1-failure')
    expect(log.append).toHaveBeenCalledWith(expect.objectContaining({
      step: 1,
      method: 'aiWaitFor',
      prompt: 'world ready',
      result: 'error',
      errorMessage: expect.stringContaining('timed out after 180000ms'),
    }))
  })

  it('preserves the visual timeout when the failure screenshot fails', async () => {
    vi.useFakeTimers()
    const { page } = createPage()
    const screenshotError = new Error('screenshot failed')
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    mocks.saveScreenshot.mockRejectedValue(screenshotError)
    mocks.aiWaitFor.mockImplementation(() => new Promise<void>(() => {}))

    const pending = executeSteps(context(page, [{ method: 'aiWaitFor', prompt: 'ready' }], {
      timeoutMs: 16_000,
      screenshotDir: '/tmp/screens',
    }))
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      message: expect.stringMatching(
        /^Operation "skill:demo-skill:step:1:aiWaitFor" timed out after \d+ms$/,
      ),
    })
    await vi.waitFor(() => expect(mocks.aiWaitFor).toHaveBeenCalledOnce())

    await vi.advanceTimersByTimeAsync(1_000)
    await rejection
    expect(warning).toHaveBeenCalledWith('Could not capture failure screenshot', screenshotError)
  })

  it('waits for an externally cancelled visual wait to unwind before rejecting', async () => {
    const { page } = createPage()
    const controller = new AbortController()
    let finishWait!: () => void
    mocks.aiWaitFor.mockImplementation(() => new Promise<void>(resolve => finishWait = resolve))
    const reason = new Error('cancel visual wait')
    let settled = false

    const pending = executeSteps(context(page, [{ method: 'aiWaitFor', prompt: 'ready' }], {
      signal: controller.signal,
      timeoutMs: 600_000,
    })).finally(() => {
      settled = true
    })
    const rejection = expect(pending).rejects.toBe(reason)
    await vi.waitFor(() => expect(mocks.aiWaitFor).toHaveBeenCalledOnce())

    controller.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false)

    finishWait()
    await rejection
    expect(settled).toBe(true)
  })

  it('keeps an immediate visual-wait failure distinct from deadline termination', async () => {
    const { page, raw } = createPage()
    const waitError = new Error('visual inspection failed')
    mocks.aiWaitFor.mockRejectedValue(waitError)
    mocks.saveScreenshot.mockResolvedValue('/tmp/visual-wait-failure.png')

    await expect(executeSteps(context(page, [{ method: 'aiWaitFor', prompt: 'ready' }], {
      screenshotDir: '/tmp/screens',
    }))).rejects.toMatchObject({
      name: 'StepExecutionError',
      cause: waitError,
      screenshotPath: '/tmp/visual-wait-failure.png',
    })

    expect(raw.close).not.toHaveBeenCalled()
    expect(mocks.saveScreenshot).toHaveBeenCalledWith(
      page,
      '/tmp/screens',
      'demo-skill-step-1-failure',
    )
  })

  it('does not finish cancellation until the underlying AI operation settles', async () => {
    const { page } = createPage()
    const controller = new AbortController()
    let rejectOperation!: (error: Error) => void
    mocks.aiAction.mockImplementation(() => new Promise<void>((_, reject) => {
      rejectOperation = reject
    }))

    let settled = false
    const reason = new Error('cancel visual action')
    const pending = executeSteps(context(page, [{ method: 'aiAct', prompt: 'continue' }], {
      signal: controller.signal,
    })).finally(() => {
      settled = true
    })
    const rejection = expect(pending).rejects.toBe(reason)
    await vi.waitFor(() => expect(mocks.aiAction).toHaveBeenCalledOnce())

    controller.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false)

    rejectOperation(new Error('transport aborted'))
    await rejection
    expect(settled).toBe(true)
  })

  it('does not let a progress observer interrupt browser work', async () => {
    const { page } = createPage()
    const observerError = new Error('progress observer failed')

    await expect(executeSteps(context(page, [{ method: 'aiAct', prompt: 'continue' }], {
      onProgress: () => { throw observerError },
    }))).resolves.toMatchObject({ success: true })

    expect(mocks.aiAction).toHaveBeenCalledOnce()
  })

  it('throws a timeout error if the workflow expires before a step starts', async () => {
    const { page } = createPage()
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(2)
      .mockReturnValue(2)

    await expect(executeSteps(context(page, [{ method: 'aiAct', prompt: 'never' }], {
      timeoutMs: 1,
    }))).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'TIMEOUT',
      message: 'Operation "skill:demo-skill" timed out after 1ms',
    })
    expect(mocks.aiAction).not.toHaveBeenCalled()
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })

  it('releases held keyboard and mouse input after failures and cancellation', async () => {
    const keyboard = createPage()
    keyboard.raw.keyDown.mockRejectedValue(new Error('key transport failed'))

    await expect(executeSteps(context(keyboard.page, [
      { method: 'keyDown', prompt: 'W' },
    ]))).rejects.toThrow('key transport failed')
    expect(keyboard.raw.keyUp).toHaveBeenCalledWith('W')

    const mouse = createPage()
    const controller = new AbortController()
    mouse.raw.mouseDown.mockImplementation(async () => {
      controller.abort(new Error('cancel mouse hold'))
    })
    await expect(executeSteps(context(mouse.page, [
      { method: 'mouseDown', prompt: 'left' },
      { method: 'keyPress', prompt: 'Enter' },
    ], { signal: controller.signal }))).rejects.toThrow('cancel mouse hold')
    expect(mouse.raw.mouseUp).toHaveBeenCalledWith({ button: 'left' })
    expect(mouse.raw.press).not.toHaveBeenCalled()
  })

  it('preserves the step failure when emergency input release also fails', async () => {
    const { page, raw } = createPage()
    const original = new Error('model failed after holding input')
    raw.keyUp.mockRejectedValue(new Error('key release failed'))
    raw.mouseUp.mockRejectedValue(new Error('mouse release failed'))
    mocks.aiAction.mockRejectedValue(original)

    await expect(executeSteps(context(page, [
      { method: 'keyDown', prompt: 'W' },
      { method: 'mouseDown', prompt: 'left' },
      { method: 'aiAct', prompt: 'continue' },
    ]))).rejects.toMatchObject({
      name: 'StepExecutionError',
      cause: original,
    })

    expect(raw.keyUp).toHaveBeenCalledWith('W')
    expect(raw.mouseUp).toHaveBeenCalledWith({ button: 'left' })
  })

  it('rejects waits longer than the remaining task time', async () => {
    const { page } = createPage()

    await expect(executeSteps(context(page, [{ method: 'wait', prompt: '2s' }], {
      timeoutMs: 1000,
    }))).rejects.toThrow('exceeds the task\'s remaining')
    expect(mocks.delay).not.toHaveBeenCalledWith(2000)
  })

  it('rejects coordinates outside a known viewport', async () => {
    const { page } = createPage({ width: 100, height: 100 })

    await expect(executeSteps(context(page, [{ method: 'click', prompt: '101,50' }])))
      .rejects
      .toThrow('outside the 100x100 viewport')
  })

  it('allows coordinates when Playwright has no viewport metadata', async () => {
    const { page, raw } = createPage(null)
    await executeSteps(context(page, [{ method: 'click', prompt: '5000,5000' }]))
    expect(raw.click).toHaveBeenCalledWith(5000, 5000, { delay: 100 })
  })

  it('captures step failures in the transcript and wraps the original error', async () => {
    const { page } = createPage()
    const log = transcript()
    const original = new Error('model failed')
    mocks.aiAction.mockRejectedValue(original)
    mocks.saveScreenshot.mockResolvedValue('/tmp/failure.png')

    let thrown: unknown
    try {
      await executeSteps(context(page, [{ method: 'aiAct', prompt: 'act' }], {
        transcript: log,
        screenshotDir: '/tmp/screens',
      }))
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(StepExecutionError)
    expect(thrown).toMatchObject({
      step: 1,
      screenshotPath: '/tmp/failure.png',
      cause: original,
    })
    expect(log.append).toHaveBeenCalledWith(expect.objectContaining({
      result: 'error',
      errorMessage: 'model failed',
      screenshotPath: '/tmp/failure.png',
    }))
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })

  it('does not attempt a failure screenshot after the page is already closed', async () => {
    const { page, setClosed } = createPage()
    setClosed(true)
    mocks.aiAction.mockRejectedValue(new Error('page closed during action'))

    await expect(executeSteps(context(page, [{ method: 'aiAct', prompt: 'act' }], {
      screenshotDir: '/tmp/screens',
    }))).rejects.toMatchObject({
      name: 'StepExecutionError',
      message: expect.stringContaining('page closed during action'),
    })

    expect(mocks.saveScreenshot).not.toHaveBeenCalled()
  })

  it('still captures diagnostics when checking page closure itself fails', async () => {
    const { page, raw } = createPage()
    raw.isClosed.mockImplementation(() => {
      throw new Error('page state unavailable')
    })
    mocks.aiAction.mockRejectedValue(new Error('action failed'))
    mocks.saveScreenshot.mockResolvedValue('/tmp/fallback-diagnostic.png')

    await expect(executeSteps(context(page, [{ method: 'aiAct', prompt: 'act' }], {
      screenshotDir: '/tmp/screens',
    }))).rejects.toMatchObject({
      name: 'StepExecutionError',
      screenshotPath: '/tmp/fallback-diagnostic.png',
    })

    expect(raw.isClosed).toHaveBeenCalledOnce()
    expect(mocks.saveScreenshot).toHaveBeenCalledWith(
      page,
      '/tmp/screens',
      'demo-skill-step-1-failure',
    )
  })

  it('preserves the original step failure when transcript recording also fails', async () => {
    const { page } = createPage()
    const original = new Error('original model failure')
    const log = transcript()
    vi.mocked(log.append).mockRejectedValue(new Error('transcript unavailable'))
    mocks.aiAction.mockRejectedValue(original)

    await expect(executeSteps(context(page, [{ method: 'aiAct', prompt: 'act' }], {
      transcript: log,
    }))).rejects.toMatchObject({
      name: 'StepExecutionError',
      cause: original,
      message: expect.stringContaining('original model failure'),
    })
  })

  it('normalizes non-Error step failures', async () => {
    const { page } = createPage()
    mocks.aiAction.mockRejectedValue('plain failure')

    await expect(executeSteps(context(page, [{ method: 'aiAct', prompt: 'act' }])))
      .rejects
      .toThrow('plain failure')
  })

  it('rejects an unsupported runtime method defensively', async () => {
    const { page } = createPage()
    const invalid = { method: 'unknown', prompt: 'value' } as unknown as SkillStep

    await expect(executeSteps(context(page, [invalid])))
      .rejects
      .toThrow('Unsupported step method: unknown')
  })

  it('preserves the step error if failure screenshot capture also fails', async () => {
    const { page } = createPage()
    mocks.aiTap.mockRejectedValue(new Error('tap failed'))
    mocks.saveScreenshot.mockRejectedValue(new Error('screenshot failed'))

    await expect(executeSteps(context(page, [{ method: 'aiTap', prompt: 'button' }], {
      screenshotDir: '/tmp/screens',
    }))).rejects.toMatchObject({
      name: 'StepExecutionError',
      screenshotPath: undefined,
      message: expect.stringContaining('tap failed'),
    })
  })

  it('requires a screenshot directory for checkpoint steps', async () => {
    const { page } = createPage()
    await expect(executeSteps(context(page, [{ method: 'screenshot', prompt: 'checkpoint' }])))
      .rejects
      .toThrow('No screenshot directory configured')
  })

  it('does not let agent cleanup failures mask a successful workflow', async () => {
    const { page } = createPage()
    mocks.destroy.mockRejectedValue(new Error('cleanup failed'))

    await expect(executeSteps(context(page, [{ method: 'keyPress', prompt: 'Escape' }])))
      .resolves
      .toMatchObject({ success: true })
  })
})
