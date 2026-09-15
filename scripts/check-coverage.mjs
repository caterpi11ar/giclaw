import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const projectRoot = resolve('.')
const reportPath = resolve('coverage/coverage-summary.json')
const report = JSON.parse(await readFile(reportPath, 'utf8'))
const minimumGlobal = 99.8
const minimumPerFile = 98
const failures = []
const metricsToCheck = ['statements', 'branches', 'functions', 'lines']
const typeOnlyFiles = new Set([
  'src/agent/types.ts',
  'src/gateway/types.ts',
  'src/model/types.ts',
  'src/plugins/types.ts',
  'src/queue/types.ts',
  'src/tasks/base-task.ts',
  'src/tools/types.ts',
  'src/utils/progress.ts',
])

async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path))
      continue
    }
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts'))
      continue
    files.push(relative(projectRoot, path).replaceAll('\\', '/'))
  }
  return files
}

const reportsByRelativePath = new Map(
  Object.entries(report)
    .filter(([file]) => file !== 'total')
    .map(([file, metrics]) => [relative(projectRoot, file).replaceAll('\\', '/'), metrics]),
)

for (const metric of metricsToCheck) {
  const result = report.total?.[metric]
  if (!result || result.total <= 0 || result.pct < minimumGlobal)
    failures.push(`global ${metric}: ${result?.pct ?? 'missing'}% < ${minimumGlobal}%`)
}

for (const file of await sourceFiles(resolve('src'))) {
  const metrics = reportsByRelativePath.get(file)
  if (!metrics) {
    failures.push(`${file}: missing from coverage report`)
    continue
  }

  const hasExecutableMetric = metricsToCheck.some(metric => metrics[metric]?.total > 0)
  if (!hasExecutableMetric && !typeOnlyFiles.has(file)) {
    failures.push(`${file}: zero executable metrics without an explicit type-only exemption`)
    continue
  }

  for (const metric of metricsToCheck) {
    const result = metrics[metric]
    if (result.total > 0 && result.pct < minimumPerFile)
      failures.push(`${file}: ${metric} ${result.pct}% < ${minimumPerFile}%`)
  }
}

if (failures.length > 0)
  throw new Error(`Coverage threshold failed:\n${failures.join('\n')}`)

console.log(`Coverage thresholds passed (global >= ${minimumGlobal}%, per-file >= ${minimumPerFile}%).`)
