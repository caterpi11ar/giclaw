#!/usr/bin/env node
// Evidence summarizer for the giclaw-evolve loop.
//
// Reads the daemon/CLI persisted state plus the JSONL transcript and screenshots
// of the most recent run, then prints a compact, agent-friendly digest. It never
// writes anything and never calls a model, so it is safe to run after every
// iteration.
//
// Usage:
//   node summarize.mjs <stateFile> <transcriptsDir> <screenshotDir> [tailN]

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const [stateFile, transcriptsDir, screenshotDir, tailArg] = process.argv.slice(2)
const tailN = Number.parseInt(tailArg ?? '80', 10)

function line(label, value) {
  process.stdout.write(`${label.padEnd(16)} ${value}\n`)
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  }
  catch {
    return null
  }
}

async function readTranscript(runId) {
  if (!runId)
    return []
  try {
    const raw = await readFile(join(transcriptsDir, `${runId}.jsonl`), 'utf-8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        }
        catch {
          return null
        }
      })
      .filter(Boolean)
  }
  catch {
    return []
  }
}

async function newestScreenshots(limit = 5) {
  try {
    const names = await readdir(screenshotDir)
    const withTime = await Promise.all(
      names.map(async name => ({
        name,
        mtime: (await stat(join(screenshotDir, name))).mtimeMs,
      })),
    )
    return withTime.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
  }
  catch {
    return []
  }
}

const state = await readJson(stateFile)

process.stdout.write('=== latest run ===\n')
if (!state) {
  process.stdout.write('(no state.json yet — no run has been persisted)\n')
}
else {
  line('lastRunId', state.lastRunId ?? '(none)')
  line('lastRunAt', state.lastRunAt ?? '(none)')
  line('lastSuccess', String(state.lastSuccess ?? '(none)'))
  line('totalRuns', String(state.totalRuns ?? 0))
  const history = Array.isArray(state.history) ? state.history.slice(-3) : []
  for (const run of history) {
    const passed = run.results.filter(r => r.success).length
    process.stdout.write(`  ${run.runId}  ${run.trigger}  ${run.startedAt}  ${passed}/${run.results.length} passed\n`)
    for (const r of run.results) {
      process.stdout.write(`    [${r.success ? 'OK' : 'FAIL'}] ${r.taskId}: ${r.message}\n`)
    }
  }
}

process.stdout.write('\n=== transcript ===\n')
const entries = await readTranscript(state?.lastRunId)
if (entries.length === 0) {
  process.stdout.write('(no transcript for the last run)\n')
}
else {
  for (const e of entries.slice(-tailN)) {
    const parts = [`step ${String(e.step).padStart(3)}`, e.result.padEnd(8), e.method ?? '']
    if (e.errorMessage)
      parts.push(`error=${e.errorMessage}`)
    if (e.screenshotPath)
      parts.push(`shot=${e.screenshotPath}`)
    if (e.output !== undefined)
      parts.push(`out=${JSON.stringify(e.output)}`)
    process.stdout.write(`${parts.join('  ')}\n`)
    if (e.prompt && (e.result === 'started' || e.result === 'error'))
      process.stdout.write(`      prompt: ${e.prompt}\n`)
  }
}

process.stdout.write('\n=== newest screenshots ===\n')
const shots = await newestScreenshots()
if (shots.length === 0) {
  process.stdout.write('(none)\n')
}
else {
  for (const s of shots)
    process.stdout.write(`${new Date(s.mtime).toISOString()}  ${join(screenshotDir, s.name)}\n`)
}
