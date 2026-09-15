import type { RegisteredService } from './capabilities.js'
import type { PluginLogger } from './types.js'
import { toError } from '../utils/errors.js'

/** Outcome of one service start; failures always carry a diagnostic message. */
export type ServiceStartResult
  = | { id: string, pluginId: string, ok: true }
    | { id: string, pluginId: string, ok: false, detail: string }

/** Reported when a stop lands while a service is still starting. */
export const SERVICE_STOPPED_DURING_STARTUP = 'stopped during startup'

interface ActiveService {
  entry: RegisteredService
  controller: AbortController
  /** Settles once the in-flight start finished, whether it succeeded or not. */
  startup: Promise<void>
  /** Set by {@link ServiceManager.stopAll} so a late start cannot count as running. */
  stopRequested: boolean
}

/**
 * Owns the lifecycle of plugin services (openclaw: `OpenClawPluginService`).
 *
 * A failing service must never take the daemon down, so every start/stop is
 * isolated and reported instead of thrown. openclaw also tracks each startup
 * promise: a stop that arrives while a service is still starting waits for it
 * (and marks it as stopping) instead of racing it.
 */
export class ServiceManager {
  private readonly active = new Map<string, ActiveService>()
  private readonly failed = new Map<string, string>()

  constructor(private readonly logger: PluginLogger) {}

  async startAll(entries: RegisteredService[]): Promise<ServiceStartResult[]> {
    const results: ServiceStartResult[] = []
    for (const entry of entries) {
      if (this.active.has(entry.service.id))
        continue
      const controller = new AbortController()
      const active: ActiveService = {
        entry,
        controller,
        startup: Promise.resolve(),
        stopRequested: false,
      }
      this.active.set(entry.service.id, active)
      active.startup = this.startService(active, results)
      await active.startup
    }
    return results
  }

  private async startService(active: ActiveService, results: ServiceStartResult[]): Promise<void> {
    const { entry } = active
    const id = entry.service.id
    const pluginId = entry.pluginId
    try {
      await entry.service.start({ logger: this.logger, signal: active.controller.signal })
      if (active.stopRequested) {
        this.logger.warn(`Service ${id} finished starting after it was already stopping`)
        results.push({ id, pluginId, ok: false, detail: SERVICE_STOPPED_DURING_STARTUP })
        return
      }
      this.failed.delete(id)
      results.push({ id, pluginId, ok: true })
    }
    catch (error) {
      active.controller.abort()
      if (this.active.get(id) === active)
        this.active.delete(id)
      const message = toError(error).message
      if (active.stopRequested) {
        this.logger.warn(`Service ${id} stopped while it was starting: ${message}`)
        results.push({ id, pluginId, ok: false, detail: SERVICE_STOPPED_DURING_STARTUP })
        return
      }
      this.failed.set(id, message)
      this.logger.error(`Service ${id} failed to start: ${message}`)
      results.push({ id, pluginId, ok: false, detail: message })
    }
  }

  async stopAll(): Promise<void> {
    const entries = [...this.active.values()]
    this.active.clear()
    await Promise.allSettled(
      entries.map(async (active) => {
        const { entry, controller, startup } = active
        // Claim the service before the in-flight start settles, so its continuation
        // cannot report the service as running on behalf of a stop that superseded it.
        active.stopRequested = true
        controller.abort()
        // Wait for a startup that is still in flight: its continuation may create
        // the very resources this stop has to release, and it must see that a stop
        // was requested before it decides anything.
        await startup
        try {
          await entry.service.stop?.()
        }
        catch (error) {
          this.logger.warn(`Service ${entry.service.id} failed to stop`, error)
        }
      }),
    )
  }

  isRunning(id: string): boolean {
    return this.active.has(id)
  }

  listRunning(): string[] {
    return [...this.active.keys()]
  }

  lastFailure(id: string): string | undefined {
    return this.failed.get(id)
  }
}
