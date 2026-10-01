/**
 * Research-pattern knowledge graphs, shared by every mode. The platform ships
 * one graph distilled from spark-to-paper's AI corpus without its vectors
 * (runtime/kg/ai-kg.json.gz, built by scripts/build_kg.py); a project may build
 * its own from a corpus (.research/kg/graph.json). recall ranks patterns for
 * an idea, novelty compares a story with the closest works, and build-graph
 * and name-patterns turn extracted papers into a project graph. Ranking is
 * BM25 over patterns and papers plus the graph's paper neighbours; with an
 * embedding endpoint configured, cosine similarity over pattern texts joins
 * in, fused by reciprocal rank. Every result names the basis that produced it.
 */
import { readFile, stat } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import { agglomerate, Bm25, cosine, fuse, kMeans, similarityMatrix, termVectors, tokens, type Vector } from './clustering.ts'
import { atomicWrite, errorText, projectPath, readText } from './files.ts'
import {
  applyAnnotations, describeAnnotations, readAnnotations, type AnnotationSummary, type AnnotationWhy, type GraphSource,
  type RecallCandidate, type SkippedItem,
} from './knowledge-annotations.ts'
import { readHonour } from './knowledge-marks-state.ts'
import type { KnowledgeGraphNode, KnowledgeGraphPage, KnowledgeGraphQuery, KnowledgeReference } from './types.ts'

const tierSchema = z.enum(['A', 'B', 'C', ''])
const patternSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  domain: z.number().int(),
  subDomains: z.array(z.string()),
  size: z.number().int().nonnegative(),
  coherence: z.number().nullable(),
  tier: tierSchema,
  summary: z.string(),
  details: z.string(),
  ideas: z.array(z.string()),
  exemplars: z.array(z.number().int().nonnegative()),
  works: z.array(z.tuple([z.number().int(), z.number(), z.number()])),
})
const paperSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  pattern: z.number().int(),
  domain: z.number().int(),
  idea: z.string(),
  problem: z.string(),
  solution: z.string(),
  story: z.string(),
  score: z.number().nullable(),
  similar: z.array(z.number().int().nonnegative()),
  url: z.string().optional(),
})
const graphSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  description: z.string(),
  paperUrl: z.string().optional(),
  domains: z.array(z.string()),
  patterns: z.array(patternSchema),
  papers: z.array(paperSchema),
}).superRefine((graph, context) => {
  const problem = dangling(graph)
  if (problem !== undefined) context.addIssue({ code: 'custom', message: `The graph points outside itself at ${problem}` })
})

/** The first pattern or paper whose domain, pattern, exemplar or neighbour index names nothing. */
function dangling(graph: { domains: string[]; patterns: GraphPattern[]; papers: GraphPaper[] }): string | undefined {
  const domains = (at: number): boolean => at < 0 || at >= graph.domains.length
  const papers = (at: number): boolean => at < 0 || at >= graph.papers.length
  const patterns = (at: number): boolean => at !== -1 && (at < 0 || at >= graph.patterns.length)
  const pattern = graph.patterns.find(item => domains(item.domain) || item.exemplars.some(papers) || item.works.some(([at]) => domains(at)))
  if (pattern) return `pattern ${pattern.id}`
  const paper = graph.papers.find(item => patterns(item.pattern) || domains(item.domain) || item.similar.some(papers))
  return paper && `paper ${paper.id}`
}

/** A research-pattern graph as stored: patterns and papers point at each other by index. */
export type GraphFile = z.infer<typeof graphSchema>
/** A named research pattern with domain references and exemplar-paper indices into its graph. */
export type GraphPattern = z.infer<typeof patternSchema>
/** An indexed paper and its story fields; pattern -1 denotes a paper assigned to no pattern. */
export type GraphPaper = z.infer<typeof paperSchema>

/** Turns texts into embeddings with the configured endpoint; `model` keys the cached vectors. */
export interface Embedder {
  model: string
  embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]>
}

/** Where a project keeps the graph it builds. */
export const PROJECT_GRAPH = '.research/kg/graph.json'
/** Project-relative clustering output that name-patterns reads to construct the project graph. */
export const PROJECT_CLUSTERS = '.research/kg/clusters.json'
/** Cosine distance under which embedded papers join a cluster (spark-to-paper's cluster.py). */
const CLUSTER_THRESHOLD = 0.45
/** A corpus above this many papers is refused: clustering is quadratic. */
export const MAX_CORPUS = 2000
/** Story similarity bands, from the upstream novelty check. */
export const NOVELTY_HIGH = 0.88
/** Minimum embedding cosine similarity for medium novelty risk; lexical comparisons do not use this threshold. */
export const NOVELTY_MEDIUM = 0.82
/** Pattern names that describe architecture instead of a story angle (spark-to-paper's ts-kg-build). */
const BANNED_NAME_WORDS = ['method', 'framework', 'model', 'approach', 'network', 'system', 'technique', 'learning', 'based', 'novel', 'general']

const embeddingResponse = z.object({ data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().int() })).min(1) })

/**
 * An embedder for an OpenAI-compatible `/embeddings` endpoint.
 * @param binding - the endpoint and model.
 * @param key - the API key.
 * @returns the embedder, which starts at 64 texts per request and halves the batch, down to one,
 * whenever the endpoint rejects it as too large.
 */
