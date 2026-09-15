import type { PairingApprovalResult } from './extensions/feishu/src/pairing.js'
import type { PluginStatusEntry } from './plugins/host.js'
import type { OutboxEntry } from './plugins/outbox.js'
import type { ChannelPlugin } from './plugins/types.js'
import type { ProgressEvent } from './utils/progress.js'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const spinner = {
    text: '',
    stop: vi.fn(),
  }
  const runner = {
    getEnabledTasks: vi.fn(),
  }
  const gateway = {
    init: vi.fn(),
    getSkillSummaries: vi.fn(),
    getTaskRunner: vi.fn(() => runner),
    runOnce: vi.fn(),
  }
  const pluginHost = {
    load: vi.fn(),
    getStatus: vi.fn<() => PluginStatusEntry[]>(() => []),
    getFailure: vi.fn<(id: string) => string | undefined>(() => undefined),
    capabilities: { listChannels: vi.fn<() => { pluginId: string, channel: ChannelPlugin }[]>(() => []) },
  }
  const outbox = {
    list: vi.fn<() => Promise<OutboxEntry[]>>(async () => []),
    clear: vi.fn(async () => 0),
  }
  const pairingStore = {
    listAccountIds: vi.fn<() => Promise<string[]>>(async () => []),
    listPending: vi.fn<(account: string) => Promise<Record<string, { subjects: string[], createdAt: string }>>>(
      async () => ({}),
    ),
    readApproved: vi.fn<(account: string) => Promise<string[]>>(async () => []),
    approve: vi.fn<() => Promise<PairingApprovalResult>>(async () => ({ ok: true, subjects: ['user:ou_1'], alreadyApproved: false })),
    dismiss: vi.fn(async () => true),
    revoke: vi.fn(async () => true),
  }
  return {
    pluginHost,
    pairingStore,
    outbox,
    outboxOpen: vi.fn(async () => outbox),
    pairingOpen: vi.fn(async () => pairingStore),
    feishuConfigSchema: {
      safeParse: vi.fn<(raw: unknown) => { success: boolean, data?: unknown, error?: unknown }>(() => ({
        success: true,
        data: {},
      })),
    },
    resolveFeishuBaseUrl: vi.fn(() => 'https://open.feishu.cn'),
    resolveFeishuAccount: vi.fn(() => ({ accountId: 'default', config: {} })),
    createTenantTokenProvider: vi.fn(() => ({ getToken: vi.fn(async () => 't-1'), invalidate: vi.fn() })),
    sendAppMessage: vi.fn(async () => 'om_1'),
    createPluginHost: vi.fn(async () => pluginHost),
    loadConfig: vi.fn(),
    initStateDir: vi.fn(),
    PATHS: {
      stateDir: '/tmp/.giclaw',
      configPath: '/tmp/.giclaw/config.json',
      cookiePath: '/tmp/.giclaw/cookies.json',
      dataDir: '/tmp/.giclaw/data',
    },
    gateway,
    runner,
    Gateway: vi.fn(() => gateway),
    startGateway: vi.fn(),
    runSetupWizard: vi.fn(),
    wizardConfigured: vi.fn(),
    confirm: vi.fn(),
    spinner,
    ora: vi.fn(() => ({
      start: vi.fn(() => spinner),
    })),
    logger: {
      setLevel: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      mute: vi.fn(),
      unmute: vi.fn(),
    },
  }
})

vi.mock('./config/loader.js', () => ({ loadConfig: mocks.loadConfig }))
vi.mock('./config/paths.js', () => ({ initStateDir: mocks.initStateDir, PATHS: mocks.PATHS }))
vi.mock('./gateway/gateway.js', () => ({ Gateway: mocks.Gateway }))
vi.mock('./gateway/lifecycle.js', () => ({ startGateway: mocks.startGateway }))
vi.mock('./config/wizard.js', () => ({
  isModelConfigured: mocks.wizardConfigured,
  runSetupWizard: mocks.runSetupWizard,
}))
vi.mock('@inquirer/prompts', () => ({ confirm: mocks.confirm }))
vi.mock('./utils/logger.js', () => ({ logger: mocks.logger }))
vi.mock('ora', () => ({ default: mocks.ora }))
vi.mock('./plugins/bootstrap.js', () => ({ createPluginHost: mocks.createPluginHost }))
vi.mock('./extensions/feishu/src/pairing.js', () => ({
  FeishuPairingStore: { open: mocks.pairingOpen },
}))
vi.mock('./extensions/feishu/src/config.js', () => ({
  feishuConfigSchema: mocks.feishuConfigSchema,
  resolveFeishuBaseUrl: mocks.resolveFeishuBaseUrl,
}))
vi.mock('./extensions/feishu/src/accounts.js', () => ({ resolveFeishuAccount: mocks.resolveFeishuAccount }))
vi.mock('./extensions/feishu/src/client.js', () => ({
  createTenantTokenProvider: mocks.createTenantTokenProvider,
  sendAppMessage: mocks.sendAppMessage,
}))
vi.mock('./plugins/outbox.js', () => ({ NotificationOutbox: { open: mocks.outboxOpen } }))

