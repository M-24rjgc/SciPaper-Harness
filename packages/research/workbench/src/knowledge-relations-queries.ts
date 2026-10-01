/**
 * Queries over a project's relation graph, as the person's view and the agent
 * read it: the neighbourhood of one node, the best explained paths between two
 * nodes, and the gap matrix of methods against tasks, datasets or settings.
 * Every query reads the derived view (relationGraph), so rejected relations
 * never appear and stale ones are marked and weigh less. The gap matrix is
 * about the project's own sources, never the field; the wording that keeps it
 * honest is in the Agent Note
 * .agents/notes/proposed/feature/2026-10-01-knowledge-graph-relations.md.
 */
import {
  describeLocator, findMentions, nameKey, settingKey, settingKeys, tokenize, type EntityKind, type RelationKind,
} from './knowledge-relations-grounding.ts'
import {
  RELATION_TUNING, entityKeys, groundSetting, sourceKey,
  type Author, type Decision, type EntityView, type GroundSource, type GroundView, type RelationGraphView, type RelationTuning,
  type RelationView,
} from './knowledge-relations.ts'
import type { EvidenceChunk, ResearchProject, SourceLocator } from './types.ts'

/** Longest quotation a query result carries; the full text stays in the stored ground. */
export const SUMMARY_QUOTE_LENGTH = 200
/** Most nodes a neighbourhood returns. */
export const MAX_NEIGHBOURHOOD = 80
/** Most paths one path query returns. */
export const MAX_PATHS = 5
/** Most hops of one path. */
export const MAX_HOPS = 6
/** Most rows or columns of a gap matrix. */
export const MAX_GAP_AXIS = 30

/** One ground as a query reports it: what it rests on and, for a quotation, where and what. */
export interface GroundSummary {
  id: string
  type: 'quote' | 'run' | 'citation'
  source: GroundSource
  status: GroundView['status']
  /** The evidence record's title, the run's name and seed, or the citing paper. */
  title: string
  evidenceId?: string | undefined
  locator?: SourceLocator | undefined
  /** The quotation, cut to {@link SUMMARY_QUOTE_LENGTH} characters. */
  quote?: string | undefined
  runId?: string | undefined
  setting?: string | undefined
  /** Who recorded a quotation or run ground; absent for a citation, which a provider's record carries. */
  by?: Author | undefined
  /** Who rejected the ground, when, and why; present only when its status is `rejected`. */
  rejection?: Decision | undefined
}

function summary(view: GroundView): GroundSummary {
  const { ground } = view
  const base = {
    id: ground.id, type: ground.type, source: view.source, status: view.status, title: view.title,
    ...ground.rejected === undefined ? {} : { rejection: ground.rejected },
  }
  if (ground.type === 'citation') return base
  const setting = ground.setting === undefined ? {} : { setting: ground.setting }
  if (ground.type === 'run') return { ...base, runId: ground.runId, evidenceId: ground.evidenceId, by: ground.by, ...setting }
  const quote = ground.quote.length > SUMMARY_QUOTE_LENGTH ? `${ground.quote.slice(0, SUMMARY_QUOTE_LENGTH - 1)}…` : ground.quote
  return { ...base, evidenceId: ground.evidenceId, locator: ground.locator, quote, by: ground.by, ...setting }
}

/** The weightiest grounds of a relation that are not rejected, current ones first. */
function bestGrounds(view: RelationView, count: number): GroundSummary[] {
  return view.grounds.filter(item => item.status !== 'rejected')
    .sort((a, b) => b.weight - a.weight || byText(a.ground.id, b.ground.id)).slice(0, count).map(summary)
}

/** Every ground of a relation, rejected ones last, so that a view can offer to restore them. */
function allGrounds(view: RelationView): GroundSummary[] {
  return [...view.grounds].sort((a, b) => b.weight - a.weight || byText(a.ground.id, b.ground.id)).map(summary)
}

/** Code-unit order of two ids, so results do not depend on the runtime's locale. */
function byText(a: string, b: string): number { return Number(a > b) - Number(a < b) }

/** Relations a query may walk: not rejected, stale only when asked, of the given kinds. */
function usable(graph: RelationGraphView, includeStale: boolean, kinds: readonly RelationKind[] | undefined): RelationView[] {
  return [...graph.relations.values()].filter(view => view.status === 'active' || (includeStale && view.status === 'stale'))
    .filter(view => kinds === undefined || kinds.includes(view.relation.kind))
}

/** An undirected simple graph over usable relations: per neighbour, the strongest relation between the two and the others. */
type Adjacency = Map<string, Map<string, RelationView[]>>

function adjacency(relations: readonly RelationView[]): Adjacency {
  const graph: Adjacency = new Map()
  const link = (a: string, b: string, view: RelationView): void => {
    const row = graph.get(a) ?? new Map<string, RelationView[]>()
    graph.set(a, row)
    row.set(b, [...row.get(b) ?? [], view])
  }
  for (const view of relations) {
    link(view.relation.from, view.relation.to, view)
    link(view.relation.to, view.relation.from, view)
  }
  for (const row of graph.values()) {
    for (const list of row.values()) list.sort((x, y) => y.confidence - x.confidence || byText(x.relation.id, y.relation.id))
  }
  return graph
}