export function createEmbedder(binding: { baseUrl: string; model: string }, key: string): Embedder {
  const base = binding.baseUrl.replace(/\/$/, '')
  // Providers cap a batch differently (some at 10 texts); the size that worked is kept for the next call.
  let limit = 64
  return {
    model: binding.model,
    async embed(texts, signal) {
      const vectors: Float32Array[] = []
      let start = 0
      while (start < texts.length) {
        const batch = texts.slice(start, start + limit)
        const response = await fetch(`${base}/embeddings`, {
          method: 'POST',
          signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: binding.model, input: batch }),
        })
        if (!response.ok) {
          if ([400, 413, 422].includes(response.status) && batch.length > 1) {
            limit = Math.max(1, Math.floor(batch.length / 2))
            continue
          }
          const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200)
          throw new Error(`Embedding endpoint returned HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`)
        }
        const data = embeddingResponse.parse(await response.json()).data.sort((a, b) => a.index - b.index)
        if (data.length !== batch.length) throw new Error('The embedding endpoint returned a different number of vectors')
        vectors.push(...data.map(item => Float32Array.from(item.embedding)))
        start += batch.length
      }
      return vectors
    },
  }
}

/** A graph ready to search. */
interface LoadedGraph {
  file: GraphFile
  /** `ai` for the built-in graph, `project` for the project's own. */
  source: 'ai' | 'project'
  patterns: Bm25
  papers: Bm25
  /** Pattern embeddings by model. */
  vectors: Map<string, Float32Array[]>
}

function patternText(graph: GraphFile, pattern: GraphPattern): string {
  const exemplars = pattern.exemplars.slice(0, 6).map(index => (graph.papers[index] as GraphPaper).title).join(' ')
  return `${pattern.name}. ${pattern.summary} ${pattern.details} ${pattern.ideas.join(' ')} ${pattern.subDomains.join(' ')} ${exemplars}`
}

function paperText(paper: GraphPaper): string {
  return `${paper.title}. ${paper.idea} ${paper.problem} ${paper.solution} ${paper.story}`
}

function index(file: GraphFile, source: LoadedGraph['source']): LoadedGraph {
  return {
    file, source, vectors: new Map(),
    patterns: new Bm25(file.patterns.map(pattern => tokens(patternText(file, pattern)))),
    papers: new Bm25(file.papers.map(paper => tokens(paperText(paper)))),
  }
}

/**
 * A paper's page: its own URL, else the graph's URL template filled with its id.
 * @param graph - the graph the paper belongs to.
 * @param paper - the paper.
 * @returns the URL, or undefined when neither is recorded.
 */
export function paperUrl(graph: GraphFile, paper: GraphPaper): string | undefined {
  return paper.url ?? graph.paperUrl?.replace('{id}', encodeURIComponent(paper.id))
}

/** One ranked pattern, as recall reports it. */
export interface RecalledPattern {
  graph: string
  id: string
  name: string
  tier: string
  domain: string
  subDomains: string[]
  size: number
  coherence: number | null
  score: number
  summary: string
  details: string
  ideas: string[]
  worksWellIn: { domain: string; effectiveness: number; confidence: number }[]
  exemplars: { title: string; story: string; url?: string; score: number | null }[]
  /** Papers the query matched that use this pattern: why it was recalled. */
  matchedPapers: string[]
  /** How the person's or the agent's marks moved it; present only when the project has marks. */
  why?: AnnotationWhy
}

/** A paper close to the query or the story. */
export interface ClosePaper {
  graph: string
  id: string
  title: string
  idea: string
  story: string
  pattern: string | null
  url?: string
  score: number | null
  /** How the marks moved it; present only when the project has marks. */
  why?: AnnotationWhy
}

/** What the project's marks changed in one recall. */
export interface RecallAnnotations {
  /** One sentence the agent can repeat: how many marks applied, and what they did. */
  applied: string
  /** Results a mark took out, with its reason. */
  skipped: SkippedItem[]
  summary: AnnotationSummary
}

/** Ranked patterns and nearby papers with the ranking method and any embedding-fallback explanation. */
export interface RecallResult {
  basis: 'lexical' | 'semantic+lexical'
  note: string
  patterns: RecalledPattern[]
  closestPapers: ClosePaper[]
  /** Present only when the project has marks: what they changed. */
  annotations?: RecallAnnotations
}

/** The built-in graph's rankings behind one recall, by index into that graph's papers and patterns. */
export interface RecallIndices {
  /** The papers the query matched (BM25, at most 30), best first. */
  papers: { index: number; score: number }[]
  /** Every pattern in recall's fused order, with its fused score. */
  patterns: { index: number; score: number }[]
}

/**
 * Indices behind each recall result. They stay beside the result so that the result's JSON, which the
 * model reads, and its declared type keep their fields.
 */
const recalledIndices = new WeakMap<RecallResult, RecallIndices>()

/**
 * The built-in graph's indices behind a recall result, for placing the query on the domain map.
 * @param result - a result that `KnowledgeBase.recall` returned, not a copy of one.
 * @returns the indices, or undefined when the built-in graph was unavailable to that recall.
 */
export function builtinIndices(result: RecallResult): RecallIndices | undefined {
  return recalledIndices.get(result)
}

/** Story fields the novelty check compares, in upstream order. */
const STORY_FIELDS = ['title', 'abstract', 'problem_framing', 'gap_pattern', 'solution', 'method_skeleton', 'experiments_plan'] as const

/** Story-similarity report; risk remains unknown when only lexical comparison or no comparison is available. */
export interface NoveltyReport {
  ok: true
  basis: string
  max_similarity: number | null
  risk_level: 'high' | 'medium' | 'low' | 'unknown'
  threshold_high: number
  threshold_medium: number
  top_similar: { ref: string; similarity: number }[]
  verdict: string
  max_pivots: 2
  note?: string
}

/** The story-first fields of an exemplar paper, from which the agent names its cluster. */
interface Exemplar { paper_id: string; title: string; story: string; base_problem: string; solution_pattern: string }

/** What build-graph found: the candidate patterns to name. */
export interface BuildResult {
  basis: 'embedding' | 'terms'
  note: string
  papers: number
  rejected: string[]
  unclustered: number
  saved: string
  clusters: { id: string; size: number; coherence: number; exemplars: Exemplar[] }[]
  next: string
}

