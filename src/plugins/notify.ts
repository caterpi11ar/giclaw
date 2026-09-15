import type { AppConfig } from '../config/schema.js'
import type { RunTrigger } from '../queue/types.js'
import type { RunResult } from '../tasks/task-runner.js'
import type { NotificationOutbox } from './outbox.js'
import type { ChannelPlugin, NotificationMessage, PluginLogger } from './types.js'
import { toError } from '../utils/errors.js'
import { logger as rootLogger, sanitizeBoundedText } from '../utils/logger.js'
import { MAX_OUTBOX_ATTEMPTS } from './outbox.js'

export type NotificationEvent = 'run:complete' | 'run:error'

export interface NotificationDispatchEntry {
  channel: string
  target?: string
  ok: boolean
  detail: string
}

export interface NotificationDispatcherOptions {
  config: AppConfig
  getChannel: (id: string) => ChannelPlugin | undefined
  logger?: PluginLogger
  /** Per-channel send timeout. Notification failures must never stall a run. */
  timeoutMs?: number
  /** Maximum concurrent channel sends. */
  concurrency?: number
  /**
   * Durable queue for failed sends. Without it a failure is only logged, which
   * is what the daemon does when no data directory is available.
   */
  outbox?: NotificationOutbox
}

export interface RedeliverySummary {
  delivered: number
  failed: number
  dropped: number
  pending: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_CONCURRENCY = 4

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let cursor = 0
  const size = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length)
        return
      results[index] = await worker(items[index] as T)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Fans gateway run outcomes out to configured channels.
 *
 * Dispatch is deliberately isolated from the run: a channel that throws,
 * hangs, or is misconfigured is reported but never rewrites a successful
 * reward claim into a failure (the "提交不可取消" boundary).
 */
export class NotificationDispatcher {
  private readonly config: AppConfig
  private readonly getChannel: (id: string) => ChannelPlugin | undefined
  private readonly logger: PluginLogger
  private readonly timeoutMs: number
  private readonly concurrency: number
  private readonly outbox?: NotificationOutbox

  constructor(options: NotificationDispatcherOptions) {
    this.config = options.config
    this.getChannel = options.getChannel
    this.logger = options.logger ?? rootLogger
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
    this.outbox = options.outbox
  }

  shouldNotify(event: NotificationEvent): boolean {
    return this.config.notifications.on.includes(event)
  }

  buildRunMessage(runId: string, trigger: RunTrigger, result: RunResult): NotificationMessage {
    const successes = result.results.filter(item => item.success).length
    const total = result.results.length
    const failed = result.results.filter(item => !item.success)
    const ok = failed.length === 0
    const lines = result.results.map(
      item => `${item.success ? '✓' : '✗'} ${item.taskId}${item.success ? '' : ` — ${sanitizeBoundedText(item.message)}`}`,
    )
    return {
      level: ok ? 'success' : 'error',
      title: sanitizeBoundedText(`Giclaw 运行${ok ? '成功' : '部分失败'} (${successes}/${total})`),
      body: sanitizeBoundedText(
        [`runId: ${runId}`, `trigger: ${trigger}`, ...lines].join('\n'),
      ),
      runId,
      trigger,
      occurredAt: result.completedAt.toISOString(),
      results: result.results.map(item => ({
        taskId: item.taskId,
        success: item.success,
        message: sanitizeBoundedText(item.message),
        durationMs: item.durationMs,
      })),
    }
  }

  buildErrorMessage(runId: string, trigger: RunTrigger, error: Error): NotificationMessage {
    const message = sanitizeBoundedText(error.message)
    return {
      level: 'error',
      title: sanitizeBoundedText('Giclaw 运行失败'),
      body: sanitizeBoundedText([`runId: ${runId}`, `trigger: ${trigger}`, `error: ${message}`].join('\n')),
      runId,
      trigger,
      occurredAt: new Date().toISOString(),
      results: [],
    }
  }

  /** Send one message to one route, never rejecting. */
  private async deliver(params: {
    channel: string
    target?: string
    accountId?: string
    message: NotificationMessage
  }): Promise<NotificationDispatchEntry> {
    const channel = this.getChannel(params.channel)
    if (!channel) {
      const detail = `Channel "${params.channel}" is not registered`
      this.logger.warn(`Notification skipped: ${detail}`)
      return { channel: params.channel, target: params.target, ok: false, detail }
    }

    const channelConfig = (this.config.channels?.[params.channel] ?? {}) as Record<string, unknown>
    try {
      const result = await withTimeout(
        channel.outbound.send(params.message, {
          config: this.config,
          logger: this.logger,
          channelConfig,
          ...(params.target || params.accountId
            ? { target: { ...(params.target ? { name: params.target } : {}), ...(params.accountId ? { accountId: params.accountId } : {}) } }
            : {}),
        }),
        this.timeoutMs,
        `Channel "${params.channel}" send`,
      )
      const detail = sanitizeBoundedText(result.detail ?? (result.ok ? 'sent' : 'failed'))
      if (!result.ok)
        this.logger.warn(`Notification to "${params.channel}" failed: ${detail}`)
      return { channel: params.channel, target: params.target, ok: result.ok, detail }
    }
    catch (error) {
      const detail = sanitizeBoundedText(toError(error).message)
      this.logger.warn(`Notification to "${params.channel}" threw: ${detail}`)
      return { channel: params.channel, target: params.target, ok: false, detail }
    }
  }

