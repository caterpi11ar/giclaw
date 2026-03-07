import cron from 'node-cron'
import { logger } from '../utils/logger.js'

export interface SchedulerOptions {
  cronExpr: string
  timezone: string
  onTick: () => void
}

/**
 * Thin wrapper around node-cron.
 */
export class Scheduler {
  private job: cron.ScheduledTask | null = null
  private cronExpr: string
  private timezone: string
  private onTick: () => void

  constructor(options: SchedulerOptions) {
    this.cronExpr = options.cronExpr
    this.timezone = options.timezone
    this.onTick = options.onTick
  }

  start(): void {
    if (this.job)
      return
    logger.info(
      `Scheduler starting — cron: "${this.cronExpr}" (${this.timezone})`,
    )
    this.job = cron.schedule(this.cronExpr, this.onTick, {
      timezone: this.timezone,
    })
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      this.job = null
      logger.info('Scheduler stopped')
    }
  }

  getCronExpr(): string {
    return this.cronExpr
  }

  getTimezone(): string {
    return this.timezone
  }
}
