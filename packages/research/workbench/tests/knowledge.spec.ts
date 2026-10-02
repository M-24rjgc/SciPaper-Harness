import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  createEmbedder, KnowledgeBase, KNOWLEDGE_LINK, MAX_CORPUS, PROJECT_CLUSTERS, PROJECT_GRAPH, returnedItems, type Embedder, type GraphFile,
} from '../src/knowledge.ts'
import { recallTrace } from '../src/knowledge-trace.ts'
import { writeHonour } from '../src/knowledge-marks-state.ts'
import { ANNOTATIONS_FILE, setAnnotation } from '../src/knowledge-annotations.ts'

const roots: string[] = []
const bases: KnowledgeBase[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  for (const base of bases.splice(0)) base.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true })
})
const signal = new AbortController().signal

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'research knowledge '))
  roots.push(root)
  return root
}

async function write(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

const pattern = (id: string, name: string, extra: Partial<GraphFile['patterns'][number]> = {}): GraphFile['patterns'][number] => ({
  id, name, domain: 0, subDomains: ['Attention'], size: 2, coherence: 0.7, tier: 'A', summary: `${name} summary`, details: '', ideas: [], exemplars: [0], works: [[0, 0.1, 1]], ...extra,
})
const paper = (id: string, title: string, patternIndex: number, similar: number[] = []): GraphFile['papers'][number] => ({
  id, title, pattern: patternIndex, domain: 0, idea: `${title} idea`, problem: 'problem', solution: 'solution', story: `${title} story`, score: 0.6, similar,
})

/** A small built-in graph: sparse attention, graph learning, and a paper without a pattern. */
const BUILTIN: GraphFile = {
  version: 1, name: 'ai', description: 'Test graph', paperUrl: 'https://openreview.net/forum?id={id}', domains: ['Machine Learning'],
  patterns: [
    pattern('pattern_0', 'Sparse attention at scale', { ideas: ['Prune attention blocks'], details: 'Ideas: sparse kernels' }),
    pattern('pattern_1', 'Message passing reframed', { exemplars: [2], coherence: null, works: [] }),
  ],
  papers: [
    paper('p0', 'Block sparse attention kernels', 0, [1]),
    paper('p1', 'Linear attention approximations', 0, [0]),
    paper('p2', 'Graph message passing networks', 1, [3]),
    paper('p3', 'Unclustered sparse attention note', -1, [2]),
  ],
}

async function builtinBase(file: GraphFile = BUILTIN, idleMs?: number): Promise<{ base: KnowledgeBase; path: string }> {
  const path = join(await temp(), 'kg.json.gz')
  await write(path, gzipSync(JSON.stringify(file)))
  const base = new KnowledgeBase(path, idleMs)
  bases.push(base)
  return { base, path }
}

/** An embedder that places texts about attention, about graphs, and anything else on three axes. */
function embedder(fail: (texts: string[]) => boolean = () => false): Embedder & { calls: string[][] } {
  const calls: string[][] = []
  return {
    model: 'fake-embed', calls,
    async embed(texts) {
      calls.push(texts)
      if (fail(texts)) throw new Error('endpoint down')
      const axis = (text: string): Float32Array => /graph|message/i.test(text)
        ? Float32Array.of(0.1, 1, 0)
        : /attention|sparse/i.test(text) ? Float32Array.of(1, 0.1, 0) : Float32Array.of(0, 0, 1)
      return texts.map(axis)
    },
  }
}

describe('recall', () => {
  it('keeps a healthy project graph when the built-in graph is missing, and supports direct claims without Spark files', async () => {
    const root = await temp()
    const base = new KnowledgeBase(join(root, 'missing.gz')); bases.push(base)
    const empty = await base.recall(root, 'attention', 5, embedder(), signal)
    expect(empty.basis).toBe('lexical')
    expect(empty.patterns).toEqual([])
    expect(empty.note).toMatch(/No graph is available/)
    await write(join(root, PROJECT_GRAPH), JSON.stringify({ ...BUILTIN, name: 'custom' }))
    const result = await base.recall(root, 'sparse attention', 5, undefined, signal)
    expect(result.patterns[0]?.graph).toBe('custom')
    const report = await base.novelty(root, 'story.json', 'report.json', undefined, signal, 1_000_000,
      { claim: 'Sparse attention for long context', references: [{ title: 'Related paper', text: 'Sparse attention reduces kernel cost' }] })
    expect(report.basis).toMatch(/lexical/)
    expect(report.risk_level).toBe('unknown')
    expect(report.top_similar.map(item => item.ref)).toContain('Related paper')
    expect(JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))).toEqual(report)
  })

  it('pages real graph relations, filters sources and domains, and isolates corrupt graph files', async () => {
    const { base } = await builtinBase()
    const root = await temp()
    await write(join(root, PROJECT_GRAPH), '{broken')
    const first = await base.view(root, { source: 'all', limit: 1 })
    expect(first.graphs.map(graph => graph.source)).toEqual(['ai'])
    expect(first.warnings.length).toBe(1)
    expect(first.total).toBe(2)
    expect(first.hasMore).toBe(true)
    expect(first.nodes.filter(node => node.kind === 'pattern')).toHaveLength(1)
    const nodes = new Set(first.nodes.map(node => node.id))
    expect(first.edges.every(edge => nodes.has(edge.from) && nodes.has(edge.to))).toBe(true)
    const next = await base.view(root, { offset: 1, limit: 1 })
    expect(next.hasMore).toBe(false)
    expect(next.nodes.find(node => node.kind === 'pattern')?.id).not.toBe(first.nodes.find(node => node.kind === 'pattern')?.id)
    expect((await base.view(root, { source: 'project' })).nodes).toEqual([])
    expect((await base.view(root, { domain: 'unknown' })).nodes).toEqual([])
    const search = await base.view(root, { query: 'message passing' })
    expect(search.nodes.find(node => node.kind === 'pattern')?.label).toBe('Message passing reframed')
    expect(search.nodes.find(node => node.kind === 'paper')?.url).toMatch(/^https:\/\//)
  })

  it('ranks patterns lexically, says why each was recalled, and lists the closest papers with links', async () => {
    const { base } = await builtinBase()
    const root = await temp()
    const result = await base.recall(root, 'sparse attention kernels for long context', 5, undefined, signal)
    expect(result.basis).toBe('lexical')
    expect(result.note).toMatch(/match of words, not of meaning/)
    expect(result.patterns[0]).toMatchObject({
      graph: 'ai', id: 'pattern_0', name: 'Sparse attention at scale', tier: 'A', domain: 'Machine Learning', ideas: ['Prune attention blocks'],
      worksWellIn: [{ domain: 'Machine Learning', effectiveness: 0.1, confidence: 1 }],
      exemplars: [{ title: 'Block sparse attention kernels', url: 'https://openreview.net/forum?id=p0', score: 0.6 }],
    })
    expect(result.patterns[0]?.matchedPapers).toContain('Block sparse attention kernels')
    expect(result.closestPapers[0]).toMatchObject({ graph: 'ai', id: 'p0', pattern: 'Sparse attention at scale' })
    expect(result.closestPapers.find(item => item.id === 'p3')?.pattern).toBeNull()
    // Each item names itself by the id the Conversation view's traces hold, so the agent can cite it as a `kg:` link.
    expect(result.patterns[0]?.link).toBe('kg:ai:pattern:pattern_0')
    expect(result.closestPapers[0]?.link).toBe('kg:ai:paper:p0')
    expect(returnedItems(result).patterns.map(item => `${KNOWLEDGE_LINK}${item.graph}:pattern:${item.id}`))
      .toEqual(result.patterns.map(item => item.link))
    expect(returnedItems(result).papers.map(item => `${KNOWLEDGE_LINK}${item.graph}:paper:${item.id}`))
      .toEqual(result.closestPapers.map(item => item.link))
    const linked = [...result.patterns, ...result.closestPapers].map(item => item.link.slice(KNOWLEDGE_LINK.length))
    expect(recallTrace('sparse attention', result, returnedItems(result)).nodes.map(node => node.id).sort()).toEqual([...new Set(linked)].sort())
    // The graph source and index that the result's own fields lack stay beside it.
    expect(returnedItems(result).patterns[0]).toEqual({ graph: 'ai', index: 0, id: 'pattern_0', label: 'Sparse attention at scale' })
    expect(returnedItems(result).papers[0]).toEqual({ graph: 'ai', index: 0, id: 'p0', label: 'Block sparse attention kernels' })
    expect(returnedItems({ ...result })).toEqual({ patterns: [], papers: [] })
    // The host loads this module twice (bundled entry and unbundled plugin), so the items sit under a registry symbol on a
    // property that JSON and spread skip: a second copy of the module reads them under the same key.
    const key = Symbol.for('@deepseek-ai/dsh-research-workbench/recall-returned')
    expect(Object.getOwnPropertyDescriptor(result, key)).toMatchObject({ enumerable: false, value: returnedItems(result) })
    expect(Object.keys(result)).toEqual(['basis', 'note', 'patterns', 'closestPapers'])
    // A query without any known word still returns nothing rather than failing.
    expect((await base.recall(root, 'zzz', 5, undefined, signal)).patterns).toEqual([])
  })

  it('adds semantic ranking with an embedding endpoint, caches pattern vectors, and falls back when it fails', async () => {
    const { base } = await builtinBase()
    const root = await temp()
    const semantic = embedder()
    const result = await base.recall(root, 'message passing on graphs', 2, semantic, signal)
    expect(result.basis).toBe('semantic+lexical')
    expect(result.note).toMatch(/fake-embed/)
    expect(result.patterns[0]?.id).toBe('pattern_1')
    await base.recall(root, 'graphs again', 2, semantic, signal)
    // The query is embedded each time; the pattern texts only once.
    expect(semantic.calls.map(texts => texts.length)).toEqual([1, 2, 1])
    const broken = await base.recall(root, 'graphs', 2, embedder(() => true), signal)
    expect(broken).toMatchObject({ basis: 'lexical', note: expect.stringMatching(/^The embedding endpoint failed \(endpoint down\)/) as unknown })
  })

  it('reads a project graph beside the built-in one, reloads it when it changes, and forgets it when removed', async () => {
    const { base } = await builtinBase()
    const root = await temp()
    const project: GraphFile = {
      version: 1, name: 'project', description: 'Project graph', domains: ['HCI'],
      patterns: [pattern('pattern_0', 'Haptic feedback as dialogue', { exemplars: [0] })],
      papers: [{ ...paper('h0', 'Haptic dialogue interfaces', 0), url: 'https://doi.org/10.1/h0' }],
    }
    await write(join(root, PROJECT_GRAPH), JSON.stringify(project))
    const first = await base.recall(root, 'haptic dialogue', 3, undefined, signal)
    expect(first.patterns[0]).toMatchObject({ graph: 'project', name: 'Haptic feedback as dialogue', exemplars: [{ url: 'https://doi.org/10.1/h0' }] })
    // An unchanged graph is read once.
    expect((await base.recall(root, 'haptic dialogue', 3, undefined, signal)).patterns[0]?.name).toBe('Haptic feedback as dialogue')
    expect((await base.status(root, undefined)).project).toEqual({ path: PROJECT_GRAPH, name: 'project', description: 'Project graph', patterns: 1, papers: 1, domains: 1 })
    project.patterns[0]!.name = 'Haptic feedback as conversation'
    await write(join(root, PROJECT_GRAPH), JSON.stringify(project))
    await utimes(join(root, PROJECT_GRAPH), new Date(), new Date(Date.now() + 5000))
    expect((await base.recall(root, 'haptic', 3, undefined, signal)).patterns[0]?.name).toBe('Haptic feedback as conversation')
    await rm(join(root, PROJECT_GRAPH))
    expect((await base.recall(root, 'haptic', 3, undefined, signal)).patterns).toEqual([])
  })
})

