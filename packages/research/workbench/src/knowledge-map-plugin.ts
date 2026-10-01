/** Optional domain map provider; it builds on the graph engine and owns the map work in flight. */
import { Context, Service } from '@deepseek-ai/cordis'
import { runtimeAsset } from './components.ts'
import { builtinIndices, type Embedder, type KnowledgeBase, type RecallIndices } from './knowledge.ts'
import { readAnnotations } from './knowledge-annotations.ts'
import { hitsFromRecall, loadKnowledgeMap, placeFromHits, type KnowledgeMap } from './knowledge-map.ts'
import { encodeMapView, exactPlacement, mapPaperViews, markViews, paperByTitle, placementView, searchView } from './knowledge-map-view.ts'
import type {} from './knowledge-plugin.ts'
import { readHonour } from './knowledge-marks-state.ts'
import { readRecalls } from './knowledge-recall-log.ts'
import { OperationScope } from './operation-scope.ts'
import type { MapOverlayPage, MapPaperView, MapPlacementView, MapSearchView, MapViewPage, ResearchProject } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { researchKnowledgeMap: ResearchKnowledgeMap }
}

/** Imported references placed per overlay; the rest are listed without a position. */
export const MAX_LIBRARY = 80
/** Recent recalls whose papers the overlay shows. */
const RECALLS_SHOWN = 3
/** Papers per recall the overlay shows. */
const PAPERS_PER_RECALL = 8
/** Characters of a reference's abstract used to place it. */
const ABSTRACT_CHARS = 1500

/** The domain map of the research field, shared by all research modes in one profile. */
export class ResearchKnowledgeMap extends Service {
  static inject = ['researchKnowledge']
  private readonly scope = new OperationScope('The domain map plugin was disabled')
  /** The shipped map asset. */
  protected readonly assetPath: string = runtimeAsset('kg/ai-map.bin')
  private map: Promise<KnowledgeMap> | undefined
  private encoded: { map: KnowledgeMap; page: Extract<MapViewPage, { built: true }> } | undefined

  /**
   * Register the map provider and await cancellation of its work when the plugin is disabled.
   * @param ctx - the plugin context; it injects the graph engine.
   */
  constructor(ctx: Context) {
    super(ctx, 'researchKnowledgeMap')
    ctx.effect(() => () => {
      this.map = undefined
      this.encoded = undefined
      return this.scope.close()
    }, 'research-knowledge-map.close')
  }

