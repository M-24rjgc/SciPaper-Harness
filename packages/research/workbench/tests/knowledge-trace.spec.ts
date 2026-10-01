import { describe, expect, it } from 'vitest'
import type { RecallResult, RecallReturned, ReturnedItem } from '../src/knowledge.ts'
import {
  markTrace, marksTrace, neighbourhoodTrace, pathsTrace, recallTrace, traceMeta, TRACE_MAX_EDGES, TRACE_MAX_NODES, withoutTrace,
} from '../src/knowledge-trace.ts'
import type {
  KnowledgeMarkView, RelationEdgeView, RelationGroundView, RelationHopView, RelationNeighbourhoodView, RelationNodeView, RelationPathsPage,
} from '../src/types.ts'

const item = (graph: 'ai' | 'project', index: number, id: string, label: string, pinned = false): ReturnedItem => ({
  graph, index, id, label, ...pinned ? { why: { kind: 'pinned', mark: `${graph}:paper:${id}`, by: 'user', recalled: true } } : {},
})
const result = (over: Partial<RecallResult> = {}): RecallResult => ({ basis: 'lexical', note: '', patterns: [], closestPapers: [], ...over })
const summary = {
  marks: 3, applied: 2, orphaned: 0, orphanedIds: [], unavailable: 0, pinned: 1, pinsNotShown: 0, skipped: 1, demoted: 0, boosted: 0,
}

describe('the trace of a recall', () => {
  it('lists the pinned items first, then what a mark took out, then the rest, under the ids marks use', () => {
    const returned: RecallReturned = {
      patterns: [item('ai', 4, 'pattern_4', 'Adaptive sparse attention')],
      papers: [item('ai', 17, 'p17', 'FlexPrefill'), item('ai', 3, 'p3', 'MoBA', true), item('project', 2, 'q2', 'Own paper')],
    }
    const recall = result({
      annotations: {
        applied: '2 marks applied', summary,
        skipped: [{ kind: 'paper', graph: 'ai', index: 9, mark: 'ai:paper:p9', title: 'MInference', by: 'user', before: 2, note: 'prefill only' }],
      },
    })
    const trace = recallTrace('block sparse attention', recall, returned)
    expect(trace).toEqual({
      v: 1, action: 'recall', query: 'block sparse attention', edges: [], marks: { count: 2 },
      nodes: [
        { id: 'ai:paper:p3', source: 'ai', kind: 'paper', label: 'MoBA', use: 'pinned', index: 3 },
        { id: 'ai:paper:p9', source: 'ai', kind: 'paper', label: 'MInference', use: 'skipped', index: 9 },
        { id: 'ai:pattern:pattern_4', source: 'ai', kind: 'pattern', label: 'Adaptive sparse attention', use: 'recalled' },
        { id: 'ai:paper:p17', source: 'ai', kind: 'paper', label: 'FlexPrefill', use: 'recalled', index: 17 },
        { id: 'project:paper:q2', source: 'project', kind: 'paper', label: 'Own paper', use: 'recalled' },
      ],
    })
  })

  it('records no marks when the project has none, counts a repeated paper id once, and keeps the labels short', () => {
    const long = 'x'.repeat(120)
    const returned: RecallReturned = {
      patterns: [], papers: [item('ai', 1, 'p1', long), item('ai', 2, 'p1', 'the same id again')],
    }
    const trace = recallTrace(long, result(), returned)
    expect(trace.marks).toBeUndefined()
    expect(trace.nodes).toHaveLength(1)
    expect(Array.from(trace.nodes[0]!.label)).toHaveLength(80)
    expect(trace.nodes[0]!.label.endsWith('…')).toBe(true)
    expect(Array.from(trace.query ?? '')).toHaveLength(120)
    expect(Array.from(recallTrace('y'.repeat(300), result(), { patterns: [], papers: [] }).query ?? '')).toHaveLength(200)
  })

  it('keeps the first forty nodes and counts the rest', () => {
    const papers = Array.from({ length: TRACE_MAX_NODES + 5 }, (_, at) => item('ai', at, `p${at}`, `Paper ${at}`))
    const trace = recallTrace('many', result(), { patterns: [], papers })
    expect(trace.nodes).toHaveLength(TRACE_MAX_NODES)
    expect(trace.omitted).toBe(5)
    expect(recallTrace('few', result(), { patterns: [], papers: papers.slice(0, 2) })).not.toHaveProperty('omitted')
  })
})