/** The confidence of the strongest relation between two adjacent nodes. */
function strength(graph: Adjacency, a: string, b: string): number {
  return (((graph.get(a) as Map<string, RelationView[]>).get(b) as RelationView[])[0] as RelationView).confidence
}

// ── Neighbourhood ───────────────────────────────────────────────────────────

/** The neighbourhood to return. */
export interface NeighbourhoodRequest {
  center: string
  /** 1 or 2; 2 when absent. */
  depth?: 1 | 2 | undefined
  /** At most {@link MAX_NEIGHBOURHOOD}; 40 when absent. */
  maxNodes?: number | undefined
  /** Stale relations are shown, marked, unless this is false. */
  includeStale?: boolean | undefined
  kinds?: readonly RelationKind[] | undefined
}

/** A node of a neighbourhood with its layout hint. */
export interface NeighbourhoodNode {
  id: string
  kind: EntityKind
  name: string
  aliases: string[]
  status: EntityView['status']
  /** 0 for the centre, 1 for its neighbours, 2 for theirs. */
  ring: 0 | 1 | 2
  /**
   * The centre and the nodes of the densest group around it: those whose
   * k-core number in the returned subgraph is the largest, when that is at
   * least 2. A view draws them nearest the centre.
   */
  core: boolean
  /** For ring 2: the ring-1 node it is most strongly reached through. */
  parent?: string | undefined
  /** Place around its ring: ring 1 ordered by kind, strength and name; ring 2 by its parent's place, kind, strength and name. */
  slot: number
  /** Relations it has in the whole graph that are not rejected. */
  degree: number
  /** A paper's literature records. */
  evidenceIds?: string[] | undefined
}

/** A relation of a neighbourhood. */
export interface NeighbourhoodEdge {
  id: string
  kind: RelationKind
  from: string
  to: string
  status: 'active' | 'stale'
  confidence: number
  /** Grounds that are not rejected, counted by where they come from. */
  sources: Record<GroundSource, number>
  /** Its weightiest ground. */
  best: GroundSummary
  /** Every ground, the heaviest first and the rejected ones last. */
  grounds: GroundSummary[]
  /** Who first recorded the relation. */
  by: Author
}

/** The neighbourhood of one node. */
export interface Neighbourhood {
  center: string
  nodes: NeighbourhoodNode[]
  edges: NeighbourhoodEdge[]
  /** What the size limits left out. */
  omitted: { nodes: number; edges: number }
}

const KIND_ORDER: Record<EntityKind, number> = { method: 0, task: 1, dataset: 2, metric: 3, paper: 4 }

/** The k-core number of every node of an undirected simple graph (Batagelj and Zaversnik's peeling). */
function coreNumbers(nodes: readonly string[], neighbours: (node: string) => string[]): Map<string, number> {
  const degree = new Map(nodes.map(node => [node, neighbours(node).length]))
  const core = new Map<string, number>()
  const left = new Set(nodes)
  let k = 0
  while (left.size > 0) {
    const next = [...left].sort((a, b) => (degree.get(a) as number) - (degree.get(b) as number) || (a < b ? -1 : 1))[0] as string
    k = Math.max(k, degree.get(next) as number)
    core.set(next, k)
    left.delete(next)
    for (const other of neighbours(next)) if (left.has(other)) degree.set(other, (degree.get(other) as number) - 1)
  }
  return core
}

function groundCounts(view: RelationView): Record<GroundSource, number> {
  const counts: Record<GroundSource, number> = { 'full-text': 0, 'abstract': 0, 'file': 0, 'run': 0, 'citation': 0 }
  for (const item of view.grounds) if (item.status !== 'rejected') counts[item.source]++
  return counts
}

function edgeOf(view: RelationView): NeighbourhoodEdge {
  const { relation } = view
  return {
    id: relation.id, kind: relation.kind, from: relation.from, to: relation.to, status: view.status === 'stale' ? 'stale' : 'active',
    confidence: view.confidence, sources: groundCounts(view), best: bestGrounds(view, 1)[0] as GroundSummary, grounds: allGrounds(view),
    by: relation.by,
  }
}

/**
 * The neighbourhood of a node to depth 1 or 2. Its neighbours come first,
 * strongest relation first; then, at depth 2, their neighbours ranked by the
 * strength with which the centre reaches them, the sum over ring-1 nodes of
 * the product of the two relations' confidences. The node limit cuts ring 2
 * before ring 1. Edges are every usable relation among the returned nodes, the
 * most confident first, at most four per node. The layout hint gives each node
 * its ring, its place around the ring and, for ring 2, the ring-1 node it hangs
 * from, so a view draws the same picture for the same graph; `core` marks the
 * densest group.
 * @param graph - the derived view.
 * @param request - the centre, depth, limit and filters.
 * @returns the nodes and edges, or undefined when the centre is not an entity.
 */