/** The project graph name-patterns wrote, and what is wrong with it. */
export interface NameResult {
  valid: boolean
  saved: string
  patterns: number
  papers: number
  domains: number
  tiers: Record<string, number>
  issues: string[]
  next: string
}

const corpusSchema = z.object({
  paper_id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  story: z.string().trim().min(1),
  base_problem: z.string().trim().min(1),
  solution_pattern: z.string().trim().min(1),
  idea: z.string().optional(),
  domain: z.string().optional(),
  sub_domains: z.array(z.string()).default([]),
  review_score: z.number().min(0).max(1).optional(),
  url: z.string().optional(),
  doi: z.string().optional(),
})
/** An extracted paper, its domain filled in from the corpus label. */
type CorpusPaper = z.infer<typeof corpusSchema> & { domain: string }

const clusterFileSchema = z.object({
  version: z.literal(1),
  domain: z.string(),
  basis: z.enum(['embedding', 'terms']),
  model: z.string().optional(),
  builtAt: z.string(),
  papers: z.array(corpusSchema.extend({ domain: z.string(), similar: z.array(z.number().int()) })),
  clusters: z.array(z.object({
    id: z.string(),
    members: z.array(z.number().int()),
    membership: z.array(z.number()),
    coherence: z.number(),
    exemplars: z.array(z.number().int()),
  })),
})
type ClusterFile = z.infer<typeof clusterFileSchema>

const namesSchema = z.record(z.string(), z.object({
  name: z.string().optional(),
  summary: z.string().optional(),
  llm_enhanced_summary: z.string().optional(),
  tier: z.string().optional(),
}))

/** How long loaded graphs stay in memory after their last use. */
const IDLE_MS = 10 * 60_000
/** Byte ceiling for a graph, its clusters or its corpus; a 2000-paper graph is a few megabytes. */
const GRAPH_LIMIT = 64 * 1024 * 1024

/**
 * The knowledge graphs of one service: the built-in graph and each project's
 * own, loaded on first use and released after a quiet spell.
 */
export class KnowledgeBase {
  private builtin: Promise<LoadedGraph> | undefined
  private readonly projects = new Map<string, { mtime: number; graph: Promise<LoadedGraph> }>()
  private timer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param builtinPath - the shipped graph (gzip JSON).
   * @param idleMs - how long loaded graphs stay in memory unused.
   */
  constructor(private readonly builtinPath: string, private readonly idleMs = IDLE_MS) {}