const mark = (id: string, verdict: 'pin' | 'irrelevant', over: Partial<KnowledgeMarkView> = {}): KnowledgeMarkView => ({
  id, target: { kind: 'paper', graph: 'ai', id: id.split(':')[2] as string }, verdict, by: 'user', at: '2026-10-01T00:00:00.000Z', ...over,
})

describe('the trace of a mark', () => {
  it('counts the marks a listing read and whether the agent follows them, and names no node', () => {
    const marks = [mark('ai:paper:p1', 'pin'), mark('ai:paper:p2', 'irrelevant')]
    expect(marksTrace('marks', marks, false)).toEqual({ v: 1, action: 'marks', nodes: [], edges: [], marks: { count: 2, honour: false } })
    expect(marksTrace('unmark', marks.slice(0, 1))).toEqual({ v: 1, action: 'unmark', nodes: [], edges: [], marks: { count: 1 } })
  })

  it('names the paper a new mark is on, pinned or skipped by its verdict, with its place on the map', () => {
    const marks = [mark('ai:paper:p1', 'pin', { title: 'MoBA', index: 3 }), mark('ai:paper:p2', 'irrelevant')]
    expect(markTrace(marks, 'ai:paper:p1').nodes).toEqual([{ id: 'ai:paper:p1', source: 'ai', kind: 'paper', label: 'MoBA', use: 'pinned', index: 3 }])
    // A mark whose target left its graph keeps its id as the label, and a skipped paper is a node too.
    expect(markTrace(marks, 'ai:paper:p2').nodes).toEqual([{ id: 'ai:paper:p2', source: 'ai', kind: 'paper', label: 'p2', use: 'skipped' }])
    expect(markTrace(marks, 'ai:paper:p2').marks).toEqual({ count: 2 })
  })
})

const ground: RelationGroundView = { id: 'g1', type: 'quote', source: 'full-text', status: 'current', title: 'MoBA', by: 'agent' }
const entity = (id: string, name: string, ring: 0 | 1 | 2, slot: number, kind: RelationNodeView['kind'] = 'method'): RelationNodeView =>
  ({ id, kind, name, aliases: [], status: 'active', degree: 1, ring, core: ring === 0, slot })
const relation = (id: string, from: string, to: string, by: 'user' | 'agent' = 'agent'): RelationEdgeView => ({
  id, kind: 'compares-with', from, to, status: 'active', confidence: 0.8, sources: { 'full-text': 1, abstract: 0, file: 0, run: 0, citation: 0 },
  best: ground, grounds: [ground], by,
})

