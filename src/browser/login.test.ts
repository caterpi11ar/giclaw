import type { Page } from 'playwright'
import type { SessionManager } from './session-manager.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../config/schema.js'
import { logger } from '../utils/logger.js'

import { loginFlow } from './login.js'

const cookieMocks = vi.hoisted(() => ({
  loadCookies: vi.fn(),
  saveCookies: vi.fn(),
  deleteCookies: vi.fn(),
}))

vi.mock('./cookie-store.js', () => cookieMocks)

function mockPage() {
  const waitFor = vi.fn(async () => {})
  const reload = vi.fn(async () => {})
  const locator = vi.fn(() => ({ waitFor }))
  return {
    page: { locator, reload } as unknown as Page,
    waitFor,
    reload,
    locator,
  }
}

function selectorTimeout(message = 'selector timed out'): Error {
  return Object.assign(new Error(message), { name: 'TimeoutError' })
}

function mockContext(cookies = [{ name: 'fresh', value: 'cookie' }]) {
  return {
    addCookies: vi.fn(async () => {}),
    cookies: vi.fn(async () => cookies),
  }
}

function mockSession() {
  return {
    launch: vi.fn(),
    relaunch: vi.fn(),
    close: vi.fn(async () => {}),
    getContext: vi.fn(),
  }
}

