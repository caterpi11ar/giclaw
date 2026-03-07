import { access, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DIR_NAME = '.giclaw'

export interface StatePaths {
  stateDir: string
  configPath: string
  cookiePath: string
  dataDir: string
  transcriptsDir: string
  screenshotDir: string
  skillsDir: string
  builtinSkillsDir: string
}

function resolve(): StatePaths {
  const home = homedir()
  const stateDir = join(home, DIR_NAME)
  const dataDir = join(stateDir, 'data')
  // dist/config/ → package root
  const packageRoot = resolvePath(__dirname, '..', '..')

  return {
    stateDir,
    configPath: join(stateDir, 'config.json'),
    cookiePath: join(stateDir, 'cookies.json'),
    dataDir,
    transcriptsDir: join(dataDir, 'transcripts'),
    screenshotDir: join(dataDir, 'screenshots'),
    skillsDir: join(stateDir, 'skills'),
    builtinSkillsDir: join(packageRoot, 'skills'),
  }
}

// Module-level constant — resolved once on first import
export const PATHS: StatePaths = resolve()

// --- Async initializers ---

export async function ensureStateDir(): Promise<void> {
  const dirs = [PATHS.stateDir, PATHS.dataDir, PATHS.transcriptsDir, PATHS.screenshotDir, PATHS.skillsDir]
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true })
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

const DEFAULT_CONFIG = {
  locale: 'zh',
  model: {
    name: '',
    baseUrl: '',
    apiKey: '',
  },
  browser: {},
  tasks: {},
  schedule: {},
}

export async function initStateDir(): Promise<{ created: string[] }> {
  await ensureStateDir()
  const created: string[] = []

  if (!(await fileExists(PATHS.configPath))) {
    await writeFile(PATHS.configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf-8')
    created.push(PATHS.configPath)
  }

  return { created }
}
