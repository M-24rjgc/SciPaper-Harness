/** Optional research memory provider; it reads the records of the researches on this computer and needs no graph engine. */
import { Context, Service } from '@deepseek-ai/cordis'
import { buildResearchMemory, carriedMemory, type CarriedMemory, type MemoryOptions } from './knowledge-memory.ts'
import type { ResearchMemoryPage, ResearchProject } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { researchKnowledgeMemory: ResearchKnowledgeMemory }
}

/** What the researches on this computer leave for the next one, shared by all research modes in one profile. */
export class ResearchKnowledgeMemory extends Service {
  /** Register the research memory provider. */
  constructor(ctx: Context) {
    super(ctx, 'researchKnowledgeMemory')
  }

  /**
   * Project the researches into the memory a new research can carry. Nothing is stored or written.
   * @param projects - every research record the host holds.
   * @param options - the examples to leave out, the finished researches, the person's switches and the venue names.
   * @returns the researches that left memory, and their literature, finished experiments, environments, venue templates and lessons.
   */
  page(projects: readonly ResearchProject[], options: MemoryOptions): ResearchMemoryPage {
    return buildResearchMemory(projects, options)
  }

  /**
   * Reduce a page to what the agent reads.
   * @param page - the memory of the researches other than the one the agent works in.
   * @returns only the kinds the person switched on, each cut to the agent's limit, with research titles in place of ids.
   */
  carried(page: ResearchMemoryPage): CarriedMemory {
    return carriedMemory(page)
  }
}

export default ResearchKnowledgeMemory