describe('loginFlow', () => {
  beforeEach(() => {
    for (const mock of Object.values(cookieMocks))
      mock.mockReset()
    cookieMocks.saveCookies.mockResolvedValue(undefined)
    cookieMocks.deleteCookies.mockResolvedValue(undefined)
    logger.mute()
  })

  afterEach(() => {
    vi.useRealTimers()
    logger.unmute()
  })

  it('restores a valid cookie session within the bounded check timeout', async () => {
    const restore = mockPage()
    const context = mockContext()
    const session = mockSession()
    const cookies = [{ name: 'session', value: 'saved', domain: '.example.test' }]
    cookieMocks.loadCookies.mockResolvedValue(cookies)
    session.launch.mockResolvedValue(restore.page)
    session.getContext.mockReturnValue(context)
    const config = appConfigSchema.parse({
      browser: { cookieFilePath: '/tmp/cookies.json', headless: true },
      login: { timeoutMs: 300000 },
    })

    await loginFlow(session as unknown as SessionManager, config)

    expect(session.launch).toHaveBeenCalledWith({ headless: true })
    expect(context.addCookies).toHaveBeenCalledWith(cookies)
    expect(restore.reload).toHaveBeenCalledOnce()
    expect(restore.waitFor).toHaveBeenCalledWith({ timeout: 60000 })
    expect(session.close).not.toHaveBeenCalled()
    expect(cookieMocks.saveCookies).not.toHaveBeenCalled()
  })

  it('keeps cookies when restore fails and completes a visible manual login', async () => {
    const restore = mockPage()
    restore.waitFor.mockRejectedValue(selectorTimeout('not logged in'))
    const manual = mockPage()
    const restoreContext = mockContext()
    const manualContext = mockContext([{ name: 'new', value: 'value' }])
    const session = mockSession()
    cookieMocks.loadCookies.mockResolvedValue([{ name: 'old', value: 'value' }])
    session.launch.mockResolvedValueOnce(restore.page).mockResolvedValueOnce(manual.page)
    session.getContext.mockReturnValueOnce(restoreContext).mockReturnValueOnce(manualContext)
    const config = appConfigSchema.parse({
      browser: { cookieFilePath: '/tmp/cookies.json', headless: false },
    })

    await loginFlow(session as unknown as SessionManager, config)

    expect(cookieMocks.deleteCookies).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
    expect(session.launch).toHaveBeenNthCalledWith(2, { headless: false })
    expect(cookieMocks.saveCookies).toHaveBeenCalledWith('/tmp/cookies.json', [{ name: 'new', value: 'value' }])
    expect(session.relaunch).not.toHaveBeenCalled()
  })

  it('opens a visible login and switches back to a verified headless session', async () => {
    const manual = mockPage()
    const headless = mockPage()
    const fresh = [{ name: 'new', value: 'value' }]
    const manualContext = mockContext(fresh)
    const headlessContext = mockContext()
    const session = mockSession()
    cookieMocks.loadCookies.mockResolvedValue(null)
    session.launch.mockResolvedValue(manual.page)
    session.relaunch.mockResolvedValue(headless.page)
    session.getContext.mockReturnValueOnce(manualContext).mockReturnValueOnce(headlessContext)
    const config = appConfigSchema.parse({
      browser: { cookieFilePath: '/tmp/cookies.json', headless: true },
    })

    await loginFlow(session as unknown as SessionManager, config)

    expect(session.launch).toHaveBeenCalledWith({ headless: false })
    expect(cookieMocks.saveCookies).toHaveBeenCalledWith('/tmp/cookies.json', fresh)
    expect(session.relaunch).toHaveBeenCalledWith({ headless: true })
    expect(headlessContext.addCookies).toHaveBeenCalledWith(fresh)
    expect(headless.reload).toHaveBeenCalledOnce()
    expect(headless.waitFor).toHaveBeenCalledWith({ timeout: 60000 })
  })

  it('propagates a cancellation signal through the visible and headless launches', async () => {
    const manual = mockPage()
    const headless = mockPage()
    const fresh = [{ name: 'new', value: 'value' }]
    const session = mockSession()
    const controller = new AbortController()
    cookieMocks.loadCookies.mockResolvedValue(null)
    session.launch.mockResolvedValue(manual.page)
    session.relaunch.mockResolvedValue(headless.page)
    session.getContext
      .mockReturnValueOnce(mockContext(fresh))
      .mockReturnValueOnce(mockContext())

    await loginFlow(
      session as unknown as SessionManager,
      appConfigSchema.parse({ browser: { headless: true } }),
      controller.signal,
    )

    expect(session.launch).toHaveBeenCalledWith({ headless: false }, controller.signal)
    expect(session.relaunch).toHaveBeenCalledWith({ headless: true }, controller.signal)
  })

  it('polls until manual login becomes available', async () => {
    const manual = mockPage()
    manual.waitFor
      .mockRejectedValueOnce(selectorTimeout('not yet'))
      .mockResolvedValueOnce(undefined)
    const context = mockContext()
    const session = mockSession()
    cookieMocks.loadCookies.mockResolvedValue(null)
    session.launch.mockResolvedValue(manual.page)
    session.getContext.mockReturnValue(context)
    const config = appConfigSchema.parse({ browser: { headless: false } })

    await loginFlow(session as unknown as SessionManager, config)

    expect(manual.waitFor).toHaveBeenCalledTimes(2)
    expect(cookieMocks.saveCookies).toHaveBeenCalledOnce()
  })

  it('fails when manual login reaches its deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T00:00:00Z'))
    const manual = mockPage()
    manual.waitFor.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 100)
      throw selectorTimeout('not logged in')
    })
    const session = mockSession()
    cookieMocks.loadCookies.mockResolvedValue(null)
    session.launch.mockResolvedValue(manual.page)
    const config = appConfigSchema.parse({
      login: { timeoutMs: 200, pollIntervalMs: 100 },
    })

    await expect(loginFlow(session as unknown as SessionManager, config)).rejects.toMatchObject({
      name: 'LoginError',
      code: 'LOGIN_ERROR',
      message: expect.stringContaining('timed out after 200ms'),
    })
    expect(manual.waitFor).toHaveBeenCalledTimes(2)
    expect(cookieMocks.saveCookies).not.toHaveBeenCalled()
  })

  it('fails if the fresh cookies cannot be verified after headless relaunch', async () => {
    const manual = mockPage()
    const headless = mockPage()
    headless.waitFor.mockRejectedValue(selectorTimeout('not restored'))
    const manualContext = mockContext([{ name: 'new', value: 'value' }])
    const headlessContext = mockContext()
    const session = mockSession()
    cookieMocks.loadCookies.mockResolvedValue(null)
    session.launch.mockResolvedValue(manual.page)
    session.relaunch.mockResolvedValue(headless.page)
    session.getContext.mockReturnValueOnce(manualContext).mockReturnValueOnce(headlessContext)
    const config = appConfigSchema.parse({ browser: { headless: true } })

    await expect(loginFlow(session as unknown as SessionManager, config))
      .rejects
      .toThrow('Failed to verify login after switching to headless mode')
  })

  it('cancels a pending manual-login selector wait promptly', async () => {
    const manual = mockPage()
    manual.waitFor.mockImplementation(() => new Promise<void>(() => {}))
    const session = mockSession()
    const controller = new AbortController()
    cookieMocks.loadCookies.mockResolvedValue(null)
    session.launch.mockResolvedValue(manual.page)
    const config = appConfigSchema.parse({ browser: { headless: false } })

    const login = loginFlow(session as unknown as SessionManager, config, controller.signal)
    await vi.waitFor(() => expect(manual.waitFor).toHaveBeenCalledOnce())
    controller.abort(new Error('daemon shutdown'))

    await expect(login).rejects.toMatchObject({
      name: 'CancellationError',
      code: 'CANCELLED',
      cause: expect.objectContaining({ message: 'daemon shutdown' }),
    })
    expect(session.launch).toHaveBeenCalledWith({ headless: false }, controller.signal)
    expect(cookieMocks.saveCookies).not.toHaveBeenCalled()
  })

  it('does not hide browser failures as an ordinary selector timeout', async () => {
    const manual = mockPage()
    const pageFailure = Object.assign(new Error('page crashed'), { name: 'TargetClosedError' })
    manual.waitFor.mockRejectedValue(pageFailure)
    const session = mockSession()
    cookieMocks.loadCookies.mockResolvedValue(null)
    session.launch.mockResolvedValue(manual.page)

    await expect(loginFlow(
      session as unknown as SessionManager,
      appConfigSchema.parse({ browser: { headless: false } }),
    )).rejects.toMatchObject({
      name: 'LoginError',
      code: 'LOGIN_ERROR',
      cause: pageFailure,
    })
    expect(manual.waitFor).toHaveBeenCalledOnce()
    expect(cookieMocks.saveCookies).not.toHaveBeenCalled()
  })

  it('does not start I/O when login is already cancelled', async () => {
    const session = mockSession()
    const controller = new AbortController()
    controller.abort(new Error('already stopping'))

    await expect(loginFlow(
      session as unknown as SessionManager,
      appConfigSchema.parse({}),
      controller.signal,
    )).rejects.toMatchObject({ name: 'CancellationError' })
    expect(cookieMocks.loadCookies).not.toHaveBeenCalled()
    expect(session.launch).not.toHaveBeenCalled()
  })

  it('does not start cookie mutation if cancellation wins after session launch', async () => {
    const restore = mockPage()
    const context = mockContext()
    const session = mockSession()
    const controller = new AbortController()
    cookieMocks.loadCookies.mockResolvedValue([{ name: 'saved', value: 'cookie' }])
    session.launch.mockImplementation(async () => {
      controller.abort(new Error('shutdown after launch'))
      return restore.page
    })
    session.getContext.mockReturnValue(context)

    await expect(loginFlow(
      session as unknown as SessionManager,
      appConfigSchema.parse({}),
      controller.signal,
    )).rejects.toMatchObject({ name: 'CancellationError' })

    expect(context.addCookies).not.toHaveBeenCalled()
    expect(restore.reload).not.toHaveBeenCalled()
  })
})
