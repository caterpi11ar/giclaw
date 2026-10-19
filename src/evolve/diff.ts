/**
 * Minimal, reviewable diff for SKILL.md patches.
 *
 * The loop only needs (a) a bounded "how much changed" number for the patch
 * budget and (b) a human-readable unified diff for the generation record, so a
 * common-prefix/suffix diff is enough and avoids a full Myers implementation.
 */

export interface DiffSummary {
  added: number
  removed: number
  changedLines: number
  unified: string
}

export function summarizeDiff(before: string, after: string): DiffSummary {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')

  let prefix = 0
  while (
    prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const removedLines = beforeLines.slice(prefix, beforeLines.length - suffix)
  const addedLines = afterLines.slice(prefix, afterLines.length - suffix)
  const unified = [
    `@@ -${prefix + 1},${removedLines.length} +${prefix + 1},${addedLines.length} @@`,
    ...removedLines.map(line => `-${line}`),
    ...addedLines.map(line => `+${line}`),
  ].join('\n')

  return {
    added: addedLines.length,
    removed: removedLines.length,
    changedLines: removedLines.length + addedLines.length,
    unified,
  }
}
