import type { ProviderPreset } from './presets.js'
import { readFile, writeFile } from 'node:fs/promises'
import { ensureStateDir, PATHS } from './paths.js'
import {
  CUSTOM_PROVIDER_VALUE,
  PROVIDER_PRESETS,

} from './presets.js'

const PLACEHOLDER_KEYS = ['your-api-key-here', 'sk-xxx', '']

export async function isModelConfigured(): Promise<boolean> {
  try {
    const raw = await readFile(PATHS.configPath, 'utf-8')
    const config = JSON.parse(raw) as Record<string, unknown>
    const model = config.model as Record<string, unknown> | undefined
    if (!model)
      return false

    const apiKey = (model.apiKey as string) ?? ''
    const baseUrl = (model.baseUrl as string) ?? ''
    const name = (model.name as string) ?? ''

    if (!apiKey || PLACEHOLDER_KEYS.includes(apiKey))
      return false
    if (!baseUrl || !name)
      return false
    return true
  }
  catch {
    return false
  }
}

function maskKey(key: string): string {
  if (key.length <= 4)
    return '****'
  return `****${key.slice(-4)}`
}

export async function runSetupWizard(): Promise<void> {
  // Dynamic import to keep startup fast for non-wizard paths
  const { select, input, password, confirm } = await import(
    '@inquirer/prompts',
  )

  try {
    // Welcome banner
    console.log()
    console.log('\x1B[36m  giclaw — AI Agent for Genshin Impact\x1B[0m')
    console.log('\x1B[2m  Let\'s configure your vision model.\x1B[0m')
    console.log()

    // 0. Select language
    const locale = await select({
      message: 'Select language / 选择语言:',
      choices: [
        { name: '中文', value: 'zh' as const },
        { name: 'English', value: 'en' as const },
      ],
    })

    // 1. Select provider
    const providerChoices = [
      ...PROVIDER_PRESETS.map(p => ({
        name: p.label,
        value: p.value,
      })),
      { name: 'Custom / Other', value: CUSTOM_PROVIDER_VALUE },
    ]

    const providerValue = await select({
      message: 'Select model provider:',
      choices: providerChoices,
    })

    const preset: ProviderPreset | undefined = PROVIDER_PRESETS.find(
      p => p.value === providerValue,
    )

    // 2. Base URL
    const baseUrl = await input({
      message: 'Base URL:',
      default: preset?.baseUrl,
      validate: (val: string) => {
        if (!val)
          return 'Base URL is required'
        if (!/^https?:\/\//.test(val))
          return 'Must start with http:// or https://'
        return true
      },
    })

    // 3. API Key
    const apiKey = await password({
      message: 'API Key:',
      validate: (val: string) => {
        if (!val)
          return 'API key is required'
        if (PLACEHOLDER_KEYS.includes(val))
          return 'Please enter a real API key'
        return true
      },
    })

    // 4. Model Name
    const modelName = await input({
      message: 'Model name:',
      default: preset?.modelName,
      validate: (val: string) => (val ? true : 'Model name is required'),
    })

    // 5. Summary & confirm
    console.log()
    console.log('\x1B[1mConfiguration summary:\x1B[0m')
    console.log(`  Language:     ${locale === 'zh' ? '中文' : 'English'}`)
    console.log(`  Provider:     ${preset?.label ?? 'Custom'}`)
    console.log(`  Base URL:     ${baseUrl}`)
    console.log(`  API Key:      ${maskKey(apiKey)}`)
    console.log(`  Model Name:   ${modelName}`)
    console.log()

    const ok = await confirm({ message: 'Save this configuration?' })
    if (!ok) {
      console.log('Setup cancelled.')
      return
    }

    // 7. Write config.json — deep merge to preserve other settings
    await ensureStateDir()

    let existing: Record<string, unknown> = {}
    try {
      const raw = await readFile(PATHS.configPath, 'utf-8')
      existing = JSON.parse(raw) as Record<string, unknown>
    }
    catch {
      // File doesn't exist yet, that's fine
    }

    existing.locale = locale
    existing.model = {
      name: modelName,
      baseUrl,
      apiKey,
    }

    await writeFile(PATHS.configPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8')

    // 8. Success message
    console.log()
    console.log(`\x1B[32mConfiguration saved to ${PATHS.configPath}\x1B[0m`)
    console.log()
    console.log('Next steps:')
    console.log('  giclaw run --dry-run   Validate configuration')
    console.log('  giclaw run             Run tasks once')
    console.log('  giclaw daemon          Start daemon mode')
    console.log()
  }
  catch (err) {
    // Handle Ctrl+C from @inquirer/prompts
    if (
      err
      && typeof err === 'object'
      && 'name' in err
      && (err as { name: string }).name === 'ExitPromptError'
    ) {
      console.log('\nSetup cancelled.')
      return
    }
    throw err
  }
}
