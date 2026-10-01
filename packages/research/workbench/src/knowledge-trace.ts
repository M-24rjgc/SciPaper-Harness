/**
 * What one research_knowledge call touched, as the tool persists it beside the call's result: the patterns and papers a
 * recall returned or skipped, the marks a read listed, the relations around an entity, the hops of the paths found. Each
 * builder is a pure function of the structured value the call computed anyway, so nothing is stored apart from the
 * session log and the model's result keeps its text. Ids are the ones the views already use: a mark's id
 * (`ai:paper:<id>`, also graph-view's node id) for the two graphs and the relation graph's entity and relation ids.
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecallResult, RecallReturned, ReturnedItem } from './knowledge.ts'
import type {
  KnowledgeMarkView, KnowledgeTrace, KnowledgeTraceEdge, KnowledgeTraceNode, RelationNeighbourhoodView, RelationPathsPage,
} from './types.ts'

/** Nodes a trace keeps; the rest are counted in `omitted`. */
export const TRACE_MAX_NODES = 40
/** Relations a trace keeps. */
export const TRACE_MAX_EDGES = 80
/** The longest label a trace keeps, in characters. */
const LABEL_MAX = 80
/** The longest query a trace keeps, in characters. */
const QUERY_MAX = 200

/** A text cut to a length in characters, with an ellipsis when cut. */
function clip(text: string, max: number = LABEL_MAX): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/**
 * Apply the size limits: nodes past the limit are dropped and counted, and a relation stays only while both its ends do.
 * @param trace - the trace without limits.
 * @returns the bounded trace.
 */
function limited(trace: KnowledgeTrace): KnowledgeTrace {
  // A node listed twice (the built-in graph repeats a few paper ids) counts once, at its first place.
  const unique = trace.nodes.filter((node, at) => trace.nodes.findIndex(other => other.id === node.id) === at)
  const nodes = unique.slice(0, TRACE_MAX_NODES)
  const kept = new Set(nodes.map(node => node.id))
  const edges = trace.edges.filter(edge => kept.has(edge.from) && kept.has(edge.to)).slice(0, TRACE_MAX_EDGES)
  const omitted = unique.length - nodes.length
  return { ...trace, nodes, edges, ...omitted > 0 ? { omitted } : {} }
}

/** The index field of a built-in graph paper. */
function indexOf(source: string, kind: string, index: number): { index?: number } {
  return source === 'ai' && kind === 'paper' ? { index } : {}
}

/**
 * The trace of a recall: the pinned items first, then what a mark took out, then the rest in the recall's order.
 * @param query - the recall's query.
 * @param result - the recall's result, for the marks' summary and the items a mark took out.
 * @param returned - the patterns and papers the recall returned, with their graph and index.
 * @returns the trace.
 */
export function recallTrace(query: string, result: RecallResult, returned: RecallReturned): KnowledgeTrace {
  const node = (kind: 'pattern' | 'paper') => (item: ReturnedItem): KnowledgeTraceNode => ({
    id: `${item.graph}:${kind}:${item.id}`, source: item.graph, kind, label: clip(item.label),
    use: item.why?.kind === 'pinned' ? 'pinned' : 'recalled', ...indexOf(item.graph, kind, item.index),
  })
  const listed = [...returned.patterns.map(node('pattern')), ...returned.papers.map(node('paper'))]
  const skipped = (result.annotations?.skipped ?? []).map((item): KnowledgeTraceNode => ({
    id: item.mark, source: item.graph, kind: item.kind, label: clip(item.title), use: 'skipped', ...indexOf(item.graph, item.kind, item.index),
  }))
  const applied = result.annotations?.summary.applied
  return limited({
    v: 1, action: 'recall', query: clip(query, QUERY_MAX),
    nodes: [...listed.filter(item => item.use === 'pinned'), ...skipped, ...listed.filter(item => item.use !== 'pinned')], edges: [],
    ...applied === undefined ? {} : { marks: { count: applied } },
  })
}

