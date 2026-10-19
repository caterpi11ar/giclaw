import type { SkillDefinition } from './types.js'

/**
 * Merge context skills (`context: true`) into runnable skills.
 *
 * Scoping is tag-based: a context skill declares `tags`, a runnable skill
 * declares `contexts`, and the `core` tag is always injected. This keeps a
 * large Genshin knowledge base (UI, map, quests, combat, shops, ...) from all
 * landing in every prompt.
 */
export function applyContextSkills(skills: SkillDefinition[]): void {
  const contextSkills = skills.filter(skill => skill.context)
  if (contextSkills.length === 0)
    return

  for (const skill of skills) {
    if (skill.context)
      continue

    const wanted = ['core', ...(skill.contexts ?? [])]
    const selected = new Map<string, SkillDefinition>()
    for (const tag of wanted) {
      for (const context of contextSkills) {
        if (tagsOf(context).includes(tag))
          selected.set(context.id, context)
      }
    }

    const backgrounds: string[] = []
    const issues: string[] = []
    for (const context of selected.values()) {
      if (context.background)
        backgrounds.push(context.background)
      issues.push(...(context.knownIssues ?? []))
    }

    if (backgrounds.length > 0)
      skill.background = [...backgrounds, skill.background].filter(Boolean).join('\n\n')
    if (issues.length > 0)
      skill.knownIssues = [...issues, ...(skill.knownIssues ?? [])]
  }
}

function tagsOf(skill: SkillDefinition): string[] {
  return skill.tags && skill.tags.length > 0 ? skill.tags : ['core']
}