  /** Keep the graphs for another quiet spell. */
  private touch(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.builtin = undefined; this.projects.clear() }, this.idleMs)
    this.timer.unref()
  }

  /** Release every loaded graph now. */
  dispose(): void {
    clearTimeout(this.timer)
    this.builtin = undefined
    this.projects.clear()
  }

  /**
   * The shipped graph, as parsed; the domain map reads paper titles and patterns from it.
   * @returns the built-in graph file.
   */
  async builtinGraph(): Promise<GraphFile> {
    this.touch()
    return (await this.loadBuiltin()).file
  }

  /**
   * One graph a project can mark: the built-in one, or the project's own.
   * @param root - the project root.
   * @param source - which graph.
   * @returns the graph file, or undefined when the project has no graph of its own.
   */
  async graphOf(root: string, source: 'ai' | 'project'): Promise<GraphFile | undefined> {
    this.touch()
    return source === 'ai' ? (await this.loadBuiltin()).file : (await this.loadProject(root))?.file
  }

  private loadBuiltin(): Promise<LoadedGraph> {
    this.builtin ??= readFile(this.builtinPath).then(bytes => index(graphSchema.parse(JSON.parse(gunzipSync(bytes).toString('utf8'))), 'ai'))
    // A failed load is retried on the next call instead of being cached.
    this.builtin.catch(() => { this.builtin = undefined })
    return this.builtin
  }

  private async loadProject(root: string): Promise<LoadedGraph | undefined> {
    const path = await projectPath(root, PROJECT_GRAPH)
    const mtime = await stat(path).then(info => info.mtimeMs, () => undefined)
    if (mtime === undefined) { this.projects.delete(root); return undefined }
    const cached = this.projects.get(root)
    if (cached?.mtime === mtime) return cached.graph
    const graph = readText(path, GRAPH_LIMIT).then(text => index(graphSchema.parse(JSON.parse(text)), 'project'))
    this.projects.set(root, { mtime, graph })
    graph.catch(() => { this.projects.delete(root) })
    return graph
  }

  private async availableGraphs(root: string): Promise<{ graphs: LoadedGraph[]; warnings: string[] }> {
    this.touch()
    const graphs: LoadedGraph[] = []
    const warnings: string[] = []
    for (const [source, load] of [
      ['ai', () => this.loadBuiltin()], ['project', () => this.loadProject(root)],
    ] as const) {
      try {
        const graph = await load()
        if (graph) graphs.push(graph)
      } catch (error) { warnings.push(`${source}: ${errorText(error)}`) }
    }
    return { graphs, warnings }
  }

  /**
   * Browse patterns and their recorded relationships without loading the complete graph into the browser.
   * @param root - the project directory.
   * @param request - source, domain, text search, selected pattern and page limits.
   * @returns a bounded graph whose node ids remain stable between searches.
   */
  async view(root: string, request: KnowledgeGraphQuery): Promise<KnowledgeGraphPage> {
    const { graphs: available, warnings } = await this.availableGraphs(root)
    const graphs = available.filter(graph => !request.source || request.source === 'all' || graph.source === request.source)
    const nodes = new Map<string, KnowledgeGraphNode>()
    const edges: KnowledgeGraphPage['edges'] = []
    const identity = (graph: LoadedGraph, kind: string, id: string): string => `${graph.source}:${kind}:${id}`
    const candidates = graphs.flatMap((graph) => {
      const scores = new Map<number, number>()
      if (request.query?.trim()) {
        const words = tokens(request.query)
        for (const hit of graph.patterns.rank(words, graph.file.patterns.length)) scores.set(hit.index, hit.score)
        for (const hit of graph.papers.rank(words, 100)) {
          const at = (graph.file.papers[hit.index] as GraphPaper).pattern
          if (at >= 0) scores.set(at, (scores.get(at) ?? 0) + hit.score)
        }
      }
      return graph.file.patterns.flatMap((pattern, at) => {
        const key = identity(graph, 'pattern', pattern.id)
        if (request.pattern && request.pattern !== key) return []
        if (request.domain && graph.file.domains[pattern.domain] !== request.domain) return []
        if (request.query?.trim() && !scores.has(at)) return []
        return [{ graph, pattern, at, key, score: scores.get(at) ?? pattern.size }]
      })
    }).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    const offset = request.offset ?? 0
    const limit = Math.max(1, Math.min(request.limit ?? 8, 12))
    for (const { graph, pattern, at, key } of candidates.slice(offset, offset + limit)) {
      const domain = graph.file.domains[pattern.domain] as string
      const domainId = identity(graph, 'domain', domain)
      nodes.set(domainId, { id: domainId, kind: 'domain', label: domain, source: graph.source, summary: '', domain })
      nodes.set(key, { id: key, kind: 'pattern', label: pattern.name, source: graph.source, domain,
        summary: [pattern.summary, pattern.details].filter(Boolean).join('\n\n'), size: pattern.size })
      edges.push({ from: key, to: domainId, kind: 'in-domain' })
      const indices = new Set(pattern.exemplars)
      if (request.pattern) graph.file.papers.forEach((paper, index) => { if (paper.pattern === at) indices.add(index) })
      for (const index of [...indices].slice(0, request.pattern ? 30 : 3)) {
        const paper = graph.file.papers[index] as GraphPaper
        const id = identity(graph, 'paper', paper.id)
        const url = paperUrl(graph.file, paper)
        nodes.set(id, { id, kind: 'paper', label: paper.title, source: graph.source,
          domain: graph.file.domains[paper.domain] as string, summary: paper.story || paper.idea,
          problem: paper.problem, solution: paper.solution, ...(url ? { url } : {}) })
        edges.push({ from: id, to: key, kind: 'uses-pattern' })
      }
    }
    for (const graph of graphs) for (const paper of graph.file.papers) {
      const from = identity(graph, 'paper', paper.id)
      if (!nodes.has(from)) continue
      for (const at of paper.similar) {
        const to = identity(graph, 'paper', (graph.file.papers[at] as GraphPaper).id)
        if (nodes.has(to) && from < to) edges.push({ from, to, kind: 'similar' })
      }
    }
    return {
      nodes: [...nodes.values()], edges, warnings,
      graphs: available.map(({ source, file }) => ({
        source, name: file.name, patterns: file.patterns.length, papers: file.papers.length,
      })),
      domains: [...new Set(graphs.flatMap(graph => graph.file.domains))].sort(),
      total: candidates.length, offset, hasMore: offset + limit < candidates.length,
    }
  }

  /**
   * What graphs there are and whether semantic ranking is available.
   * @param root - the project root.
   * @param embedding - the configured embedding model, if any.
   * @returns a summary for the agent.
   */
  async status(root: string, embedding: string | undefined): Promise<Record<string, unknown>> {
    this.touch()
    const describe = ({ file }: LoadedGraph) => ({
      name: file.name, description: file.description,
      patterns: file.patterns.length, papers: file.papers.length, domains: file.domains.length,
    })
    let builtin: Record<string, unknown>
    try { builtin = describe(await this.loadBuiltin()) } catch (error) { builtin = { error: errorText(error) } }
    let project: Record<string, unknown> | null = null
    try {
      const loaded = await this.loadProject(root)
      if (loaded) project = { path: PROJECT_GRAPH, ...describe(loaded) }
    } catch (error) { project = { path: PROJECT_GRAPH, error: errorText(error) } }
    const clusters = await readText(await projectPath(root, PROJECT_CLUSTERS), GRAPH_LIMIT)
      .then(text => clusterFileSchema.parse(JSON.parse(text)), () => undefined)
    return {
      builtin, project,
      pendingClusters: clusters && !project
        ? { path: PROJECT_CLUSTERS, clusters: clusters.clusters.length, builtAt: clusters.builtAt }
        : null,
      embedding: embedding === undefined
        ? { configured: false, note: 'Recall and novelty are lexical; add an embedding endpoint in the research settings for semantic ranking' }
        : { configured: true, model: embedding },
    }
  }

  private async patternVectors(graph: LoadedGraph, embedder: Embedder, signal: AbortSignal): Promise<Float32Array[]> {
    const cached = graph.vectors.get(embedder.model)
    if (cached) return cached
    const vectors = await embedder.embed(graph.file.patterns.map(pattern => patternText(graph.file, pattern).slice(0, 2000)), signal)
    graph.vectors.set(embedder.model, vectors)
    return vectors
  }

  /**
   * Rank the patterns and papers of every available graph for an idea.
   * @param root - the project root.
   * @param query - the idea, as an English retrieval query.
   * @param topK - how many patterns to return.
   * @param embedder - semantic ranking, when configured.
   * @param signal - cancellation.
   * @returns the ranked patterns, the closest papers and the basis.
   */
  async recall(root: string, query: string, topK: number, embedder: Embedder | undefined, signal: AbortSignal): Promise<RecallResult> {
    const { graphs, warnings } = await this.availableGraphs(root)
    const words = tokens(query)
    const rankings: string[][] = []
    const paperRankings: string[][] = []
    const matched = new Map<string, string[]>()
    let builtinPapers: RecallIndices['papers'] | undefined
    for (const graph of graphs) {
      const key = (pattern: number) => `${graph.source}:${pattern}`
      rankings.push(graph.patterns.rank(words, 60).map(hit => key(hit.index)))
      const papers = graph.papers.rank(words, 30)
      if (graph.source === 'ai') builtinPapers = papers
      paperRankings.push(papers.map(hit => `${graph.source}:${hit.index}`))
      // Graph route: the patterns of the papers the query matched, and of their nearest papers.
      const via = new Map<string, number>()
      papers.forEach((hit, rank) => {
        const paper = graph.file.papers[hit.index] as GraphPaper
        if (paper.pattern >= 0) {
          via.set(key(paper.pattern), (via.get(key(paper.pattern)) ?? 0) + 1 / (61 + rank))
          matched.set(key(paper.pattern), [...matched.get(key(paper.pattern)) ?? [], paper.title])
        }
        for (const neighbour of paper.similar) {
          const pattern = (graph.file.papers[neighbour] as GraphPaper).pattern
          if (pattern >= 0) via.set(key(pattern), (via.get(key(pattern)) ?? 0) + 0.5 / (61 + rank))
        }
      })
      rankings.push([...via].sort((a, b) => b[1] - a[1]).map(([id]) => id))
    }
    let basis: RecallResult['basis'] = 'lexical'
    let note = 'Lexical ranking (BM25 over patterns and papers, plus the papers\' graph neighbours): a match of words, not of meaning; weigh it accordingly.'
    if (graphs.length === 0) note += ' No graph is available. Continue with literature search and source-grounded judgement.'
    if (embedder && graphs.length > 0) {
      try {
        const [vector] = await embedder.embed([query], signal)
        for (const graph of graphs) {
          const vectors = await this.patternVectors(graph, embedder, signal)
          rankings.push(vectors.map((item, at) => ({ at, score: cosine(vector as Float32Array, item) }))
            .sort((a, b) => b.score - a.score).slice(0, 60).map(item => `${graph.source}:${item.at}`))
        }
        basis = 'semantic+lexical'
        note = `Semantic ranking with ${embedder.model} fused with lexical ranking by reciprocal rank.`
      } catch (error) {
        signal.throwIfAborted()
        note = `The embedding endpoint failed (${errorText(error)}); this recall is lexical only. ${note}`
      }
    }
    if (warnings.length) note += ` Unavailable graphs: ${warnings.join('; ')}.`
    const byName = new Map(graphs.map(graph => [graph.source, graph]))
    const ranked = [...fuse(rankings)].sort((a, b) => b[1] - a[1])
    const rankedPapers = [...fuse(paperRankings)].sort((a, b) => b[1] - a[1])
    const paused = !await readHonour(root)
    const marks: Awaited<ReturnType<typeof readAnnotations>> = paused ? { annotations: [], problems: [] } : await readAnnotations(root)
    if (paused) note += ' The person paused their marks, so none shaped this recall.'
    if (marks.problems.length) note += ` Marks: ${marks.problems.join('; ')}.`
    const candidate = ([key, score]: [string, number]): RecallCandidate => {
      const [source, at] = key.split(':') as [GraphSource, string]
      return { graph: source, index: Number(at), score }
    }
    // Without marks the result is exactly what it was before marks existed.
    const annotated = marks.annotations.length === 0 ? undefined : applyAnnotations({
      graphs: Object.fromEntries(graphs.map(graph => [graph.source, graph.file])),
      annotations: marks.annotations,
      patterns: ranked.map(candidate),
      papers: rankedPapers.map(candidate),
      limits: { patterns: topK, papers: 8 },
    })
    const fused: (RecallCandidate & { why?: AnnotationWhy })[] = annotated?.patterns ?? ranked.slice(0, topK).map(candidate)
    const patterns = fused.map(({ graph: source, index: at, score, why }): RecalledPattern => {
      const key = `${source}:${at}`
      const { file } = byName.get(source) as LoadedGraph
      const pattern = file.patterns[at] as GraphPattern
      return {
        graph: file.name, id: pattern.id, name: pattern.name, tier: pattern.tier, domain: file.domains[pattern.domain] as string,
        subDomains: pattern.subDomains.slice(0, 8), size: pattern.size, coherence: pattern.coherence, score: Math.round(score * 1e5) / 1e5,
        summary: pattern.summary, details: pattern.details, ideas: pattern.ideas,
        worksWellIn: pattern.works.slice(0, 3)
          .map(([domain, effectiveness, confidence]) => ({ domain: file.domains[domain] as string, effectiveness, confidence })),
        exemplars: pattern.exemplars.slice(0, 3).map((paperIndex) => {
          const paper = file.papers[paperIndex] as GraphPaper
          const url = paperUrl(file, paper)
          return { title: paper.title, story: paper.story, ...url ? { url } : {}, score: paper.score }
        }),
        matchedPapers: (matched.get(key) ?? []).slice(0, 3),
        ...why === undefined ? {} : { why },
      }
    })
    const closest: (RecallCandidate & { why?: AnnotationWhy })[] = annotated?.papers ?? rankedPapers.slice(0, 8).map(candidate)
    const closestPapers = closest.map(({ graph: source, index, why }) => ({
      ...closePaper(byName.get(source) as LoadedGraph, index), ...why === undefined ? {} : { why },
    }))
    const result: RecallResult = { basis, note, patterns, closestPapers }
    if (annotated) {
      result.annotations = { applied: describeAnnotations(annotated.summary), skipped: annotated.skipped, summary: annotated.summary }
    }
    if (builtinPapers) {
      recalledIndices.set(result, {
        papers: builtinPapers,
        patterns: ranked.flatMap(([key, score]) => key.startsWith('ai:') ? [{ index: Number(key.slice(3)), score }] : []),
      })
    }
    return result
  }

  /**
   * Compare a story with the works closest to it and write the report.
   * @param root - the project root.
   * @param storyPath - the story file, project-relative.
   * @param reportPath - where the report goes, project-relative.
   * @param embedder - semantic comparison, when configured.
   * @param signal - cancellation.
   * @param limit - byte ceiling for reading project files.
   * @param input - direct claim and reference texts when no story file is used.
   * @returns the report, as written.
   */
  async novelty(
    root: string, storyPath: string, reportPath: string, embedder: Embedder | undefined, signal: AbortSignal, limit: number,
    input?: { claim: string; references?: KnowledgeReference[] | undefined },
  ): Promise<NoveltyReport> {
    const story = input === undefined
      ? z.record(z.string(), z.unknown()).parse(JSON.parse(await readText(await projectPath(root, storyPath), limit)))
      : { innovation_claims: [input.claim] }
    const field = (value: unknown): string => typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value)
    const claims = Array.isArray(story.innovation_claims) ? story.innovation_claims.map(field) : [field(story.innovation_claims)]
    const text = [...STORY_FIELDS.map(name => field(story[name])), ...claims].filter(Boolean).join('\n')
    if (!text) throw new Error(`${storyPath} has none of the story fields (${STORY_FIELDS.join(', ')}, innovation_claims)`)
    const references: { label: string; text: string }[] = (input?.references ?? []).map(item => ({ label: item.title, text: `${item.title}\n${item.text}` }))
    const retrieved = input === undefined
      ? await readText(await projectPath(root, 'retrieved_papers.json'), limit).then(value => JSON.parse(value) as unknown, () => undefined)
      : undefined
    const listed = Array.isArray(retrieved) ? retrieved : (retrieved as { papers?: unknown } | undefined)?.papers
    for (const item of Array.isArray(listed) ? listed as Record<string, unknown>[] : []) {
      const abstract = typeof item.abstract === 'string' ? item.abstract.trim() : ''
      if (!abstract || item.abstract_source === 'missing') continue
      references.push({ label: field(item.title) || field(item.paper_id) || '(untitled)', text: `${field(item.title)}\n${abstract}` })
    }
    const { graphs, warnings } = await this.availableGraphs(root)
    const words = tokens(text)
    for (const graph of graphs) {
      for (const hit of graph.papers.rank(words, 8)) {
        const paper = graph.file.papers[hit.index] as GraphPaper
        references.push({ label: `${paper.title} (graph ${graph.file.name})`, text: paperText(paper) })
      }
    }
    const base = { ok: true as const, threshold_high: NOVELTY_HIGH, threshold_medium: NOVELTY_MEDIUM, max_pivots: 2 as const }
    let report: NoveltyReport | undefined
    if (embedder && references.length > 0) {
      try {
        const inputs = [text, ...references.map(item => item.text)].map(item => item.slice(0, 6000))
        const [storyVector, ...vectors] = await embedder.embed(inputs, signal)
        const scored = references
          .map((item, at) => ({ ref: item.label, similarity: cosine(storyVector as Float32Array, vectors[at] as Float32Array) }))
          .sort((a, b) => b.similarity - a.similarity)
        const top = (scored[0] as { similarity: number }).similarity
        const risk = top >= NOVELTY_HIGH ? 'high' : top >= NOVELTY_MEDIUM ? 'medium' : 'low'
        report = {
          ...base, basis: `semantic (${embedder.model}) against reference texts and the closest graph papers`,
          max_similarity: round(top), risk_level: risk,
          top_similar: scored.slice(0, 5).map(item => ({ ...item, similarity: round(item.similarity) })),
          verdict: risk === 'high'
            ? `High collision (${round(top)} ≥ ${NOVELTY_HIGH}): pivot to a more differentiating reserved pattern and re-tell the story (at most 2 pivots).`
            : risk === 'medium' ? `Medium similarity (${round(top)} ≥ ${NOVELTY_MEDIUM}): sharpen the differentiating angle.` : `Low collision (${round(top)}): the novelty signal is acceptable.`,
        }
      } catch (error) {
        signal.throwIfAborted()
        report = lexicalReport(base, text, references, `The embedding endpoint failed (${errorText(error)}). `)
      }
    }
    report ??= lexicalReport(base, text, references, '')
    if (warnings.length) report.note = `${report.note ?? ''} Unavailable graphs: ${warnings.join('; ')}.`.trim()
    signal.throwIfAborted()
    await atomicWrite(await projectPath(root, reportPath), `${JSON.stringify(report, null, 1)}\n`)
    return report
  }

  /**
   * Cluster an extracted corpus into candidate patterns.
   * @param root - the project root.
   * @param papersPath - the corpus as JSON lines, project-relative.
   * @param domain - the corpus's domain label.
   * @param embedder - embeddings for clustering, when configured; term weights otherwise.
   * @param signal - cancellation.
   * @returns each cluster with its exemplars, and the lines that were rejected.
   */
  async build(root: string, papersPath: string, domain: string, embedder: Embedder | undefined, signal: AbortSignal): Promise<BuildResult> {
    const lines = (await readText(await projectPath(root, papersPath), GRAPH_LIMIT)).split(/\r?\n/)
    const papers: CorpusPaper[] = []
    const rejected: string[] = []
    const seen = new Set<string>()
    lines.forEach((line, at) => {
      if (!line.trim()) return
      let parsed: ReturnType<typeof corpusSchema.safeParse>
      try { parsed = corpusSchema.safeParse(JSON.parse(line)) } catch { rejected.push(`line ${at + 1}: not JSON`); return }
      if (!parsed.success) { rejected.push(`line ${at + 1}: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`); return }
      if (seen.has(parsed.data.paper_id)) { rejected.push(`line ${at + 1}: duplicate paper_id ${parsed.data.paper_id}`); return }
      seen.add(parsed.data.paper_id)
      papers.push({ ...parsed.data, domain: parsed.data.domain ?? domain })
    })
    if (papers.length < 3) throw new Error(`build-graph needs at least 3 extracted papers; ${papersPath} has ${papers.length}${rejected.length ? ` (rejected: ${rejected.slice(0, 5).join(' | ')})` : ''}`)
    if (papers.length > MAX_CORPUS) throw new Error(`build-graph takes at most ${MAX_CORPUS} papers; ${papersPath} has ${papers.length}`)
    // Story-first text: clustering on the reframe groups transferable angles, not topics.
    const texts = papers.map(paper => `${paper.story} ${paper.base_problem} ${paper.solution_pattern}`)
    let vectors: Vector[]
    let basis: ClusterFile['basis'] = 'terms'
    let note = ''
    if (embedder) {
      try { vectors = await embedder.embed(texts, signal); basis = 'embedding' } catch (error) {
        signal.throwIfAborted()
        note = `The embedding endpoint failed (${errorText(error)}); clustered on term weights instead. `
        vectors = termVectors(texts.map(tokens))
      }
    } else vectors = termVectors(texts.map(tokens))
    const n = papers.length
    const similarity = similarityMatrix(vectors)
    const labels = basis === 'embedding'
      ? agglomerate(similarity, n, CLUSTER_THRESHOLD)
      : kMeans(vectors as ReturnType<typeof termVectors>, Math.max(2, Math.min(Math.floor(Math.sqrt(n / 2)) + 1, n - 1)))
    const clusters: ClusterFile['clusters'] = []
    for (const label of [...new Set(labels)]) {
      const members = labels.flatMap((value, at) => value === label ? [at] : [])
      if (members.length < 2) continue
      // Membership: mean similarity to the other members, the centroid cosine without the centroid.
      const others = (i: number): number => members.reduce((sum, j) => sum + (i === j ? 0 : similarity[i * n + j] as number), 0)
      const membership = members.map(i => others(i) / (members.length - 1))
      const order = members.map((member, at) => ({ member, score: membership[at] as number })).sort((a, b) => b.score - a.score)
      clusters.push({
        id: '', members, membership: membership.map(round),
        coherence: round(membership.reduce((sum, value) => sum + value, 0) / members.length),
        exemplars: order.slice(0, 5).map(item => item.member),
      })
    }
    clusters.sort((a, b) => b.members.length - a.members.length || b.coherence - a.coherence)
    clusters.forEach((cluster, at) => { cluster.id = `c${at}` })
    const withNeighbours = papers.map((paper, i) => ({
      ...paper,
      similar: Array.from({ length: n }, (_, j) => j).filter(j => j !== i)
        .sort((a, b) => (similarity[i * n + b] as number) - (similarity[i * n + a] as number)).slice(0, 5),
    }))
    const file: ClusterFile = {
      version: 1, domain, basis, ...basis === 'embedding' ? { model: (embedder as Embedder).model } : {},
      builtAt: new Date().toISOString(), papers: withNeighbours, clusters,
    }
    signal.throwIfAborted()
    await atomicWrite(await projectPath(root, PROJECT_CLUSTERS), JSON.stringify(file))
    const clustered = new Set(clusters.flatMap(cluster => cluster.members))
    return {
      basis, note: `${note}${basis === 'embedding' ? `Average-linkage clusters of ${(embedder as Embedder).model} embeddings (cosine distance ≤ ${CLUSTER_THRESHOLD}).` : 'k-means clusters of term-weight vectors: grouped by shared words, not by meaning.'}`,
      papers: n, rejected, unclustered: n - clustered.size, saved: PROJECT_CLUSTERS,
      clusters: clusters.map(cluster => ({
        id: cluster.id, size: cluster.members.length, coherence: cluster.coherence,
        exemplars: cluster.exemplars.map((at) => {
          const paper = papers[at] as CorpusPaper
          const { paper_id, title, story, base_problem, solution_pattern } = paper
          return { paper_id, title, story, base_problem, solution_pattern }
        }),
      })),
      next: 'Name each cluster from its exemplars in cluster_meta.json ({cluster_id: {name, summary, llm_enhanced_summary, tier}}), then run name-patterns.',
    }
  }

  /**
   * Assemble the project graph from the clusters and their names, and validate it.
   * @param root - the project root.
   * @param namesPath - the cluster names file, project-relative.
   * @param limit - byte ceiling for reading the names file.
   * @param signal - cancellation before publishing the project graph.
   * @returns the graph's counts and every problem found; the graph is written either way.
   */
  async namePatterns(root: string, namesPath: string, limit: number, signal?: AbortSignal): Promise<NameResult> {
    const clusterText = await readText(await projectPath(root, PROJECT_CLUSTERS), GRAPH_LIMIT).catch(() => {
      throw new Error('No clusters yet: run build-graph on the extracted corpus first')
    })
    const clusters = clusterFileSchema.parse(JSON.parse(clusterText))
    const names = namesSchema.parse(JSON.parse(await readText(await projectPath(root, namesPath), limit)))
    const issues: string[] = []
    for (const id of Object.keys(names)) if (!clusters.clusters.some(cluster => cluster.id === id)) issues.push(`${namesPath} names ${id}, which is not a cluster`)
    const domains = [...new Set([clusters.domain, ...clusters.papers.map(paper => paper.domain)])]
    const quality = (member: number): number => (clusters.papers[member] as CorpusPaper).review_score ?? 0.7
    const patternOf = new Map<number, number>()
    const patterns = clusters.clusters.map((cluster, at): GraphPattern => {
      const meta = names[cluster.id] ?? {}
      const name = meta.name?.trim() ?? ''
      const summary = meta.summary?.trim() ?? ''
      if (!name) issues.push(`${cluster.id}: no name`)
      else {
        const words = name.split(/\s+/)
        if (words.length < 3 || words.length > 6) issues.push(`${cluster.id}: "${name}" should be a 3–6 word story angle`)
        const banned = BANNED_NAME_WORDS.filter(word => words.some(item => item.toLowerCase().replace(/[^a-z-]/g, '') === word))
        if (banned.length) issues.push(`${cluster.id}: "${name}" uses generic words (${banned.join(', ')}): name the angle, not the architecture`)
      }
      if (!summary) issues.push(`${cluster.id}: no summary`)
      const tier = tierSchema.safeParse(meta.tier ?? '')
      if (!tier.success || tier.data === '') issues.push(`${cluster.id}: tier must be A, B or C`)
      for (const member of cluster.members) patternOf.set(member, at)
      const members = cluster.members.map(member => clusters.papers[member] as ClusterFile['papers'][number])
      const counts = new Map<string, number>()
      for (const paper of members) counts.set(paper.domain, (counts.get(paper.domain) ?? 0) + 1)
      const [domain] = [...counts].sort((a, b) => b[1] - a[1])[0] as [string, number]
      return {
        id: `pattern_${at}`, name: name || `pattern ${at}`, domain: domains.indexOf(domain),
        subDomains: [...new Set(members.flatMap(paper => paper.sub_domains))].sort().slice(0, 12),
        size: members.length, coherence: cluster.coherence, tier: tier.success ? tier.data : '',
        summary, details: meta.llm_enhanced_summary?.trim() || summary,
        ideas: cluster.exemplars.slice(0, 3).map((member) => {
          const paper = clusters.papers[member] as CorpusPaper
          return paper.idea ?? paper.story
        }),
        exemplars: cluster.exemplars, works: [],
      }
    })
    // works_well_in: a pattern's mean quality minus its domain's, with confidence growing to 1 at 20 papers (upstream kg_build.py).
    const scores = clusters.clusters.map(cluster => cluster.members.map(quality))
    const byDomain = new Map<number, number[]>()
    patterns.forEach((pattern, at) => { byDomain.set(pattern.domain, [...byDomain.get(pattern.domain) ?? [], ...scores[at] as number[]]) })
    const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length
    patterns.forEach((pattern, at) => {
      const own = scores[at] as number[]
      const lift = mean(own) - mean(byDomain.get(pattern.domain) as number[])
      pattern.works = [[pattern.domain, round(lift), round(Math.min(own.length / 20, 1))]]
    })
    const graph: GraphFile = {
      version: 1, name: 'project', description: `Research patterns built in this project from ${clusters.papers.length} papers (${clusters.domain}; ${clusters.model ? `embeddings: ${clusters.model}` : 'term weights'}).`,
      domains,
      patterns,
      papers: clusters.papers.map((paper, at): GraphPaper => {
        const url = paper.url ?? (paper.doi ? `https://doi.org/${paper.doi}` : undefined)
        return {
          id: paper.paper_id, title: paper.title, pattern: patternOf.get(at) ?? -1, domain: domains.indexOf(paper.domain),
          idea: paper.idea ?? '', problem: paper.base_problem, solution: paper.solution_pattern, story: paper.story,
          score: paper.review_score ?? null, similar: paper.similar, ...url ? { url } : {},
        }
      }),
    }
    signal?.throwIfAborted()
    await atomicWrite(await projectPath(root, PROJECT_GRAPH), JSON.stringify(graph))
    const tiers = Object.fromEntries(['A', 'B', 'C', ''].map(tier => [tier || 'none', patterns.filter(pattern => pattern.tier === tier).length]))
    return {
      valid: issues.length === 0, saved: PROJECT_GRAPH, tiers, issues,
      patterns: patterns.length, papers: graph.papers.length, domains: domains.length,
      next: issues.length ? 'Fix the names in the names file and run name-patterns again.' : 'recall and novelty now read this graph beside the built-in one.',
    }
  }
}

