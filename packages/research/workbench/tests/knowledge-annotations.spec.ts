import { describe, expect, it } from 'vitest'
import {
  ANNOTATION_TUNING, annotationId, applyAnnotations, describeAnnotations, locateTarget, prepareAnnotationGraph,
  type Annotation, type AnnotationRequest, type AnnotationSummary, type AnnotationTarget, type RecallCandidate,
} from '../src/knowledge-annotations.ts'
import type { GraphFile } from '../src/knowledge.ts'

const pattern = (index: number, name: string): GraphFile['patterns'][number] => ({
  id: `pattern_${index}`, name, domain: 0, subDomains: [], size: 0, coherence: null, tier: 'A', summary: '', details: '', ideas: [], exemplars: [], works: [],
})
const paper = (id: string, patternIndex: number, similar: number[]): GraphFile['papers'][number] => ({
  id, title: `Paper ${id}`, pattern: patternIndex, domain: 0, idea: '', problem: '', solution: '', story: '', score: null, similar,
})

/**
 * Undirected links: 0–1, 0–2, 1–2, 2–3, 3–4, 4–5, 5–6, 7–8, 7–10. Paper 8 lists itself, papers 9 and 10
 * share the id `dup`, paper 7 has no pattern and pattern 3 has no papers.
 */
const GRAPH: GraphFile = {
  version: 1, name: 'ai', description: 'test', domains: ['ML'],
  patterns: [pattern(0, 'Sparse attention angle'), pattern(1, 'Graph dialogue angle'), pattern(2, 'Third angle'), pattern(3, 'Empty angle')],
  papers: [
    paper('a0', 0, [1, 2]), paper('a1', 0, [0, 2]), paper('a2', 0, [3]), paper('a3', 0, [4]),
    paper('b4', 1, [5]), paper('b5', 1, [6]), paper('b6', 1, []),
    paper('c7', -1, [8]), paper('c8', 2, [8]), paper('dup', 2, []), paper('dup', 2, [7]),
  ],
}
/** A project graph built without recorded neighbours. */
const PROJECT: GraphFile = {
  version: 1, name: 'project', description: 'test', domains: ['HCI'],
  patterns: [pattern(0, 'Haptic angle')],
  papers: [paper('q0', 0, []), paper('q1', 0, []), paper('q2', -1, [])],
}

const T0 = Date.parse('2026-10-01T00:00:00.000Z')
function mark(kind: AnnotationTarget['kind'], id: string, verdict: Annotation['verdict'], options: { graph?: 'ai' | 'project'; note?: string; at?: number } = {}): Annotation {
  const target = { kind, graph: options.graph ?? 'ai', id }
  return {
    id: annotationId(target), target, verdict, ...options.note === undefined ? {} : { note: options.note }, by: 'user',
    at: new Date(T0 + (options.at ?? 0) * 1000).toISOString(),
  }
}
/** A ranking of the given indices, best first. */
function ranking(indices: number[], graph: 'ai' | 'project' = 'ai'): RecallCandidate[] {
  return indices.map((index, rank) => ({ graph, index, score: 1 / (61 + rank) }))
}
function request(annotations: Annotation[], papers: number[], patterns: number[], limits = { patterns: 4, papers: 6 }): AnnotationRequest {
  return { graphs: { ai: GRAPH }, annotations, papers: ranking(papers), patterns: ranking(patterns), limits }
}
const indices = (items: { index: number }[]): number[] => items.map(item => item.index)
const link = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ mark: id, title, ...extra })
const NOTE = 'it targets the prefill stage'
const NO_EFFECT = { orphaned: 0, orphanedIds: [], unavailable: 0, pinned: 0, pinsNotShown: 0, skipped: 0, demoted: 0, boosted: 0 }

describe('without marks', () => {
  it('returns the first candidates in the query order with their scores, each unchanged', () => {
    const result = applyAnnotations(request([], [3, 1, 0, 7, 8, 2, 5], [1, 0, 2, 3], { patterns: 3, papers: 5 }))
    expect(result.papers).toEqual(ranking([3, 1, 0, 7, 8]).map((candidate, rank) => ({ ...candidate, before: rank + 1, why: { kind: 'unchanged' } })))
    expect(result.patterns).toEqual(ranking([1, 0, 2]).map((candidate, rank) => ({ ...candidate, before: rank + 1, why: { kind: 'unchanged' } })))
    expect(result.skipped).toEqual([])
    expect(result.summary).toEqual({ marks: 0, applied: 0, ...NO_EFFECT })
    expect(describeAnnotations(result.summary)).toBe('')
  })

  it('leaves the ranking as it is when every mark is orphaned or on a graph that is not loaded', () => {
    const orphans = Array.from({ length: 12 }, (_, at) => mark('paper', `gone${String(at).padStart(2, '0')}`, 'irrelevant'))
    const marks = [...orphans, mark('pattern', 'pattern_9', 'pin'), mark('paper', 'q0', 'pin', { graph: 'project' })]
    const result = applyAnnotations(request(marks, [3, 1, 0], [1, 0]))
    expect(result.papers).toEqual(applyAnnotations(request([], [3, 1, 0], [1, 0])).papers)
    expect(result.summary).toMatchObject({ marks: 14, applied: 0, orphaned: 13, unavailable: 1 })
    expect(result.summary.orphanedIds).toEqual(orphans.slice(0, 10).map(item => item.id))
  })
})

