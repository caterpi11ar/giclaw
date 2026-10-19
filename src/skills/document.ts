/**
 * The SKILL.md document format, in one module.
 *
 * Both the loader (which materialises a `SkillDefinition`) and the evolution
 * patcher (which edits a skill file line-by-line) must agree on where the
 * `## Steps` / `## Known Issues` sections are and how one step line parses.
 * Keeping that knowledge here means a format change is made once, and both
 * callers cross the same interface.
 */

export interface ParsedStepLine {
  method: string
  prompt: string
}

export interface LocatedSkill {
  lines: string[]
  /** Index of the closing `---`, or -1 when the file has no frontmatter. */
  frontmatterClose: number
  stepsHeading: number
  stepsEnd: number
  stepLines: number[]
  knownIssuesHeading: number
  knownIssuesEnd: number
  knownIssueLines: number[]
}

const BULLET_PREFIX = '- '
const HEADING_PREFIX = '## '

/**
 * Parse one `- method: prompt` bullet. Returns null when the line is not a
 * step bullet or has no colon; callers decide whether that is an error.
 */
export function parseStepLine(line: string): ParsedStepLine | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(BULLET_PREFIX))
    return null
  const content = trimmed.slice(BULLET_PREFIX.length)
  const colon = content.indexOf(':')
  if (colon === -1)
    return null
  const method = content.slice(0, colon).trim()
  const prompt = content.slice(colon + 1).trim()
  return method ? { method, prompt } : null
}

/** True for any `- ...` bullet, including free-text Known Issues entries. */
export function isBulletLine(line: string): boolean {
  return line.trim().startsWith(BULLET_PREFIX)
}

/** Lower-cased `## Heading` title, or null when the line is not a heading. */
export function headingName(line: string): string | null {
  const trimmed = line.trim()
  return trimmed.startsWith(HEADING_PREFIX)
    ? trimmed.slice(HEADING_PREFIX.length).trim().toLowerCase()
    : null
}

/** Split a Markdown body into `## Heading` sections, keyed by title. */
export function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>()
  let current = ''
  for (const line of body.split('\n')) {
    const name = headingName(line)
    if (name)
      current = name
    else if (current)
      sections.set(current, `${sections.get(current) ?? ''}${line}\n`)
  }
  return sections
}

/** Locate the frontmatter and the `## Steps` / `## Known Issues` sections. */
export function locateSkill(markdown: string): LocatedSkill {
  const lines = markdown.split('\n')

  let frontmatterClose = -1
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === '---') {
        frontmatterClose = i
        break
      }
    }
  }

  const headings: Array<{ name: string, index: number }> = []
  for (let i = frontmatterClose + 1; i < lines.length; i++) {
    const name = headingName(lines[i]!)
    if (name)
      headings.push({ name, index: i })
  }
  const endOfSection = (index: number): number => {
    const next = headings.find(heading => heading.index > index)
    return next ? next.index : lines.length
  }

  const steps = headings.find(heading => heading.name === 'steps')
  const known = headings.find(heading => heading.name === 'known issues')
  const stepsHeading = steps?.index ?? -1
  const stepsEnd = steps ? endOfSection(steps.index) : -1
  const knownIssuesHeading = known?.index ?? -1
  const knownIssuesEnd = known ? endOfSection(known.index) : -1

  const bulletLines = (from: number, to: number, predicate: (line: string) => boolean): number[] => {
    const found: number[] = []
    for (let i = from + 1; i < to; i++) {
      if (predicate(lines[i]!))
        found.push(i)
    }
    return found
  }

  return {
    lines,
    frontmatterClose,
    stepsHeading,
    stepsEnd,
    stepLines: stepsHeading === -1 ? [] : bulletLines(stepsHeading, stepsEnd, line => parseStepLine(line) !== null),
    knownIssuesHeading,
    knownIssuesEnd,
    knownIssueLines: knownIssuesHeading === -1 ? [] : bulletLines(knownIssuesHeading, knownIssuesEnd, isBulletLine),
  }
}
