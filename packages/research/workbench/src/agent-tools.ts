/**
 * The research tools for one agent. The research preset mounts this entry, so
 * the tools and their approval hook live in the agents composed from it and
 * nowhere else; the ledger service itself stays host-wide.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.ts'
import { registerResearchTools } from './tools.ts'

export const name = 'research-tools'
export const inject = ['research', 'tools']

/**
 * Register the research tools on the mounting agent's tool registry.
 * @param ctx - the agent's plugin context.
 */
export function apply(ctx: Context): void {
  registerResearchTools(ctx, ctx.research)
}
