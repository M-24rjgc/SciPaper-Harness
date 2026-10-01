/**
 * Opt-in evaluation of the mark re-ranking on the shipped graph; it takes about
 * a minute. Run with RESEARCH_KG_EVAL=1. It prints the tables the Agent Note
 * .agents/notes/proposed/feature/2026-10-01-knowledge-graph-annotations.md
 * quotes, and asserts only properties that survive a rebuilt graph.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Bm25, cosine, fuse, termVectors, tokens, type SparseVector } from '../src/clustering.ts'
import {
  ANNOTATION_TUNING, annotationId, applyAnnotations, prepareAnnotationGraph,
  type Annotation, type AnnotatedRecall, type AnnotationTuning, type RecallCandidate,
} from '../src/knowledge-annotations.ts'
import { KnowledgeBase, type GraphFile, type GraphPaper, type GraphPattern } from '../src/knowledge.ts'

const GRAPH_PATH = join(import.meta.dirname, '..', 'runtime', 'kg', 'ai-kg.json.gz')
const VIEW = 8
const LIMITS = { patterns: VIEW, papers: VIEW }

/** A seeded generator, one per study, so each study draws the same samples whichever ran before it. */
function generator(seed: number): () => number {
  let state = seed
  return () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state / 4294967296 }
}
function auc(items: [number, boolean][]): number {
  const sorted = [...items].sort((a, b) => a[0] - b[0])
  let rankSum = 0, positives = 0, i = 0
  while (i < sorted.length) {
    let j = i
    while (j < sorted.length && sorted[j]![0] === sorted[i]![0]) j++
    for (let k = i; k < j; k++) if (sorted[k]![1]) { rankSum += (i + j + 1) / 2; positives++ }
    i = j
  }
  const negatives = sorted.length - positives
  return (rankSum - positives * (positives + 1) / 2) / (positives * negatives)
}
function spearman(xs: number[], ys: number[]): number {
  const rank = (values: number[]): number[] => {
    const order = values.map((value, at) => [value, at] as const).sort((a, b) => a[0] - b[0])
    const ranks = new Array<number>(values.length)
    let i = 0
    while (i < order.length) {
      let j = i
      while (j < order.length && order[j]![0] === order[i]![0]) j++
      for (let k = i; k < j; k++) ranks[order[k]![1]] = (i + j - 1) / 2
      i = j
    }
    return ranks
  }
  const a = rank(xs), b = rank(ys), n = a.length
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2 }
  return num / Math.sqrt(da * db)
}
const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length
const fmt = (value: number, digits = 3): string => Number.isFinite(value) ? value.toFixed(digits) : '-'
const table = (title: string, head: string[], rows: (string | number)[][]): void => {
  console.log([`\n${title}`, `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n'))
}

/** The shipped graph, its indexes, the query pools and the helpers every study uses; built only when the evaluation runs. */
function createWorld() {
  const graph = JSON.parse(gunzipSync(readFileSync(GRAPH_PATH)).toString('utf8')) as GraphFile
  const { papers } = graph
  const graphs = { ai: graph }
  const patternText = (pattern: GraphPattern): string => {
    const exemplars = pattern.exemplars.slice(0, 6).map(index => papers[index]!.title).join(' ')
    return `${pattern.name}. ${pattern.summary} ${pattern.details} ${pattern.ideas.join(' ')} ${pattern.subDomains.join(' ')} ${exemplars}`
  }
  const paperText = (paper: GraphPaper): string => `${paper.title}. ${paper.idea} ${paper.problem} ${paper.solution} ${paper.story}`
  const patternIndex = new Bm25(graph.patterns.map(pattern => tokens(patternText(pattern))))
  const paperIndex = new Bm25(papers.map(paper => tokens(paperText(paper))))

  /** Recall's complete lexical rankings of the shipped graph, as knowledge.ts recall fuses them before its cut. */
  function rankings(query: string): { patterns: RecallCandidate[]; papers: RecallCandidate[] } {
    const words = tokens(query)
    const patternRankings: string[][] = [patternIndex.rank(words, 60).map(hit => `ai:${hit.index}`)]
    const hits = paperIndex.rank(words, 30)
    const via = new Map<string, number>()
    hits.forEach((hit, rank) => {
      const paper = papers[hit.index]!
      if (paper.pattern >= 0) via.set(`ai:${paper.pattern}`, (via.get(`ai:${paper.pattern}`) ?? 0) + 1 / (61 + rank))
      for (const neighbour of paper.similar) {
        const pattern = papers[neighbour]!.pattern
        if (pattern >= 0) via.set(`ai:${pattern}`, (via.get(`ai:${pattern}`) ?? 0) + 0.5 / (61 + rank))
      }
    })
    patternRankings.push([...via].sort((a, b) => b[1] - a[1]).map(([id]) => id))
    const list = (fused: Map<string, number>): RecallCandidate[] => [...fused].sort((a, b) => b[1] - a[1])
      .map(([key, score]) => ({ graph: 'ai' as const, index: Number(key.split(':')[1]), score }))
    return { patterns: list(fuse(patternRankings)), papers: list(fuse([hits.map(hit => `ai:${hit.index}`)])) }
  }

  const neighbours: number[][] = papers.map(() => [])
  papers.forEach((paper, i) => { for (const j of paper.similar) if (j !== i) { neighbours[i]!.push(j); neighbours[j]!.push(i) } })
  for (const list of neighbours) {
    list.sort((a, b) => a - b)
    for (let k = list.length - 1; k > 0; k--) if (list[k] === list[k - 1]) list.splice(k, 1)
  }
  function hops(seeds: number[], max: number): Map<number, number> {
    const distance = new Map(seeds.map(seed => [seed, 0]))
    let frontier = [...seeds]
    for (let h = 1; h <= max; h++) {
      const next: number[] = []
      for (const u of frontier) for (const v of neighbours[u]!) if (!distance.has(v)) { distance.set(v, h); next.push(v) }
      frontier = next
    }
    return distance
  }
  const AT = Date.parse('2026-10-01T00:00:00.000Z')
  const mark = (kind: 'paper' | 'pattern', index: number, verdict: Annotation['verdict'], seconds = 0, note?: string): Annotation => {
    const target = { kind, graph: 'ai' as const, id: kind === 'paper' ? papers[index]!.id : graph.patterns[index]!.id }
    return { id: annotationId(target), target, verdict, ...note ? { note } : {}, by: 'user', at: new Date(AT + seconds * 1000).toISOString() }
  }
  const tuned = (change: Partial<AnnotationTuning>): AnnotationTuning => ({ ...ANNOTATION_TUNING, ...change })
  /** The weight of one irrelevant mark on paper x on each paper of a pool, before the threshold. */
  function weights(x: number, pool: number[], tuning: AnnotationTuning = ANNOTATION_TUNING): Map<number, number> {
    const result = applyAnnotations({
      graphs, annotations: [mark('paper', x, 'irrelevant')], patterns: [], limits: { patterns: 0, papers: pool.length },
      papers: pool.map((index, k) => ({ graph: 'ai', index, score: 1 / (61 + k) })),
    }, { ...tuning, threshold: 0, maxDemotion: 0, maxPromotion: 0 })
    return new Map(result.papers.map(item => [item.index, item.why.kind === 'demoted' ? item.why.penalty : 0]))
  }
  /** Rejected spreading methods, each a score per paper for a mark on x. */
  function walk(x: number, steps: number, step: (u: number, v: number) => number): Map<number, number> {
    let current = new Map([[x, 1]])
    const total = new Map<number, number>()
    for (let length = 1; length <= steps; length++) {
      const next = new Map<number, number>()
      for (const [u, mass] of current) for (const v of neighbours[u]!) next.set(v, (next.get(v) ?? 0) + mass * step(u, v))
      for (const [v, mass] of next) if (v !== x) total.set(v, (total.get(v) ?? 0) + mass)
      current = next
    }
    return total
  }
  const degree = (v: number): number => neighbours[v]!.length
  const ALTERNATIVES: Record<string, (x: number) => Map<number, number>> = {
    'exact target only (no spread)': () => new Map(),
    'hop decay 0.5^h': x => new Map([...hops([x], 3)].filter(([, h]) => h > 0).map(([v, h]) => [v, 0.5 ** h])),
    'noisy-OR over shortest paths only, t=0.65': (x) => {
      const distance = hops([x], 3)
      const weight = new Map([[x, 1]])
      for (const h of [1, 2, 3]) {
        for (const [v, d] of distance) {
          if (d !== h) continue
          let miss = 1
          for (const u of neighbours[v]!) if (distance.get(u) === h - 1) miss *= 1 - weight.get(u)! * 0.65
          weight.set(v, 1 - miss)
        }
      }
      weight.delete(x)
      return weight
    },
    'personalised PageRank, row-normalised, restart 0.15': x => walk(x, 6, u => 0.85 / degree(u)),
    'personalised PageRank, row-normalised, restart 0.5': x => walk(x, 6, u => 0.5 / degree(u)),
    'personalised PageRank, symmetric, restart 0.15': x => walk(x, 6, (u, v) => 0.85 / Math.sqrt(degree(u) * degree(v))),
    'Katz walk counts, b=0.1': x => walk(x, 3, () => 0.1),
  }
  let vectors: SparseVector[] | undefined
  const lexical = (): SparseVector[] => vectors ??= termVectors(papers.map(paper => tokens(paperText(paper))))

  const WRITTEN = [
    'speculative decoding to accelerate large language model inference', 'KV cache compression for long-context LLM serving',
    'graph neural network over-smoothing in deep message passing', 'classifier-free guidance for diffusion image generation',
    'conservative offline reinforcement learning from fixed datasets', 'federated learning under heterogeneous client data',
    'token pruning for efficient vision transformers', 'contrastive self-supervised representation learning with hard negatives',
    'reward model overoptimization in RLHF', 'adversarial robustness certification with randomized smoothing',
    'mixture of experts routing and load balancing', 'chain-of-thought prompting for mathematical reasoning',
  ]
  const queryRandom = generator(20261001)
  const ideas: string[] = []
  while (ideas.length < 88) {
    const paper = papers[Math.floor(queryRandom() * papers.length)]!
    if (paper.idea.length > 40 && !ideas.includes(paper.idea)) ideas.push(paper.idea)
  }
  const pools = [...WRITTEN, ...ideas].map(query => ({ query, ...rankings(query) }))
  type Pool = typeof pools[number]
  const run = (pool: Pool, annotations: Annotation[], tuning: AnnotationTuning = ANNOTATION_TUNING): AnnotatedRecall =>
    applyAnnotations({ graphs, annotations, patterns: pool.patterns, papers: pool.papers, limits: LIMITS }, tuning)
  return { graph, papers, rankings, hops, degree, neighbours, mark, tuned, weights, ALTERNATIVES, lexical, paperText, WRITTEN, pools, run }
}
type World = ReturnType<typeof createWorld>
type Pool = World['pools'][number]

describe.skipIf(process.env.RESEARCH_KG_EVAL !== '1')('marks on the shipped graph', () => {
  let world: World
  beforeAll(() => { world = createWorld() }, 300_000)
  const roots: string[] = []
  afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

  it('feeds the rankings recall itself produces', async () => {
    const { WRITTEN, rankings, graph, papers } = world
    const base = new KnowledgeBase(GRAPH_PATH)
    const root = await mkdtemp(join(tmpdir(), 'research annotations eval '))
    roots.push(root)
    try {
      for (const query of WRITTEN) {
        const recalled = await base.recall(root, query, VIEW, undefined, new AbortController().signal)
        const own = rankings(query)
        const expected = own.patterns.slice(0, VIEW).map(item => [graph.patterns[item.index]!.id, Math.round(item.score * 1e5) / 1e5])
        expect(recalled.patterns.map(item => [item.id, item.score])).toEqual(expected)
        expect(recalled.closestPapers.map(item => item.id)).toEqual(own.papers.slice(0, VIEW).map(item => papers[item.index]!.id))
      }
    } finally { base.dispose() }
  }, 120_000)

  it('leaves the ranking as it is without marks, with an orphaned mark, and around a pin far from the query', () => {
    const { pools, run, mark, hops, papers, degree } = world
    const random = generator(7)
    // Only the fields recall reads from a candidate: graph, index and score, in order.
    const strip = (items: RecallCandidate[]): string => JSON.stringify(items.map(item => [item.graph, item.index, item.score]))
    let unmarked = 0, orphaned = 0, far = 0, farPins = 0
    for (const pool of pools) {
      const plain = strip(pool.patterns.slice(0, VIEW)) + strip(pool.papers.slice(0, VIEW))
      const none = run(pool, [])
      if (strip(none.patterns) + strip(none.papers) === plain && [...none.patterns, ...none.papers].every(item => item.why.kind === 'unchanged')) unmarked++
      const orphan = { ...mark('paper', 0, 'irrelevant'), id: 'ai:paper:no-such-paper', target: { kind: 'paper' as const, graph: 'ai' as const, id: 'no-such-paper' } }
      const withOrphan = run(pool, [orphan])
      if (strip(withOrphan.patterns) + strip(withOrphan.papers) === plain && withOrphan.summary.orphaned === 1) orphaned++
      const near = hops(pool.papers.map(item => item.index), 4)
      const recalledPatterns = new Set(pool.patterns.map(item => item.index))
      let pin = -1
      for (let tries = 0; tries < 1000 && pin < 0; tries++) {
        const v = Math.floor(random() * papers.length)
        if (!near.has(v) && !recalledPatterns.has(papers[v]!.pattern) && degree(v) > 0) pin = v
      }
      if (pin < 0) continue
      farPins++
      const pinned = run(pool, [mark('paper', pin, 'pin', 0, 'the person keeps this')])
      const first = pinned.papers[0]!
      if (first.index === pin && first.why.kind === 'pinned' && !first.why.recalled && strip(pinned.papers.slice(1)) === strip(pool.papers.slice(0, VIEW))
        && strip(pinned.patterns) === strip(pool.patterns.slice(0, VIEW))) far++
    }
    console.log(`\nS0 identity over ${pools.length} queries: no marks ${unmarked}, one orphaned mark ${orphaned}; S1 pin far from the query listed first with the ranked lists unchanged: ${far} of ${farPins}`)
    expect([unmarked, orphaned]).toEqual([pools.length, pools.length])
    expect(far).toBe(farPins)
  })

  it('describes how related papers are by the links between them, and what walking the links costs', () => {
    const { papers, hops, degree, neighbours, lexical } = world
    const vec = lexical()
    const random = generator(12345)
    let pairs = 0, pairsSame = 0, pairsCos = 0
    for (let k = 0; k < 200_000; k++) {
      const a = Math.floor(random() * papers.length), b = Math.floor(random() * papers.length)
      if (a === b || papers[a]!.pattern < 0 || papers[b]!.pattern < 0) continue
      pairs++
      if (papers[a]!.pattern === papers[b]!.pattern) pairsSame++
      pairsCos += cosine(vec[a]!, vec[b]!)
    }
    const level = [1, 2, 3, 4].map(() => ({ papers: 0, labelled: 0, same: 0, cos: 0 }))
    const direct = { reciprocal: { n: 0, same: 0 }, 'one way': { n: 0, same: 0 } }
    // Two links away, by the number of shortest routes (4 stands for four or more); one link away, by the marked paper's degree.
    const routes = [1, 2, 3, 4].map(() => ({ n: 0, same: 0 }))
    const byDegree = new Map<string, { n: number; same: number }>([['6 or fewer', { n: 0, same: 0 }], ['7 to 14', { n: 0, same: 0 }], ['15 or more', { n: 0, same: 0 }]])
    const listed = papers.map(paper => new Set(paper.similar))
    const seeds = 1500
    for (let s = 0; s < seeds; s++) {
      let x = -1
      while (x < 0) { const v = Math.floor(random() * papers.length); if (papers[v]!.pattern >= 0 && degree(v) > 0) x = v }
      const one = new Set(neighbours[x])
      for (const v of new Set(neighbours[x]!.flatMap(u => neighbours[u]!))) {
        if (v === x || one.has(v) || papers[v]!.pattern < 0) continue
        const entry = routes[Math.min(neighbours[v]!.filter(u => one.has(u)).length, 4) - 1]!
        entry.n++
        if (papers[v]!.pattern === papers[x]!.pattern) entry.same++
      }
      const bucket = byDegree.get(degree(x) <= 6 ? '6 or fewer' : degree(x) <= 14 ? '7 to 14' : '15 or more')!
      for (const v of one) {
        if (papers[v]!.pattern < 0) continue
        bucket.n++
        if (papers[v]!.pattern === papers[x]!.pattern) bucket.same++
      }
      for (const [v, h] of hops([x], 4)) {
        if (h === 0) continue
        const entry = level[h - 1]!
        entry.papers++
        entry.cos += cosine(vec[x]!, vec[v]!)
        if (papers[v]!.pattern < 0) continue
        const same = papers[v]!.pattern === papers[x]!.pattern
        entry.labelled++
        if (same) entry.same++
        if (h === 1) {
          const kind = listed[x]!.has(v) && listed[v]!.has(x) ? direct.reciprocal : direct['one way']
          kind.n++
          if (same) kind.same++
        }
      }
    }
    table(`Relatedness by links, ${seeds} papers; random pairs share a pattern ${fmt(pairsSame / pairs, 4)} of the time, mean lexical cosine ${fmt(pairsCos / pairs, 4)}`,
      ['links', 'papers per paper', 'share in the same pattern', 'mean lexical cosine'],
      level.map((entry, h) => [h + 1, fmt(entry.papers / seeds, 1), fmt(entry.same / entry.labelled), fmt(entry.cos / entry.papers, 4)]))
    console.log(`One link, both papers list each other: ${fmt(direct.reciprocal.same / direct.reciprocal.n)} share the pattern; one lists the other: ${fmt(direct['one way'].same / direct['one way'].n)}`)
    console.log(`Two links, by shortest routes 1/2/3/4+: ${routes.map(entry => `${fmt(entry.same / entry.n)} (n=${entry.n})`).join(' / ')}`)
    console.log(`One link, by the marked paper's degree: ${[...byDegree].map(([name, entry]) => `${name} ${fmt(entry.same / entry.n)}`).join(', ')}`)
    const steps = (x: number, depth: number): number => {
      let count = 0
      const path = [x]
      const walk = (u: number, length: number): void => {
        for (const v of neighbours[u]!) {
          if (path.includes(v)) continue
          count++
          if (length < depth) { path.push(v); walk(v, length + 1); path.pop() }
        }
      }
      walk(x, 1)
      return count
    }
    const cost = [2, 3, 4].map((depth) => {
      const counts = papers.flatMap((_, x) => depth < 4 || x % 29 === 0 ? [steps(x, depth)] : []).sort((a, b) => a - b)
      return [depth, fmt(mean(counts), 0), counts[Math.floor(counts.length * 0.99)]!, counts.at(-1)!]
    })
    table('Simple paths a mark walks (depth 4 sampled on every 29th paper)', ['depth', 'mean paths', '99th percentile', 'most'], cost)
    expect(level[0]!.same / level[0]!.labelled).toBeGreaterThan(level[3]!.same / level[3]!.labelled)
  }, 600_000)

  it('compares spreading methods by which nearby papers share the marked paper\'s pattern', () => {
    const { papers, degree, hops, lexical, ALTERNATIVES, weights, tuned } = world
    const random = generator(4242)
    const seeds: number[] = []
    while (seeds.length < 400) {
      const x = Math.floor(random() * papers.length)
      if (papers[x]!.pattern >= 0 && degree(x) > 0 && !seeds.includes(x)) seeds.push(x)
    }
    const balls = seeds.map(x => hops([x], 3))
    const vec = lexical()
    const rows: (string | number)[][] = []
    const measured: Record<string, { auc: number; hop1: number; ece: number }> = {}
    const evaluate = (name: string, score: (x: number, pool: number[]) => Map<number, number>, bounded: boolean): void => {
      const all: [number, boolean][] = [], byHop: [number, boolean][][] = [[], [], [], []], xs: number[] = [], ys: number[] = []
      const bins = Array.from({ length: 10 }, () => ({ n: 0, sum: 0, same: 0 }))
      const level: number[][] = [[], [], [], []]
      const started = performance.now()
      seeds.forEach((x, s) => {
        const ball = balls[s]!
        const pool = [...ball.keys()].filter(v => v !== x)
        const values = score(x, pool)
        for (const v of pool) {
          const value = values.get(v) ?? 0, h = ball.get(v)!
          level[h]!.push(value)
          if (xs.length < 80_000) { xs.push(value); ys.push(cosine(vec[x]!, vec[v]!)) }
          if (papers[v]!.pattern < 0) continue
          const same = papers[v]!.pattern === papers[x]!.pattern
          all.push([value, same])
          byHop[h]!.push([value, same])
          const bin = bins[Math.min(9, Math.floor(value * 10))]!
          bin.n++; bin.sum += value; if (same) bin.same++
        }
      })
      const ms = (performance.now() - started) / seeds.length
      const total = bins.reduce((s, b) => s + b.n, 0)
      const ece = bounded ? bins.reduce((s, b) => s + (b.n ? b.n / total * Math.abs(b.sum / b.n - b.same / b.n) : 0), 0) : NaN
      measured[name] = { auc: auc(all), hop1: auc(byHop[1]!), ece }
      rows.push([name, fmt(auc(all)), fmt(auc(byHop[1]!)), fmt(auc(byHop[2]!)), fmt(auc(byHop[3]!)), fmt(spearman(xs, ys)), fmt(ece), level.slice(1).map(v => fmt(mean(v), 2)).join(' / '), fmt(ms, 2)])
    }
    for (const [name, method] of Object.entries(ALTERNATIVES)) evaluate(name, x => method(x), name.startsWith('hop') || name.startsWith('noisy'))
    for (const [transmission, depth] of [[0.5, 1], [0.5, 2], [0.3, 3], [0.4, 3], [0.5, 3], [0.65, 3], [0.8, 3]] as const) {
      evaluate(`chosen: simple-path noisy-OR, t=${transmission}, depth ${depth}`, (x, pool) => weights(x, pool, tuned({ transmission, depth })), true)
    }
    table(
      'A. 400 marked papers, every paper within 3 links. AUC: shares the marked paper\'s pattern. rho: Spearman with lexical TF-IDF cosine. ECE: calibration error of a 0-1 weight.',
      ['method', 'AUC', 'AUC 1 link', 'AUC 2 links', 'AUC 3 links', 'rho', 'ECE', 'mean weight at 1/2/3 links', 'ms per mark'], rows,
    )
    const bins = Array.from({ length: 10 }, () => ({ n: 0, sum: 0, same: 0 }))
    const above = [0, 0, 0, 0], reached = [0, 0, 0, 0]
    seeds.forEach((x, s) => {
      const ball = balls[s]!
      const pool = [...ball.keys()].filter(v => v !== x)
      const values = weights(x, pool)
      for (const v of pool) {
        const h = ball.get(v)!
        reached[h]!++
        if (values.get(v)! >= ANNOTATION_TUNING.threshold) above[h]!++
        if (papers[v]!.pattern < 0) continue
        const bin = bins[Math.min(9, Math.floor(values.get(v)! * 10))]!
        bin.n++; bin.sum += values.get(v)!; if (papers[v]!.pattern === papers[x]!.pattern) bin.same++
      }
    })
    table('Calibration of the production setting', ['weight', 'papers', 'mean weight', 'share in the marked paper\'s pattern'],
      bins.flatMap((b, k) => b.n ? [[`${(k / 10).toFixed(1)}-${((k + 1) / 10).toFixed(1)}`, b.n, fmt(b.sum / b.n), fmt(b.same / b.n)]] : []))
    console.log(`Papers per mark at 1/2/3 links: ${[1, 2, 3].map(h => fmt(reached[h]! / seeds.length, 1)).join(' / ')}; share at or above the threshold: ${[1, 2, 3].map(h => fmt(above[h]! / reached[h]!, 2)).join(' / ')}`)
    const chosen = measured['chosen: simple-path noisy-OR, t=0.5, depth 3']!
    expect(chosen.ece).toBeLessThan(0.1)
    expect(chosen.hop1).toBeGreaterThan(measured['personalised PageRank, symmetric, restart 0.15']!.hop1)
    expect(chosen.auc).toBeGreaterThan(measured['hop decay 0.5^h']!.auc)
  }, 600_000)

  type Scenario = (pool: Pool) => { marks: Annotation[]; marked: number[] }
  const topHit: Scenario = pool => ({ marks: [world.mark('paper', pool.papers[0]!.index, 'irrelevant')], marked: [pool.papers[0]!.index] })
  const fiveNearest: Scenario = (pool) => {
    const x = pool.papers[0]!.index
    const group = [x, ...world.papers[x]!.similar.slice(0, 4)]
    return { marks: group.map((index, k) => world.mark('paper', index, 'irrelevant', k)), marked: group }
  }
  /** Moves in the paper view by links from the nearest marked paper, churn of the views, and the largest drop. */
  type Effects = Record<'churn' | 'demoted' | 'top3' | 'move1' | 'move2' | 'move3' | 'move4' | 'maxDrop' | 'patternChurn' | 'patternsDemoted', number>
  function measure(scenario: Scenario, tuning: AnnotationTuning): Effects {
    const { pools, run, hops } = world
    const totals: Record<string, number> = {}
    const add = (key: string, value: number): void => { totals[key] = (totals[key] ?? 0) + value }
    let maxDrop = 0
    for (const pool of pools) {
      const { marks, marked } = scenario(pool)
      const result = run(pool, marks, tuning)
      const distance = hops(marked, 6)
      const view = pool.papers.filter(item => !marked.includes(item.index)).slice(0, VIEW)
      const ranked = result.papers.filter(item => item.why.kind !== 'pinned')
      const after = new Set(ranked.map(item => item.index))
      add('churn', view.filter(item => !after.has(item.index)).length)
      add('demoted', ranked.filter(item => item.why.kind === 'demoted').length)
      add('top3', view.slice(0, 3).filter(item => !after.has(item.index)).length)
      view.forEach((item, place) => {
        const now = ranked.findIndex(entry => entry.index === item.index)
        const drop = (now === -1 ? VIEW : now) - place
        const h = Math.min(distance.get(item.index) ?? 9, 4)
        add(`move${h}`, drop)
        add(`count${h}`, 1)
        maxDrop = Math.max(maxDrop, drop)
      })
      const patternsAfter = new Set(result.patterns.filter(item => item.why.kind !== 'pinned').map(item => item.index))
      add('patternChurn', pool.patterns.slice(0, VIEW).filter(item => !patternsAfter.has(item.index)).length)
      add('patternsDemoted', result.patterns.filter(item => item.why.kind === 'demoted').length)
    }
    const per = (key: string): number => (totals[key] ?? 0) / pools.length
    const move = (h: number): number => (totals[`move${h}`] ?? 0) / Math.max(1, totals[`count${h}`] ?? 0)
    return { churn: per('churn'), demoted: per('demoted'), top3: per('top3'), move1: move(1), move2: move(2), move3: move(3), move4: move(4), maxDrop, patternChurn: per('patternChurn'), patternsDemoted: per('patternsDemoted') }
  }
  const HEAD = ['setting', 'paper churn of 8', 'demoted in view', 'top-3 left view', 'move 1 link', 'move 2 links', 'move 3 links', 'move 4+ links', 'largest drop', 'pattern churn of 8', 'patterns demoted']
  const row = (label: string, r: Effects): (string | number)[] => [
    label, ...(['churn', 'demoted', 'top3', 'move1', 'move2', 'move3', 'move4'] as const).map(key => fmt(r[key], 2)), r.maxDrop,
    fmt(r.patternChurn, 2), fmt(r.patternsDemoted, 2),
  ]

  it('measures what the marks do to recall\'s views', () => {
    const { pools, run, mark, papers, tuned } = world
    const s2 = measure(topHit, ANNOTATION_TUNING), s3 = measure(fiveNearest, ANNOTATION_TUNING)
    table(`B. ${pools.length} queries (12 written, 88 paper ideas), production tuning; moves are places down (+) or up (-) in the 8-paper view`, HEAD, [
      row('S2 top paper hit marked irrelevant', s2), row('S3 top hit and its 4 nearest marked irrelevant', s3),
      row('S2, exact target only (no spread)', measure(topHit, tuned({ threshold: 2 }))),
    ])
    expect([s2.top3, s3.top3]).toEqual([0, 0])
    expect(s2.move1).toBeGreaterThan(s2.move2)
    let pinnedFirst = 0, both = 0, netDown = 0, netUp = 0
    for (const pool of pools) {
      const x = pool.papers[0]!.index
      const result = run(pool, [mark('paper', x, 'pin'), mark('paper', papers[x]!.similar[0]!, 'irrelevant', 1)])
      if (result.papers[0]!.index === x && result.papers[0]!.why.kind === 'pinned') pinnedFirst++
      for (const item of result.papers) {
        if ((item.why.kind === 'demoted' || item.why.kind === 'boosted') && item.why.counter) { both++; if (item.why.kind === 'demoted') netDown++; else netUp++ }
      }
    }
    console.log(`S4 pin the top hit and mark its nearest neighbour irrelevant: pin listed first in ${pinnedFirst}/${pools.length}; ${both} results weighed on both ways, ${netDown} net down, ${netUp} net up`)
    expect(pinnedFirst).toBe(pools.length)
    const places: number[] = [], skipped: number[] = [], inPattern: number[] = []
    for (const pool of pools) {
      const top = pool.patterns[0]!.index
      const own = papers.flatMap((paper, i) => paper.pattern === top ? [i] : [])
      const three = run(pool, own.slice(0, 3).map((index, k) => mark('paper', index, 'irrelevant', k)))
      const place = three.patterns.findIndex(item => item.index === top)
      places.push(place === -1 ? VIEW + 1 : place + 1)
      const whole = run(pool, [mark('pattern', top, 'irrelevant', 0, 'not my setting')])
      skipped.push(whole.skipped.filter(item => item.kind === 'pattern').length)
      inPattern.push(whole.papers.filter(item => item.why.kind === 'demoted' && item.why.nearest.relation === 'in-pattern').length)
    }
    console.log(`S5 three papers of the top pattern marked irrelevant: the pattern moves from place 1 to ${fmt(mean(places), 2)} on average (at most ${Math.max(...places)}); the pattern marked itself is skipped in ${skipped.filter(Boolean).length}/${pools.length} and ${fmt(mean(inPattern), 2)} of its papers in the paper view move down`)
    expect(skipped.every(Boolean)).toBe(true)
    const boosted: number[] = [], entered: number[] = []
    for (const pool of pools) {
      const pin = pool.papers[4]!.index
      const ranked = run(pool, [mark('paper', pin, 'pin')]).papers.filter(item => item.why.kind !== 'pinned')
      boosted.push(ranked.filter(item => item.why.kind === 'boosted').length)
      const view = new Set(pool.papers.filter(item => item.index !== pin).slice(0, VIEW).map(item => item.index))
      entered.push(ranked.filter(item => !view.has(item.index)).length)
    }
    console.log(`S6 pin the fifth paper hit: ${fmt(mean(boosted), 2)} papers in the view move up and ${fmt(mean(entered), 2)} enter it from below`)
  }, 600_000)

  it('shows how the views respond to each constant', () => {
    const { tuned } = world
    const s2: (string | number)[][] = []
    for (const transmission of [0.3, 0.4, 0.5, 0.65, 0.8]) s2.push(row(`transmission ${transmission}`, measure(topHit, tuned({ transmission }))))
    for (const depth of [1, 2, 3]) s2.push(row(`depth ${depth}`, measure(topHit, tuned({ depth }))))
    const byBound = [1, 2, 3, 4, 6, 8].map(bound => [bound, measure(topHit, tuned({ maxDemotion: bound, maxPromotion: bound }))] as const)
    for (const [bound, r] of byBound) s2.push(row(`largest move ${bound}`, r))
    for (const threshold of [0, 0.1, 0.15, 0.25, 0.35]) s2.push(row(`threshold ${threshold}`, measure(topHit, tuned({ threshold }))))
    table('C. Sensitivity, scenario S2 (top paper hit marked irrelevant), one constant changed at a time', HEAD, s2)
    const s3: (string | number)[][] = []
    for (const bound of [1, 2, 3, 4, 6]) s3.push(row(`largest move ${bound}`, measure(fiveNearest, tuned({ maxDemotion: bound, maxPromotion: bound }))))
    for (const transmission of [0.3, 0.5, 0.8]) s3.push(row(`transmission ${transmission}`, measure(fiveNearest, tuned({ transmission }))))
    table('C. Sensitivity, scenario S3 (top hit and its 4 nearest marked irrelevant)', HEAD, s3)
    for (let k = 1; k < byBound.length; k++) expect(byBound[k]![1].churn).toBeGreaterThanOrEqual(byBound[k - 1]![1].churn)
  }, 600_000)

  it('compares methods inside recall\'s own candidates', () => {
    const { lexical, pools, papers, weights, ALTERNATIVES, paperText, neighbours } = world
    const vec = lexical()
    const results: Record<string, { all: [number, boolean][]; touched: number[]; hits: number; picked: number }> = {}
    let linked = 0, stillDown = 0
    for (const pool of pools) {
      const x = pool.papers[0]!.index
      if (papers[x]!.pattern < 0) continue
      const others = pool.papers.slice(1).map(item => item.index)
      const same = (v: number): boolean => papers[v]!.pattern === papers[x]!.pattern
      const production = weights(x, others)
      // Every method is judged on its top m candidates, m being how many the production setting moves.
      const m = others.filter(v => production.get(v)! >= ANNOTATION_TUNING.threshold).length
      const score = (name: string, values: Map<number, number>): void => {
        const entry = results[name] ??= { all: [], touched: [], hits: 0, picked: 0 }
        entry.all.push(...others.filter(v => papers[v]!.pattern >= 0).map((v): [number, boolean] => [values.get(v) ?? 0, same(v)]))
        entry.touched.push(others.filter(v => (values.get(v) ?? 0) > 0).length)
        const top = [...others].sort((a, b) => (values.get(b) ?? 0) - (values.get(a) ?? 0)).slice(0, m)
        entry.picked += top.length
        entry.hits += top.filter(same).length
      }
      score('chosen: simple-path noisy-OR, t=0.5, depth 3', production)
      for (const [name, method] of Object.entries(ALTERNATIVES)) if (/PageRank|Katz/.test(name)) score(name, method(x))
      score('Rocchio on TF-IDF: cosine to the marked paper', new Map(others.map(v => [v, cosine(vec[x]!, vec[v]!)])))
      const query = new Set(tokens(pool.query))
      const words = (i: number): Set<string> => new Set(tokens(paperText(papers[i]!)).filter(word => !query.has(word)))
      const own = words(x)
      const jaccard = (other: Set<string>): number => {
        const shared = [...other].filter(word => own.has(word)).length
        return shared / (own.size + other.size - shared || 1)
      }
      score('Rocchio without the query\'s words: Jaccard to the marked paper', new Map(others.map(v => [v, jaccard(words(v))])))
      // Personalised PageRank with the marked paper as the negative seed and the next five hits as positive seeds.
      const negative = ALTERNATIVES['personalised PageRank, row-normalised, restart 0.15']!(x)
      const positive = new Map<number, number>()
      for (const hit of pool.papers.slice(1, 6)) for (const [v, mass] of ALTERNATIVES['personalised PageRank, row-normalised, restart 0.15']!(hit.index)) positive.set(v, (positive.get(v) ?? 0) + mass / 5)
      for (const v of neighbours[x]!) {
        if (!others.includes(v)) continue
        linked++
        if ((negative.get(v) ?? 0) > (positive.get(v) ?? 0)) stillDown++
      }
    }
    table('D. Inside recall\'s 30 paper candidates, top hit marked irrelevant', ['method', 'AUC', 'other candidates touched (of 29)', 'precision at the chosen method\'s spread'],
      Object.entries(results).map(([name, r]) => [name, fmt(auc(r.all)), fmt(mean(r.touched), 1), fmt(r.hits / r.picked)]))
    console.log(`Signed PageRank with the next five hits as positive seeds: ${stillDown} of the ${linked} candidates linked to the marked paper stay net demoted`)
    const precision = (name: string): number => results[name]!.hits / results[name]!.picked
    expect(precision('chosen: simple-path noisy-OR, t=0.5, depth 3')).toBeGreaterThan(precision('Rocchio on TF-IDF: cosine to the marked paper'))
  }, 600_000)

  it('prepares a graph once and re-ranks in milliseconds', () => {
    const { papers, mark, pools } = world
    const fresh = JSON.parse(gunzipSync(readFileSync(GRAPH_PATH)).toString('utf8')) as GraphFile
    const random = generator(99)
    let started = performance.now()
    prepareAnnotationGraph(fresh)
    const prepare = performance.now() - started
    const rows: (string | number)[][] = []
    let warmThousand = Infinity
    for (const count of [1, 10, 100, 1000]) {
      const marks: Annotation[] = []
      const used = new Set<number>()
      while (marks.length < count) {
        const i = Math.floor(random() * papers.length)
        if (used.has(i)) continue
        used.add(i)
        marks.push(mark('paper', i, random() < 0.5 ? 'pin' : 'irrelevant', marks.length))
      }
      const pool = pools[0]!
      const time = (): number => {
        started = performance.now()
        applyAnnotations({ graphs: { ai: fresh }, annotations: marks, patterns: pool.patterns, papers: pool.papers, limits: LIMITS })
        return performance.now() - started
      }
      const first = time()
      const warm = Array.from({ length: 15 }, time).sort((a, b) => a - b)
      if (count === 1000) warmThousand = warm[7]!
      rows.push([count, fmt(first, 1), fmt(warm[7]!, 2), fmt(warm[0]!, 2)])
    }
    table(`E. Runtime; preparing the graph took ${fmt(prepare, 1)} ms`, ['marks', 'first call ms', 'median of 15 later calls ms', 'fastest ms'], rows)
    expect(warmThousand).toBeLessThan(250)
  }, 600_000)
})
