import type { Page } from "playwright";
import type { IVisionModel } from "../model/types.js";
import type { AppConfig } from "../config/schema.js";
import type { TranscriptWriter } from "../memory/transcript.js";
import type { logger } from "../utils/logger.js";

export interface TaskContext {
  page: Page;
  model: IVisionModel;
  config: AppConfig;
  logger: typeof logger;
  transcript?: TranscriptWriter;
  screenshotDir?: string;
  onProgress?: (step: number, elapsed: number, action: string, reason: string) => void;
}

export interface TaskDefinition {
  id: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
  timeoutMs: number;
  retries?: number;
  execute(ctx: TaskContext): Promise<TaskResult>;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  message: string;
  durationMs: number;
  screenshot?: string;
  completedAt: Date;
  error?: { name: string; message: string };
}
