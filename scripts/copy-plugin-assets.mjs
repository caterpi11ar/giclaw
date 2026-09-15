import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

const projectRoot = resolve('.')
const sourceRoot = resolve(projectRoot, 'src')
const outputRoot = resolve(projectRoot, 'dist')

/**
 * Plugin manifests are read from disk at runtime (never bundled by `tsc`), so
 * every `giclaw.plugin.json` under `src/` must be copied next to its compiled
 * module in `dist/`.
 */
async function collectManifests(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...await collectManifests(path))
      continue
    }
    if (entry.isFile() && entry.name === 'giclaw.plugin.json')
      found.push(path)
  }
  return found
}

if (!(await stat(sourceRoot)).isDirectory())
  throw new Error(`Source directory is missing: ${sourceRoot}`)

const manifests = await collectManifests(sourceRoot)
for (const manifest of manifests) {
  const target = resolve(outputRoot, relative(sourceRoot, manifest))
  if (!target.startsWith(`${outputRoot}/`))
    throw new Error(`Refusing to copy outside dist: ${target}`)
  await mkdir(dirname(target), { recursive: true })
  await cp(manifest, target)
}

console.log(`Copied ${manifests.length} plugin manifest(s) into dist/.`)
