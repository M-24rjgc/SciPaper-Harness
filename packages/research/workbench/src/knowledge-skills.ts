/** Mode-independent research graph methods, present only while the graph provider is enabled. */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {} from './knowledge-plugin.ts'
import type {} from '@deepseek-ai/dsh-skill'
import { runtimeAsset } from './components.ts'
import { parseSkillFile } from './modes.ts'

export const name = 'research-knowledge-skills'
export const inject = ['skills', 'researchKnowledge']

/**
 * Publish the graph method in every preset that mounts this plugin.
 * @param ctx - graph-enabled Agent preset.
 */
export function apply(ctx: Context): void {
  const directory = runtimeAsset('knowledge-skills/research-knowledge')
  const path = join(directory, 'SKILL.md')
  const summary = {
    name: 'research-knowledge', description: 'Find related research patterns, compare claims, build and inspect a knowledge graph in any research mode.',
    invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled' as const, path,
    resourceBase: { kind: 'directory' as const, path: directory },
  }
  ctx.skills.registerProvider(() => ({
    name: 'research-knowledge',
    list: () => Promise.resolve([{ ...summary, provider: 'research-knowledge', rank: 290, locator: path }]),
    get: async () => ({ ...summary, provider: 'research-knowledge', content: parseSkillFile(await readFile(path, 'utf8')).body }),
  }))
}
