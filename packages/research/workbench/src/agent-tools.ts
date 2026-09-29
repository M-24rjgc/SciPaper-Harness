/** Independently mountable research tool families in an Agent preset. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from './index.ts'
import { RESEARCH_TOOL_MODULES, registerResearchTools, type ResearchToolModule } from './tools.ts'
import * as knowledgeSkills from './knowledge-skills.ts'

/** Loader identity of the tool-family consumer. */
export const name = 'research-tools'
/** The project ledger and scoped tool registry required by every family. */
export const inject = ['research', 'tools']

/** Tool families contributed by this plugin instance. */
export interface Config {
  modules: ResearchToolModule[]
}

/** Empty selections contribute no tools; omitted selections mount every family. */
export const Config: s<Config> = s.object({
  modules: s.array(s.union([...RESEARCH_TOOL_MODULES])).default([...RESEARCH_TOOL_MODULES]),
})

/**
 * Register selected families with their own external-file approval hooks.
 * @param ctx - the preset's plugin context.
 * @param config - families enabled in this plugin instance.
 */
export function apply(ctx: Context, config: Config): void {
  registerResearchTools(ctx, ctx.research, config.modules.filter(module => module !== 'knowledge'))
  if (config.modules.includes('knowledge')) ctx.inject(['researchKnowledge'], async (scope) => {
    registerResearchTools(scope, scope.research, ['knowledge'])
    await scope.plugin(knowledgeSkills)
  })
}