function closePaper(graph: LoadedGraph, at: number): ClosePaper {
  const paper = graph.file.papers[at] as GraphPaper
  const url = paperUrl(graph.file, paper)
  return {
    graph: graph.file.name, id: paper.id, title: paper.title, idea: paper.idea, story: paper.story,
    pattern: graph.file.patterns[paper.pattern]?.name ?? null, ...url ? { url } : {}, score: paper.score,
  }
}

function round(value: number): number { return Math.round(value * 1e4) / 1e4 }

/** The degraded report: term-weight similarity, with the risk left to the agent's judgement. */
function lexicalReport(
  base: Pick<NoveltyReport, 'ok' | 'threshold_high' | 'threshold_medium' | 'max_pivots'>, text: string, references: { label: string; text: string }[], prefix: string,
): NoveltyReport {
  if (references.length === 0) {
    return {
      ...base, basis: 'unconfigured', max_similarity: null, risk_level: 'unknown', top_similar: [],
      verdict: 'lexical/judgment only — not a semantic guarantee',
      note: `${prefix}No reference set: no supplied reference has usable text and no graph paper shares its words; judge novelty against verified literature.`,
    }
  }
  const [storyVector, ...vectors] = termVectors([text, ...references.map(item => item.text)].map(tokens))
  const scored = references
    .map((item, at) => ({ ref: item.label, similarity: round(cosine(storyVector as Vector, vectors[at] as Vector)) }))
    .sort((a, b) => b.similarity - a.similarity)
  return {
    ...base, basis: 'lexical (term-weight cosine) against reference texts and the closest graph papers',
    max_similarity: (scored[0] as { similarity: number }).similarity, risk_level: 'unknown', top_similar: scored.slice(0, 5),
    verdict: 'lexical/judgment only — not a semantic guarantee',
    note: `${prefix}Shared words are not shared ideas, and the ${NOVELTY_HIGH}/${NOVELTY_MEDIUM} bands apply to embeddings only: read the closest works and judge the collision yourself.`,
  }
}
