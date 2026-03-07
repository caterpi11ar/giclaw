import type { GatewayEvents, GatewaySnapshot } from './types.js'
import { EventEmitter } from 'node:events'

/**
 * Observable runtime state. Emits "change" whenever state updates.
 * TUI and Web subscribe to this instead of importing daemon module-level vars.
 */
export class GatewayState extends EventEmitter {
  private snapshot: GatewaySnapshot = {
    running: false,
    currentRunId: null,
    currentTask: null,
    queueDepth: 0,
    lastRunAt: null,
    lastSuccess: null,
    phase: 'idle',
    taskIndex: 0,
    taskTotal: 0,
    currentStep: 0,
    elapsed: 0,
    currentAction: null,
    currentReason: null,
  }

  getSnapshot(): GatewaySnapshot {
    return { ...this.snapshot }
  }

  update(partial: Partial<GatewaySnapshot>): void {
    Object.assign(this.snapshot, partial)
    this.emit('change', this.getSnapshot())
  }

  // Typed event helpers (for consumers)
  override on<K extends keyof GatewayEvents>(
    event: K,
    listener: GatewayEvents[K],
  ): this
  override on(event: string, listener: (...args: unknown[]) => void): this
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener)
  }

  override emit<K extends keyof GatewayEvents>(
    event: K,
    ...args: Parameters<GatewayEvents[K]>
  ): boolean
  override emit(event: string, ...args: unknown[]): boolean
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args)
  }
}
