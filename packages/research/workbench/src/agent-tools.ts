/**
 * The research tools for one agent, and the skills of each project's mode.
 * The research preset mounts this entry, so the tools, their approval hook and
 * the mode skills live in the agents composed from it and nowhere else; the
 * ledger service itself stays host-wide.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from './index.ts'
import { registerModeSkills } from './mode-skills.ts'
import { registerResearchTools } from './tools.ts'

export const name = 'research-tools'
export const inject = ['research', 'tools', 'skills']

/**
 * Register the research tools and the mode-skill provider in the mounting preset.
 * @param ctx - the preset's plugin context.
 */
export function apply(ctx: Context): void {
  registerResearchTools(ctx, ctx.research)
  registerModeSkills(ctx, ctx.research)
}