describe('an irrelevant mark', () => {
  it('leaves the target out, names it in skipped, and moves the papers and patterns near it down by a bounded amount', () => {
    const result = applyAnnotations(request([mark('paper', 'a0', 'irrelevant', { note: NOTE })], [0, 1, 7, 8, 3, 5, 4, 2], [1, 0, 2, 3]))
    const a0 = link('ai:paper:a0', 'Paper a0', { note: NOTE })
    expect(result.skipped).toEqual([{ kind: 'paper', graph: 'ai', index: 0, mark: 'ai:paper:a0', title: 'Paper a0', note: NOTE, by: 'user', before: 1 }])
    // Places among the rest plus 3 × weight: paper 1 at 0 + 1.875, paper 3 at 3 + 1.031, paper 2 at 6 + 1.875.
    expect(indices(result.papers)).toEqual([7, 1, 8, 5, 3, 4])
    expect(result.papers.map(item => [item.before, item.why])).toEqual([
      [3, { kind: 'unchanged' }],
      [2, { kind: 'demoted', shift: 1.875, penalty: 0.625, boost: 0, nearest: { ...a0, relation: 'similar', hops: 1 }, marks: 1 }],
      [4, { kind: 'unchanged' }],
      [6, { kind: 'unchanged' }],
      [5, { kind: 'demoted', shift: 1.031, penalty: 0.344, boost: 0, nearest: { ...a0, relation: 'similar', hops: 2 }, marks: 1 }],
      // One path of three links weighs 0.125, under the threshold.
      [7, { kind: 'unchanged' }],
    ])
    // Pattern 0 holds the marked paper: its weight is the mean over its four papers, (1 + 0.625 + 0.625 + 0.344) / 4.
    expect(indices(result.patterns)).toEqual([1, 2, 0, 3])
    expect(result.patterns[2]?.why).toEqual({
      kind: 'demoted', shift: 1.945, penalty: 0.648, boost: 0, nearest: { ...a0, relation: 'members', hops: 0, papers: 4 }, marks: 1,
    })
    expect(result.patterns.filter(item => item.index !== 0).every(item => item.why.kind === 'unchanged')).toBe(true)
    expect(result.summary).toEqual({ ...NO_EFFECT, marks: 1, applied: 1, skipped: 1, demoted: 3 })
  })

  it('removes a target the query placed beyond the limit without naming it', () => {
    const result = applyAnnotations(request([mark('paper', 'a0', 'irrelevant')], [1, 7, 0], [], { patterns: 0, papers: 2 }))
    expect(indices(result.papers)).toEqual([7, 1])
    expect(result.skipped).toEqual([])
  })

  it('treats every copy of a repeated paper id as the marked paper', () => {
    const skipped = applyAnnotations(request([mark('paper', 'dup', 'irrelevant')], [10, 9, 7, 8], []))
    expect(skipped.skipped).toEqual([{ kind: 'paper', graph: 'ai', index: 10, mark: 'ai:paper:dup', title: 'Paper dup', by: 'user', before: 1 }])
    expect(skipped.papers.map(item => [item.index, item.why.kind])).toEqual([[7, 'demoted'], [8, 'demoted']])
    const pinned = applyAnnotations(request([mark('paper', 'dup', 'pin')], [7, 9, 10], []))
    expect(pinned.papers.map(item => [item.index, item.before, item.why.kind])).toEqual([[9, 2, 'pinned'], [7, 1, 'boosted']])
    expect(locateTarget(GRAPH, { kind: 'paper', graph: 'ai', id: 'dup' })).toEqual([9, 10])
  })

  it('keeps the full weight on a copy of the marked paper that another copy links to', () => {
    const twins: GraphFile = { ...GRAPH, patterns: [pattern(0, 'Twin angle')], papers: [paper('twin', 0, [1]), paper('twin', 0, [2]), paper('n2', 0, [])] }
    const result = applyAnnotations({
      graphs: { ai: twins }, annotations: [mark('paper', 'twin', 'irrelevant')], papers: ranking([0, 1, 2]), patterns: ranking([0]), limits: { patterns: 1, papers: 3 },
    })
    expect(result.skipped.map(item => item.index)).toEqual([0])
    expect(result.papers.map(item => [item.index, item.why.kind === 'demoted' && item.why.penalty])).toEqual([[2, 0.625]])
    // Both copies count fully among the pattern's three papers: (1 + 1 + 0.625) / 3.
    expect(result.patterns[0]?.why).toMatchObject({ kind: 'demoted', penalty: 0.875, nearest: { relation: 'members', hops: 0, papers: 3 } })
  })

  it('spreads only as far as the configured depth', () => {
    const marks = [mark('paper', 'a0', 'irrelevant')]
    const weights = (depth: number) => Object.fromEntries(applyAnnotations(request(marks, [1, 3, 4], [], { patterns: 0, papers: 3 }), {
      ...ANNOTATION_TUNING, depth, threshold: 0,
    }).papers.map(item => [item.index, item.why.kind === 'demoted' ? [item.why.penalty, item.why.nearest.hops] : null]))
    expect(weights(1)).toEqual({ 1: [0.5, 1], 3: null, 4: null })
    expect(weights(2)).toEqual({ 1: [0.625, 1], 3: [0.25, 2], 4: null })
    expect(weights(3)).toEqual({ 1: [0.625, 1], 3: [0.344, 2], 4: [0.125, 3] })
  })
})

