import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptEntry } from "./types.js";

/**
 * Append-only JSONL writer for execution transcripts.
 */
export class TranscriptWriter {
  private filePath: string;
  private initialized = false;
  private readonly transcriptsDir: string;

  constructor(transcriptsDir: string, runId: string) {
    this.transcriptsDir = transcriptsDir;
    this.filePath = join(transcriptsDir, `${runId}.jsonl`);
  }

  async append(entry: TranscriptEntry): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.transcriptsDir, { recursive: true });
      this.initialized = true;
    }
    const line = JSON.stringify(entry) + "\n";
    await appendFile(this.filePath, line, "utf-8");
  }

  getFilePath(): string {
    return this.filePath;
  }
}
