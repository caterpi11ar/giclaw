import { Command } from "commander";
import { loadConfig } from "./config/loader.js";
import { PATHS, initStateDir } from "./config/paths.js";
import { Gateway } from "./gateway/gateway.js";
import { startGateway } from "./gateway/lifecycle.js";
import { logger } from "./utils/logger.js";
import type { ProgressEvent } from "./utils/progress.js";

const program = new Command();

program
  .name("giclaw")
  .description("AI agent for Genshin Impact cloud gaming")
  .version("0.2.0")
  .option("-c, --config <path>", "config file path")
  .option("-t, --tasks <ids...>", "task IDs to run")
  .option("--headless", "force headless mode")
  .option("--no-headless", "force visible mode")
  .option("--dry-run", "validate config only, do not execute")
  .option("-v, --verbose", "enable debug logging");

program
  .command("run", { isDefault: true })
  .description("Run tasks once (default)")
  .action(async () => {
    const opts = program.opts();
    await runOnce(opts);
  });

program
  .command("daemon")
  .description("Run as daemon with cron scheduling")
  .option("-p, --port <number>", "web panel port", "3000")
  .option("--no-web", "disable web panel")
  .action(async (daemonOpts) => {
    const opts = program.opts();
    await runDaemon(opts, daemonOpts);
  });

program
  .command("init")
  .description("Initialize ~/.giclaw/ directory with default config")
  .action(async () => {
    const { created } = await initStateDir();
    if (created.length === 0) {
      logger.info(`~/.giclaw/ already initialized at ${PATHS.stateDir}`);
    } else {
      logger.info(`Initialized ~/.giclaw/ at ${PATHS.stateDir}`);
      for (const f of created) {
        logger.info(`  Created ${f}`);
      }
    }
  });

program
  .command("config")
  .description("Show resolved config paths")
  .action(() => {
    for (const [key, value] of Object.entries(PATHS)) {
      logger.info(`${key}: ${value}`);
    }
  });

async function runOnce(opts: Record<string, unknown>): Promise<void> {
  if (opts["verbose"]) {
    logger.setLevel("debug");
  }

  const cliOverrides: Record<string, unknown> = {};
  if (opts["headless"] !== undefined) {
    cliOverrides["browser"] = { headless: opts["headless"] as boolean };
  }

  const config = await loadConfig({
    configPath: opts["config"] as string | undefined,
    cliOverrides,
  });

  if (opts["dryRun"]) {
    logger.info("Dry run — config validated successfully:");
    logger.info(JSON.stringify(config, null, 2));
    return;
  }

  const gateway = new Gateway(config);
  await gateway.init();
  const taskIds = opts["tasks"] as string[] | undefined;

  // Real-time progress in TTY mode
  const isTTY = process.stderr.isTTY;
  let progressCleanup: (() => void) | undefined;

  if (isTTY) {
    const formatElapsed = (ms: number): string => {
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return `${sec}s`;
      const min = Math.floor(sec / 60);
      const s = sec % 60;
      return `${min}m ${s.toString().padStart(2, "0")}s`;
    };

    const onProgress = (event: ProgressEvent) => {
      let line = `[${formatElapsed(event.elapsed)}]`;
      if (event.phase === "login") {
        line += " Logging in...";
      } else if (event.phase === "running") {
        if (event.taskTotal > 0) {
          line += ` Task ${event.taskIndex}/${event.taskTotal}: ${event.taskId ?? ""}`;
        }
        if (event.step > 0) {
          line += ` | Step ${event.step}: ${event.action ?? ""}`;
        }
        if (event.reason) {
          line += ` — "${event.reason}"`;
        }
      } else if (event.phase === "done") {
        line += " Done";
      } else if (event.phase === "error") {
        line += ` Error: ${event.reason ?? "unknown"}`;
      }
      process.stderr.write(`\r\x1b[K${line}`);
    };

    logger.on("progress", onProgress);
    logger.mute(); // Suppress stderr logs so progress line is clean
    progressCleanup = () => {
      logger.off("progress", onProgress);
      logger.unmute();
      process.stderr.write("\r\x1b[K");
    };
  }

  try {
    const result = await gateway.runOnce(taskIds);
    progressCleanup?.();

    for (const r of result.results) {
      const status = r.success ? "OK" : "FAIL";
      logger.info(
        `  [${status}] ${r.taskId}: ${r.message} (${r.durationMs}ms)`,
      );
    }

    const failed = result.results.filter((r) => !r.success);
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    progressCleanup?.();
    logger.error("Run failed", err);
    process.exitCode = 1;
  }
}

async function runDaemon(
  opts: Record<string, unknown>,
  daemonOpts: Record<string, unknown>,
): Promise<void> {
  if (opts["verbose"]) {
    logger.setLevel("debug");
  }

  const cliOverrides: Record<string, unknown> = {};
  if (opts["headless"] !== undefined) {
    cliOverrides["browser"] = { headless: opts["headless"] as boolean };
  }

  const webPort = Number(daemonOpts["port"] ?? 3000);
  const webEnabled = daemonOpts["web"] !== false;
  cliOverrides["web"] = { port: webPort, enabled: webEnabled };

  const config = await loadConfig({
    configPath: opts["config"] as string | undefined,
    cliOverrides,
  });

  await startGateway(config);
}

program.parse();