describe('pins', () => {
  it('lists pins first, recalled ones in query order and the rest newest first, and lifts the papers near them', () => {
    const marks = [
      mark('paper', 'a1', 'pin', { note: 'core related work' }), mark('paper', 'b5', 'pin', { at: 2 }),
      mark('paper', 'b6', 'pin', { at: 1 }), mark('paper', 'c7', 'pin', { at: 2 }),
    ]
    const result = applyAnnotations(request(marks, [3, 8, 9, 1, 4], [], { patterns: 0, papers: 4 }), { ...ANNOTATION_TUNING, pinLimit: 3 })
    expect(result.papers.slice(0, 3)).toEqual([
      { graph: 'ai', index: 1, score: 1 / 64, before: 4, why: { kind: 'pinned', mark: 'ai:paper:a1', by: 'user', note: 'core related work', recalled: true } },
      { graph: 'ai', index: 5, score: 0, before: null, why: { kind: 'pinned', mark: 'ai:paper:b5', by: 'user', recalled: false } },
      { graph: 'ai', index: 7, score: 0, before: null, why: { kind: 'pinned', mark: 'ai:paper:c7', by: 'user', recalled: false } },
    ])
    // Paper 3 is weighed on by a1 (0.344), b5 (0.25) and b6 (0.125): 1 - 0.656 × 0.75 × 0.875 = 0.569.
    expect(result.papers.slice(3).map(item => [item.index, item.why])).toEqual([
      [3, { kind: 'boosted', shift: -1.708, penalty: 0, boost: 0.569, nearest: link('ai:paper:a1', 'Paper a1', { note: 'core related work', relation: 'similar', hops: 2 }), marks: 3 }],
      [8, { kind: 'boosted', shift: -1.5, penalty: 0, boost: 0.5, nearest: link('ai:paper:c7', 'Paper c7', { relation: 'similar', hops: 1 }), marks: 1 }],
      [4, { kind: 'boosted', shift: -2.016, penalty: 0, boost: 0.672, nearest: link('ai:paper:b5', 'Paper b5', { relation: 'similar', hops: 1 }), marks: 3 }],
      [9, { kind: 'unchanged' }],
    ])
    expect(result.summary).toMatchObject({ pinned: 3, pinsNotShown: 1, boosted: 3 })
  })

  it('lists at most five pins by default, ties in time broken by id', () => {
    const marks = ['b5', 'a0', 'a3', 'b4', 'a2', 'a1'].map(id => mark('paper', id, 'pin'))
    const result = applyAnnotations(request(marks, [7], [], { patterns: 0, papers: 1 }))
    expect(indices(result.papers)).toEqual([0, 1, 2, 3, 4, 7])
    expect(result.summary).toMatchObject({ pinned: 5, pinsNotShown: 1 })
  })
})