export function neighbourhood(graph: RelationGraphView, request: NeighbourhoodRequest): Neighbourhood | undefined {
  const center = graph.entities.get(request.center)
  if (center === undefined) return undefined
  const maxNodes = Math.max(1, Math.min(MAX_NEIGHBOURHOOD, Math.floor(request.maxNodes ?? 40)))
  const relations = usable(graph, request.includeStale ?? true, request.kinds)
  const adjacent = adjacency(relations)
  const near = (node: string): string[] => [...adjacent.get(node)?.keys() ?? []]
  const id = center.entity.id
  const ring1 = near(id).sort((a, b) => strength(adjacent, id, b) - strength(adjacent, id, a) || byText(a, b))
  const reach = new Map<string, { score: number; parent: string; best: number }>()
  if ((request.depth ?? 2) === 2) {
    const inner = new Set([id, ...ring1])
    for (const middle of ring1) {
      const first = strength(adjacent, id, middle)
      for (const outer of near(middle)) {
        if (inner.has(outer)) continue
        const through = first * strength(adjacent, middle, outer)
        const entry = reach.get(outer) ?? { score: 0, parent: middle, best: -1 }
        entry.score += through
        if (through > entry.best) { entry.best = through; entry.parent = middle }
        reach.set(outer, entry)
      }
    }
  }
  const scoreOf = (node: string): number => (reach.get(node) as { score: number }).score
  const ring2 = [...reach.keys()].sort((a, b) => scoreOf(b) - scoreOf(a) || byText(a, b))
  const kept = [id, ...ring1, ...ring2].slice(0, maxNodes)
  const keptSet = new Set(kept)
  const edges = relations.filter(view => keptSet.has(view.relation.from) && keptSet.has(view.relation.to))
    .sort((a, b) => b.confidence - a.confidence || byText(a.relation.id, b.relation.id))
  const shownEdges = edges.slice(0, maxNodes * 4)
  const cores = coreNumbers(kept, node => near(node).filter(other => keptSet.has(other)))
  const top = Math.max(...cores.values())
  const entity = (node: string): EntityView => graph.entities.get(node) as EntityView
  const kindOf = (node: string): number => KIND_ORDER[entity(node).entity.kind]
  const order = (a: string, b: string, score: (node: string) => number): number =>
    kindOf(a) - kindOf(b) || score(b) - score(a) || byText(a, b)
  const ring1Kept = ring1.filter(node => keptSet.has(node)).sort((a, b) => order(a, b, node => strength(adjacent, id, node)))
  const slots = new Map(ring1Kept.map((node, slot) => [node, slot]))
  const ring2Kept = ring2.filter(node => keptSet.has(node)).sort((a, b) => {
    const parent = (node: string): number => slots.get((reach.get(node) as { parent: string }).parent) as number
    return parent(a) - parent(b) || order(a, b, scoreOf)
  })
  ring2Kept.forEach((node, slot) => slots.set(node, slot))
  const degree = (node: string): number => (graph.touching.get(node) ?? []).filter(view => view.status !== 'rejected').length
  const nodes = [id, ...ring1Kept, ...ring2Kept].map((node): NeighbourhoodNode => {
    const { entity: item, status } = entity(node)
    const ring = node === id ? 0 : ring1Kept.includes(node) ? 1 : 2
    return {
      id: node, kind: item.kind, name: item.name, aliases: item.aliases, status, ring,
      core: node === id || (top >= 2 && cores.get(node) === top), slot: node === id ? 0 : slots.get(node) as number, degree: degree(node),
      ...ring === 2 ? { parent: reach.get(node)?.parent } : {}, ...item.evidenceIds === undefined ? {} : { evidenceIds: item.evidenceIds },
    }
  })
  return {
    center: id, nodes, edges: shownEdges.map(edgeOf),
    omitted: { nodes: ring1.length + ring2.length + 1 - kept.length, edges: edges.length - shownEdges.length },
  }
}

/**
 * A neighbourhood as the agent reads it: one line per relation with the
 * source of its weightiest ground, without quotations, which the agent reads
 * by relation when it needs them.
 * @param view - a neighbourhood.
 * @returns the description.
 */
export function describeNeighbourhood(view: Neighbourhood): string {
  const names = new Map(view.nodes.map(node => [node.id, `${node.name} (${node.kind})`]))
  const lines = view.edges.map(edge => `${names.get(edge.from) as string} —${edge.kind}→ ${names.get(edge.to) as string}`
    + `${edge.status === 'stale' ? ' [stale]' : ''}, ${edge.confidence}, ${edge.best.title} [${edge.id}]`)
  const omitted = view.omitted.nodes + view.omitted.edges > 0 ? ` (${view.omitted.nodes} nodes and ${view.omitted.edges} relations not shown)` : ''
  return [`${view.nodes.length} nodes around ${names.get(view.center) as string}${omitted}:`, ...lines].join('\n')
}

// ── Paths ───────────────────────────────────────────────────────────────────

