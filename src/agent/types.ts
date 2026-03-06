import type { Page } from "playwright";
import type { IVisionModel, TaskDescription } from "../model/types.js";
import type { TranscriptWriter } from "../memory/transcript.js";

export interface AgentContext {
  page: Page;
  model: IVisionModel;
  goal: string | TaskDescription;
  timeoutMs: number;
  transcript?: TranscriptWriter;
  screenshotDir?: string;
  onProgress?: (step: number, elapsed: number, action: string, reason: string) => void;
}

export interface AgentResult {
  success: boolean;
  reason: string;
  steps: number;
  durationMs: number;
  screenshotPaths: string[];
}