describe('recall with marks', () => {
  it('pins, skips and explains by the project marks, reports a damaged marks file, and changes nothing without marks', async () => {
    const { base } = await builtinBase()
    const root = await temp()
    const plain = await base.recall(root, 'sparse attention', 2, undefined, signal)
    expect(plain).not.toHaveProperty('annotations')
    expect(plain.closestPapers.every(item => !('why' in item))).toBe(true)
    expect(plain.patterns.every(item => !('why' in item))).toBe(true)
    await setAnnotation(root, { target: { kind: 'paper', graph: 'ai', id: 'p0' }, verdict: 'irrelevant', note: 'kernels only', by: 'user' })
    await setAnnotation(root, { target: { kind: 'paper', graph: 'ai', id: 'p2' }, verdict: 'pin', by: 'user' })
    const marked = await base.recall(root, 'sparse attention', 2, undefined, signal)
    expect(marked.closestPapers[0]).toMatchObject({ id: 'p2', why: { kind: 'pinned' } })
    expect(marked.closestPapers.some(item => item.id === 'p0')).toBe(false)
    expect(marked.annotations?.skipped).toEqual([expect.objectContaining({ kind: 'paper', note: 'kernels only' })])
    expect(marked.annotations?.applied).not.toBe('')
    expect(marked.annotations?.summary).toMatchObject({ marks: 2, pinned: 1, skipped: 1 })
    expect(marked.patterns.every(item => 'why' in item)).toBe(true)
    expect(returnedItems(marked).papers[0]).toMatchObject({ graph: 'ai', id: 'p2', why: { kind: 'pinned' } })
    await writeFile(join(root, ANNOTATIONS_FILE), '{not json')
    const damaged = await base.recall(root, 'sparse attention', 2, undefined, signal)
    expect(damaged.note).toMatch(/Marks: /)
    expect(damaged).not.toHaveProperty('annotations')
  })

  it('applies no mark while the person has paused them, and again once they resume', async () => {
    const { base } = await builtinBase()
    const root = await temp()
    await setAnnotation(root, { target: { kind: 'paper', graph: 'ai', id: 'p2' }, verdict: 'pin', by: 'user' })
    const plain = await base.recall(root, 'sparse attention', 2, undefined, signal)
    await writeHonour(root, false)
    const paused = await base.recall(root, 'sparse attention', 2, undefined, signal)
    expect(paused.note).toMatch(/paused their marks/)
    expect(paused).not.toHaveProperty('annotations')
    expect(paused.closestPapers[0]?.id).not.toBe('p2')
    expect(paused.closestPapers.map(item => item.id)).not.toEqual(plain.closestPapers.map(item => item.id))
    await writeHonour(root, true)
    expect((await base.recall(root, 'sparse attention', 2, undefined, signal)).closestPapers[0]).toMatchObject({ id: 'p2', why: { kind: 'pinned' } })
  })
  it('hands the parsed built-in graph to the domain map', async () => {
    const { base } = await builtinBase()
    expect((await base.builtinGraph()).papers).toHaveLength(4)
  })
})