/** The paths to find between two nodes. */
export interface PathRequest {
  from: string
  to: string
  /** At most {@link MAX_PATHS}; 3 when absent. */
  k?: number | undefined
  /** At most {@link MAX_HOPS}; 4 when absent. */
  maxHops?: number | undefined
  /** Stale relations may be walked, at their lower confidence, unless this is false. */
  includeStale?: boolean | undefined
  kinds?: readonly RelationKind[] | undefined
}

/** One hop of a path, read in the direction the path walks it. */
export interface PathHop {
  relation: string
  kind: RelationKind
  /** The relation's own ends; `direction` says whether the path walks it from `from` to `to`. */
  from: string
  to: string
  direction: 'forward' | 'backward'
  status: 'active' | 'stale'
  confidence: number
  /** Its two weightiest grounds. */
  grounds: GroundSummary[]
  /** Other relations between the same two nodes. */
  parallel: { relation: string; kind: RelationKind }[]
}

/** A path between two nodes with the grounds of every hop. */
export interface RelationPath {
  nodes: string[]
  hops: PathHop[]
  /** Σ (hop cost − ln confidence); lower is better. */
  cost: number
  /** Π confidence of its hops. */
  confidence: number
  /** Some hop is stale. */
  stale: boolean
}

/** The paths found, or why there are none. */
export interface PathResult {
  from: string
  to: string
  paths: RelationPath[]
  /** `unknown-node`: an end is not an entity; `same-node`: the ends are one node; `no-path`: nothing joins them within the hop limit. */
  none?: 'unknown-node' | 'same-node' | 'no-path' | undefined
}

/**
 * The cheapest walk from `source` to `target` of at most `hops` edges, avoiding
 * the given nodes and edges; it is a simple path because every cost is positive.
 */
function cheapest(
  adjacent: Adjacency, cost: (a: string, b: string) => number, source: string, target: string, hops: number,
  blockedNodes: ReadonlySet<string>, blockedEdges: ReadonlySet<string>,
): { nodes: string[]; cost: number } | undefined {
  // After round h, `reached` holds each node's cheapest walk of at most h hops; `rounds[h - 1]` names the node a walk improved in
  // round h came from, and a node absent from it kept its walk of round h - 1.
  let reached = new Map<string, number>([[source, 0]])
  const rounds: Map<string, string>[] = []
  for (let round = 0; round < hops; round++) {
    const next = new Map(reached)
    const previous = new Map<string, string>()
    for (const [node, distance] of reached) {
      for (const other of adjacent.get(node)?.keys() ?? []) {
        if (blockedNodes.has(other) || blockedEdges.has(`${node}|${other}`)) continue
        const candidate = distance + cost(node, other)
        const known = next.get(other)
        const tie = candidate === known && previous.has(other) && node < (previous.get(other) as string)
        if (known === undefined || candidate < known || tie) {
          next.set(other, candidate)
          previous.set(other, node)
        }
      }
    }
    rounds.push(previous)
    reached = next
  }
  const total = reached.get(target)
  if (total === undefined) return undefined
  const nodes = [target]
  let node = target
  for (let round = rounds.length - 1; round >= 0 && node !== source; round--) {
    const step = (rounds[round] as Map<string, string>).get(node)
    if (step !== undefined) { node = step; nodes.unshift(node) }
  }
  return { nodes, cost: total }
}

/**
 * The best explained paths between two nodes: Yen's k shortest loopless paths
 * over the undirected graph of usable relations, each pair of nodes joined by
 * its most confident relation, with the hop-limited cheapest walk (a
 * Bellman–Ford pass per hop) as the spur search. A hop costs the tuning's hop
 * cost minus the logarithm of its relation's confidence, so the best path is
 * the one whose hops most probably all hold, slightly preferring fewer hops; a
 * citation hop (0.5) costs 0.94 against 0.36 for a hop quoted from full text
 * (0.9), and a stale relation weighs half. Rejected relations are never walked.
 * Equal walks are taken by node id and equal candidates in the order the search found them, so the answer is the same for the
 * same graph.
 * @param graph - the derived view.
 * @param request - the two ends, the number of paths, the hop limit and filters.
 * @param tuning - the hop cost; production callers pass none.
 * @returns up to k paths, best first, each hop with its grounds.
 */
