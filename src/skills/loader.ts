import type { TaskDescription } from '../model/types.js'
import type { SkillDefinition } from './types.js'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import matter from 'gray-matter'
import { z } from 'zod'

const frontmatterSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().default(600_000),
  retries: z.number().default(1),
})

function parseTaskDescription(markdown: string): TaskDescription {
  const sections = new Map<string, string>()
  let currentHeading = ''

  for (const line of markdown.split('\n')) {
    const headingMatch = line.match(/^## (.+)/)
    if (headingMatch) {
      currentHeading = headingMatch[1]!.trim().toLowerCase()
    }
    else if (currentHeading) {
      const existing = sections.get(currentHeading) ?? ''
      sections.set(currentHeading, `${existing + line}\n`)
    }
  }

  const background = (sections.get('background') ?? '').trim()
  const goal = (sections.get('goal') ?? '').trim()

  const knownIssuesRaw = (sections.get('known issues') ?? '').trim()
  const knownIssues = knownIssuesRaw
    .split('\n')
    .map(line => line.replace(/^- /, '').trim())
    .filter(Boolean)

  return { background, goal, knownIssues }
}

export async function loadSkills(dirs: string[]): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  for (const dir of dirs) {
    const absDir = resolve(dir)
    let entries: string[]
    try {
      entries = await readdir(absDir)
    }
    catch {
      continue // directory doesn't exist, skip
    }

    for (const entry of entries) {
      const skillFile = join(absDir, entry, 'SKILL.md')
      let content: string
      try {
        content = await readFile(skillFile, 'utf-8')
      }
      catch {
        continue // no SKILL.md, skip
      }

      const { data, content: body } = matter(content)
      const frontmatter = frontmatterSchema.parse(data)
      const taskDescription = parseTaskDescription(body)

      skills.push({
        ...frontmatter,
        taskDescription,
        sourcePath: skillFile,
      })
    }
  }

  return skills
}
