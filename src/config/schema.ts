import { z } from "zod";
import { PATHS } from "./paths.js";

export const appConfigSchema = z.object({
  browser: z
    .object({
      startupUrl: z
        .string()
        .url()
        .default("https://ys.mihoyo.com/cloud/"),
      headless: z.boolean().default(true),
      viewport: z
        .object({
          width: z.number().default(1280),
          height: z.number().default(720),
        })
        .default({}),
      cookieFilePath: z.string().default(PATHS.cookiePath),
      dialogAutoDismissMs: z.number().default(10_000),
    })
    .default({}),

  login: z
    .object({
      successSelector: z.string().default(".wel-card__content--start"),
      timeoutMs: z.number().default(300_000),
      pollIntervalMs: z.number().default(500),
    })
    .default({}),

  startGame: z
    .object({
      startSelector: z.string().default(".wel-card__content--start"),
      dismissSelectors: z.array(z.string()).default([".guide-close-btn"]),
    })
    .default({}),

  model: z
    .object({
      name: z.string().default(""),
      baseUrl: z.string().default(""),
      apiKey: z.string().default(""),
      family: z.string().default(""),
    })
    .default({}),

  tasks: z
    .object({
      enabled: z.array(z.string()).default([
        "welkin-moon",
        "claim-mail",
        "expedition-collect",
        "battle-pass-claim",
      ]),
      skillsDirs: z.array(z.string()).default(["./skills", PATHS.skillsDir]),
    })
    .default({}),

  schedule: z
    .object({
      cron: z.string().default("0 6 * * *"),
      timezone: z.string().default("Asia/Shanghai"),
    })
    .default({}),

  web: z
    .object({
      port: z.number().default(3000),
      enabled: z.boolean().default(true),
    })
    .default({}),

  memory: z
    .object({
      dataDir: z.string().default(PATHS.dataDir),
      maxHistory: z.number().default(100),
    })
    .default({}),

  queue: z
    .object({
      maxDepth: z.number().default(10),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