/**
 * The trace of reading the marks, or of taking one off.
 * @param action - `marks` for the listing, `unmark` for a removal.
 * @param marks - the marks that stand after the call.
 * @param honour - whether the person lets the agent follow them, when the call read it.
 * @returns the trace, which names no node.
 */
export function marksTrace(action: 'marks' | 'unmark', marks: readonly KnowledgeMarkView[], honour?: boolean): KnowledgeTrace {
  return { v: 1, action, nodes: [], edges: [], marks: { count: marks.length, ...honour === undefined ? {} : { honour } } }
}

/**
 * The trace of setting a mark: the marked pattern or paper, pinned or skipped by its verdict.
 * @param marks - the marks that stand after the call.
 * @param id - the id of the mark that was set.
 * @returns the trace.
 */
export function markTrace(marks: readonly KnowledgeMarkView[], id: string): KnowledgeTrace {
  const nodes = marks.filter(mark => mark.id === id).map((mark): KnowledgeTraceNode => ({
    id: mark.id, source: mark.target.graph, kind: mark.target.kind, label: clip(mark.title ?? mark.target.id),
    use: mark.verdict === 'pin' ? 'pinned' : 'skipped', ...mark.index === undefined ? {} : { index: mark.index },
  }))
  return limited({ v: 1, action: 'mark', nodes, edges: [], marks: { count: marks.length } })
}

/**
 * The trace of reading the relations around an entity.
 * @param view - the neighbourhood the agent read.
 * @returns the trace, nodes nearest the centre first.
 */
export function neighbourhoodTrace(view: RelationNeighbourhoodView): KnowledgeTrace {
  const ordered = [...view.nodes].sort((a, b) => a.ring - b.ring || a.slot - b.slot || Number(a.id > b.id) - Number(a.id < b.id))
  return limited({
    v: 1, action: 'relations-neighbourhood',
    nodes: ordered.map((node): KnowledgeTraceNode => ({
      id: node.id, source: 'relations', kind: node.kind, label: clip(node.name), ...node.id === view.center ? { use: 'centre' as const } : {},
    })),
    edges: view.edges.map((edge): KnowledgeTraceEdge => ({ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to, by: edge.by })),
  })
}

/**
 * The trace of a path search: the nodes on the paths, and each distinct hop as a walked relation.
 * @param page - the paths the agent was given.
 * @returns the trace.
 */
export function pathsTrace(page: RelationPathsPage): KnowledgeTrace {
  const ends = new Set([page.from, page.to])
  const hops = new Map<string, KnowledgeTraceEdge>()
  for (const path of page.paths) {
    for (const hop of path.hops) hops.set(hop.relation, { id: hop.relation, kind: hop.kind, from: hop.from, to: hop.to, walked: true })
  }
  return limited({
    v: 1, action: 'relations-paths', paths: page.paths.length,
    nodes: page.nodes.map((node): KnowledgeTraceNode => ({
      id: node.id, source: 'relations', kind: node.kind, label: clip(node.name), ...ends.has(node.id) ? { use: 'end' as const } : {},
    })),
    edges: [...hops.values()],
  })
}

/** A JSON object, as opposed to a list, a scalar or null. */
function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The model's view of a knowledge result: everything except the trace.
 * @param value - the tool's value.
 * @returns the value without `knowledgeTrace`.
 */
export function withoutTrace(value: JsonValue): JsonValue {
  if (!isObject(value) || !('knowledgeTrace' in value)) return value
  const { knowledgeTrace: _trace, ...rest } = value
  return rest
}

/**
 * The tool's presentation metadata for a result.
 * @param value - the tool's value.
 * @returns the trace the call carries, or null for a call that touched nothing to draw.
 */
export function traceMeta(value: JsonValue): JsonValue {
  return isObject(value) ? value.knowledgeTrace ?? null : null
}
