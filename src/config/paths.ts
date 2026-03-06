import { join } from "node:path";
import { mkdir, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";

const DIR_NAME = ".giclaw";

export interface StatePaths {
  stateDir: string;
  configPath: string;
  envPath: string;
  cookiePath: string;
  dataDir: string;
  transcriptsDir: string;
  screenshotDir: string;
  skillsDir: string;
}

function resolve(): StatePaths {
  const home = process.env["GICLAW_HOME"] ?? process.env["HOME"] ?? process.env["USERPROFILE"] ?? homedir();
  const stateDir = process.env["GICLAW_STATE_DIR"] ?? join(home, DIR_NAME);
  const dataDir = join(stateDir, "data");

  return {
    stateDir,
    configPath: join(stateDir, "config.json"),
    envPath: join(stateDir, ".env"),
    cookiePath: join(stateDir, "cookies.json"),
    dataDir,
    transcriptsDir: join(dataDir, "transcripts"),
    screenshotDir: join(dataDir, "screenshots"),
    skillsDir: join(stateDir, "skills"),
  };
}

// Module-level constant — resolved once on first import
export const PATHS: StatePaths = resolve();

// --- Async initializers ---

export async function ensureStateDir(): Promise<void> {
  const dirs = [PATHS.stateDir, PATHS.dataDir, PATHS.transcriptsDir, PATHS.screenshotDir, PATHS.skillsDir];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_CONFIG = {
  browser: {},
  model: {},
  tasks: {},
  schedule: {},
};

const DEFAULT_ENV = `# Vision model configuration
MIDSCENE_MODEL_NAME=gemini-2.5-flash
MIDSCENE_MODEL_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
MIDSCENE_MODEL_API_KEY=your-api-key-here
MIDSCENE_MODEL_FAMILY=gemini

# Browser (optional)
# BROWSER_HEADLESS=true
`;

export async function initStateDir(): Promise<{ created: string[] }> {
  await ensureStateDir();
  const created: string[] = [];

  if (!(await fileExists(PATHS.configPath))) {
    await writeFile(PATHS.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf-8");
    created.push(PATHS.configPath);
  }

  if (!(await fileExists(PATHS.envPath))) {
    await writeFile(PATHS.envPath, DEFAULT_ENV, "utf-8");
    created.push(PATHS.envPath);
  }

  return { created };
}