interface TestConfig {
  model: { name: string, baseUrl: string, apiKey: string }
  notifications: { routes: { channel: string, target?: string }[] }
  browser: { headless: boolean }
  tasks: {
    enabled: string[]
    routines: Record<string, string[]>
  }
  web: { enabled: boolean, port: number }
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  plugins: { entries: Record<string, { config: Record<string, unknown> }> }
}

function config(overrides: Partial<TestConfig> = {}): TestConfig {
  return {
    model: { name: 'gpt-5.6', baseUrl: 'http://127.0.0.1:3002/v1', apiKey: 'test-key' },
    browser: { headless: true },
    tasks: {
      enabled: ['welkin-moon', 'claim-mail'],
      routines: { daily: ['welkin-moon', 'claim-mail'] },
    },
    web: { enabled: true, port: 3000 },
    logLevel: 'info',
    notifications: { routes: [] },
    plugins: { entries: {} },
    ...overrides,
  }
}

function channel(id: string, label: string, blurb?: string): ChannelPlugin {
  return {
    id,
    meta: blurb ? { label, blurb } : { label },
    outbound: { send: async () => ({ ok: true }) },
  }
}

const originalArgv = process.argv
const ttyDescriptors = {
  stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
  stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
  stderr: Object.getOwnPropertyDescriptor(process.stderr, 'isTTY'),
}

function setTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): void {
  Object.defineProperty(stream, 'isTTY', { configurable: true, value })
}

async function runCli(...args: string[]): Promise<void> {
  process.argv = ['node', 'giclaw', ...args]
  vi.resetModules()
  await import('./cli.js')
}

