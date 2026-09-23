/**
 * The skills of the project's mode, and only those. A session working in a
 * spark-to-paper project sees that pack's skills; the same session in a
 * general project sees none of them, and switching the mode swaps the
 * catalog in the live session — the skill registry lists providers per
 * working directory before every model step, and republishes the catalog
 * when it changes.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'
import type { ResearchWorkbench } from './index.ts'
import { parseSkillFile, type ModeSkill } from './modes.ts'

/** Pack skills outrank the preset's own directory (300), so a mode's skill wins a name clash inside the preset. */
const MODE_SKILL_RANK = 290
const PROVIDER = 'research-modes'

/**
 * Register the provider that lists the current mode's skills for a working directory.
 * @param ctx - the research preset's plugin context; the provider lives in its skill layer.
 * @param service - the research service, which knows each directory's project and mode.
 */
export function registerModeSkills(ctx: Context, service: ResearchWorkbench): void {
  ctx.skills.registerProvider((control) => {
    // A mode change or a new project changes what a directory lists; the registry caches completed catalogs.
    ctx.on('research/mode', () => { control.invalidate() })
    const provider: SkillProvider = {
      name: PROVIDER,
      // projectAt answers undefined for a directory it cannot resolve, so a lookup never fails the whole catalog.
      async list({ cwd }) {
        const project = cwd === undefined ? undefined : await service.projectAt(cwd)
        return project ? service.modes.resolve(project).pack.skills.map(skill => candidate(skill)) : []
      },
      get: found => modeSkillDefinition(found.locator as ModeSkill),
    }
    return provider
  })
}

/**
 * Load one pack skill's full body.
 * @param skill - the skill as its pack listed it.
 * @returns the definition, or undefined when its file can no longer be read.
 */
export async function modeSkillDefinition(skill: ModeSkill): Promise<SkillDefinition | undefined> {
  let body: string
  try { body = parseSkillFile(await readFile(join(skill.directory, 'SKILL.md'), 'utf8')).body } catch { return undefined }
  return { ...summary(skill), provider: PROVIDER, content: body }
}

/** Metadata shared by the catalog entry and the loaded skill. */
function summary(skill: ModeSkill): Omit<SkillDefinition, 'content' | 'provider'> {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    path: join(skill.directory, 'SKILL.md'),
    resourceBase: { kind: 'directory', path: skill.directory },
  }
}

function candidate(skill: ModeSkill): SkillCandidate {
  return { ...summary(skill), provider: PROVIDER, rank: MODE_SKILL_RANK, locator: skill }
}