describe('graph status and lifetime', () => {
  it('reports the graphs, a broken one, pending clusters and the embedding state', async () => {
    const { base } = await builtinBase()
    const root = await temp()
    expect(await base.status(root, undefined)).toEqual({
      builtin: { name: 'ai', description: 'Test graph', patterns: 2, papers: 4, domains: 1 }, project: null, pendingClusters: null,
      embedding: { configured: false, note: expect.stringMatching(/lexical/) as unknown },
    })
    await write(join(root, PROJECT_GRAPH), '{"version": 2}')
    await write(join(root, PROJECT_CLUSTERS), JSON.stringify({ version: 1, domain: 'hci', basis: 'terms', builtAt: 'now', papers: [], clusters: [] }))
    const broken = await base.status(root, 'text-embedding-3-small')
    expect(broken.project).toMatchObject({ path: PROJECT_GRAPH, error: expect.any(String) as unknown })
    expect(broken.embedding).toEqual({ configured: true, model: 'text-embedding-3-small' })
    await rm(join(root, PROJECT_GRAPH))
    expect((await base.status(root, undefined)).pendingClusters).toEqual({ path: PROJECT_CLUSTERS, clusters: 0, builtAt: 'now' })
    const missing = new KnowledgeBase(join(root, 'absent.json.gz'))
    bases.push(missing)
    expect((await missing.status(root, undefined)).builtin).toMatchObject({ error: expect.any(String) as unknown })
  })

  it('refuses a graph whose indexes point at nothing', async () => {
    const root = await temp()
    const broken: [string, (graph: GraphFile) => void][] = [
      ['pattern pattern_0', (graph) => { graph.patterns[0]!.domain = 5 }],
      ['pattern pattern_0', (graph) => { graph.patterns[0]!.exemplars = [9] }],
      ['pattern pattern_0', (graph) => { graph.patterns[0]!.works = [[-1, 0, 0]] }],
      ['paper p0', (graph) => { graph.papers[0]!.pattern = 7 }],
      ['paper p0', (graph) => { graph.papers[0]!.domain = 3 }],
      ['paper p0', (graph) => { graph.papers[0]!.similar = [4] }],
    ]
    for (const [where, breakIt] of broken) {
      const graph = structuredClone(BUILTIN)
      breakIt(graph)
      const { base } = await builtinBase(graph)
      expect((await base.status(root, undefined)).builtin).toMatchObject({ error: expect.stringContaining(`The graph points outside itself at ${where}`) as unknown })
    }
  })

  it('releases loaded graphs after a quiet spell and loads them again on demand', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { base, path } = await builtinBase(BUILTIN, 1000)
    const root = await temp()
    await base.recall(root, 'sparse', 1, undefined, signal)
    await write(path, gzipSync(JSON.stringify({ ...BUILTIN, description: 'Changed graph' })))
    expect((await base.status(root, undefined)).builtin).toMatchObject({ description: 'Test graph' })
    vi.advanceTimersByTime(1500)
    expect((await base.status(root, undefined)).builtin).toMatchObject({ description: 'Changed graph' })
  })
})