  /**
   * Queue a failed delivery so the next startup can replay it. The queue is
   * best-effort: a store that cannot be written must not break the dispatch.
   */
  private async enqueueFailure(
    route: { channel: string, target?: string, account?: string },
    message: NotificationMessage,
  ): Promise<void> {
    const outbox = this.outbox
    if (!outbox)
      return
    const appended = await outbox.record({
      channel: route.channel,
      ...(route.target === undefined ? {} : { target: route.target }),
      ...(route.account === undefined ? {} : { accountId: route.account }),
      message,
    }).then(
      result => result,
      (error: unknown) => {
        this.logger.warn(
          `Notification to "${route.channel}" could not be queued for redelivery: ${sanitizeBoundedText(toError(error).message)}`,
        )
        return null
      },
    )
    if (appended === null)
      return
    this.logger.warn(
      appended.duplicate
        ? `Notification to "${route.channel}" is already queued for redelivery (${appended.id})`
        : `Notification to "${route.channel}" queued for redelivery (${appended.id})`,
    )
  }

  /** Dispatch to every configured route, collecting per-channel outcomes. */
  async dispatch(message: NotificationMessage): Promise<NotificationDispatchEntry[]> {
    const routes = this.config.notifications.routes
    if (routes.length === 0)
      return []

    return runWithConcurrency(routes, this.concurrency, async (route) => {
      const entry = await this.deliver({
        channel: route.channel,
        ...(route.target === undefined ? {} : { target: route.target }),
        ...(route.account === undefined ? {} : { accountId: route.account }),
        message,
      })
      if (!entry.ok)
        await this.enqueueFailure(route, message)
      return entry
    })
  }

  /**
   * Replay the durable queue. Called once at startup, after the channels are
   * registered; a delivery that still fails keeps its place until it exhausts
   * {@link MAX_OUTBOX_ATTEMPTS} retries or outlives the queue's age limit.
   */
  async redeliverPending(): Promise<RedeliverySummary> {
    const outbox = this.outbox
    const empty: RedeliverySummary = { delivered: 0, failed: 0, dropped: 0, pending: 0 }
    if (!outbox)
      return empty

    const entries = await outbox.list()
    if (entries.length === 0)
      return empty

    this.logger.info(`Redelivering ${entries.length} queued notification(s)`)
    const outcomes = await runWithConcurrency(entries, this.concurrency, async (pending) => {
      const entry = await this.deliver({
        channel: pending.channel,
        target: pending.target,
        accountId: pending.accountId,
        message: pending.message,
      })
      if (entry.ok) {
        await outbox.remove(pending.id)
        return 'delivered'
      }
      const failure = await outbox.recordFailure(pending.id, entry.detail)
      if (failure === 'dropped') {
        this.logger.warn(
          `Dropped queued notification ${pending.id} for "${pending.channel}" after ${MAX_OUTBOX_ATTEMPTS} attempts`,
        )
      }
      return failure === 'dropped' ? 'dropped' as const : 'failed' as const
    })

    const summary: RedeliverySummary = {
      delivered: outcomes.filter(outcome => outcome === 'delivered').length,
      failed: outcomes.filter(outcome => outcome === 'failed').length,
      dropped: outcomes.filter(outcome => outcome === 'dropped').length,
      pending: await outbox.size(),
    }
    this.logger.info(
      `Redelivery finished: ${summary.delivered} delivered, ${summary.failed} failed, ${summary.pending} still queued`,
    )
    return summary
  }

  /**
   * Fire-and-forget dispatch used by the gateway event bridge. Never rejects
   * and never blocks the caller — the run result is already committed.
   */
  dispatchSafe(message: NotificationMessage, onSettled?: (entries: NotificationDispatchEntry[]) => void): void {
    void this.dispatch(message)
      .then((entries) => {
        try {
          onSettled?.(entries)
        }
        catch (error) {
          this.logger.warn('Notification observer failed', error)
        }
      })
      .catch((error: unknown) => {
        this.logger.warn('Notification dispatch failed', error)
      })
  }
}
