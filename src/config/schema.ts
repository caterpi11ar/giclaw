import cron from 'node-cron'
import { z } from 'zod'
import { PLUGIN_ID_PATTERN } from '../plugins/manifest.js'
import { hasNoUrlCredentials, isHttpsOrLoopbackHttp } from '../utils/url.js'
import { PATHS } from './paths.js'

export const modelBaseUrlSchema = z.string().refine(
  isHttpsOrLoopbackHttp,
  'must use HTTPS unless the host is loopback',
).refine(hasNoUrlCredentials, 'must not contain credentials').refine((value) => {
  if (value === '')
    return true
  try {
    const url = new URL(value)
    return !value.includes('?') && !value.includes('#') && !url.search && !url.hash
  }
  catch {
    return false
  }
}, 'must not contain query parameters or fragments')

export const appConfigSchema = z.object({
  locale: z.enum(['zh', 'en']).default('zh'),

  browser: z
    .object({
      startupUrl: z
        .string()
        .url()
        .refine(isHttpsOrLoopbackHttp, 'must use HTTPS unless the host is loopback')
        .refine(hasNoUrlCredentials, 'must not contain credentials')
        .default('https://ys.mihoyo.com/cloud/'),
      headless: z.boolean().default(true),
      viewport: z
        .object({
          width: z.number().int().positive().max(16_384).default(1280),
          height: z.number().int().positive().max(16_384).default(720),
        })
        .default({}),
      cookieFilePath: z.string().default(PATHS.cookiePath),
      dialogAutoDismissMs: z.number().int().nonnegative().max(3_600_000).default(10_000),
    })
    .default({}),

  login: z
    .object({
      successSelector: z.string().min(1).max(1_000).default('.wel-card__content--start'),
      timeoutMs: z.number().int().positive().max(86_400_000).default(300_000),
      pollIntervalMs: z.number().int().positive().max(60_000).default(500),
    })
    .default({}),

  startGame: z
    .object({
      startSelector: z.string().default('.wel-card__content--start'),
      dismissSelectors: z.array(z.string()).default(['.guide-close-btn']),
    })
    .default({}),

  model: z
    .object({
      name: z.string().max(500).default(''),
      baseUrl: modelBaseUrlSchema.default(''),
      apiKey: z.string().max(10_000).default(''),
      family: z.string().max(100).default(''),
      stream: z.boolean().default(false),
    })
    .default({}),

  agent: z
    .object({
      replanningCycleLimit: z.number().int().positive().max(200).default(40),
    })
    .default({}),

  /**
   * Self-iteration (`giclaw evolve`) settings. Disabled by default, matching the
   * plugin system: nothing runs, no model call is made and no skill is rewritten
   * unless the operator opts in.
   */
  evolve: z
    .object({
      enabled: z.boolean().default(false),
      maxGenerations: z.number().int().positive().max(20).default(3),
      maxWallClockMs: z.number().int().positive().max(3_600_000).default(1_800_000),
      maxModelCalls: z.number().int().positive().max(100).default(10),
      regressionFactor: z.number().min(1).max(5).default(1.5),
      requireApproval: z.boolean().default(true),
      maxPatchLines: z.number().int().positive().max(200).default(40),
      modelTimeoutMs: z.number().int().positive().max(600_000).default(120_000),
      /** Empty means every skill is eligible. */
      allowedSkills: z.array(z.string().min(1).max(100)).max(200).default([]),
    })
    .default({}),

  tasks: z
    .object({
      enabled: z.array(z.string().min(1)).min(1).max(100).default([
        'welkin-moon',
        'claim-mail',
        'claim-achievements',
        'claim-event-rewards',
        'battle-pass-claim',
      ]),
      skillsDirs: z.array(z.string().min(1)).min(1).max(50).default([PATHS.builtinSkillsDir, './skills', PATHS.skillsDir]),
      routines: z.record(z.array(z.string().min(1)).min(1).max(100)).default({
        daily: ['welkin-moon', 'claim-mail'],
        rewards: ['welkin-moon', 'claim-mail', 'claim-achievements', 'claim-event-rewards', 'battle-pass-claim'],
        full: ['welkin-moon', 'claim-mail', 'claim-achievements', 'claim-event-rewards', 'battle-pass-claim'],
      }),
    })
    .default({}),

  schedule: z
    .object({
      cron: z.string().min(1).max(100).refine(value => cron.validate(value), 'must be a valid cron expression').default('0 6 * * *'),
      timezone: z.string().min(1).max(100).refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value }).format()
          return true
        }
        catch {
          return false
        }
      }, 'must be a valid IANA timezone').default('Asia/Shanghai'),
    })
    .default({}),

  web: z
    .object({
      port: z.number().int().min(1).max(65_535).default(3000),
      enabled: z.boolean().default(true),
    })
    .default({}),

  memory: z
    .object({
      dataDir: z.string().min(1).default(PATHS.dataDir),
      maxHistory: z.number().int().positive().max(10_000).default(100),
      maxArtifactFiles: z.number().int().positive().max(100_000).default(1_000),
      maxArtifactBytes: z.number().int().positive().max(100 * 1024 * 1024 * 1024).default(1024 * 1024 * 1024),
    })
    .default({}),

  queue: z
    .object({
      maxDepth: z.number().int().positive().max(10_000).default(10),
    })
    .default({}),

  /**
   * Plugin system configuration, mirroring openclaw's `plugins` segment.
   * `enabled` defaults to empty: no plugin runs, no outbound request is made
   * and no inbound route is opened unless explicitly opted in.
   */
  plugins: z
    .object({
      enabled: z.array(z.string().regex(PLUGIN_ID_PATTERN)).max(100).default([]),
      /** Additional directories scanned for external `<id>/giclaw.plugin.json` packages. */
      dirs: z.array(z.string().min(1).max(1_000)).max(50).default([]),
      /** Per-plugin private configuration: `entries.<id>.config`. */
      entries: z.record(z.object({ config: z.record(z.unknown()).default({}) })).default({}),
    })
    .default({}),

  /** Channel connection settings (`channels.<channelId>`), secrets usually via `env:` refs. */
  channels: z.record(z.record(z.unknown())).default({}),

  /** Run-outcome fan-out to channels. Empty `routes` disables all notifications. */
  notifications: z
    .object({
      on: z
        .array(z.enum(['run:complete', 'run:error']))
        .max(2)
        .default(['run:complete', 'run:error']),
      routes: z
        .array(
          z.object({
            channel: z.string().min(1).max(100),
            target: z.string().min(1).max(200).optional(),
            /** Sending account, for channels that are configured more than once. */
            account: z.string().min(1).max(64).optional(),
          }),
        )
        .max(50)
        .default([]),
    })
    .default({}),

  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type AppConfig = z.infer<typeof appConfigSchema>
