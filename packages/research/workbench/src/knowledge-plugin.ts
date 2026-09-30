/** Optional graph provider; its lifetime owns caches and in-flight graph operations. */
import { Context, Service } from '@deepseek-ai/cordis'
import { runtimeAsset } from './components.ts'
import { KnowledgeBase } from './knowledge.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { researchKnowledge: ResearchKnowledge }
}

/** Shared graph engine for all research modes in one profile. */
export class ResearchKnowledge extends Service {
  private readonly engine = new KnowledgeBase(runtimeAsset('kg/ai-kg.json.gz'))
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()

  /** Register the graph provider and await cancellation before releasing its caches. */
  constructor(ctx: Context) {
    super(ctx, 'researchKnowledge')
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('The knowledge graph plugin was disabled'))
      await Promise.allSettled([...this.operations])
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
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    const operation = Promise.resolve().then(async () => {
      combined.throwIfAborted()
      const result = await work(this.engine, combined)
      combined.throwIfAborted()
      return result
    })
    this.operations.add(operation)
    void operation.then(() => { this.operations.delete(operation) }, () => { this.operations.delete(operation) })
    return operation
  }
}

export default ResearchKnowledge