describe('cLI', () => {
  beforeEach(() => {
    process.exitCode = undefined
    setTTY(process.stdin, false)
    setTTY(process.stdout, false)
    setTTY(process.stderr, false)
    mocks.loadConfig.mockResolvedValue(config())
    mocks.gateway.init.mockResolvedValue(undefined)
    mocks.gateway.getSkillSummaries.mockReturnValue([])
    mocks.runner.getEnabledTasks.mockImplementation((ids: string[]) => ids.map(id => ({ id })))
    mocks.gateway.runOnce.mockResolvedValue({ results: [] })
    mocks.startGateway.mockResolvedValue(undefined)
    mocks.initStateDir.mockResolvedValue({ created: [] })
    mocks.wizardConfigured.mockResolvedValue(false)
    mocks.confirm.mockResolvedValue(false)
    mocks.runSetupWizard.mockResolvedValue(undefined)
    mocks.spinner.text = ''
    mocks.pluginHost.getStatus.mockReturnValue([])
    mocks.pluginHost.getFailure.mockReturnValue(undefined)
    mocks.pluginHost.capabilities.listChannels.mockReturnValue([])
    mocks.pairingOpen.mockResolvedValue(mocks.pairingStore)
    mocks.pairingStore.listAccountIds.mockResolvedValue([])
    mocks.pairingStore.listPending.mockResolvedValue({})
    mocks.pairingStore.readApproved.mockResolvedValue([])
    mocks.pairingStore.approve.mockResolvedValue({ ok: true, subjects: ['user:ou_1'], alreadyApproved: false })
    mocks.pairingStore.dismiss.mockResolvedValue(true)
    mocks.pairingStore.revoke.mockResolvedValue(true)
    mocks.outboxOpen.mockResolvedValue(mocks.outbox)
    mocks.outbox.list.mockResolvedValue([])
    mocks.outbox.clear.mockResolvedValue(0)
    mocks.feishuConfigSchema.safeParse.mockReturnValue({ success: true, data: {} })
    mocks.resolveFeishuAccount.mockReturnValue({ accountId: 'default', config: {} })
    mocks.createTenantTokenProvider.mockReturnValue({ getToken: vi.fn(async () => 't-1'), invalidate: vi.fn() })
    mocks.sendAppMessage.mockResolvedValue('om_1')
  })

  afterEach(() => {
    process.argv = originalArgv
    process.exitCode = undefined
    for (const [key, descriptor] of Object.entries(ttyDescriptors)) {
      if (descriptor)
        Object.defineProperty(process[key as keyof typeof ttyDescriptors], 'isTTY', descriptor)
    }
  })

  it('validates explicit tasks in dependency order during a verbose dry run', async () => {
    await runCli('--config', '/tmp/custom.json', '--tasks', 'claim-mail', '--no-headless', '--dry-run', '--verbose', 'run')

    expect(mocks.loadConfig).toHaveBeenCalledWith({
      configPath: '/tmp/custom.json',
      cliOverrides: { browser: { headless: false } },
    })
    expect(mocks.logger.setLevel).toHaveBeenCalledWith('debug')
    expect(mocks.runner.getEnabledTasks).toHaveBeenCalledWith(['claim-mail'])
    expect(mocks.logger.info).toHaveBeenCalledWith('Execution order: claim-mail')
    expect(mocks.gateway.runOnce).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('resolves a named routine in dry-run mode', async () => {
    await runCli('--routine', 'daily', '--dry-run')

    expect(mocks.runner.getEnabledTasks).toHaveBeenCalledWith(['welkin-moon', 'claim-mail'])
    expect(mocks.logger.info).toHaveBeenCalledWith('Execution order: welkin-moon -> claim-mail')
  })

  it('rejects conflicting task and routine selections', async () => {
    await runCli('--tasks', 'claim-mail', '--routine', 'daily')

    expect(mocks.logger.error).toHaveBeenCalledWith('Use either --tasks or --routine, not both.')
    expect(mocks.runner.getEnabledTasks).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('rejects an unknown routine and lists available names', async () => {
    await runCli('--routine', 'missing')

    expect(mocks.logger.error).toHaveBeenCalledWith('Unknown routine "missing". Available: daily')
    expect(process.exitCode).toBe(1)
  })

  it.each([
    [[], 'Model not configured. Run `giclaw init` to set up your API key and model.'],
    [['--config', '/tmp/empty.json'], 'Model not configured in /tmp/empty.json.'],
  ])('rejects non-interactive unconfigured runs %#', async (args, message) => {
    mocks.loadConfig.mockResolvedValue(config({
      model: { name: '', baseUrl: '', apiKey: '' },
    }))

    await runCli(...args)

    expect(mocks.logger.error).toHaveBeenCalledWith(message)
    expect(mocks.Gateway).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('runs setup interactively, reloads config, and aborts if setup remains incomplete', async () => {
    setTTY(process.stdin, true)
    setTTY(process.stdout, true)
    const incomplete = config({ model: { name: '', baseUrl: '', apiKey: '' } })
    mocks.loadConfig.mockResolvedValue(incomplete)

    await runCli()

    expect(mocks.runSetupWizard).toHaveBeenCalledOnce()
    expect(mocks.loadConfig).toHaveBeenCalledTimes(2)
    expect(mocks.logger.error).toHaveBeenCalledWith('Model still not configured. Aborting.')
    expect(process.exitCode).toBe(1)
  })

  it('continues after interactive setup produces a complete model config', async () => {
    setTTY(process.stdin, true)
    setTTY(process.stdout, true)
    const incomplete = config({ model: { name: '', baseUrl: '', apiKey: '' } })
    mocks.loadConfig.mockResolvedValueOnce(incomplete).mockResolvedValueOnce(config())

    await runCli('--dry-run')

    expect(mocks.runSetupWizard).toHaveBeenCalledOnce()
    expect(mocks.runner.getEnabledTasks).toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('renders TTY progress, reports task results, and sets failure exit status', async () => {
    setTTY(process.stderr, true)
    let progressListener: ((event: ProgressEvent) => void) | undefined
    mocks.logger.on.mockImplementation((event: string, listener: (event: ProgressEvent) => void) => {
      if (event === 'progress')
        progressListener = listener
    })
    mocks.gateway.runOnce.mockImplementation(async () => {
      progressListener?.({ phase: 'login', elapsed: 500, taskIndex: 0, taskTotal: 0, taskId: null, step: 0, action: null, reason: null, timestamp: '' })
      progressListener?.({ phase: 'running', elapsed: 65_000, taskIndex: 1, taskTotal: 2, taskId: 'claim-mail', step: 3, action: 'tap', reason: 'claim', timestamp: '' })
      progressListener?.({ phase: 'running', elapsed: 65_500, taskIndex: 2, taskTotal: 2, taskId: null, step: 4, action: null, reason: null, timestamp: '' })
      progressListener?.({ phase: 'done', elapsed: 66_000, taskIndex: 0, taskTotal: 0, taskId: null, step: 0, action: null, reason: null, timestamp: '' })
      progressListener?.({ phase: 'error', elapsed: 67_000, taskIndex: 0, taskTotal: 0, taskId: null, step: 0, action: null, reason: null, timestamp: '' })
      return {
        results: [
          { taskId: 'ok', success: true, message: 'done', durationMs: 10 },
          { taskId: 'failed', success: false, message: 'nope', durationMs: 20 },
        ],
      }
    })

    await runCli()

    expect(mocks.ora).toHaveBeenCalled()
    expect(mocks.logger.mute).toHaveBeenCalledOnce()
    expect(mocks.logger.off).toHaveBeenCalledWith('progress', expect.any(Function))
    expect(mocks.logger.unmute).toHaveBeenCalledOnce()
    expect(mocks.spinner.stop).toHaveBeenCalledOnce()
    expect(mocks.spinner.text).toBe('[1m 07s] Error: unknown')
    expect(mocks.logger.info).toHaveBeenCalledWith('  [OK] ok: done (10ms)')
    expect(mocks.logger.info).toHaveBeenCalledWith('  [FAIL] failed: nope (20ms)')
    expect(process.exitCode).toBe(1)
  })

  it('reports a top-level run failure and cleans up TTY progress', async () => {
    setTTY(process.stderr, true)
    mocks.gateway.runOnce.mockRejectedValue(new Error('pipeline failed'))

    await runCli()

    expect(mocks.logger.error).toHaveBeenCalledWith('Run failed', expect.objectContaining({ message: 'pipeline failed' }))
    expect(mocks.spinner.stop).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(1)
  })

  it('lists validated operations, skills, dependencies, and routines', async () => {
    mocks.gateway.getSkillSummaries.mockReturnValue([
      { id: 'welkin-moon', steps: 2, dependsOn: [] },
      { id: 'claim-mail', steps: 3, dependsOn: ['welkin-moon'] },
    ])

    await runCli('skills')

    expect(mocks.logger.info).toHaveBeenCalledWith('Atomic operations:')
    expect(mocks.logger.info).toHaveBeenCalledWith('  welkin-moon — 2 step(s)')
    expect(mocks.logger.info).toHaveBeenCalledWith('  claim-mail — 3 step(s); depends on welkin-moon')
    expect(mocks.logger.info).toHaveBeenCalledWith('  daily: welkin-moon -> claim-mail')
  })

  it('initializes defaults non-interactively and reports created files', async () => {
    mocks.initStateDir.mockResolvedValue({ created: ['/tmp/.giclaw/config.json'] })

    await runCli('init', '--non-interactive')

    expect(mocks.logger.info).toHaveBeenCalledWith('Initialized ~/.giclaw/ at /tmp/.giclaw')
    expect(mocks.logger.info).toHaveBeenCalledWith('  Created /tmp/.giclaw/config.json')

    mocks.initStateDir.mockResolvedValue({ created: [] })
    await runCli('init', '--non-interactive')
    expect(mocks.logger.info).toHaveBeenCalledWith('~/.giclaw/ already initialized at /tmp/.giclaw')
  })

  it('honors cancellation and confirmation when reconfiguring interactively', async () => {
    setTTY(process.stdin, true)
    setTTY(process.stdout, true)
    mocks.wizardConfigured.mockResolvedValue(true)
    mocks.confirm.mockResolvedValue(false)

    await runCli('init')
    expect(mocks.logger.info).toHaveBeenCalledWith('No changes made.')
    expect(mocks.runSetupWizard).not.toHaveBeenCalled()

    mocks.confirm.mockResolvedValue(true)
    await runCli('init')
    expect(mocks.runSetupWizard).toHaveBeenCalledOnce()
  })

  it('lists plugin load state, capabilities, and failures', async () => {
    mocks.pluginHost.getStatus.mockReturnValue([
      {
        id: 'webhook',
        name: 'Webhook',
        description: 'Signed notifications',
        version: '0.1.0',
        enabled: true,
        loaded: true,
        bundled: true,
        channels: ['webhook'],
        services: ['watcher'],
        routes: ['POST /api/ext/webhook'],
        tools: ['send'],
      },
      { id: 'feishu', name: 'Feishu', enabled: true, loaded: false, bundled: false, channels: [], services: [], routes: [], tools: [] },
      { id: 'disabled', name: 'Disabled', enabled: false, loaded: false, bundled: false, channels: [], services: [], routes: [], tools: [] },
    ])
    mocks.pluginHost.getFailure.mockImplementation((id: string) => (id === 'feishu' ? 'missing app secret' : undefined))

    await runCli('plugins')

    expect(mocks.logger.info).toHaveBeenCalledWith('[x] webhook — Webhook v0.1.0 (bundled)')
    expect(mocks.logger.info).toHaveBeenCalledWith('    Signed notifications')
    expect(mocks.logger.info).toHaveBeenCalledWith('    channels: webhook')
    expect(mocks.logger.info).toHaveBeenCalledWith('    services: watcher')
    expect(mocks.logger.info).toHaveBeenCalledWith('    routes: POST /api/ext/webhook')
    expect(mocks.logger.info).toHaveBeenCalledWith('    tools: send')
    expect(mocks.logger.info).toHaveBeenCalledWith('[!] feishu — Feishu')
    expect(mocks.logger.info).toHaveBeenCalledWith('[ ] disabled — Disabled')
    expect(mocks.logger.warn).toHaveBeenCalledWith('    failed: missing app secret')
    expect(mocks.logger.info).toHaveBeenCalledWith('Enable plugins with plugins.enabled in ~/.giclaw/config.json')
    expect(mocks.pluginHost.load).toHaveBeenCalled()
  })

  it('reports when no plugins are discovered', async () => {
    await runCli('plugins')

    expect(mocks.logger.info).toHaveBeenCalledWith('No plugins discovered.')
    expect(mocks.logger.info).not.toHaveBeenCalledWith(
      'Enable plugins with plugins.enabled in ~/.giclaw/config.json',
    )
  })

  it('lists registered channels and notification routes', async () => {
    mocks.pluginHost.capabilities.listChannels.mockReturnValue([
      { pluginId: 'webhook', channel: channel('webhook', 'Webhook', 'Posts JSON') },
      { pluginId: 'feishu', channel: channel('feishu', 'Feishu') },
    ])
    mocks.loadConfig.mockResolvedValue(config({
      notifications: { routes: [{ channel: 'webhook', target: 'ops' }, { channel: 'feishu' }] },
    }))

    await runCli('channels')

    expect(mocks.logger.info).toHaveBeenCalledWith('webhook — Webhook (plugin: webhook)')
    expect(mocks.logger.info).toHaveBeenCalledWith('    Posts JSON')
    expect(mocks.logger.info).toHaveBeenCalledWith('feishu — Feishu (plugin: feishu)')
    expect(mocks.logger.info).toHaveBeenCalledWith('Routes:')
    expect(mocks.logger.info).toHaveBeenCalledWith('  webhook -> ops')
    expect(mocks.logger.info).toHaveBeenCalledWith('  feishu')
  })

  it('reports when no channels are registered', async () => {
    await runCli('channels')

    expect(mocks.logger.info).toHaveBeenCalledWith(
      'No channels registered. Enable a channel plugin and set notifications.routes.',
    )
  })

  it('reports an empty notification route list', async () => {
    mocks.pluginHost.capabilities.listChannels.mockReturnValue([
      { pluginId: 'webhook', channel: channel('webhook', 'Webhook') },
    ])

    await runCli('channels')

    expect(mocks.logger.info).toHaveBeenCalledWith('  (none configured)')
  })

  it('shows resolved paths', async () => {
    await runCli('config')

    expect(mocks.logger.info).toHaveBeenCalledWith('configPath: /tmp/.giclaw/config.json')
  })

  it('applies daemon overrides and starts the gateway', async () => {
    await runCli('--headless', '--verbose', 'daemon', '--port', '4321', '--no-web')

    expect(mocks.loadConfig).toHaveBeenCalledWith({
      configPath: undefined,
      cliOverrides: {
        browser: { headless: true },
        web: { port: 4321, enabled: false },
      },
    })
    expect(mocks.logger.setLevel).toHaveBeenCalledWith('debug')
    expect(mocks.startGateway).toHaveBeenCalledWith(config())
  })

  it('rejects daemon startup when the model is not configured', async () => {
    mocks.loadConfig.mockResolvedValue(config({ model: { name: '', baseUrl: '', apiKey: '' } }))

    await runCli('daemon')

    expect(mocks.startGateway).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('lists pairing requests and approved senders per account', async () => {
    mocks.pairingStore.listAccountIds.mockResolvedValue(['default', 'beta'])
    mocks.pairingStore.listPending.mockImplementation(
      async (account: string): Promise<Record<string, { subjects: string[], createdAt: string }>> =>
        account === 'default' ? { ABC12345: { subjects: ['user:ou_1'], createdAt: '2026-01-01T00:00:00.000Z' } } : {},
    )
    mocks.pairingStore.readApproved.mockImplementation(async (account: string) =>
      account === 'default' ? ['user:ou_9'] : [])

    await runCli('pairing', 'list')

    expect(mocks.logger.info).toHaveBeenCalledWith('feishu/default:')
    expect(mocks.logger.info).toHaveBeenCalledWith('  pending ABC12345 -> user:ou_1')
    expect(mocks.logger.info).toHaveBeenCalledWith('  approved: user:ou_9')
    expect(mocks.logger.info).toHaveBeenCalledWith('feishu/beta:')
    expect(mocks.logger.info).toHaveBeenCalledWith('  pending: (none)')
    expect(mocks.logger.info).toHaveBeenCalledWith('  approved: (none)')
  })

  it('lists a named account even before anything paired on it', async () => {
    await runCli('pairing', 'list', 'feishu', '--account', 'beta')

    expect(mocks.logger.info).toHaveBeenCalledWith('feishu/beta:')
    expect(mocks.logger.info).toHaveBeenCalledWith('  pending: (none)')
  })

  it('resolves the default account from the plugin config', async () => {
    mocks.loadConfig.mockResolvedValue(
      config({
        plugins: { entries: { feishu: { config: { appId: 'cli_1', appSecret: 's' } } } },
      }) as never,
    )
    mocks.feishuConfigSchema.safeParse.mockReturnValue({ success: true, data: { defaultAccount: 'alpha' } })

    await runCli('pairing', 'list')

    expect(mocks.logger.info).toHaveBeenCalledWith('feishu/alpha:')
  })

  it('survives an invalid plugin config', async () => {
    mocks.loadConfig.mockResolvedValue(
      config({ plugins: { entries: { feishu: { config: {} } } } }) as never,
    )
    mocks.feishuConfigSchema.safeParse.mockReturnValue({ success: false, error: { issues: [] } })

    await runCli('pairing', 'list')

    expect(mocks.logger.warn).toHaveBeenCalledWith('Feishu plugin config is invalid; using the pairing store only.')
    expect(mocks.logger.info).toHaveBeenCalledWith('feishu/default:')
  })

  it('approves a pairing code and reports already-approved senders', async () => {
    await runCli('pairing', 'approve', 'feishu', 'abc12345')

    expect(mocks.pairingStore.approve).toHaveBeenCalledWith('default', 'abc12345')
    expect(mocks.logger.info).toHaveBeenCalledWith('Approved user:ou_1 on feishu/default')
    expect(process.exitCode).toBeUndefined()

    mocks.pairingStore.approve.mockResolvedValue({ ok: true, subjects: ['user:ou_1', 'user:ou_2'], alreadyApproved: true })
    await runCli('pairing', 'approve', 'feishu', 'ABC12345')

    expect(mocks.logger.info).toHaveBeenCalledWith('user:ou_1, user:ou_2 were already allowed on feishu/default')
  })

  it('targets another account with --account', async () => {
    await runCli('pairing', 'approve', 'feishu', 'ABC12345', '--account', 'beta')

    expect(mocks.pairingStore.approve).toHaveBeenCalledWith('beta', 'ABC12345')
    expect(mocks.logger.info).toHaveBeenCalledWith('Approved user:ou_1 on feishu/beta')
  })

  it('refuses to approve an unknown or expired code', async () => {
    mocks.pairingStore.approve.mockResolvedValue({ ok: false, reason: 'unknown-code' })

    await runCli('pairing', 'approve', 'feishu', 'NOPE1234')

    expect(mocks.logger.error).toHaveBeenCalledWith('Cannot approve NOPE1234: unknown or expired pairing code')
    expect(process.exitCode).toBe(1)
  })

  it('dismisses a request and reports an unknown code', async () => {
    await runCli('pairing', 'dismiss', 'feishu', 'ABC12345')

    expect(mocks.pairingStore.dismiss).toHaveBeenCalledWith('default', 'ABC12345')
    expect(mocks.logger.info).toHaveBeenCalledWith('Dismissed pairing request ABC12345 on feishu/default')

    mocks.pairingStore.dismiss.mockResolvedValue(false)
    await runCli('pairing', 'dismiss', 'feishu', 'NOPE1234')

    expect(mocks.logger.error).toHaveBeenCalledWith('Cannot dismiss NOPE1234: unknown or expired pairing code')
    expect(process.exitCode).toBe(1)
  })

  it('revokes a paired sender and reports an unknown sender', async () => {
    await runCli('pairing', 'revoke', 'feishu', 'user:ou_1')

    expect(mocks.pairingStore.revoke).toHaveBeenCalledWith('default', 'user:ou_1')
    expect(mocks.logger.info).toHaveBeenCalledWith('Revoked user:ou_1 on feishu/default')

    mocks.pairingStore.revoke.mockResolvedValue(false)
    await runCli('pairing', 'revoke', 'feishu', 'user:ou_404')

    expect(mocks.logger.error).toHaveBeenCalledWith('Cannot revoke user:ou_404: the sender is not paired on feishu/default')
    expect(process.exitCode).toBe(1)
  })

  it('notifies the requester after --notify', async () => {
    mocks.pairingStore.approve.mockResolvedValue({
      ok: true,
      subjects: ['user:ou_1', 'user:1234', 'chat:oc_1'],
      alreadyApproved: false,
    })
    mocks.loadConfig.mockResolvedValue(
      config({ plugins: { entries: { feishu: { config: { appId: 'cli_1', appSecret: 's' } } } } }) as never,
    )
    mocks.feishuConfigSchema.safeParse.mockReturnValue({ success: true, data: { defaultAccount: 'default' } })
    mocks.resolveFeishuAccount.mockReturnValue({
      accountId: 'default',
      config: { appId: 'cli_1', appSecret: 's', httpTimeoutMs: 30_000 },
    })

    await runCli('pairing', 'approve', 'feishu', 'ABC12345', '--notify')

    expect(mocks.sendAppMessage).toHaveBeenCalledTimes(2)
    expect(mocks.sendAppMessage).toHaveBeenCalledWith(
      expect.objectContaining({ receiveIdType: 'open_id', receiveId: 'ou_1', token: 't-1' }),
    )
    expect(mocks.sendAppMessage).toHaveBeenCalledWith(
      expect.objectContaining({ receiveIdType: 'user_id', receiveId: '1234' }),
    )
    expect(mocks.logger.info).toHaveBeenCalledWith('Notified user:ou_1 of the approval.')
  })

  it('reports a notification that failed without failing the approval', async () => {
    mocks.loadConfig.mockResolvedValue(
      config({ plugins: { entries: { feishu: { config: { appId: 'cli_1', appSecret: 's' } } } } }) as never,
    )
    mocks.feishuConfigSchema.safeParse.mockReturnValue({ success: true, data: {} })
    mocks.resolveFeishuAccount.mockReturnValue({
      accountId: 'default',
      config: { appId: 'cli_1', appSecret: 's', httpTimeoutMs: 30_000 },
    })
    mocks.sendAppMessage.mockRejectedValue(new Error('socket closed'))

    await runCli('pairing', 'approve', 'feishu', 'ABC12345', '--notify')

    expect(mocks.logger.warn).toHaveBeenCalledWith('Approved user:ou_1, but the notification failed: socket closed')
    expect(process.exitCode).toBeUndefined()
  })

  it('skips --notify when no Feishu account can send', async () => {
    await runCli('pairing', 'approve', 'feishu', 'ABC12345', '--notify')

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Cannot notify the requester: the Feishu plugin is not configured.',
    )

    mocks.loadConfig.mockResolvedValue(
      config({ plugins: { entries: { feishu: { config: { webhookUrl: 'https://hook' } } } } }) as never,
    )
    mocks.feishuConfigSchema.safeParse.mockReturnValue({ success: true, data: {} })
    mocks.resolveFeishuAccount.mockReturnValue({
      accountId: 'default',
      config: { httpTimeoutMs: 30_000 },
    })

    await runCli('pairing', 'approve', 'feishu', 'ABC12345', '--notify')

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Cannot notify the requester: this Feishu account has no app credentials.',
    )
    expect(mocks.sendAppMessage).not.toHaveBeenCalled()
  })

  it('explains how to use an action that is missing arguments', async () => {
    await runCli('pairing', 'approve', 'feishu')

    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Usage: giclaw pairing approve feishu <code> [--account <id>]',
    )
    expect(process.exitCode).toBe(1)

    await runCli('pairing', 'revoke', 'feishu')
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Usage: giclaw pairing revoke feishu <sender id> [--account <id>]',
    )
  })

  it('rejects an unknown pairing action', async () => {
    await runCli('pairing', 'enroll', 'feishu', 'ABC12345')

    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Unknown pairing action "enroll". Use list, approve, dismiss, revoke.',
    )
    expect(process.exitCode).toBe(1)
    expect(mocks.pairingStore.approve).not.toHaveBeenCalled()
  })

  it('rejects a channel that does not implement pairing', async () => {
    await runCli('pairing', 'list', 'telegram')

    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Channel "telegram" does not implement pairing. Known channels: feishu.',
    )
    expect(process.exitCode).toBe(1)
  })

  it('lists the queued notifications that failed to send', async () => {
    mocks.outbox.list.mockResolvedValue([
      {
        id: 'id-1',
        channel: 'feishu',
        target: 'ops',
        attempts: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        message: { level: 'success', title: 't', body: 'b', runId: 'run-7', trigger: 'cron', occurredAt: '2026-01-01T00:00:00.000Z', results: [] },
      },
      {
        id: 'id-2',
        channel: 'smtp',
        attempts: 0,
        createdAt: '2026-01-01T00:00:01.000Z',
        message: { level: 'error', title: 't', body: 'b', runId: 'run-8', trigger: 'manual', occurredAt: '2026-01-01T00:00:00.000Z', results: [] },
      },
    ])

    await runCli('outbox')

    expect(mocks.logger.info).toHaveBeenCalledWith(
      'id-1  feishu -> ops  attempts=2  2026-01-01T00:00:00.000Z  run=run-7',
    )
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'id-2  smtp  attempts=0  2026-01-01T00:00:01.000Z  run=run-8',
    )
    expect(process.exitCode).toBeUndefined()
  })

  it('says so when nothing is queued', async () => {
    await runCli('outbox', 'list')

    expect(mocks.logger.info).toHaveBeenCalledWith(
      'No queued notifications. Failed sends are queued here until the next daemon start.',
    )
    expect(mocks.outbox.clear).not.toHaveBeenCalled()
  })

  it('discards the queue on request', async () => {
    mocks.outbox.clear.mockResolvedValueOnce(2).mockResolvedValueOnce(0)

    await runCli('outbox', 'clear')

    expect(mocks.logger.info).toHaveBeenCalledWith('Discarded 2 queued notification(s).')

    await runCli('outbox', 'clear')
    expect(mocks.logger.info).toHaveBeenCalledWith('Nothing was queued.')
  })

  it('rejects an unknown outbox action', async () => {
    await runCli('outbox', 'flush')

    expect(mocks.logger.error).toHaveBeenCalledWith('Unknown outbox action "flush". Use list or clear.')
    expect(process.exitCode).toBe(1)
    expect(mocks.outbox.list).not.toHaveBeenCalled()
  })
})
