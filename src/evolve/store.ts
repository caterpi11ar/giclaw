import type { BestKnownGood, GenerationRecord, PendingApproval } from './types.js'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWritePrivateFile, ensurePrivateDir } from '../config/paths.js'
import { EvolveError } from '../utils/errors.js'
import {
  bestKnownGoodSchema,
  generationRecordSchema,
  pendingApprovalSchema,
} from './types.js'

/**
 * Filesystem persistence for the evolution loop, under `~/.giclaw/evolve/`.
 *
 * Everything is written through giclaw's private-file helpers (0700 dirs, 0600
 * files, atomic replace) because transcripts, candidates and screenshots can
 * contain account information. Only the override SKILL.md that giclaw actually
 * loads lives outside this tree, at `~/.giclaw/skills/<id>/SKILL.md`.
 */

export interface EvolveStoreOptions {
  evolveDir: string
  overrideSkillsDir: string
}

/** Generation ids are `${skillId}-${stamp}-${random}`; keep them path-safe. */
const SAFE_GEN_ID = /^[\w.-]+$/

export class EvolveStore {
  readonly evolveDir: string
  readonly overrideSkillsDir: string

  constructor(options: EvolveStoreOptions) {
    this.evolveDir = options.evolveDir
    this.overrideSkillsDir = options.overrideSkillsDir
  }

  private generationDir(genId: string): string {
    if (!SAFE_GEN_ID.test(genId))
      throw new EvolveError(`非法 generation id "${genId}"`)
    return join(this.evolveDir, 'generations', genId)
  }

  private pendingFile(skillId: string): string {
    return join(this.evolveDir, 'pending', `${skillId}.json`)
  }

  private bestKnownGoodFile(skillId: string): string {
    return join(this.evolveDir, 'best-known-good', `${skillId}.json`)
  }

  overrideFile(skillId: string): string {
    return join(this.overrideSkillsDir, skillId, 'SKILL.md')
  }

  async ensure(): Promise<void> {
    await ensurePrivateDir(this.evolveDir)
    for (const name of ['generations', 'pending', 'best-known-good']) {
      await ensurePrivateDir(join(this.evolveDir, name))
    }
  }

  // --- generation records ---

  async writeGeneration(record: GenerationRecord): Promise<string> {
    await this.ensure()
    const path = join(this.generationDir(record.genId), 'record.json')
    await atomicWritePrivateFile(path, `${JSON.stringify(record, null, 2)}\n`)
    return path
  }

  async saveCandidate(genId: string, markdown: string): Promise<string> {
    await this.ensure()
    const path = join(this.generationDir(genId), 'candidate', 'SKILL.md')
    await atomicWritePrivateFile(path, markdown)
    return path
  }

  async readGeneration(genId: string): Promise<GenerationRecord | null> {
    try {
      const raw = await readFile(join(this.generationDir(genId), 'record.json'), 'utf-8')
      return generationRecordSchema.parse(JSON.parse(raw))
    }
    catch {
      return null
    }
  }

  async listGenerations(skillId?: string): Promise<GenerationRecord[]> {
    await this.ensure()
    const entries = await readdir(join(this.evolveDir, 'generations'))

    const records: GenerationRecord[] = []
    for (const entry of entries) {
      const record = await this.readGeneration(entry)
      if (record && (!skillId || record.skillId === skillId))
        records.push(record)
    }
    return records.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  }

  async latestGeneration(skillId?: string): Promise<GenerationRecord | null> {
    const [latest] = await this.listGenerations(skillId)
    return latest ?? null
  }

  // --- pending approval ---

  async writePending(pending: PendingApproval): Promise<void> {
    await this.ensure()
    await atomicWritePrivateFile(
      this.pendingFile(pending.skillId),
      `${JSON.stringify(pending, null, 2)}\n`,
    )
  }

  async readPending(skillId: string): Promise<PendingApproval | null> {
    try {
      const raw = await readFile(this.pendingFile(skillId), 'utf-8')
      return pendingApprovalSchema.parse(JSON.parse(raw))
    }
    catch {
      return null
    }
  }

  async clearPending(skillId: string): Promise<void> {
    await rm(this.pendingFile(skillId), { force: true })
  }

  async listPending(): Promise<PendingApproval[]> {
    await this.ensure()
    const entries = await readdir(join(this.evolveDir, 'pending'))
    const found: PendingApproval[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json'))
        continue
      const value = await this.readPending(entry.slice(0, -'.json'.length))
      if (value)
        found.push(value)
    }
    return found.sort((a, b) => a.skillId.localeCompare(b.skillId))
  }

  // --- best known good ---

  async setBestKnownGood(entry: BestKnownGood): Promise<void> {
    await this.ensure()
    await atomicWritePrivateFile(
      this.bestKnownGoodFile(entry.skillId),
      `${JSON.stringify(entry, null, 2)}\n`,
    )
  }

  async getBestKnownGood(skillId: string): Promise<BestKnownGood | null> {
    try {
      const raw = await readFile(this.bestKnownGoodFile(skillId), 'utf-8')
      return bestKnownGoodSchema.parse(JSON.parse(raw))
    }
    catch {
      return null
    }
  }

  async listBestKnownGood(): Promise<BestKnownGood[]> {
    await this.ensure()
    const entries = await readdir(join(this.evolveDir, 'best-known-good'))
    const found: BestKnownGood[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json'))
        continue
      const value = await this.getBestKnownGood(entry.slice(0, -'.json'.length))
      if (value)
        found.push(value)
    }
    return found.sort((a, b) => a.skillId.localeCompare(b.skillId))
  }

  // --- live override ---

  async readOverride(skillId: string): Promise<string | null> {
    try {
      return await readFile(this.overrideFile(skillId), 'utf-8')
    }
    catch {
      return null
    }
  }

  async writeOverride(skillId: string, markdown: string): Promise<void> {
    await ensurePrivateDir(this.overrideSkillsDir)
    await atomicWritePrivateFile(this.overrideFile(skillId), markdown)
  }

  async removeOverride(skillId: string): Promise<void> {
    await rm(this.overrideFile(skillId), { force: true })
  }

  /** Restore the pre-session override state (null means "there was none"). */
  async restoreOverride(skillId: string, original: string | null): Promise<void> {
    if (original === null) {
      await this.removeOverride(skillId)
      return
    }
    await this.writeOverride(skillId, original)
  }
}

export function assertSafeSkillId(skillId: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillId))
    throw new EvolveError(`非法技能 id "${skillId}"`)
}