describe('novelty', () => {
  const story = {
    title: 'Sparse attention at a quarter of the cost', abstract: 'Block sparse attention kernels', problem_framing: 'p', gap_pattern: 'g',
    solution: 's', method_skeleton: { steps: ['a'] }, experiments_plan: null, innovation_claims: ['c1'],
  }

  it('compares the story lexically with retrieved abstracts and graph papers, and leaves the risk to judgement', async () => {
    const { base } = await builtinBase()
    const root = await temp()
    await write(join(root, 'story.json'), JSON.stringify(story))
    await write(join(root, 'retrieved_papers.json'), JSON.stringify({ papers: [
      { title: 'BigBird', abstract: 'Sparse attention for long sequences', abstract_source: 'arxiv' },
      { title: 'Missing', abstract: 'x', abstract_source: 'missing' },
      { paper_id: 'no-title', abstract: 'attention kernels' },
      { title: 'Empty', abstract: '   ' },
      { title: 'No abstract field' },
      { abstract: 'anonymous attention' },
    ] }))
    const report = await base.novelty(root, 'story.json', 'novelty_report.json', undefined, signal, 100000)
    expect(report).toMatchObject({ basis: expect.stringMatching(/^lexical/) as unknown, risk_level: 'unknown', threshold_high: 0.88, max_pivots: 2 })
    expect(report.top_similar.map(item => item.ref)).toEqual(expect.arrayContaining(['BigBird', 'no-title', '(untitled)', 'Block sparse attention kernels (graph ai)']))
    expect(report.top_similar.some(item => item.ref === 'Missing')).toBe(false)
    expect(JSON.parse(await readFile(join(root, 'novelty_report.json'), 'utf8'))).toEqual(report)
  })

  it('applies the upstream bands on a semantic basis and falls back when the endpoint fails', async () => {
    const { base } = await builtinBase()
    const root = await temp()
    await write(join(root, 'story.json'), JSON.stringify(story))
    await write(join(root, 'retrieved_papers.json'), JSON.stringify([{ title: 'Near', abstract: 'sparse attention' }]))
    const high = await base.novelty(root, 'story.json', 'out/high.json', embedder(), signal, 100000)
    expect(high).toMatchObject({ risk_level: 'high', basis: expect.stringMatching(/^semantic \(fake-embed\)/) as unknown, max_similarity: 1 })
    expect(high.verdict).toMatch(/pivot/)
    const graded = (vector: Float32Array): Embedder => ({ model: 'm', embed: async texts => texts.map((_, at) => at === 0 ? Float32Array.of(1, 0) : vector) })
    expect((await base.novelty(root, 'story.json', 'n.json', graded(Float32Array.of(0.85, Math.sqrt(1 - 0.85 ** 2))), signal, 100000)).risk_level).toBe('medium')
    expect((await base.novelty(root, 'story.json', 'n.json', graded(Float32Array.of(0, 1)), signal, 100000)).verdict).toMatch(/^Low collision/)
    const fallback = await base.novelty(root, 'story.json', 'n.json', embedder(() => true), signal, 100000)
    expect(fallback.note).toMatch(/^The embedding endpoint failed \(endpoint down\)\. Shared words/)
  })

  it('says when there is nothing to compare with, and refuses a story without story fields', async () => {
    const { base } = await builtinBase()
    const root = await temp()
    await write(join(root, 'story.json'), JSON.stringify({ title: 'zzz qqq', innovation_claims: 'single claim zzz' }))
    const report = await base.novelty(root, 'story.json', 'novelty_report.json', undefined, signal, 100000)
    expect(report).toMatchObject({ basis: 'unconfigured', max_similarity: null, top_similar: [], note: expect.stringMatching(/No reference set/) as unknown })
    // An embedding endpoint does not help without anything to compare with.
    const semantic = embedder()
    expect((await base.novelty(root, 'story.json', 'novelty_report.json', semantic, signal, 100000)).basis).toBe('unconfigured')
    expect(semantic.calls).toEqual([])
    await write(join(root, 'empty.json'), JSON.stringify({ unrelated: 1 }))
    await expect(base.novelty(root, 'empty.json', 'x.json', undefined, signal, 100000)).rejects.toThrow(/has none of the story fields/)
  })
})