export function relationPaths(graph: RelationGraphView, request: PathRequest, tuning: RelationTuning = RELATION_TUNING): PathResult {
  const from = graph.entities.get(request.from)?.entity.id, to = graph.entities.get(request.to)?.entity.id
  const result = { from: from ?? request.from, to: to ?? request.to }
  if (from === undefined || to === undefined) return { ...result, paths: [], none: 'unknown-node' }
  if (from === to) return { ...result, paths: [], none: 'same-node' }
  const k = Math.max(1, Math.min(MAX_PATHS, Math.floor(request.k ?? 3)))
  const maxHops = Math.max(1, Math.min(MAX_HOPS, Math.floor(request.maxHops ?? 4)))
  const adjacent = adjacency(usable(graph, request.includeStale ?? true, request.kinds))
  const cost = (a: string, b: string): number => tuning.hop - Math.log(Math.max(strength(adjacent, a, b), 1e-6))
  const pathCost = (nodes: readonly string[]): number => nodes.slice(1).reduce((sum, node, i) => sum + cost(nodes[i] as string, node), 0)
  const first = cheapest(adjacent, cost, from, to, maxHops, new Set(), new Set())
  if (first === undefined) return { ...result, paths: [], none: 'no-path' }
  const found: string[][] = [first.nodes]
  const candidates = new Map<string, { nodes: string[]; cost: number }>()
  while (found.length < k) {
    const last = found.at(-1) as string[]
    for (let i = 0; i < last.length - 1; i++) {
      const root = last.slice(0, i + 1)
      const blockedEdges = new Set<string>()
      for (const path of found) {
        if (path.length > i + 1 && root.every((node, j) => path[j] === node)) {
          blockedEdges.add(`${path[i] as string}|${path[i + 1] as string}`)
          blockedEdges.add(`${path[i + 1] as string}|${path[i] as string}`)
        }
      }
      const spur = cheapest(adjacent, cost, last[i] as string, to, maxHops - i, new Set(root.slice(0, -1)), blockedEdges)
      if (spur === undefined) continue
      const nodes = [...root.slice(0, -1), ...spur.nodes]
      // The blocked edges keep a spur from repeating a path found before, so every candidate is new.
      candidates.set(nodes.join('>'), { nodes, cost: pathCost(nodes) })
    }
    // The cheapest candidate; of equal ones, the first found. The search order depends only on the graph.
    const entries = [...candidates.entries()]
    if (entries.length === 0) break
    const best = entries.reduce((cheapest, entry) => entry[1].cost < cheapest[1].cost ? entry : cheapest)
    candidates.delete(best[0])
    found.push(best[1].nodes)
  }
  const paths = found.map((nodes): RelationPath => {
    const hops = nodes.slice(1).map((node, i): PathHop => {
      const previous = nodes[i] as string
      const [view, ...others] = adjacent.get(previous)?.get(node) as RelationView[]
      const { relation } = view as RelationView
      return {
        relation: relation.id, kind: relation.kind, from: relation.from, to: relation.to,
        direction: relation.from === previous ? 'forward' : 'backward', status: (view as RelationView).status === 'stale' ? 'stale' : 'active',
        confidence: (view as RelationView).confidence, grounds: bestGrounds(view as RelationView, 2),
        parallel: others.map(other => ({ relation: other.relation.id, kind: other.relation.kind })),
      }
    })
    return {
      nodes, hops, cost: Math.round(pathCost(nodes) * 1000) / 1000, stale: hops.some(hop => hop.status === 'stale'),
      confidence: Math.round(hops.reduce((product, hop) => product * hop.confidence, 1) * 1000) / 1000,
    }
  })
  return { ...result, paths }
}

/**
 * A path as the agent reads it: one line per hop with the ground that carries it.
 * @param graph - the derived view, for names.
 * @param path - a path from relationPaths.
 * @returns the description.
 */
export function describePath(graph: RelationGraphView, path: RelationPath): string {
  const name = (id: string): string => (graph.entities.get(id) as EntityView).entity.name
  const lines = path.hops.map((hop) => {
    const ground = hop.grounds[0]
    const where = ground === undefined ? '' : ground.type === 'quote'
      ? ` — ${ground.title}, ${describeLocator(ground.locator as SourceLocator)}: "${ground.quote as string}"`
      : ground.type === 'run' ? ` — run ${ground.title}` : ` — ${ground.title} cites it (${ground.source})`
    const arrow = hop.direction === 'forward' ? `${name(hop.from)} —${hop.kind}→ ${name(hop.to)}` : `${name(hop.to)} ←${hop.kind}— ${name(hop.from)}`
    return `${arrow}${hop.status === 'stale' ? ' [stale]' : ''}${where}`
  })
  return [`${path.hops.length} hop${path.hops.length === 1 ? '' : 's'}, confidence ${path.confidence}:`, ...lines].join('\n')
}

// ── Gap matrix ──────────────────────────────────────────────────────────────

/** One passage the gap matrix scans: its token keys, and which tokens are written in capitals. */
export interface Passage {
  evidenceId: string
  locator: SourceLocator
  keys: string[]
  capitals: boolean[]
}

/** The tokens of every passage the gap matrix scans, built once per record version and reusable across matrices. */
export interface PassageIndex {
  passages: Passage[]
  /** Literature records by what was extracted, and the project files scanned. */
  basis: { literature: number; fullText: number; abstractOnly: number; metadataOnly: number; files: number }
}

/**
 * Index the passages the gap matrix reads: the pages of literature records
 * with full text (not their provider abstract, which may belong to another
 * work), the abstract or title of the others, and the chunks of project files.
 * Runs and BibTeX entries are not passages.
 * @param project - the record, with evidence text loaded.
 * @returns the passages' token keys and the coverage counts.
 */
