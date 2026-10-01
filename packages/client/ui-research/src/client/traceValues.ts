/**
 * Reading what a research_knowledge call touched. The research host persists it beside the call's result as the tool's
 * presentation metadata (`KnowledgeTrace`); the session log hands it back unchecked, so every field is validated here and
 * an entry that does not read the way the host writes it is left out. A call without a trace reads as absent.
 */
import type {
  KnowledgeTrace, KnowledgeTraceEdge, KnowledgeTraceNode, KnowledgeTraceSource, RelationAuthor, RelationKindId,
} from '@deepseek-ai/dsh-research-workbench/types'

const ACTIONS: ReadonlySet<KnowledgeTrace['action']> = new Set([
  'recall', 'marks', 'mark', 'unmark', 'relations-neighbourhood', 'relations-paths',
])
const SOURCES: ReadonlySet<KnowledgeTraceSource> = new Set(['ai', 'project', 'relations'])
const KINDS: ReadonlySet<KnowledgeTraceNode['kind']> = new Set(['pattern', 'paper', 'method', 'task', 'dataset', 'metric'])
const USES: ReadonlySet<NonNullable<KnowledgeTraceNode['use']>> = new Set(['pinned', 'recalled', 'skipped', 'centre', 'end'])
const RELATIONS: ReadonlySet<RelationKindId> = new Set([
  'cites', 'introduces', 'is-a', 'extends', 'improves-on', 'compares-with', 'applied-to', 'evaluated-on', 'measured-by',
])
const AUTHORS: ReadonlySet<RelationAuthor> = new Set(['user', 'agent'])

/** A JSON object, as opposed to a list, a scalar or null. */
type Fields = Readonly<Record<string, unknown>>

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-negative whole number the field holds, or undefined. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** The member of a set a field holds, or undefined. */
function member<T extends string>(value: unknown, set: ReadonlySet<T>): T | undefined {
  return typeof value === 'string' && set.has(value as T) ? value as T : undefined
}

/** A node as the host writes one, or undefined for anything else. */
function nodeOf(value: unknown): KnowledgeTraceNode | undefined {
  if (!isFields(value) || typeof value.id !== 'string' || value.id === '' || typeof value.label !== 'string') return undefined
  const source = member(value.source, SOURCES)
  const kind = member(value.kind, KINDS)
  if (source === undefined || kind === undefined) return undefined
  const use = member(value.use, USES)
  const index = count(value.index)
  return { id: value.id, source, kind, label: value.label, ...use === undefined ? {} : { use }, ...index === undefined ? {} : { index } }
}

/** A relation as the host writes one, or undefined for anything else. */
function edgeOf(value: unknown): KnowledgeTraceEdge | undefined {
  if (!isFields(value) || typeof value.id !== 'string' || typeof value.from !== 'string' || typeof value.to !== 'string') return undefined
  const kind = member(value.kind, RELATIONS)
  if (kind === undefined) return undefined
  const by = member(value.by, AUTHORS)
  return {
    id: value.id, kind, from: value.from, to: value.to,
    ...by === undefined ? {} : { by }, ...value.walked === true ? { walked: true as const } : {},
  }
}

/** The entries of a list that read as the host writes them. */
function entries<T>(value: unknown, read: (item: unknown) => T | undefined): T[] {
  const items: readonly unknown[] = Array.isArray(value) ? value : []
  return items.flatMap((item) => {
    const found = read(item)
    return found === undefined ? [] : [found]
  })
}

/** The marks a call read or applied, as the host writes them, or undefined for anything else. */
function marksOf(value: unknown): KnowledgeTrace['marks'] {
  if (!isFields(value)) return undefined
  const read = count(value.count)
  if (read === undefined) return undefined
  return typeof value.honour === 'boolean' ? { count: read, honour: value.honour } : { count: read }
}

/**
 * The trace a call's result metadata holds.
 * @param meta - the `meta` of a settled research_knowledge result, as the session log gives it.
 * @returns the trace with its malformed nodes and relations left out; undefined when the metadata is no version 1 trace.
 */
export function readTrace(meta: unknown): KnowledgeTrace | undefined {
  if (!isFields(meta) || meta.v !== 1) return undefined
  const action = member(meta.action, ACTIONS)
  if (action === undefined) return undefined
  const marks = marksOf(meta.marks)
  const paths = count(meta.paths), omitted = count(meta.omitted)
  return {
    v: 1, action, nodes: entries(meta.nodes, nodeOf), edges: entries(meta.edges, edgeOf),
    ...typeof meta.query === 'string' ? { query: meta.query } : {},
    ...marks === undefined ? {} : { marks }, ...paths === undefined ? {} : { paths }, ...omitted === undefined ? {} : { omitted },
  }
}

/**
 * How many patterns and papers of the built-in and project graphs a recall returned.
 * @param trace - a recall's trace.
 * @returns the counts, without what a mark took out.
 */
export function recalledCounts(trace: KnowledgeTrace): { patterns: number; papers: number } {
  const listed = trace.nodes.filter(node => node.use === 'pinned' || node.use === 'recalled')
  return { patterns: listed.filter(node => node.kind === 'pattern').length, papers: listed.filter(node => node.kind === 'paper').length }
}