describe('building a project graph', () => {
  const extracted = (id: string, topic: 'attention' | 'graph', extra: Record<string, unknown> = {}) => JSON.stringify({
    paper_id: id, title: `${topic} paper ${id}`, story: `Reframes ${topic} ${topic === 'attention' ? 'sparsity as routing' : 'message passing as dialogue'}`,
    base_problem: `${topic} cost`, solution_pattern: `${topic} pattern`, domain: 'ml', sub_domains: [topic], ...extra,
  })

  it('clusters term vectors, reports rejected lines, then names the patterns into a graph that recall reads', async () => {
    const { base } = await builtinBase()
    const root = await temp()
    await write(join(root, 'papers.jsonl'), [
      extracted('a1', 'attention', { review_score: 0.9, idea: 'Route tokens sparsely' }), extracted('a2', 'attention'), extracted('a3', 'attention', { doi: '10.1/a3' }),
      extracted('g1', 'graph', { url: 'https://example.org/g1' }), extracted('g2', 'graph', { domain: 'networks' }), extracted('g3', 'graph'),
      '', 'not json', JSON.stringify({ paper_id: 'x' }), extracted('a1', 'attention'),
    ].join('\n'))
    const built = await base.build(root, 'papers.jsonl', 'ml', undefined, signal)
    expect(built).toMatchObject({ basis: 'terms', papers: 6, saved: PROJECT_CLUSTERS, note: expect.stringMatching(/k-means/) as unknown })
    expect(built.rejected).toEqual([
      'line 8: not JSON', expect.stringMatching(/^line 9: title/), 'line 10: duplicate paper_id a1',
    ])
    expect(built.clusters.map(cluster => cluster.size).sort()).toEqual([3, 3])
    expect(built.clusters[0]?.exemplars[0]).toHaveProperty('story')
    expect(built.next).toMatch(/cluster_meta\.json/)
    const ids = built.clusters.map(cluster => cluster.id)
    await write(join(root, 'cluster_meta.json'), JSON.stringify({
      [ids[0]!]: { name: 'Sparsity recast as routing', summary: 'Routing view', llm_enhanced_summary: 'Richer', tier: 'A' },
      [ids[1]!]: { name: 'Dialogue between graph nodes', summary: 'Dialogue view', tier: 'B' },
    }))
    const named = await base.namePatterns(root, 'cluster_meta.json', 100000)
    expect(named).toMatchObject({ valid: true, saved: PROJECT_GRAPH, patterns: 2, papers: 6, issues: [] })
    const graph = JSON.parse(await readFile(join(root, PROJECT_GRAPH), 'utf8')) as GraphFile
    expect(graph.domains).toEqual(['ml', 'networks'])
    expect(graph.papers.find(item => item.id === 'a3')?.url).toBe('https://doi.org/10.1/a3')
    expect(graph.papers.find(item => item.id === 'g1')?.url).toBe('https://example.org/g1')
    expect(graph.patterns.every(item => item.works.length === 1)).toBe(true)
    const recalled = await base.recall(root, 'routing sparsity attention', 3, undefined, signal)
    expect(recalled.patterns.some(item => item.graph === 'project')).toBe(true)
  })

  it('clusters embeddings by average linkage, leaves an outlier unclustered, and falls back to term weights when the endpoint fails', async () => {
    const { base } = await builtinBase()
    const root = await temp()
    const outlier = JSON.stringify({ paper_id: 'o1', title: 'Soil chemistry', story: 'Recasts soil as a ledger', base_problem: 'soil', solution_pattern: 'ledger' })
    await write(join(root, 'papers.jsonl'), [...['a1', 'a2', 'g1', 'g2'].map(id => extracted(id, id.startsWith('a') ? 'attention' : 'graph')), outlier].join('\n'))
    const semantic = await base.build(root, 'papers.jsonl', 'ml', embedder(), signal)
    expect(semantic).toMatchObject({ basis: 'embedding', note: expect.stringMatching(/fake-embed embeddings/) as unknown, unclustered: 1 })
    const stored = JSON.parse(await readFile(join(root, PROJECT_CLUSTERS), 'utf8')) as { model: string; papers: { similar: number[]; domain: string }[] }
    expect(stored.model).toBe('fake-embed')
    expect(stored.papers[0]?.similar).toHaveLength(4)
    expect(stored.papers[4]?.domain).toBe('ml')
    await write(join(root, 'cluster_meta.json'), JSON.stringify(Object.fromEntries(semantic.clusters.map((cluster, at) => [cluster.id, { name: `Angle number ${at} here`, summary: 's', tier: 'B' }]))))
    expect(await base.namePatterns(root, 'cluster_meta.json', 100000)).toMatchObject({ valid: true, patterns: 2, papers: 5 })
    const graph = JSON.parse(await readFile(join(root, PROJECT_GRAPH), 'utf8')) as GraphFile
    expect(graph.description).toMatch(/embeddings: fake-embed/)
    expect(graph.papers[4]?.pattern).toBe(-1)
    const fallback = await base.build(root, 'papers.jsonl', 'ml', embedder(() => true), signal)
    expect(fallback).toMatchObject({ basis: 'terms', note: expect.stringMatching(/^The embedding endpoint failed/) as unknown })
  })

  it('refuses too small or too large a corpus, and reports every naming problem while still writing the graph', async () => {
    const { base } = await builtinBase()
    const root = await temp()
    await write(join(root, 'tiny.jsonl'), `${extracted('a1', 'attention')}\nbroken`)
    await expect(base.build(root, 'tiny.jsonl', 'ml', undefined, signal)).rejects.toThrow(/at least 3 extracted papers; tiny\.jsonl has 1 \(rejected: line 2: not JSON\)/)
    await write(join(root, 'none.jsonl'), '')
    await expect(base.build(root, 'none.jsonl', 'ml', undefined, signal)).rejects.toThrow(/has 0$/)
    await write(join(root, 'huge.jsonl'), Array.from({ length: MAX_CORPUS + 1 }, (_, at) => extracted(`p${at}`, 'graph')).join('\n'))
    await expect(base.build(root, 'huge.jsonl', 'ml', undefined, signal)).rejects.toThrow(/at most 2000 papers/)
    await expect(base.namePatterns(root, 'cluster_meta.json', 100000)).rejects.toThrow(/No clusters yet/)
    await write(join(root, 'papers.jsonl'), ['a1', 'a2', 'a3', 'g1', 'g2', 'g3'].map(id => extracted(id, id.startsWith('a') ? 'attention' : 'graph')).join('\n'))
    const built = await base.build(root, 'papers.jsonl', 'ml', undefined, signal)
    const [first, second] = built.clusters.map(cluster => cluster.id)
    await write(join(root, 'names.json'), JSON.stringify({ [first!]: { name: 'Novel attention framework', tier: 'Z' }, ghost: { name: 'x' } }))
    const named = await base.namePatterns(root, 'names.json', 100000)
    expect(named.valid).toBe(false)
    expect(named.issues).toEqual([
      'names.json names ghost, which is not a cluster',
      `${first}: "Novel attention framework" uses generic words (framework, novel): name the angle, not the architecture`,
      `${first}: no summary`,
      `${first}: tier must be A, B or C`,
      `${second}: no name`, `${second}: no summary`, `${second}: tier must be A, B or C`,
    ])
    expect(named.tiers).toEqual({ A: 0, B: 0, C: 0, none: 2 })
    expect((JSON.parse(await readFile(join(root, PROJECT_GRAPH), 'utf8')) as GraphFile).patterns[1]?.name).toBe('pattern 1')
    await write(join(root, 'names.json'), JSON.stringify({ [first!]: { name: 'Too short', summary: 's', tier: 'A' } }))
    expect((await base.namePatterns(root, 'names.json', 100000)).issues[0]).toMatch(/should be a 3–6 word story angle/)
  })
})