describe('pattern marks', () => {
  it('skips an irrelevant pattern, pins a pinned one, and weighs on each of their papers as one link would', () => {
    const marks = [mark('pattern', 'pattern_1', 'irrelevant', { note: 'not my setting' }), mark('pattern', 'pattern_0', 'pin')]
    const result = applyAnnotations(request(marks, [4, 0, 7], [1, 2, 0], { patterns: 2, papers: 3 }))
    expect(result.skipped).toEqual([{ kind: 'pattern', graph: 'ai', index: 1, mark: 'ai:pattern:pattern_1', title: 'Graph dialogue angle', note: 'not my setting', by: 'user', before: 1 }])
    expect(result.patterns.map(item => [item.index, item.why.kind])).toEqual([[0, 'pinned'], [2, 'unchanged']])
    expect(result.papers.map(item => [item.index, item.why])).toEqual([
      [0, { kind: 'boosted', shift: -1.5, penalty: 0, boost: 0.5, nearest: link('ai:pattern:pattern_0', 'Sparse attention angle', { relation: 'in-pattern' }), marks: 1 }],
      [4, { kind: 'demoted', shift: 1.5, penalty: 0.5, boost: 0, nearest: link('ai:pattern:pattern_1', 'Graph dialogue angle', { note: 'not my setting', relation: 'in-pattern' }), marks: 1 }],
      [7, { kind: 'unchanged' }],
    ])
  })

  it('lists a pinned pattern the query did not recall', () => {
    const result = applyAnnotations(request([mark('pattern', 'pattern_3', 'pin')], [], [1], { patterns: 1, papers: 0 }))
    expect(result.patterns.map(item => [item.index, item.score, item.before])).toEqual([[3, 0, null], [1, 1 / 61, 1]])
    expect(locateTarget(GRAPH, { kind: 'pattern', graph: 'ai', id: 'pattern_9' })).toEqual([])
  })
})

describe('marks weighing both ways', () => {
  it('moves a result by the net weight and names the heaviest mark on each side', () => {
    const result = applyAnnotations(request([mark('paper', 'a0', 'irrelevant'), mark('paper', 'b4', 'pin')], [3, 2, 1], [], { patterns: 0, papers: 3 }))
    const a0 = link('ai:paper:a0', 'Paper a0'), b4 = link('ai:paper:b4', 'Paper b4')
    expect(result.papers[0]).toMatchObject({ index: 4, before: null, why: { kind: 'pinned', recalled: false } })
    expect(result.papers.slice(1).map(item => [item.index, item.why])).toEqual([
      [3, { kind: 'boosted', shift: -0.469, penalty: 0.344, boost: 0.5, nearest: { ...b4, relation: 'similar', hops: 1 }, counter: { ...a0, relation: 'similar', hops: 2 }, marks: 1 }],
      [2, { kind: 'demoted', shift: 1.125, penalty: 0.625, boost: 0.25, nearest: { ...a0, relation: 'similar', hops: 1 }, counter: { ...b4, relation: 'similar', hops: 2 }, marks: 1 }],
      // b4 reaches paper 1 by one path of three links, under the threshold, so it is not named.
      [1, { kind: 'demoted', shift: 1.875, penalty: 0.625, boost: 0, nearest: { ...a0, relation: 'similar', hops: 1 }, marks: 1 }],
    ])
    expect(describeAnnotations(result.summary)).toBe('Marks honored: 2 of 2. Pinned and listed first: 1. Moved down near items marked irrelevant: 2. Moved up near pinned items: 1.')
  })

  it('never moves a result down as many places as the two bounds together', () => {
    const all = Array.from({ length: GRAPH.papers.length }, (_, at) => at)
    const ids = [...new Set(GRAPH.papers.map(item => item.id))]
    for (let trial = 0; trial < 40; trial++) {
      const marks = ids.filter((_, at) => (trial * 7 + at * 3) % 5 === 0).map((id, at) => mark('paper', id, (trial + at) % 2 ? 'pin' : 'irrelevant', { at }))
      const order = [...all].sort((a, b) => ((a * 31 + trial) % 11) - ((b * 31 + trial) % 11))
      const result = applyAnnotations(request(marks, order, [], { patterns: 0, papers: all.length }))
      const marked = new Set(marks.flatMap(item => locateTarget(GRAPH, item.target)))
      const rest = order.filter(index => !marked.has(index))
      result.papers.filter(item => item.why.kind !== 'pinned').forEach((item, place) => {
        expect(place - rest.indexOf(item.index)).toBeLessThan(ANNOTATION_TUNING.maxDemotion + ANNOTATION_TUNING.maxPromotion)
      })
    }
  })
})