export function passageIndex(project: Pick<ResearchProject, 'evidence'>): PassageIndex {
  const passages: PassageIndex['passages'] = []
  const basis = { literature: 0, fullText: 0, abstractOnly: 0, metadataOnly: 0, files: 0 }
  for (const record of project.evidence) {
    if (record.kind === 'experiment') continue
    if (record.kind === 'file') basis.files++
    else {
      basis.literature++
      if (record.coverage === 'full-text') basis.fullText++
      else if (record.coverage === 'abstract') basis.abstractOnly++
      else basis.metadataOnly++
    }
    const skip = (chunk: EvidenceChunk): boolean => chunk.locator.key === 'bibtex' || (record.coverage === 'full-text' && chunk.locator.key !== undefined)
    for (const chunk of record.chunks.filter(item => !skip(item))) {
      const tokens = tokenize(chunk.text)
      const keys = tokens.map(token => token.key), capitals = tokens.map(token => token.upper)
      passages.push({ evidenceId: record.id, locator: chunk.locator, keys, capitals })
    }
  }
  return { passages, basis }
}

/** The matrix to build. */
export interface GapRequest {
  /** What the columns are: tasks (applied-to), datasets (evaluated-on), or settings of evaluated-on grounds. */
  axis: 'task' | 'dataset' | 'setting'
  /** Method ids; when absent, the methods with the most relations of the axis's kind. */
  rows?: readonly string[] | undefined
  /** Entity ids, or setting labels for the setting axis; when absent, those with the most relations. */
  columns?: readonly string[] | undefined
  /** Count a row's and a column's subtypes (by active is-a relations) toward them; true when absent. */
  rollUp?: boolean | undefined
  /** Rows and columns chosen when none are given, at most {@link MAX_GAP_AXIS}; 12 when absent. */
  limit?: number | undefined
}

/**
 * What the project's own sources say about one method and one column:
 * `reported` — a literature record's quotation grounds it; `project-only` —
 * only the project's runs or files do; `stale` — only grounds whose source
 * changed; `mentioned` — no ground, but some passage names both, so a source
 * may report it unread; `absent` — both are named in the project's sources,
 * never in one passage; `uncovered` — the project's sources never name one of
 * them, so they say nothing either way.
 */
export type GapState = 'reported' | 'project-only' | 'stale' | 'mentioned' | 'absent' | 'uncovered'

/** One cell of the gap matrix. */
export interface GapCell {
  state: GapState
  /** Literature records with a current quotation grounding the pair. */
  papers: number
  /** Of those, the ones that ground it only through a subtype of the row or the column. */
  viaSubtypes: number
  /** Project runs that ground it. */
  runs: number
  /** Project files with a current quotation grounding it. */
  files: number
  /** Sources whose only grounds rest on changed sources. */
  stale: number
  /** Passages naming both, counted when no ground supports the pair. */
  passages: number
  /** Sources whose grounds for the pair were rejected, and that support it no other way; they never count toward the state. */
  rejected: number
  /** The relations that ground it, at most eight. */
  relations: string[]
}

/** One row or column of the gap matrix. */
export interface GapAxisEntry {
  /** An entity id, or a setting's grouping key. */
  id: string
  name: string
  /** Passages of the project's sources that name it or, rolled up, one of its subtypes. */
  passages: number
}

/** Methods against tasks, datasets or settings, as the project's own sources cover them. */
export interface GapMatrix {
  axis: GapRequest['axis']
  rows: GapAxisEntry[]
  columns: GapAxisEntry[]
  /** cells[row][column]. */
  cells: GapCell[][]
  basis: PassageIndex['basis']
}

/** Whether a passage spells a key, by the same whole-token rule as findMentions; `starts` lists where each token key occurs. */
function spells(passage: Passage, key: string, capitals: boolean, starts: Map<string, number[]>): boolean {
  const { keys } = passage
  for (let length = 1; length <= key.length; length++) {
    for (const first of starts.get(key.slice(0, length)) ?? []) {
      let joined = ''
      for (let at = first; at < keys.length; at++) {
        if ((capitals && passage.capitals[at] !== true) || !key.startsWith(joined + (keys[at] as string))) break
        joined += keys[at] as string
        if (joined === key) return true
      }
    }
  }
  return false
}

function names(passage: Passage, keys: Map<string, boolean>, starts: Map<string, number[]>): boolean {
  for (const [key, capitals] of keys) if (spells(passage, key, capitals, starts)) return true
  return false
}

/** The subtypes of an entity by active is-a relations, itself included. */
function subtypes(graph: RelationGraphView, id: string, rollUp: boolean): Set<string> {
  const found = new Set([id])
  const queue = [id]
  while (rollUp && queue.length > 0) {
    const node = queue.shift() as string
    for (const view of graph.touching.get(node) ?? []) {
      if (view.relation.kind === 'is-a' && view.status === 'active' && view.relation.to === node && !found.has(view.relation.from)) {
        found.add(view.relation.from)
        queue.push(view.relation.from)
      }
    }
  }
  return found
}