describe('the embedding endpoint', () => {
  it('sends batches of 64 texts and orders the vectors by index', async () => {
    const bodies: { model: string; input: string[] }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { model: string; input: string[] }
      bodies.push(body)
      const data = body.input.map((_, index) => ({ index, embedding: [index, 1] })).reverse()
      return new Response(JSON.stringify({ data }), { status: 200 })
    }))
    const embed = createEmbedder({ baseUrl: 'https://api.example/v1/', model: 'emb' }, 'secret')
    const vectors = await embed.embed(Array.from({ length: 70 }, (_, at) => `t${at}`), signal)
    expect(vectors).toHaveLength(70)
    expect([...vectors[1]!]).toEqual([1, 1])
    expect(bodies.map(body => body.input.length)).toEqual([64, 6])
    const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!
    expect(url).toBe('https://api.example/v1/embeddings')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret')
  })

  it('halves the batch when the endpoint caps it, and remembers the size that worked', async () => {
    const sizes: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] }
      sizes.push(body.input.length)
      if (body.input.length > 10) return new Response('batch size is invalid, it should not be larger than 10', { status: 400 })
      return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [index] })) }), { status: 200 })
    }))
    const embed = createEmbedder({ baseUrl: 'https://capped.example/v1', model: 'emb' }, 'k')
    expect(await embed.embed(Array.from({ length: 25 }, (_, at) => `t${at}`), signal)).toHaveLength(25)
    expect(sizes).toEqual([25, 12, 6, 6, 6, 6, 1])
    sizes.length = 0
    expect(await embed.embed(Array.from({ length: 9 }, (_, at) => `u${at}`), signal)).toHaveLength(9)
    expect(sizes).toEqual([6, 3])
  })

  it("names the endpoint's own reason when even one text is refused", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"model not found"}}', { status: 400 })))
    await expect(createEmbedder({ baseUrl: 'https://e', model: 'm' }, 'k').embed(['a', 'b', 'c'], signal)).rejects.toThrow(/HTTP 400: .*model not found/)
    await expect(createEmbedder({ baseUrl: 'https://e', model: 'm' }, 'k').embed(['a'], signal)).rejects.toThrow(/HTTP 400: .*model not found/)
    vi.stubGlobal('fetch', vi.fn(async () => Object.assign(new Response(null, { status: 500 }), { text: () => Promise.reject(new Error('closed')) })))
    await expect(createEmbedder({ baseUrl: 'https://e', model: 'm' }, 'k').embed(['a'], signal)).rejects.toThrow(/^Embedding endpoint returned HTTP 500$/)
  })

  it('reports an HTTP error and a response with the wrong number of vectors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })))
    await expect(createEmbedder({ baseUrl: 'https://e', model: 'm' }, 'k').embed(['a'], signal)).rejects.toThrow(/HTTP 401/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }))))
    await expect(createEmbedder({ baseUrl: 'https://e', model: 'm' }, 'k').embed(['a', 'b'], signal)).rejects.toThrow(/different number of vectors/)
  })
})
