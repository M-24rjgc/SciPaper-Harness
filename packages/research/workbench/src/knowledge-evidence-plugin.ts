/** Optional evidence graph provider; it reads the project's own record and needs no graph engine. */
import { Context, Service } from '@deepseek-ai/cordis'
import { buildEvidenceGraph } from './knowledge-evidence.ts'
import type { EvidenceGraphPage, ResearchProject } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { researchKnowledgeEvidence: ResearchKnowledgeEvidence }
}

/** The research question, conclusions and evidence of a project, shared by all research modes in one profile. */
export class ResearchKnowledgeEvidence extends Service {
  /** Register the evidence graph provider. */
  constructor(ctx: Context) {
    super(ctx, 'researchKnowledgeEvidence')
  }

  /**
   * Project a research record into its evidence graph. Nothing is stored or written.
   * @param project - the research record.
   * @returns the question, the conclusions, the evidence behind them and the counts per status.
   */
  graph(project: ResearchProject): EvidenceGraphPage {
    return buildEvidenceGraph(project)
  }
}

export default ResearchKnowledgeEvidence
