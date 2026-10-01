/** Optional domain map provider; it builds on the graph engine and owns the map work in flight. */
import { Context, Service } from '@deepseek-ai/cordis'
import { mapNotBuilt } from './knowledge-map-shell.ts'
import { OperationScope } from './operation-scope.ts'
import type { MapOverlayPage, MapViewPage } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { researchKnowledgeMap: ResearchKnowledgeMap }
}

/** The domain map of the research field, shared by all research modes in one profile. */
export class ResearchKnowledgeMap extends Service {
  static inject = ['researchKnowledge']
  private readonly scope = new OperationScope('The domain map plugin was disabled')

  /** Register the map provider and await cancellation of its work when the plugin is disabled. */
  constructor(ctx: Context) {
    super(ctx, 'researchKnowledgeMap')
    ctx.effect(() => () => this.scope.close(), 'research-knowledge-map.close')
  }

  /**
   * Execute map work within both caller and plugin lifetimes.
   * @param signal - caller cancellation.
   * @param work - the operation; it receives a signal that fires on either cancellation.
   * @returns the operation's result.
   */
  run<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.scope.run(signal, work)
  }

  /**
   * Read the domain map of the field around a research.
   * @param signal - caller cancellation.
   * @returns the map, or the page that says it is not built.
   */
  view(signal: AbortSignal): Promise<MapViewPage> {
    return this.run(signal, () => Promise.resolve(mapNotBuilt()))
  }

  /**
   * Read what a research places over the domain map: its idea, its library and what the agent recalled.
   * @param signal - caller cancellation.
   * @returns the overlay, or the page that says the map is not built.
   */
  overlay(signal: AbortSignal): Promise<MapOverlayPage> {
    return this.run(signal, () => Promise.resolve(mapNotBuilt()))
  }
}

export default ResearchKnowledgeMap
