import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { PersistedState, RunSummary } from "./types.js";
import { logger } from "../utils/logger.js";

function defaultState(): PersistedState {
  return {
    lastRunId: null,
    lastRunAt: null,
    lastSuccess: null,
    totalRuns: 0,
    history: [],
  };
}

export class StateStore {
  private state: PersistedState | null = null;
  private readonly stateFile: string;
  private readonly dataDir: string;
  private readonly maxHistory: number;

  constructor(dataDir: string, maxHistory: number = 100) {
    this.dataDir = dataDir;
    this.stateFile = join(dataDir, "state.json");
    this.maxHistory = maxHistory;
  }

  async load(): Promise<PersistedState> {
    if (this.state) return this.state;
    try {
      const raw = await readFile(this.stateFile, "utf-8");
      this.state = JSON.parse(raw) as PersistedState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = defaultState();
      } else {
        logger.warn("Failed to load state, using defaults", err);
        this.state = defaultState();
      }
    }
    return this.state;
  }

  async save(): Promise<void> {
    if (!this.state) return;
    await mkdir(this.dataDir, { recursive: true });
    const tmp = this.stateFile + ".tmp";
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf-8");
    // .bak backup of previous state
    try { await rename(this.stateFile, this.stateFile + ".bak"); } catch {}
    await rename(tmp, this.stateFile);
  }

  async updateAfterRun(summary: RunSummary): Promise<void> {
    const state = await this.load();
    state.lastRunId = summary.runId;
    state.lastRunAt = summary.completedAt;
    state.lastSuccess = summary.results.every((r) => r.success);
    state.totalRuns++;
    state.history.push(summary);
    if (state.history.length > this.maxHistory) {
      state.history = state.history.slice(-this.maxHistory);
    }
    await this.save();
  }

  async getHistory(limit?: number): Promise<RunSummary[]> {
    const state = await this.load();
    const history = state.history;
    if (limit && limit < history.length) {
      return history.slice(-limit);
    }
    return history;
  }

  async getState(): Promise<PersistedState> {
    return this.load();
  }
}