  /**
   * Execute map work within both caller and plugin lifetimes, with the graph engine.
   * @param signal - caller cancellation.
   * @param work - the operation; it receives the engine and a signal that fires on either cancellation.
   * @returns the operation's result.
   */
  run<T>(signal: AbortSignal, work: (engine: KnowledgeBase, signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.scope.run(signal, scoped => this.ctx.researchKnowledge.run(scoped, work))
  }

  /** The parsed map, checked against the built-in graph's paper count; a failed load is retried next time. */
  private loaded(engine: KnowledgeBase): Promise<KnowledgeMap> {
    this.map ??= engine.builtinGraph().then(graph => loadKnowledgeMap(this.assetPath, graph.papers.length))
    this.map.catch(() => { this.map = undefined })
    return this.map
  }

  /**
   * The domain map of the field, encoded once per loaded map.
   * @param signal - caller cancellation.
   * @returns the map page.
   */
  view(signal: AbortSignal): Promise<MapViewPage> {
    return this.run(signal, async (engine) => {
      const map = await this.loaded(engine)
      if (this.encoded?.map !== map) this.encoded = { map, page: encodeMapView(map, await engine.builtinGraph()) }
      return this.encoded.page
    })
  }

  /**
   * Details of papers of the map, for a hover card.
   * @param indices - paper indices in the built-in graph.
   * @param signal - caller cancellation.
   * @returns their details, unknown indices left out.
   */
  papers(indices: readonly number[], signal: AbortSignal): Promise<MapPaperView[]> {
    return this.run(signal, async engine => mapPaperViews(await this.loaded(engine), await engine.builtinGraph(), indices))
  }

  /**
   * Where a search text lands on the map, with the papers and patterns it matched. Nothing is recorded: a search is
   * the person's, not a recall of the agent's.
   * @param root - the project root, whose marks recall honours.
   * @param query - the search text.
   * @param embedder - semantic pattern ranking, when configured.
   * @param signal - caller cancellation.
   * @returns the search's placement and matches.
   */
  search(root: string, query: string, embedder: Embedder | undefined, signal: AbortSignal): Promise<MapSearchView> {
    return this.run(signal, async (engine, scoped) => {
      const map = await this.loaded(engine)
      const graph = await engine.builtinGraph()
      const recall = await engine.recall(root, query, 5, embedder, scoped)
      // The built-in graph loaded above, so the recall ranked it.
      return searchView(map, graph, query, recall.basis, builtinIndices(recall) as RecallIndices)
    })
  }

  /**
   * What a research places over the map: its idea (the agent's latest recall query, else the brief), its
   * imported literature, the papers its recent recalls returned, and its marks.
   * @param project - the research record.
   * @param embedder - semantic ranking for placing the brief, when configured.
   * @param signal - caller cancellation.
   * @returns the overlay.
   */
  overlay(project: Pick<ResearchProject, 'root' | 'brief' | 'evidence'>, embedder: Embedder | undefined, signal: AbortSignal): Promise<MapOverlayPage> {
    return this.run(signal, async (engine, scoped) => {
      const map = await this.loaded(engine)
      const graph = await engine.builtinGraph()
      const place = async (text: string, semantic: Embedder | undefined): Promise<MapPlacementView | undefined> => {
        const recall = await engine.recall(project.root, text, 5, semantic, scoped)
        // The built-in graph loaded above, so the recall ranked it.
        const placement = placeFromHits(map, hitsFromRecall(builtinIndices(recall) as RecallIndices))
        return placement === undefined ? undefined : placementView(map, graph, placement)
      }
      const recalls = await readRecalls(project.root)
      const latest = recalls[0]
      let idea: Extract<MapOverlayPage, { built: true }>['idea']
      if (latest !== undefined) {
        // A log written against another build of the graph may name papers this one does not hold.
        const placement = placeFromHits(map, hitsFromRecall({
          papers: latest.papers.filter(({ index }) => index < graph.papers.length),
          patterns: latest.patterns.filter(({ index }) => index < graph.patterns.length),
        }))
        idea = { text: latest.query, source: 'recall', ...placement === undefined ? {} : { placement: placementView(map, graph, placement) } }
      } else if (project.brief.trim() !== '') {
        const placement = await place(project.brief, embedder)
        idea = placement === undefined
          ? { text: project.brief, source: 'brief', note: 'The brief shares too few words with the map\'s papers; a recall by the agent, in English, places the research.' }
          : { text: project.brief, source: 'brief', placement }
      }
      const library: Extract<MapOverlayPage, { built: true }>['library'] = []
      for (const [at, source] of project.evidence.filter(record => record.kind === 'literature').entries()) {
        scoped.throwIfAborted()
        const exact = paperByTitle(graph, source.title)
        const placement = exact !== undefined ? exactPlacement(map, graph, exact)
          : at < MAX_LIBRARY ? await place(`${source.title}. ${source.chunks.map(chunk => chunk.text).join(' ').slice(0, ABSTRACT_CHARS)}`, undefined)
            : undefined
        library.push({ evidenceId: source.id, title: source.title, ...placement === undefined ? {} : { placement } })
      }
      const seen = new Set<number>()
      const recalled = recalls.slice(0, RECALLS_SHOWN).flatMap(entry => entry.papers.slice(0, PAPERS_PER_RECALL).flatMap(({ index }) => {
        const paper = graph.papers[index]
        if (paper === undefined || seen.has(index)) return []
        seen.add(index)
        return [{ index, title: paper.title, query: entry.query }]
      }))
      const { annotations } = await readAnnotations(project.root)
      const own = await engine.graphOf(project.root, 'project')
      const marks = markViews(annotations, { ai: graph, ...own === undefined ? {} : { project: own } })
      return { built: true, ...idea === undefined ? {} : { idea }, library, recalled, marks, honour: await readHonour(project.root) }
    })
  }
}

export default ResearchKnowledgeMap