describe('the trace of the relation graph', () => {
  it('orders a neighbourhood from its centre outward and keeps who recorded each relation', () => {
    const view: RelationNeighbourhoodView = {
      center: 'method:fixed', omitted: { nodes: 0, edges: 0 },
      nodes: [entity('method:b', 'B', 1, 2), entity('method:a', 'A', 1, 1), entity('method:fixed', 'Fixed blocks', 0, 0), entity('task:x', 'X', 2, 0, 'task'), entity('method:c', 'C', 1, 1)],
      edges: [relation('r1', 'method:fixed', 'method:a'), relation('r2', 'method:a', 'method:fixed', 'user')],
    }
    const trace = neighbourhoodTrace(view)
    expect(trace.action).toBe('relations-neighbourhood')
    expect(trace.nodes.map(node => node.id)).toEqual(['method:fixed', 'method:a', 'method:c', 'method:b', 'task:x'])
    expect(trace.nodes[0]).toEqual({ id: 'method:fixed', source: 'relations', kind: 'method', label: 'Fixed blocks', use: 'centre' })
    expect(trace.nodes[1]).not.toHaveProperty('use')
    expect(trace.edges).toEqual([
      { id: 'r1', kind: 'compares-with', from: 'method:fixed', to: 'method:a', by: 'agent' },
      { id: 'r2', kind: 'compares-with', from: 'method:a', to: 'method:fixed', by: 'user' },
    ])
  })

  it('drops relations past the limit and relations whose end was cut', () => {
    const nodes = Array.from({ length: TRACE_MAX_NODES + 2 }, (_, at) => entity(`method:m${String(at).padStart(2, '0')}`, `M${at}`, 1, at))
    const edges = nodes.slice(1).map((node, at) => relation(`r${at}`, 'method:m00', node.id))
    const trace = neighbourhoodTrace({ center: 'method:m00', nodes, edges, omitted: { nodes: 0, edges: 0 } })
    expect(trace.nodes).toHaveLength(TRACE_MAX_NODES)
    expect(trace.edges.length).toBeLessThan(edges.length)
    expect(trace.edges.every(edge => trace.nodes.some(node => node.id === edge.to))).toBe(true)
    const crowded = Array.from({ length: TRACE_MAX_EDGES + 3 }, (_, at) => relation(`e${at}`, 'method:m00', 'method:m01'))
    expect(neighbourhoodTrace({ center: 'method:m00', nodes: nodes.slice(0, 2), edges: crowded, omitted: { nodes: 0, edges: 0 } }).edges).toHaveLength(TRACE_MAX_EDGES)
  })

  it('marks the ends of a path search and each distinct hop as walked', () => {
    const hop = (relationId: string, from: string, to: string): RelationHopView => ({
      relation: relationId, kind: 'compares-with', from, to, direction: 'forward', status: 'active', confidence: 0.9, grounds: [ground], parallel: [],
    })
    const page: RelationPathsPage = {
      from: 'method:fixed', to: 'method:full', nodes: [entity('method:fixed', 'Fixed', 0, 0), entity('method:mid', 'Mid', 1, 0), entity('method:full', 'Full', 1, 1)],
      paths: [
        { nodes: ['method:fixed', 'method:mid', 'method:full'], hops: [hop('r1', 'method:fixed', 'method:mid'), hop('r2', 'method:mid', 'method:full')], cost: 1, confidence: 0.8, stale: false },
        { nodes: ['method:fixed', 'method:mid'], hops: [hop('r1', 'method:fixed', 'method:mid')], cost: 1, confidence: 0.8, stale: false },
      ],
    }
    const trace = pathsTrace(page)
    expect(trace.paths).toBe(2)
    expect(trace.nodes.map(node => node.use)).toEqual(['end', undefined, 'end'])
    expect(trace.edges).toEqual([
      { id: 'r1', kind: 'compares-with', from: 'method:fixed', to: 'method:mid', walked: true },
      { id: 'r2', kind: 'compares-with', from: 'method:mid', to: 'method:full', walked: true },
    ])
    expect(pathsTrace({ from: 'a', to: 'b', paths: [], nodes: [], none: 'no-path' })).toEqual({ v: 1, action: 'relations-paths', paths: 0, nodes: [], edges: [] })
  })
})

describe('the tool value around a trace', () => {
  it('hides the trace from the model and hands it on as metadata', () => {
    const value = { message: 'done', content: '[]', knowledgeTrace: { v: 1, action: 'marks', nodes: [], edges: [] } }
    expect(withoutTrace(value)).toEqual({ message: 'done', content: '[]' })
    expect(traceMeta(value)).toEqual(value.knowledgeTrace)
    // A call that touched nothing to draw, and a value that is no object, carry no metadata and keep their text.
    expect(withoutTrace({ message: 'done' })).toEqual({ message: 'done' })
    expect(traceMeta({ message: 'done' })).toBeNull()
    expect(withoutTrace(['a'])).toEqual(['a'])
    expect(traceMeta(['a'])).toBeNull()
    expect(withoutTrace(null)).toBeNull()
  })
})