function namesOf(graph: RelationGraphView, ids: ReadonlySet<string>): Map<string, boolean> {
  const keys = new Map<string, boolean>()
  for (const id of ids) {
    const entity = (graph.entities.get(id) as EntityView).entity
    for (const [key, capitals] of entityKeys(entity)) keys.set(key, (keys.get(key) ?? true) && capitals)
  }
  return keys
}

/**
 * The gap matrix of methods against tasks, datasets or settings. A cell counts
 * the distinct sources whose grounds support an applied-to (tasks) or
 * evaluated-on (datasets; settings by their grounds' setting) relation from
 * the row, or a subtype of it, to the column or a subtype; rejected relations
 * and grounds never count. Without any ground it reads the project's passages
 * ({@link passageIndex}) to tell `mentioned`, `absent` and `uncovered` apart.
 * Every state is about the project's own sources: `absent` means no source of
 * this project reports the pair, not that nobody has.
 * @param graph - the derived view.
 * @param request - the axis and, optionally, the rows and columns.
 * @param index - the project's passages.
 * @returns the matrix, rows and columns in the order given or by relation count.
 */
export function gapMatrix(graph: RelationGraphView, request: GapRequest, index: PassageIndex): GapMatrix {
  const rollUp = request.rollUp ?? true
  const limit = Math.max(1, Math.min(MAX_GAP_AXIS, Math.floor(request.limit ?? 12)))
  const relationKind: RelationKind = request.axis === 'task' ? 'applied-to' : 'evaluated-on'
  const live = [...graph.relations.values()].filter(view => view.status !== 'rejected' && view.relation.kind === relationKind)
  const entityName = (id: string): string => (graph.entities.get(id) as EntityView).entity.name
  const ranked = (ids: Iterable<string>, count: (id: string) => number): string[] =>
    [...new Set(ids)].sort((a, b) => count(b) - count(a) || (a < b ? -1 : 1)).slice(0, limit)
  const rowIds = (request.rows ?? ranked(live.map(view => view.relation.from), id => live.filter(view => view.relation.from === id).length))
    .filter(id => graph.entities.get(id)?.entity.kind === 'method').slice(0, MAX_GAP_AXIS)
  // Settings are columns by their grouping key, shown by the first label a ground or the request gave them.
  const settingLabels = new Map<string, string>()
  const settingOf = (item: GroundView): string | undefined => item.status === 'rejected' ? undefined : groundSetting(item.ground)
  for (const view of live) {
    for (const item of view.grounds) {
      const setting = settingOf(item)
      if (setting !== undefined && !settingLabels.has(settingKey(setting))) settingLabels.set(settingKey(setting), setting)
    }
  }
  let columns: string[]
  if (request.axis === 'setting') {
    for (const label of request.columns ?? []) if (!settingLabels.has(settingKey(label))) settingLabels.set(settingKey(label), label)
    const uses = (key: string): number => live.filter(view => view.grounds.some(item => settingKey(settingOf(item) ?? '') === key)).length
    columns = request.columns?.map(settingKey) ?? ranked(settingLabels.keys(), uses)
  } else {
    columns = (request.columns ?? ranked(live.map(view => view.relation.to), id => live.filter(view => view.relation.to === id).length))
      .filter(id => graph.entities.get(id)?.entity.kind === request.axis)
  }
  columns = [...new Set(columns)].slice(0, MAX_GAP_AXIS)
  const rowSets = rowIds.map(id => subtypes(graph, id, rollUp))
  const columnSets = columns.map(id => request.axis === 'setting' ? new Set([id]) : subtypes(graph, id, rollUp))
  const rowKeys = rowSets.map(set => namesOf(graph, set))
  const columnKeys = columns.map((id, c) => request.axis === 'setting'
    ? new Map(settingKeys(settingLabels.get(id) as string).map(key => [key, false]))
    : namesOf(graph, columnSets[c] as Set<string>))
  // Which rows and columns each passage names: one scan of the passages for all of them.
  const rowHits = rowIds.map(() => new Set<number>()), columnHits = columns.map(() => new Set<number>())
  index.passages.forEach((passage, p) => {
    const starts = new Map<string, number[]>()
    passage.keys.forEach((key, at) => starts.set(key, [...starts.get(key) ?? [], at]))
    rowKeys.forEach((keys, r) => { if (names(passage, keys, starts)) rowHits[r]?.add(p) })
    columnKeys.forEach((keys, c) => { if (names(passage, keys, starts)) columnHits[c]?.add(p) })
  })
  const ofKind = [...graph.relations.values()].filter(view => view.relation.kind === relationKind)
  const cells = rowIds.map((rowId, r) => columns.map((columnId, c): GapCell => {
    const rowSet = rowSets[r] as Set<string>, columnSet = columnSets[c] as Set<string>
    const papers = new Set<string>(), direct = new Set<string>(), runs = new Set<string>()
    const files = new Set<string>(), stale = new Set<string>(), rejected = new Set<string>()
    const relations: string[] = []
    for (const view of ofKind) {
      if (!rowSet.has(view.relation.from)) continue
      if (request.axis !== 'setting' && !columnSet.has(view.relation.to)) continue
      let counted = false
      for (const item of view.grounds) {
        if (request.axis === 'setting' && settingKey(groundSetting(item.ground) ?? '') !== columnId) continue
        const key = sourceKey(item.ground)
        if (view.status === 'rejected' || item.status === 'rejected') { rejected.add(key); continue }
        counted = true
        if (item.status === 'outdated') stale.add(key)
        else if (item.source === 'run') runs.add(key)
        else if (item.source === 'file') files.add(key)
        else {
          papers.add(key)
          if (view.relation.from === rowId && (request.axis === 'setting' || view.relation.to === columnId)) direct.add(key)
        }
      }
      if (counted && relations.length < 8) relations.push(view.relation.id)
    }
    for (const key of [...papers, ...runs, ...files]) stale.delete(key)
    for (const key of [...papers, ...runs, ...files, ...stale]) rejected.delete(key)
    const both = [...(rowHits[r] as Set<number>)].filter(p => columnHits[c]?.has(p)).length
    const grounded = papers.size + runs.size + files.size + stale.size > 0
    let state: GapState
    if (papers.size > 0) state = 'reported'
    else if (runs.size + files.size > 0) state = 'project-only'
    else if (stale.size > 0) state = 'stale'
    else if (both > 0) state = 'mentioned'
    else if ((rowHits[r] as Set<number>).size > 0 && (columnHits[c] as Set<number>).size > 0) state = 'absent'
    else state = 'uncovered'
    return {
      state, papers: papers.size, viaSubtypes: [...papers].filter(key => !direct.has(key)).length, runs: runs.size, files: files.size,
      stale: stale.size, passages: grounded ? 0 : both, rejected: rejected.size, relations,
    }
  }))
  const entry = (id: string, name: string, hits: Set<number>): GapAxisEntry => ({ id, name, passages: hits.size })
  return {
    axis: request.axis,
    rows: rowIds.map((id, r) => entry(id, entityName(id), rowHits[r] as Set<number>)),
    columns: columns.map((id, c) => entry(id, request.axis === 'setting' ? settingLabels.get(id) as string : entityName(id), columnHits[c] as Set<number>)),
    cells, basis: index.basis,
  }
}

