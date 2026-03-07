import type { RunResult } from '../tasks/task-runner.js'
import type { QueueItem, QueueStatus } from './types.js'
import { EventEmitter } from 'node:events'
import { logger } from '../utils/logger.js'

interface QueueEntry {
  item: QueueItem
  processor: () => Promise<RunResult>
  resolve: (result: RunResult) => void
  reject: (error: Error) => void
}

/**
 * Serial FIFO task queue. Replaces the boolean `isRunning` flag.
 * enqueue() returns a Promise that resolves when the item is processed.
 */
export class TaskQueue extends EventEmitter {
  private queue: QueueEntry[] = []
  private processing = false
  private status: QueueStatus = 'idle'

  enqueue(
    item: QueueItem,
    processor: () => Promise<RunResult>,
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      this.queue.push({ item, processor, resolve, reject })
      logger.info(
        `Queue: enqueued run ${item.runId} (trigger=${item.trigger}), depth=${this.queue.length}`,
      )
      this.emit('enqueue', item)
      void this.processNext()
    })
  }

  getDepth(): number {
    return this.queue.length
  }

  getStatus(): QueueStatus {
    return this.status
  }

  isProcessing(): boolean {
    return this.processing
  }

  /** Wait for all queued items to finish. */
  async drain(): Promise<void> {
    if (this.queue.length === 0 && !this.processing)
      return
    this.status = 'draining'
    return new Promise((resolve) => {
      const check = () => {
        if (this.queue.length === 0 && !this.processing) {
          this.status = 'idle'
          resolve()
        }
        else {
          setTimeout(check, 100)
        }
      }
      check()
    })
  }

  private async processNext(): Promise<void> {
    if (this.processing)
      return
    const entry = this.queue.shift()
    if (!entry)
      return

    this.processing = true
    this.status = 'processing'
    this.emit('processing', entry.item)

    try {
      const result = await entry.processor()
      entry.resolve(result)
      this.emit('complete', entry.item, result)
    }
    catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      entry.reject(error)
      this.emit('error', entry.item, error)
    }
    finally {
      this.processing = false
      if (this.queue.length > 0) {
        void this.processNext()
      }
      else {
        this.status = 'idle'
      }
    }
  }
}
