import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ResearchKnowledgeRelations, { type Config, type RecordedProject } from '../src/knowledge-relations-plugin.ts'
import { RELATIONS_FILE } from '../src/knowledge-relations.ts'
import type { EvidenceId, EvidenceRecord, ExperimentId, ExperimentRecord, RelationProposalInput, SourceLocator } from '../src/types.ts'

const roots: string[] = []
let context: Context | undefined
afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const signal = new AbortController().signal

function literature(id: string, chunks: [SourceLocator, string][], extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: id as EvidenceId, title: `${id.toUpperCase()}: A Paper About ${id}`, kind: 'literature', path: `.research/sources/${id}/reference.json`, sha256: 'x',
    revision: 1, importedAt: '2026-10-01T00:00:00.000Z', chunks: chunks.map(([locator, text]) => ({ locator, text })), coverage: 'full-text',
    verified: true, stale: false, ...extra,
  }
}

function experiment(id: string, name: string): ExperimentRecord {
  return {
    id: id as ExperimentId,
    spec: { environmentId: 'env' as ExperimentRecord['spec']['environmentId'], name, argv: [], cwd: '.', seed: 1, maxSeconds: 60, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' },
    status: 'completed', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: { accuracy: 0.8 }, message: '', snapshotPath: '', collected: true,
  }
}

const MOBA_TEXT = 'We introduce MoBA, a block attention method. MoBA outperforms full attention on RULER. MoBA is evaluated on RULER at 128K. '
  + 'MoBA is applied to question answering.'
const NSA_TEXT = 'We present NSA, a sparse attention method. NSA outperforms full attention on LongBench. A sparse attention method is cheap.'

async function research(extra: Partial<RecordedProject> = {}): Promise<RecordedProject> {
  const root = await mkdtemp(join(tmpdir(), 'research relations plugin '))
  roots.push(root)
  return {
    root,
    evidence: [
      literature('moba', [[{ page: 1 }, MOBA_TEXT]], { doi: '10.1000/moba' }),
      literature('nsa', [[{ page: 1 }, NSA_TEXT]], { sourceUrl: 'https://openalex.org/W200' }),
      literature('results-dyn', [], { kind: 'experiment', path: '.research/runs/dyn/metrics.json', coverage: 'data' }),
    ],
    experiments: [experiment('dyn', 'ruler-dynamic')],
    ...extra,
  }
}

const quote = (evidenceId: string, text: string, setting?: string): RelationProposalInput['ground'] =>
  ({ type: 'quote', evidenceId, revision: 1, quote: text, ...setting === undefined ? {} : { setting } })
const method = (name: string): RelationProposalInput['from'] => ({ kind: 'method', name })
const PROPOSALS: RelationProposalInput[] = [
  { kind: 'introduces', from: { kind: 'paper', evidenceId: 'moba' }, to: method('MoBA'), ground: quote('moba', 'We introduce MoBA, a block attention method.') },
  { kind: 'improves-on', from: method('MoBA'), to: method('full attention'), ground: quote('moba', 'MoBA outperforms full attention on RULER.') },
  { kind: 'evaluated-on', from: method('MoBA'), to: { kind: 'dataset', name: 'RULER' }, ground: quote('moba', 'MoBA is evaluated on RULER at 128K.', '128K') },
  { kind: 'applied-to', from: method('MoBA'), to: { kind: 'task', name: 'question answering' }, ground: quote('moba', 'MoBA is applied to question answering.') },
  { kind: 'improves-on', from: method('NSA'), to: method('full attention'), ground: quote('nsa', 'NSA outperforms full attention on LongBench.') },
  { kind: 'is-a', from: method('NSA'), to: method('sparse attention'), ground: quote('nsa', 'We present NSA, a sparse attention method.') },
]

async function boot(config: Partial<Config> = {}): Promise<ResearchKnowledgeRelations> {
  context = new Context()
  await context.plugin(ResearchKnowledgeRelations, { citationMaxAgeDays: 30, pauseMs: 1, ...config })
  return context.researchKnowledgeRelations
}

async function filled(): Promise<{ plugin: ResearchKnowledgeRelations; project: RecordedProject }> {
  const plugin = await boot()
  const project = await research()
  const { page } = await plugin.propose(project, PROPOSALS, 'user', signal)
  expect(page.map(outcome => outcome.status)).toEqual(Array(PROPOSALS.length).fill('added'))
  return { plugin, project }
}

describe('the relation graph of a research', () => {
  it('reads an empty graph as no relations, and lists the most connected entities once there are some', async () => {
    const plugin = await boot()
    const project = await research()
    const empty = await plugin.graph(project, {}, signal)
    expect(empty.page).toMatchObject({ match: 'none', hubs: [], candidates: [], rejected: [], counts: { entities: 0, relations: 0, stale: 0, rejected: 0, citationLists: 0 } })
    expect(empty.page.neighbourhood).toBeUndefined()
    expect(empty.text).toBe('The relation graph has no relations yet.')
    expect((await plugin.graph(project, { entity: 'Zeta' }, signal)).text).toBe('No entity of the relation graph is named "Zeta".')
    // An entity without relations is no hub.
    await plugin.entity(project, { kind: 'method', name: 'Loner' }, 'user', signal)
    expect((await plugin.graph(project, {}, signal)).page.hubs).toEqual([])
    await rm(join(project.root, '.research'), { recursive: true })

    await plugin.propose(project, PROPOSALS, 'user', signal)
    const overview = await plugin.graph(project, {}, signal)
    expect(overview.page.match).toBe('none')
    expect(overview.page.hubs.map(node => [node.name, node.degree])).toEqual([['MoBA', 4], ['full attention', 2], ['NSA', 2], ['RULER', 1], ['sparse attention', 1], ['MOBA: A Paper About moba', 1], ['question answering', 1]])
    // With no entity asked for, the most connected one is the centre.
    expect(overview.page.neighbourhood?.center).toBe('method:moba')
    expect(overview.page.counts).toEqual({ entities: 7, relations: 6, stale: 0, rejected: 0, citationLists: 0 })
    expect(overview.text).toContain('around MoBA (method)')
  })

  it('resolves an entity by id, name, alias, an id it used to have, or the name that is exactly its own', async () => {
    const { plugin, project } = await filled()
    const named = await plugin.graph(project, { entity: ' moba ', hops: 1, maxNodes: 3, includeStale: false, kinds: ['improves-on'] }, signal)
    expect(named.page.match).toBe('found')
    expect(named.page.neighbourhood?.nodes.map(node => node.id)).toEqual(['method:moba', 'method:full-attention'])
    expect(named.page.neighbourhood?.edges.map(edge => [edge.kind, edge.by, edge.grounds[0]?.by, edge.best.quote])).toEqual([['improves-on', 'user', 'user', 'MoBA outperforms full attention on RULER.']])
    expect((await plugin.graph(project, { entity: 'method:nsa' }, signal)).page.neighbourhood?.center).toBe('method:nsa')
    expect((await plugin.graph(project, { entity: 'RULER', kind: 'dataset' }, signal)).page.neighbourhood?.center).toBe('dataset:ruler')
    // A name that is exactly one entity's name wins over the entities that only mention it.
    expect((await plugin.graph(project, { entity: 'sparse attention' }, signal)).page.neighbourhood?.center).toBe('method:sparse-attention')

    await plugin.merge(project, { from: 'method:nsa', into: 'method:sparse-attention' }, 'user', signal)
    expect((await plugin.graph(project, { entity: 'method:nsa' }, signal)).page.neighbourhood?.center).toBe('method:sparse-attention')
  })

  it('says when a name matches nothing or several entities, and lists what it can', async () => {
    const { plugin, project } = await filled()
    const unknown = await plugin.graph(project, { entity: 'Zeta' }, signal)
    expect(unknown.page).toMatchObject({ match: 'unknown', candidates: [] })
    expect(unknown.page.neighbourhood).toBeUndefined()
    expect(unknown.text).toContain('No entity of the relation graph is named "Zeta". Most connected: MoBA (method, method:moba)')

    const ambiguous = await plugin.graph(project, { entity: 'attention' }, signal)
    expect(ambiguous.page.match).toBe('ambiguous')
    expect(ambiguous.page.candidates.map(node => node.id)).toEqual(['method:full-attention', 'method:sparse-attention'])
    expect(ambiguous.text).toBe('"attention" names several entities; use an id: full attention (method, method:full-attention); sparse attention (method, method:sparse-attention).')
  })

  it('counts stale and rejected relations, lists the rejected ones, and names a damaged file', async () => {
    const { plugin, project } = await filled()
    const rejected = await plugin.decide(project, { verb: 'reject', relation: 'is-a:method:nsa>method:sparse-attention', reason: 'too broad' }, 'user', signal)
    expect(rejected).toEqual({ status: 'changed', relation: 'is-a:method:nsa>method:sparse-attention' })
    project.evidence[0] = { ...project.evidence[0] as EvidenceRecord, stale: true }
    const page = (await plugin.graph(project, { entity: 'NSA' }, signal)).page
    expect(page.counts).toEqual({ entities: 7, relations: 5, stale: 4, rejected: 1, citationLists: 0 })
    expect(page.rejected).toEqual([{
      id: 'is-a:method:nsa>method:sparse-attention', kind: 'is-a', from: 'method:nsa', to: 'method:sparse-attention', fromName: 'NSA',
      toName: 'sparse attention', rejection: { by: 'user', at: expect.any(String) as string, reason: 'too broad' },
    }])
    const stale = (await plugin.graph(project, { entity: 'MoBA' }, signal)).page.neighbourhood
    expect(stale?.edges.filter(edge => edge.from === 'method:moba' || edge.from === 'paper:moba').map(edge => edge.status)).toEqual(['stale', 'stale', 'stale', 'stale'])
    expect(stale?.edges.find(edge => edge.from === 'method:moba')?.grounds[0]?.status).toBe('outdated')

    await writeFile(join(project.root, RELATIONS_FILE), '{ not json')
    const damaged = await plugin.graph(project, {}, signal)
    expect(damaged.page.problems).toHaveLength(1)
    expect(damaged.text).toContain(damaged.page.problems[0] as string)
  })

  it('lists a relation whose every ground was rejected without a rejection of its own, and one of a stored rejection of the whole', async () => {
    const { plugin, project } = await filled()
    const relation = 'applied-to:method:moba>task:question-answering'
    const ground = ((await plugin.graph(project, { entity: 'question answering' }, signal)).page.neighbourhood?.edges[0]?.best.id) as string
    await plugin.decide(project, { verb: 'reject', relation, ground }, 'agent', signal)
    await plugin.decide(project, { verb: 'reject', relation: 'is-a:method:nsa>method:sparse-attention' }, 'user', signal)
    const page = (await plugin.graph(project, {}, signal)).page
    expect(page.rejected.map(item => [item.id, item.rejection?.by])).toEqual(expect.arrayContaining([[relation, undefined], ['is-a:method:nsa>method:sparse-attention', 'user']]))
    const withRejectedGround = (await plugin.graph(project, { entity: 'MoBA', includeStale: true }, signal)).page.neighbourhood
    expect(withRejectedGround?.edges.some(edge => edge.id === relation)).toBe(false)
  })
})

describe('paths, gaps and suggestions', () => {
  it('explains how two entities connect, by their names, and says why when they do not', async () => {
    const { plugin, project } = await filled()
    const found = await plugin.paths(project, { from: 'NSA', to: 'moba', k: 2, maxHops: 3, includeStale: true, kinds: ['improves-on'] }, signal)
    expect(found.page.from).toBe('method:nsa')
    expect(found.page.paths[0]?.nodes).toEqual(['method:nsa', 'method:full-attention', 'method:moba'])
    expect(found.page.paths[0]?.hops.map(hop => [hop.kind, hop.direction])).toEqual([['improves-on', 'forward'], ['improves-on', 'backward']])
    expect(found.page.nodes.map(node => node.id)).toEqual(['method:nsa', 'method:full-attention', 'method:moba'])
    expect(found.text).toContain('Path 1: 2 hops')
    expect(found.text).toContain('NSA —improves-on→ full attention')

    const none = await plugin.paths(project, { from: 'NSA', to: 'question answering', maxHops: 1 }, signal)
    expect(none.page).toMatchObject({ paths: [], none: 'no-path', nodes: [] })
    expect(none.text).toBe('No path joins method:nsa and task:question-answering within the hop limit.')
    const same = await plugin.paths(project, { from: 'NSA', to: 'method:nsa' }, signal)
    expect(same.page.none).toBe('same-node')
    expect(same.text).toBe('No path joins method:nsa and method:nsa: they are one entity.')

    const unknown = await plugin.paths(project, { from: 'NSA', to: 'Zeta' }, signal)
    expect(unknown.page).toMatchObject({ from: 'method:nsa', to: 'Zeta', none: 'unknown-node', paths: [] })
    expect(unknown.text).toBe('No entity of the relation graph is named "Zeta".')
    expect((await plugin.paths(project, { from: 'Zeta', to: 'NSA' }, signal)).text).toBe('No entity of the relation graph is named "Zeta".')
    const ambiguous = await plugin.paths(project, { from: 'attention', to: 'moba' }, signal)
    expect(ambiguous.page).toMatchObject({ none: 'ambiguous-node', from: 'attention', to: 'method:moba' })
    expect(ambiguous.page.candidates?.from.map(node => node.id)).toEqual(['method:full-attention', 'method:sparse-attention'])
    expect(ambiguous.page.candidates?.to.map(node => node.id)).toEqual(['method:moba'])
    expect(ambiguous.text).toBe('A name matches several entities; use ids from relations-neighbourhood.')
  })

  it('builds the gap matrix over the project\'s own sources, without subtypes unless asked', async () => {
    const { plugin, project } = await filled()
    await expect(plugin.gaps(project, { axis: 'dataset', columns: ['dataset:longbench'] }, signal)).rejects.toThrow('No dataset of the relation graph is named "dataset:longbench".')

    const matrix = await plugin.gaps(project, { axis: 'dataset', rows: ['MoBA', 'NSA'], columns: ['RULER'], limit: 5 }, signal)
    expect(matrix.page.wording.heading).toBe('relationsGapHeading')
    expect(matrix.page.wording.states.uncovered).toBe('relationsGapUncovered')
    expect(matrix.page.rows.map(row => row.id)).toEqual(['method:moba', 'method:nsa'])
    expect(matrix.page.cells.map(row => row.map(cell => cell.state))).toEqual([['reported'], ['absent']])
    expect(matrix.text).toContain('Gap matrix of methods × datasets over this project\'s own sources only')
    expect(matrix.text).toContain('reported by papers in this project\'s literature: MoBA × RULER (1)')

    const settings = await plugin.gaps(project, { axis: 'setting', columns: ['128K', '64K'] }, signal)
    expect(settings.page.columns.map(column => column.name)).toEqual(['128K', '64K'])
    expect(settings.page.cells[0]?.map(cell => cell.state)).toEqual(['reported', 'uncovered'])

    const tasks = await plugin.gaps(project, { axis: 'task' }, signal)
    expect(tasks.page.columns.map(column => column.name)).toEqual(['question answering'])
    await expect(plugin.gaps(project, { axis: 'task', rows: ['attention'] }, signal)).rejects.toThrow('"attention" names several methods (method:full-attention, method:sparse-attention); use an id.')
  })

  it('suggests entities that may be one, and merges them on request', async () => {
    const { plugin, project } = await filled()
    expect((await plugin.suggestions(project, signal)).text).toBe('No two entities look like one.')
    await plugin.entity(project, { kind: 'method', name: 'BA', aliases: [] }, 'user', signal)
    await plugin.entity(project, { kind: 'method', name: 'block attention', aliases: [] }, 'user', signal)
    const suggestions = await plugin.suggestions(project, signal)
    expect(suggestions.page).toEqual([{ a: 'method:ba', b: 'method:block-attention', reason: 'acronym', names: ['BA', 'block attention'] }])
    expect(suggestions.text).toBe('BA (method:ba) and block attention (method:block-attention): acronym ("BA" / "block attention")')
    expect(await plugin.merge(project, { from: 'method:ba', into: 'method:block-attention' }, 'user', signal))
      .toMatchObject({ status: 'merged', dropped: [], entity: { id: 'method:block-attention', aliases: ['BA'] } })
    expect((await plugin.suggestions(project, signal)).page).toEqual([])
    expect(await plugin.merge(project, { from: 'method:zeta', into: 'method:block-attention' }, 'user', signal)).toMatchObject({ status: 'refused', code: 'unknown-entity' })
  })
})
describe('writing the relation graph', () => {
  it('records the agent\'s proposals under the strict rule and the person\'s under the lighter one', async () => {
    const plugin = await boot()
    const project = await research()
    const paraphrase: RelationProposalInput = { ...PROPOSALS[1] as RelationProposalInput, ground: quote('moba', 'MoBA beats the full attention baseline on RULER.') }
    const agent = await plugin.propose(project, [PROPOSALS[0] as RelationProposalInput, paraphrase], 'agent', signal)
    expect(agent.page.map(outcome => outcome.status)).toEqual(['added', 'refused'])
    expect(agent.text).toMatch(/^1\. added introduces:paper:moba>method:moba \[ground [0-9a-f]+\]\n2\. refused \(quote-not-found\): /)
    expect(agent.repaired).toEqual([])
    const relation = ((await plugin.graph(project, { entity: 'MoBA' }, signal)).page.neighbourhood?.edges[0])
    expect(relation?.by).toBe('agent')
    expect(relation?.grounds[0]?.by).toBe('agent')

    // The person's quotation needs only to exist and hold four words; the rules it misses are kept as warnings.
    const person = await plugin.propose(project, [{ ...paraphrase, ground: quote('moba', 'MoBA outperforms full attention on RULER') }], 'user', signal)
    expect(person.page[0]).toMatchObject({ status: 'added', warnings: [] })
    const repeated = await plugin.propose(project, [PROPOSALS[0] as RelationProposalInput], 'agent', signal)
    expect(repeated.text).toMatch(/^1\. unchanged /)
  })

  it('notes the locator it corrected, the rejection it lifted and the warnings of a person\'s quotation', async () => {
    const plugin = await boot()
    const project = await research()
    const wrongLocator: RelationProposalInput = {
      ...PROPOSALS[1] as RelationProposalInput, ground: { ...quote('moba', 'MoBA outperforms full attention on RULER.') as Extract<RelationProposalInput['ground'], { type: 'quote' }>, locator: { page: 9 } },
    }
    expect((await plugin.propose(project, [wrongLocator], 'agent', signal)).text).toContain('(locator corrected)')
    const id = 'improves-on:method:moba>method:full-attention'
    await plugin.decide(project, { verb: 'reject', relation: id }, 'agent', signal)
    expect((await plugin.propose(project, [wrongLocator], 'user', signal)).text).toContain('(lifted an earlier rejection')
    const warned = await plugin.propose(project, [{
      kind: 'compares-with', from: method('MoBA'), to: method('NSA'), ground: quote('moba', 'MoBA is evaluated on RULER at 128K.'),
    }], 'user', signal)
    expect(warned.text).toMatch(/\(.*\)$/)
  })

  it('copies a damaged file aside before it rewrites it, and says so', async () => {
    const plugin = await boot()
    const project = await research()
    await mkdir(join(project.root, '.research', 'kg'), { recursive: true })
    await writeFile(join(project.root, RELATIONS_FILE), '{ not json')
    const result = await plugin.propose(project, [PROPOSALS[0] as RelationProposalInput], 'user', signal)
    expect(result.repaired).toHaveLength(2)
    expect(result.repaired[1]).toMatch(/^The damaged file was copied to \.research\/kg\/relations\.json\..*\.bak before /)
    expect(result.repaired[1]).toMatch(/before it was rewritten\.$/)
    expect(result.text.split('\n')).toHaveLength(3)
    expect((await readdir(join(project.root, '.research', 'kg'))).some(name => name.endsWith('.bak'))).toBe(true)
  })

  it('rejects and restores with the person\'s rejection standing against the agent', async () => {
    const { plugin, project } = await filled()
    const id = 'improves-on:method:moba>method:full-attention'
    expect(await plugin.decide(project, { verb: 'reject', relation: id, reason: 'wrong direction' }, 'user', signal)).toEqual({ status: 'changed', relation: id })
    expect(await plugin.decide(project, { verb: 'reject', relation: id }, 'agent', signal)).toEqual({ status: 'unchanged', relation: id })
    expect(await plugin.decide(project, { verb: 'restore', relation: id }, 'agent', signal)).toMatchObject({ status: 'refused', code: 'not-yours' })
    expect(await plugin.decide(project, { verb: 'restore', relation: id }, 'user', signal)).toEqual({ status: 'changed', relation: id })
    expect(await plugin.decide(project, { verb: 'restore', relation: 'cites:a>b' }, 'user', signal)).toMatchObject({ status: 'refused', code: 'unknown-relation' })
  })

  it('creates entities and adds aliases', async () => {
    const plugin = await boot()
    const project = await research()
    expect(await plugin.entity(project, { kind: 'method', name: 'MoBA', aliases: ['Mixture of Block Attention'] }, 'user', signal)).toMatchObject({ status: 'created' })
    expect(await plugin.entity(project, { kind: 'method', name: 'moba', aliases: ['Mixture of Block Attention', 'MoBA-1'] }, 'user', signal)).toMatchObject({ status: 'updated', entity: { aliases: ['Mixture of Block Attention', 'MoBA-1'] } })
    expect(await plugin.entity(project, { kind: 'method', name: 'method' }, 'user', signal)).toMatchObject({ status: 'refused', code: 'invalid-entity' })
  })

  it('moves the quotations of a source that has a new revision, and counts those that no longer hold', async () => {
    const { plugin, project } = await filled()
    project.evidence[0] = literature('moba', [[{ page: 1 }, MOBA_TEXT.replace('MoBA is applied to question answering.', 'MoBA is applied to retrieval.')]], { doi: '10.1000/moba', revision: 2 })
    expect(await plugin.reground(project, signal)).toEqual({ regrounded: 3, lapsed: 1 })
    expect(await plugin.reground(project, signal)).toEqual({ regrounded: 0, lapsed: 1 })
  })
})

describe('reference lists', () => {
  function provider(lists: Record<string, string[]>): { requested: string[]; headers: unknown[] } {
    const seen = { requested: [] as string[], headers: [] as unknown[] }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: unknown }) => {
      seen.requested.push(url)
      seen.headers.push(init.headers)
      const filter = /filter=(doi|openalex):([^&]*)/.exec(decodeURIComponent(url))
      const results = filter?.[1] === 'doi' && filter[2] === '10.1000/moba'
        ? [{ id: 'https://openalex.org/W100', doi: 'https://doi.org/10.1000/moba', referenced_works: lists.W100 ?? [] }]
        : filter?.[1] === 'openalex' && filter[2] === 'W200' ? [{ id: 'https://openalex.org/W200', doi: null, referenced_works: lists.W200 ?? [] }] : []
      return new Response(JSON.stringify({ results }))
    }))
    return seen
  }

  it('fetches the missing lists once, records the citations among the papers, and keeps them for the configured days', async () => {
    const plugin = await boot()
    const project = await research()
    const seen = provider({ W100: ['W200', 'W999'] })
    const first = await plugin.citations(project, signal)
    expect(first).toEqual({ asked: 2, works: 2, added: 1, unchanged: 0, rejected: 0, failures: [] })
    // The paper with a DOI is asked by it, the other by the OpenAlex work its source URL names; nothing identifies the person.
    expect(seen.requested.map(url => decodeURIComponent(url).match(/filter=([^&]*)/)?.[1])).toEqual(['doi:10.1000/moba', 'openalex:W200'])
    expect(seen.headers[0]).toEqual({ 'User-Agent': 'ResearchWorkbench/0.1 (scholarly metadata client)' })
    expect((await plugin.graph(project, {}, signal)).page.counts.citationLists).toBe(2)
    expect((await plugin.paths(project, { from: 'paper:moba', to: 'paper:nsa' }, signal)).page.paths[0]?.hops[0]?.kind).toBe('cites')
    // Both lists are cached, so nothing is asked again and the recorded citation is found again.
    expect(await plugin.citations(project, signal)).toEqual({ asked: 0, works: 2, added: 0, unchanged: 1, rejected: 0, failures: [] })
    expect(seen.requested).toHaveLength(2)
  })
  it('records nothing new when no list is due, and reports the requests that failed', async () => {
    const plugin = await boot({ citationMaxAgeDays: 365 })
    const project = await research({ evidence: [literature('moba', [[{ page: 1 }, MOBA_TEXT]], { doi: '10.1000/moba' })] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
    const failed = await plugin.citations(project, signal)
    expect(failed).toMatchObject({ asked: 1, works: 0, added: 0 })
    expect(failed.failures[0]).toContain('HTTP 503')
    const none = await plugin.citations({ ...project, evidence: [] }, signal)
    expect(none).toEqual({ asked: 0, works: 0, added: 0, unchanged: 0, rejected: 0, failures: [] })
  })

  it('waits between requests and stops waiting when cancelled, writing nothing', async () => {
    const plugin = await boot({ pauseMs: 10_000 })
    const project = await research()
    provider({})
    const caller = new AbortController()
    const running = plugin.citations(project, caller.signal)
    const stopped = expect(running).rejects.toThrow('stop')
    await vi.waitFor(() => { expect(vi.mocked(fetch)).toHaveBeenCalled() })
    caller.abort(new Error('stop'))
    await stopped
    await expect(readdir(join(project.root, '.research', 'kg'))).rejects.toThrow()
  })

  it('is cancelled when the plugin is disabled, and refuses work afterwards', async () => {
    const plugin = await boot()
    const project = await research()
    const release = Promise.withResolvers<undefined>()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { reject(init.signal.reason as Error) }, { once: true })
      release.resolve(undefined)
    })))
    const running = plugin.citations(project, signal)
    const stopped = expect(running).rejects.toThrow()
    await release.promise
    await context?.fiber.dispose()
    await stopped
    expect(() => plugin.graph(project, {}, signal)).toThrow('The relation graph plugin was disabled')
  })

  it('has a default configuration of 30 days and a pause of 120 milliseconds', () => {
    expect((ResearchKnowledgeRelations.Config as (input: object) => object)({})).toMatchObject({ citationMaxAgeDays: 30, pauseMs: 120 })
  })
})