/** What each gap state says, in the agent's words; the person's view uses its own locale's wording for the same states. */
const GAP_WORDS: Readonly<Record<GapState, string>> = Object.freeze({
  'reported': 'reported by papers in this project\'s literature',
  'project-only': 'only in this project\'s own runs or files',
  'stale': 'only on grounds whose source changed since',
  'mentioned': 'named together in this project\'s sources but not yet checked',
  'absent': 'no paper in this project\'s literature reports it',
  'uncovered': 'this project\'s sources do not cover it; search the literature before concluding anything',
})

/**
 * The gap matrix as the agent reads it: the coverage it rests on, then one
 * line per cell that is not reported, grouped by state. The wording never
 * claims a gap in the field.
 * @param matrix - a matrix from gapMatrix.
 * @returns the description.
 */
export function describeGapMatrix(matrix: GapMatrix): string {
  const { basis } = matrix
  const head = `Gap matrix of methods × ${matrix.axis}s over this project's own sources only (${basis.literature} literature records: ${basis.fullText} full text, `
    + `${basis.abstractOnly} abstract only, ${basis.metadataOnly} metadata only; ${basis.files} project files). It says nothing about work outside them.`
  const lines: string[] = [head]
  for (const state of ['reported', 'project-only', 'stale', 'mentioned', 'absent', 'uncovered'] as const) {
    const pairs = matrix.cells.flatMap((row, r) => row.flatMap((cell, c) => cell.state === state
      ? [`${(matrix.rows[r] as GapAxisEntry).name} × ${(matrix.columns[c] as GapAxisEntry).name}${state === 'reported' ? ` (${cell.papers})` : state === 'mentioned' ? ` (${cell.passages} passages)` : ''}`]
      : []))
    if (pairs.length > 0) lines.push(`${GAP_WORDS[state]}: ${pairs.join('; ')}`)
  }
  return lines.join('\n')
}

/**
 * The entity whose name or alias a text names, for resolving what a person or
 * the agent typed into a node id.
 * @param graph - the derived view.
 * @param text - a name.
 * @param kind - restrict to one kind.
 * @returns the matching entity ids, best first: exact name key, then alias.
 */
export function findEntities(graph: RelationGraphView, text: string, kind?: EntityKind): string[] {
  const key = nameKey(text)
  if (key === '') return []
  const exact: string[] = [], alias: string[] = []
  for (const { entity } of graph.entities.values()) {
    if (kind !== undefined && entity.kind !== kind) continue
    if (nameKey(entity.name) === key) exact.push(entity.id)
    else if (entity.aliases.some(name => nameKey(name) === key)) alias.push(entity.id)
    else if (findMentions(tokenize(entity.name), key).length > 0) alias.push(entity.id)
  }
  return [...exact.sort(), ...alias.sort()]
}
