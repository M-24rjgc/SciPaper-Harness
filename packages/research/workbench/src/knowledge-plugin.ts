/** Optional graph provider; its lifetime owns caches and in-flight graph operations. */
import { Context, Service } from '@deepseek-ai/cordis'
import { runtimeAsset } from './components.ts'
import { KnowledgeBase } from './knowledge.ts'
import { OperationScope } from './operation-scope.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { researchKnowledge: ResearchKnowledge }
}

/** Shared graph engine for all research modes in one profile. */
export class ResearchKnowledge extends Service {
  private readonly engine = new KnowledgeBase(runtimeAsset('kg/ai-kg.json.gz'))
  private readonly scope = new OperationScope('The knowledge graph plugin was disabled')

  /** Register the graph provider and await cancellation before releasing its caches. */
  constructor(ctx: Context) {
    super(ctx, 'researchKnowledge')
    ctx.effect(() => async () => {
      await this.scope.close()
      this.engine.dispose()
    }, 'research-knowledge.close')
  }

  /**
   * Execute graph work within both caller and plugin lifetimes.
   * @param signal - caller cancellation.
   * @param work - operation over the shared graph engine.
   * @returns the operation's result.
   */
  run<T>(signal: AbortSignal, work: (engine: KnowledgeBase, signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.scope.run(signal, combined => work(this.engine, combined))
  }
}

export default ResearchKnowledge
