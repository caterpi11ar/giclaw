import { captureScreenshot, saveScreenshot } from "../tools/screenshot.js";
import { executeAction } from "../tools/browser-tools.js";
import { logger } from "../utils/logger.js";
import type { AgentContext, AgentResult } from "./types.js";
import type { RecentAction } from "../model/types.js";

const EVIDENCE_INTERVAL = 5;

/** How many recent actions to include in the prompt for self-correction. */
const RECENT_ACTION_WINDOW = 8;

/**
 * Core observe→think→act loop.
 * The model alone decides coordinates from screenshots.
 * Recent action history is passed to the model so it can detect
 * repeated failures and self-correct.
 */
export async function runAgentLoop(ctx: AgentContext): Promise<AgentResult> {
  const { page, model, goal, timeoutMs, transcript, screenshotDir } = ctx;
  const start = Date.now();
  const deadline = Date.now() + timeoutMs;
  let step = 0;
  const screenshotPaths: string[] = [];
  const recentActions: RecentAction[] = [];

  while (Date.now() < deadline) {
    // Observe
    const imageBase64 = await captureScreenshot(page);

    // Think (pass recent history so the model can self-correct)
    const plan = await model.planNextAction(
      imageBase64,
      goal,
      recentActions.length > 0 ? recentActions : undefined,
    );
    step++;

    logger.info(`Step ${step}: ${plan.action} — ${plan.reason}`);
    ctx.onProgress?.(step, Date.now() - start, plan.action, plan.reason);

    // Track recent actions (sliding window)
    recentActions.push({
      step,
      action: plan.action,
      x: plan.x,
      y: plan.y,
      key: plan.key,
      reason: plan.reason,
    });
    if (recentActions.length > RECENT_ACTION_WINDOW) {
      recentActions.shift();
    }

    // Transcript
    if (transcript) {
      await transcript.append({
        step,
        timestamp: new Date().toISOString(),
        plan,
        result: plan.action === "done" ? "done" : "executed",
      });
    }

    // Done?
    if (plan.action === "done") {
      if (screenshotDir) {
        const path = await saveScreenshot(page, screenshotDir, "done");
        screenshotPaths.push(path);
      }
      return {
        success: plan.success ?? false,
        reason: plan.reason,
        steps: step,
        durationMs: Date.now() - start,
        screenshotPaths,
      };
    }

    // Act
    await executeAction(page, plan);

    // Evidence screenshots
    if (screenshotDir && step % EVIDENCE_INTERVAL === 0) {
      const path = await saveScreenshot(page, screenshotDir, `step-${step}`);
      screenshotPaths.push(path);
    }
  }

  // Timeout
  if (screenshotDir) {
    const path = await saveScreenshot(page, screenshotDir, "timeout");
    screenshotPaths.push(path);
  }

  return {
    success: false,
    reason: `Timed out after ${step} steps`,
    steps: step,
    durationMs: Date.now() - start,
    screenshotPaths,
  };
}