describe('graphs without links, without marks, or not loaded', () => {
  it('weighs only on the marked paper\'s pattern when the graph records no neighbours', () => {
    const marks = [mark('paper', 'q0', 'irrelevant', { graph: 'project' }), mark('paper', 'q2', 'pin', { graph: 'project' })]
    const result = applyAnnotations({
      graphs: { ai: GRAPH, project: PROJECT }, annotations: marks, limits: { patterns: 1, papers: 3 },
      papers: [...ranking([1], 'project'), ...ranking([7])], patterns: ranking([0], 'project'),
    })
    expect(result.patterns[0]?.why).toEqual({
      kind: 'demoted', shift: 1.5, penalty: 0.5, boost: 0, nearest: link('project:paper:q0', 'Paper q0', { relation: 'members', hops: 0, papers: 1 }), marks: 1,
    })
    expect(result.papers.map(item => [item.graph, item.index, item.why.kind])).toEqual([['project', 2, 'pinned'], ['project', 1, 'unchanged'], ['ai', 7, 'unchanged']])
  })

  it('leaves unmarked a candidate of a graph that is not loaded, and a pattern no paper belongs to', () => {
    const result = applyAnnotations({
      graphs: { ai: GRAPH }, annotations: [mark('paper', 'a0', 'irrelevant')], limits: { patterns: 2, papers: 2 },
      papers: [...ranking([0], 'project'), ...ranking([1])], patterns: [...ranking([0], 'project'), ...ranking([3])],
    })
    expect(result.papers.map(item => [item.graph, item.why.kind])).toEqual([['project', 'unchanged'], ['ai', 'demoted']])
    expect(result.patterns.map(item => [item.graph, item.why.kind])).toEqual([['project', 'unchanged'], ['ai', 'unchanged']])
  })
})

describe('the cached spreads', () => {
  it('gives the same result whatever order the marks come in and however often it runs', () => {
    const marks = [mark('paper', 'a0', 'irrelevant'), mark('paper', 'b6', 'pin', { at: 3 }), mark('pattern', 'pattern_2', 'irrelevant')]
    const first = applyAnnotations(request(marks, [3, 2, 1, 4, 5, 8, 7], [0, 1, 2, 3]))
    prepareAnnotationGraph(GRAPH)
    expect(applyAnnotations(request([...marks].reverse(), [3, 2, 1, 4, 5, 8, 7], [0, 1, 2, 3]))).toEqual(first)
    expect(applyAnnotations(request(marks, [3, 2, 1, 4, 5, 8, 7], [0, 1, 2, 3]))).toEqual(first)
  })

  it('recomputes the least recently used spreads once more marks are spread than the cache keeps', () => {
    const size = 2101
    const ring: GraphFile = {
      ...GRAPH, patterns: [],
      papers: Array.from({ length: size }, (_, at) => paper(`r${at}`, -1, [(at + 1) % size])),
    }
    const marks = Array.from({ length: 2001 }, (_, at) => mark('paper', `r${at}`, 'irrelevant'))
    const run = () => applyAnnotations({
      graphs: { ai: ring }, annotations: marks, papers: ranking([2050, 2004, 2002]), patterns: [], limits: { patterns: 0, papers: 3 },
    })
    const first = run()
    // 2002 is two links from the last marked paper, r2000, and three from r1999; 2004 is four links away.
    expect(first.papers.map(item => [item.index, item.why.kind])).toEqual([[2050, 'unchanged'], [2004, 'unchanged'], [2002, 'demoted']])
    expect(run()).toEqual(first)
  })
})

describe('describing the marks to the agent', () => {
  const summary = (change: Partial<AnnotationSummary>): AnnotationSummary => ({
    marks: 9, applied: 6, orphaned: 2, orphanedIds: ['project:paper:x', 'project:paper:y'], unavailable: 1, pinned: 2, pinsNotShown: 1, skipped: 1, demoted: 3, boosted: 1, ...change,
  })

  it('names every effect, the orphaned marks and the marks on a missing graph', () => {
    expect(describeAnnotations(summary({}))).toBe(
      'Marks honored: 6 of 9. Pinned and listed first: 2 (1 more not listed). Left out as marked irrelevant (see skipped): 1. '
      + 'Moved down near items marked irrelevant: 3. Moved up near pinned items: 1. '
      + 'Marks naming items no longer in their graph, kept: 2 (project:paper:x, project:paper:y). Marks on a graph that is not loaded: 1.',
    )
    expect(describeAnnotations(summary({ ...NO_EFFECT, pinned: 2 })))
      .toBe('Marks honored: 6 of 9. Pinned and listed first: 2.')
  })

  it('says when honored marks touched none of the results', () => {
    expect(describeAnnotations(summary(NO_EFFECT)))
      .toBe('Marks honored: 6 of 9; none touched these results.')
  })
})
