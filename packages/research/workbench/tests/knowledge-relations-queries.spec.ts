import { describe, expect, it } from 'vitest'
import {
  applyCitationWorks, applyProposals, emptyRelations, rejectRelation, relationGraph, upsertEntity,
  type EntityRef, type Relation, type RelationProject, type RelationProposal, type RelationsFile,
} from '../src/knowledge-relations.ts'
import {
  MAX_HOPS, MAX_PATHS, describeGapMatrix, describeNeighbourhood, describePath, findEntities, gapMatrix, neighbourhood, passageIndex,
  relationPaths, type Neighbourhood,
} from '../src/knowledge-relations-queries.ts'
import type { EvidenceId, EvidenceRecord, ExperimentId, ExperimentRecord, SourceLocator } from '../src/types.ts'

const NOW = new Date('2026-10-01T12:00:00.000Z')

function source(id: string, kind: EvidenceRecord['kind'], chunks: [SourceLocator, string][], extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: id as EvidenceId, title: `${id} paper`, kind, path: kind === 'experiment' ? `.research/runs/${id.slice(2)}/metrics.json` : `.research/sources/${id}`,
    sha256: 'x', revision: 1, importedAt: NOW.toISOString(), chunks: chunks.map(([locator, text]) => ({ locator, text })), coverage: 'full-text',
    verified: true, stale: false, ...extra,
  }
}

function run(id: string, name: string): ExperimentRecord {
  return {
    id: id as ExperimentId,
    spec: { environmentId: 'env' as ExperimentRecord['spec']['environmentId'], name, argv: [], cwd: '.', seed: 3, maxSeconds: 1, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'm' },
    status: 'completed', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: { accuracy: 1 }, message: '', snapshotPath: '', collected: true,
  }
}

const A_TEXT = 'We introduce Alpha, a sparse attention method. Alpha outperforms Dense on Bench at 32K. Alpha is evaluated on Bench and on Corpus. Alpha is applied to summarization tasks.'
const B_TEXT = 'Beta is a sparse attention method. Beta outperforms Alpha on every task. Beta is evaluated on Corpus. Gamma and Bench appear in this sentence. '
  + 'Beta, Corpus and 64K appear here too.'
const C_TEXT = 'Gamma outperforms Beta on every task. Delta is a kind of Gamma. Delta is evaluated on Bench. Epsilon outperforms Gamma on every task. '
  + 'Zeta outperforms Epsilon on every task. Delta is evaluated on Bench at 8K.'

function world(): RelationProject {
  return {
    evidence: [
      source('a', 'literature', [[{ page: 1 }, A_TEXT], [{ key: 'abstract' }, 'Omega is a term only the abstract has.'], [{ key: 'bibtex' }, '@misc{a}']]),
      source('b', 'literature', [[{ key: 'abstract' }, B_TEXT]], { coverage: 'abstract' }),
      source('c', 'literature', [[{ page: 1 }, C_TEXT]]),
      source('m', 'literature', [[{ key: 'title' }, 'Metadata title']], { coverage: 'metadata' }),
      source('notes', 'file', [[{ line: 1 }, 'Theta is evaluated on Bench, in our notes. Iota outperforms Alpha in our notes.']]),
      source('r-run1', 'experiment', [[{ key: 'accuracy' }, '1']]),
    ],
    experiments: [run('run1', 'bench-32k-kappa')],
  }
}

const m = (name: string): EntityRef => ({ kind: 'method', name })
const d = (name: string): EntityRef => ({ kind: 'dataset', name })
const t = (name: string): EntityRef => ({ kind: 'task', name })
const q = (evidenceId: string, quote: string, setting?: string): RelationProposal['ground'] => ({ type: 'quote', evidenceId, revision: 1, quote, ...setting === undefined ? {} : { setting } })
const r = (kind: RelationProposal['kind'], from: EntityRef, to: EntityRef, ground: RelationProposal['ground'], by: 'agent' | 'user' = 'agent'): RelationProposal => ({ kind, from, to, ground, by })

const PROPOSALS: RelationProposal[] = [
  r('introduces', { kind: 'paper', evidenceId: 'a' }, m('Alpha'), q('a', 'We introduce Alpha, a sparse attention method.')),
  r('is-a', m('Alpha'), m('sparse attention'), q('a', 'We introduce Alpha, a sparse attention method.')),
  r('improves-on', m('Alpha'), m('Dense'), q('a', 'Alpha outperforms Dense on Bench at 32K.')),
  r('evaluated-on', m('Alpha'), d('Bench'), q('a', 'Alpha outperforms Dense on Bench at 32K.', '32K')),
  r('evaluated-on', m('Alpha'), d('Corpus'), q('a', 'Alpha is evaluated on Bench and on Corpus.')),
  r('applied-to', m('Alpha'), t('summarization'), q('a', 'Alpha is applied to summarization tasks.')),
  r('is-a', m('Beta'), m('sparse attention'), q('b', 'Beta is a sparse attention method.')),
  r('improves-on', m('Beta'), m('Alpha'), q('b', 'Beta outperforms Alpha on every task.'), 'user'),
  r('evaluated-on', m('Beta'), d('Corpus'), q('b', 'Beta is evaluated on Corpus.')),
  r('improves-on', m('Gamma'), m('Beta'), q('c', 'Gamma outperforms Beta on every task.'), 'user'),
  r('is-a', m('Delta'), m('Gamma'), q('c', 'Delta is a kind of Gamma.')),
  r('evaluated-on', m('Delta'), d('Bench'), q('c', 'Delta is evaluated on Bench.')),
  r('evaluated-on', m('Delta'), d('Bench'), q('c', 'Delta is evaluated on Bench at 8K.', '8K')),
  r('improves-on', m('Epsilon'), m('Gamma'), q('c', 'Epsilon outperforms Gamma on every task.'), 'user'),
  r('improves-on', m('Zeta'), m('Epsilon'), q('c', 'Zeta outperforms Epsilon on every task.'), 'user'),
  r('evaluated-on', m('Theta'), d('Bench'), { type: 'quote', evidenceId: 'notes', revision: 1, quote: 'Theta is evaluated on Bench, in our notes.' }),
  r('improves-on', m('Iota'), m('Alpha'), { type: 'quote', evidenceId: 'notes', revision: 1, quote: 'Iota outperforms Alpha in our notes.' }),
  r('evaluated-on', m('Kappa'), d('Bench'), { type: 'run', runId: 'run1', from: 'kappa', to: 'bench', setting: '32K' }),
]

/** The view of the proposals made against world(), as data (the record now) reads them. */
function graphOf(
  changes: (file: RelationsFile) => RelationsFile = file => file, data: RelationProject = world(),
): ReturnType<typeof relationGraph> {
  const edit = applyProposals(emptyRelations(), world(), PROPOSALS, NOW)
  expect(edit.result.filter(outcome => outcome.status === 'refused')).toEqual([])
  return relationGraph(changes(edit.file), data)
}

describe('neighbourhoods', () => {
  it('returns nothing for an unknown centre', () => {
    expect(neighbourhood(graphOf(), { center: 'method:none' })).toBeUndefined()
  })

  it('lays out two rings around the centre with parents, places, degrees and the densest group as core', () => {
    const view = neighbourhood(graphOf(), { center: 'method:alpha' })
    // Ring 1 by kind, then by strength (Beta's paper is abstract only, 0.8; Iota rests on notes, 0.7), then by id.
    expect(view?.nodes.map(node => [node.id, node.ring, node.slot, node.parent ?? '', node.core])).toEqual([
      ['method:alpha', 0, 0, '', true],
      ['method:dense', 1, 0, '', false],
      ['method:sparse-attention', 1, 1, '', true],
      ['method:beta', 1, 2, '', true],
      ['method:iota', 1, 3, '', false],
      ['task:summarization', 1, 4, '', false],
      ['dataset:bench', 1, 5, '', true],
      ['dataset:corpus', 1, 6, '', true],
      ['paper:a', 1, 7, '', false],
      ['method:gamma', 2, 0, 'method:beta', true],
      ['method:delta', 2, 1, 'dataset:bench', true],
      ['method:kappa', 2, 2, 'dataset:bench', false],
      ['method:theta', 2, 3, 'dataset:bench', false],
    ])
    expect(view?.nodes.find(node => node.id === 'paper:a')).toMatchObject({ kind: 'paper', evidenceIds: ['a'], degree: 1, status: 'active' })
    expect(view?.edges.find(edge => edge.id === 'evaluated-on:method:alpha>dataset:bench')).toMatchObject({
      status: 'active', confidence: 0.9, sources: { 'full-text': 1, 'abstract': 0, 'file': 0, 'run': 0, 'citation': 0 },
      best: { type: 'quote', locator: { page: 1 }, quote: 'Alpha outperforms Dense on Bench at 32K.', setting: '32K', title: 'a paper' },
    })
    expect(view?.edges.find(edge => edge.from === 'method:kappa')?.best).toMatchObject({ type: 'run', runId: 'run1', setting: '32K', title: 'bench-32k-kappa · seed 3' })
    expect(view?.omitted).toEqual({ nodes: 0, edges: 0 })
  })

  it('names who recorded a relation and each ground, and lists every ground of an edge with the rejected one last and why', () => {
    const rejectedGround = (file: RelationsFile): RelationsFile => {
      const grounds = file.relations.find(relation => relation.id === 'evaluated-on:method:alpha>dataset:bench')?.grounds as { id: string; rejected?: unknown }[]
      grounds[0]!.rejected = { by: 'user', at: NOW.toISOString(), reason: 'wrong table' }
      return file
    }
    const edge = (view: Neighbourhood | undefined) => view?.edges.find(item => item.id === 'evaluated-on:method:alpha>dataset:bench')
    const plain = edge(neighbourhood(graphOf(), { center: 'method:alpha' }))
    expect(plain).toMatchObject({ by: 'agent', best: { by: 'agent' } })
    expect(plain?.grounds.map(ground => [ground.status, ground.by, ground.rejection])).toEqual([['current', 'agent', undefined]])
    expect(edge(neighbourhood(graphOf(), { center: 'method:kappa' }))?.best.by).toBe('agent')
    expect(edge(neighbourhood(graphOf(rejectedGround), { center: 'method:alpha' }))).toBeUndefined()
    // Two grounds: the rejected one stays in the list, after the current one, for a view that offers to restore it.
    const twoGrounds = (file: RelationsFile): RelationsFile => {
      const relation = file.relations.find(item => item.id === 'evaluated-on:method:alpha>dataset:bench') as Relation
      relation.grounds.push({ ...relation.grounds[0] as Relation['grounds'][number], id: 'extra', rejected: { by: 'user', at: NOW.toISOString(), reason: 'wrong table' } })
      return file
    }
    const listed = edge(neighbourhood(graphOf(twoGrounds), { center: 'method:alpha' }))
    expect(listed?.grounds.map(ground => [ground.id === 'extra' ? 'extra' : 'own', ground.status, ground.rejection?.reason])).toEqual([['own', 'current', undefined], ['extra', 'rejected', 'wrong table']])
    expect(listed?.sources['full-text']).toBe(1)
  })

  it('cuts ring 2 before ring 1 and caps the edges, and draws a star with only its centre as core', () => {
    const cut = neighbourhood(graphOf(), { center: 'method:alpha', maxNodes: 3, depth: 2 })
    expect(cut?.nodes.map(node => node.id)).toEqual(['method:alpha', 'dataset:bench', 'dataset:corpus'])
    expect(cut?.omitted).toEqual({ nodes: 10, edges: 0 })
    const tiny = neighbourhood(graphOf(), { center: 'method:alpha', maxNodes: 0.5 })
    expect(tiny?.nodes.map(node => node.id)).toEqual(['method:alpha'])
    const star = neighbourhood(graphOf(), { center: 'dataset:bench', depth: 1, maxNodes: 200 })
    expect(star?.nodes.filter(node => node.core).map(node => node.id)).toEqual(['dataset:bench'])
    expect(star?.nodes.every(node => node.ring < 2)).toBe(true)
    const dense = neighbourhood(graphOf(), { center: 'method:alpha', maxNodes: 2 })
    expect(dense?.edges.length).toBeLessThanOrEqual(8)
    expect(describeNeighbourhood(cut as Neighbourhood).split('\n')).toEqual([
      '3 nodes around Alpha (method) (10 nodes and 0 relations not shown):',
      'Alpha (method) —evaluated-on→ Bench (dataset), 0.9, a paper [evaluated-on:method:alpha>dataset:bench]',
      'Alpha (method) —evaluated-on→ Corpus (dataset), 0.9, a paper [evaluated-on:method:alpha>dataset:corpus]',
    ])
    const data = world()
    const changed = { ...data, evidence: data.evidence.map(record => record.id === 'c' ? { ...record, revision: 2 } : record) }
    const staleStar = neighbourhood(graphOf(file => file, changed), { center: 'method:delta', depth: 1 }) as Neighbourhood
    expect(describeNeighbourhood(staleStar)).toBe([
      '3 nodes around Delta (method):',
      'Delta (method) —evaluated-on→ Bench (dataset) [stale], 0.45, c paper [evaluated-on:method:delta>dataset:bench]',
      'Delta (method) —is-a→ Gamma (method) [stale], 0.45, c paper [is-a:method:delta>method:gamma]',
    ].join('\n'))
  })

  it('leaves out stale and rejected relations when asked, and keeps to the kinds asked for', () => {
    const data = world()
    const changed = { ...data, evidence: data.evidence.map(record => record.id === 'b' ? { ...record, revision: 2 } : record) }
    const stale = graphOf(file => rejectRelation(file, { relation: 'improves-on:method:iota>method:alpha', by: 'user' }, NOW).file, changed)
    const shown = neighbourhood(stale, { center: 'method:alpha', depth: 1 })
    expect(shown?.nodes.map(node => node.id)).not.toContain('method:iota')
    expect(shown?.edges.find(edge => edge.from === 'method:beta')?.status).toBe('stale')
    expect(neighbourhood(stale, { center: 'method:alpha', depth: 1, includeStale: false })?.nodes.map(node => node.id)).not.toContain('method:beta')
    expect(neighbourhood(stale, { center: 'method:alpha', kinds: ['evaluated-on'] })?.nodes.map(node => node.id)).toEqual([
      'method:alpha', 'dataset:bench', 'dataset:corpus', 'method:delta', 'method:kappa', 'method:theta', 'method:beta',
    ])
  })

  it('shows a node without usable relations alone, and leaves rejected grounds out of the counts', () => {
    const lonely = graphOf(file => upsertEntity(file, { kind: 'method', name: 'Lonely', by: 'user' }, NOW).file)
    expect(neighbourhood(lonely, { center: 'method:lonely' })).toMatchObject({ nodes: [{ id: 'method:lonely', ring: 0, core: true, degree: 0 }], edges: [] })
    expect(gapMatrix(lonely, { axis: 'dataset', rows: ['method:lonely'], columns: ['dataset:bench'] }, passageIndex(world())).cells[0]?.[0]?.state).toBe('uncovered')
    const twoGrounds = applyProposals(applyProposals(emptyRelations(), world(), PROPOSALS, NOW).file, world(),
      [r('evaluated-on', m('Alpha'), d('Bench'), q('a', 'Alpha is evaluated on Bench and on Corpus.'))], NOW).file
    const first = twoGrounds.relations.find(item => item.id === 'evaluated-on:method:alpha>dataset:bench')?.grounds[0]?.id as string
    const oneRejected = relationGraph(rejectRelation(twoGrounds, { relation: 'evaluated-on:method:alpha>dataset:bench', ground: first, by: 'user' }, NOW).file, world())
    expect(neighbourhood(oneRejected, { center: 'dataset:bench', depth: 1 })?.edges.find(edge => edge.from === 'method:alpha')?.sources['full-text']).toBe(1)
    const settings = gapMatrix(oneRejected, { axis: 'setting', rows: ['method:alpha'] }, passageIndex(world()))
    expect([settings.columns.map(column => column.id), settings.cells[0]?.[0]]).toMatchObject([['32k', '8k'], { state: 'mentioned', rejected: 1 }])
  })

  it('marks a paper whose records the project no longer holds', () => {
    const data = world()
    const gone = graphOf(file => file, { ...data, evidence: data.evidence.filter(record => record.id !== 'a') })
    expect(gone.entities.get('paper:a')?.status).toBe('orphaned')
  })
})

describe('paths', () => {
  it('reports unknown ends, one end, and ends nothing joins within the hop limit', () => {
    const graph = graphOf()
    expect(relationPaths(graph, { from: 'method:none', to: 'method:alpha' })).toMatchObject({ paths: [], none: 'unknown-node', from: 'method:none' })
    expect(relationPaths(graph, { from: 'method:alpha', to: 'method:none' })).toMatchObject({ none: 'unknown-node', to: 'method:none' })
    expect(relationPaths(graph, { from: 'method:alpha', to: 'method:alpha' })).toMatchObject({ none: 'same-node' })
    expect(relationPaths(graph, { from: 'method:alpha', to: 'method:zeta', maxHops: 2 })).toMatchObject({ paths: [], none: 'no-path' })
  })

  it('finds the k best loopless paths, best first, each hop with its direction and grounds', () => {
    const graph = graphOf()
    const result = relationPaths(graph, { from: 'method:alpha', to: 'method:delta', k: 3 })
    // The third path ties with alpha–sparse attention–beta–gamma–delta (0.9 × 0.8 × 0.9 × 0.9); node ids break the tie.
    expect(result.paths.map(path => [path.nodes.join(' '), path.confidence, path.stale])).toEqual([
      ['method:alpha dataset:bench method:delta', 0.81, false],
      ['method:alpha method:beta method:gamma method:delta', 0.648, false],
      ['method:alpha dataset:corpus method:beta method:gamma method:delta', 0.583, false],
    ])
    const [first] = result.paths
    expect(first?.hops.map(hop => [hop.kind, hop.direction])).toEqual([['evaluated-on', 'forward'], ['evaluated-on', 'backward']])
    expect(first?.cost).toBe(0.711)
    expect(describePath(graph, first as NonNullable<typeof first>)).toBe([
      '2 hops, confidence 0.81:',
      'Alpha —evaluated-on→ Bench — a paper, page 1: "Alpha outperforms Dense on Bench at 32K." [evaluated-on:method:alpha>dataset:bench]',
      'Bench ←evaluated-on— Delta — c paper, page 1: "Delta is evaluated on Bench at 8K." [evaluated-on:method:delta>dataset:bench]',
    ].join('\n'))
    expect(relationPaths(graph, { from: 'method:alpha', to: 'method:delta', k: 99, maxHops: 99 }).paths.length).toBeLessThanOrEqual(MAX_PATHS)
    expect(MAX_HOPS).toBe(6)
  })

  it('walks stale relations at their lower confidence unless asked not to, names parallel relations, and describes run and citation hops', () => {
    const data = world()
    const changed = { ...data, evidence: data.evidence.map(record => record.id === 'c' ? { ...record, revision: 2 } : record) }
    const graph = graphOf(file => file, changed)
    const stale = relationPaths(graph, { from: 'method:alpha', to: 'method:delta', k: 2 })
    expect(stale.paths[0]).toMatchObject({ stale: true, confidence: 0.405 })
    expect(relationPaths(graph, { from: 'method:alpha', to: 'method:delta', includeStale: false })).toMatchObject({ none: 'no-path' })
    const cited = applyCitationWorks(applyProposals(emptyRelations(), data, PROPOSALS, NOW).file, data, [
      { evidenceId: 'a', provider: 'openalex', work: 'W1', references: ['W2'], fetchedAt: NOW.toISOString() },
      { evidenceId: 'c', provider: 'openalex', work: 'W2', references: [], fetchedAt: NOW.toISOString() },
    ], NOW).file
    const withPaper = applyProposals(cited, data, [r('introduces', { kind: 'paper', evidenceId: 'c' }, m('Gamma'), q('c', 'Gamma outperforms Beta on every task.'), 'user')], NOW).file
    const citations = relationGraph(withPaper, data)
    const throughCitation = relationPaths(citations, { from: 'paper:a', to: 'paper:c', k: 1 })
    expect(describePath(citations, throughCitation.paths[0] as NonNullable<typeof throughCitation.paths[0]>)).toBe(['1 hop, confidence 0.5:', 'a paper —cites→ c paper — a paper cites it (citation) [cites:paper:a>paper:c]'].join('\n'))
    const kappa = relationPaths(citations, { from: 'method:kappa', to: 'dataset:bench' })
    expect(describePath(citations, kappa.paths[0] as NonNullable<typeof kappa.paths[0]>)).toBe(['1 hop, confidence 0.9:', 'Kappa —evaluated-on→ Bench — run bench-32k-kappa · seed 3 [evaluated-on:method:kappa>dataset:bench]'].join('\n'))
    const twice = applyProposals(withPaper, data, [r('compares-with', m('Alpha'), m('Dense'), q('a', 'Alpha outperforms Dense on Bench at 32K.'))], NOW).file
    const parallel = relationPaths(relationGraph(twice, data), { from: 'method:dense', to: 'method:alpha', k: 1 })
    expect(parallel.paths[0]?.hops[0]).toMatchObject({ direction: 'backward', parallel: [{ relation: 'improves-on:method:alpha>method:dense', kind: 'improves-on' }] })
    expect(describePath(relationGraph(twice, data), parallel.paths[0] as NonNullable<typeof parallel.paths[0]>)).toContain('Dense ←compares-with— Alpha')
    const bare = stale.paths[0] as NonNullable<typeof stale.paths[0]>
    expect(describePath(graph, { ...bare, hops: bare.hops.map(hop => ({ ...hop, grounds: [] })) })).toContain('[stale]')
    expect(relationPaths(citations, { from: 'method:alpha', to: 'paper:c', kinds: ['cites'] })).toMatchObject({ none: 'no-path' })
  })
})

describe('the gap matrix', () => {
  it('indexes the passages it scans and counts what the literature covers', () => {
    const index = passageIndex(world())
    expect(index.basis).toEqual({ literature: 4, fullText: 2, abstractOnly: 1, metadataOnly: 1, files: 1 })
    expect(index.passages.map(passage => `${passage.evidenceId}:${JSON.stringify(passage.locator)}`)).toEqual([
      'a:{"page":1}', 'b:{"key":"abstract"}', 'c:{"page":1}', 'm:{"key":"title"}', 'notes:{"line":1}',
    ])
  })

  it('tells reported, project-only, stale, mentioned, absent and uncovered apart for methods and datasets', () => {
    const data = world()
    const changed = { ...data, evidence: data.evidence.map(record => record.id === 'b' ? { ...record, revision: 2 } : record) }
    const graph = graphOf(file => file, changed)
    const matrix = gapMatrix(graph, { axis: 'dataset', rows: ['method:alpha', 'method:beta', 'method:gamma', 'method:theta', 'method:kappa', 'method:zeta', 'method:none'], columns: ['dataset:bench', 'dataset:corpus', 'method:alpha'] }, passageIndex(changed))
    expect(matrix.rows.map(row => [row.name, row.passages])).toEqual([['Alpha', 3], ['Beta', 2], ['Gamma', 2], ['Theta', 1], ['Kappa', 0], ['Zeta', 1]])
    expect(matrix.columns.map(column => [column.name, column.passages])).toEqual([['Bench', 4], ['Corpus', 2]])
    expect(matrix.cells.map(row => row.map(cell => cell.state))).toEqual([
      ['reported', 'reported'],
      ['mentioned', 'stale'],
      ['reported', 'mentioned'],
      ['project-only', 'absent'],
      ['project-only', 'uncovered'],
      ['mentioned', 'absent'],
    ])
    expect(matrix.cells[2]?.[0]).toMatchObject({ papers: 1, viaSubtypes: 1, relations: ['evaluated-on:method:delta>dataset:bench'] })
    expect(matrix.cells[1]?.[0]).toMatchObject({ passages: 2 })
    expect(matrix.cells[1]?.[1]).toMatchObject({ stale: 1, passages: 0 })
    expect(matrix.cells[3]?.[0]).toMatchObject({ files: 1, runs: 0 })
    expect(matrix.cells[4]?.[0]).toMatchObject({ files: 0, runs: 1 })
    const flat = gapMatrix(graph, { axis: 'dataset', rows: ['method:gamma'], columns: ['dataset:bench'], rollUp: false }, passageIndex(changed))
    expect(flat.cells[0]?.[0]?.state).toBe('mentioned')
    const described = describeGapMatrix(matrix)
    expect(described.split('\n')).toEqual([
      'Gap matrix of methods × datasets over this project\'s own sources only (4 literature records: 2 full text, 1 abstract only, 1 metadata only; 1 project files). It says nothing about work outside them.',
      'reported by papers in this project\'s literature: Alpha × Bench (1); Alpha × Corpus (1); Gamma × Bench (1)',
      'only in this project\'s own runs or files: Theta × Bench; Kappa × Bench',
      'only on grounds whose source changed since: Beta × Corpus',
      'named together in this project\'s sources but not yet checked: Beta × Bench (2 passages); Gamma × Corpus (1 passages); Zeta × Bench (1 passages)',
      'no paper in this project\'s literature reports it: Theta × Corpus; Zeta × Corpus',
      'this project\'s sources do not cover it; search the literature before concluding anything: Kappa × Corpus',
    ])
  })

  it('chooses the methods and columns with the most relations when none are given, for tasks and for settings', () => {
    const graph = graphOf()
    const tasks = gapMatrix(graph, { axis: 'task' }, passageIndex(world()))
    expect([tasks.rows.map(row => row.id), tasks.columns.map(column => column.id), tasks.cells[0]?.[0]?.state]).toEqual([['method:alpha'], ['task:summarization'], 'reported'])
    const datasets = gapMatrix(graph, { axis: 'dataset', limit: 2 }, passageIndex(world()))
    expect([datasets.rows.map(row => row.id), datasets.columns.map(column => column.id)]).toEqual([['method:alpha', 'method:beta'], ['dataset:bench', 'dataset:corpus']])
    const settings = gapMatrix(graph, { axis: 'setting' }, passageIndex(world()))
    const states = settings.cells.map(row => row.map(cell => cell.state))
    expect([settings.rows.map(row => row.id), settings.columns.map(column => [column.id, column.name]), states]).toEqual([
      ['method:alpha', 'method:beta', 'method:delta', 'method:kappa', 'method:theta'], [['32k', '32K'], ['8k', '8K']],
      [['reported', 'absent'], ['absent', 'mentioned'], ['absent', 'reported'], ['project-only', 'uncovered'], ['absent', 'absent']],
    ])
    const asked = gapMatrix(graph, { axis: 'setting', rows: ['method:alpha', 'method:beta'], columns: ['32768', '64K', '64K'] }, passageIndex(world()))
    expect([asked.columns.map(column => [column.id, column.name]), asked.cells.map(row => row.map(cell => cell.state))]).toEqual([
      [['32k', '32K'], ['64k', '64K']], [['reported', 'mentioned'], ['absent', 'mentioned']],
    ])
    const rejected = relationGraph(rejectRelation(applyProposals(emptyRelations(), world(), PROPOSALS, NOW).file,
      { relation: 'evaluated-on:method:alpha>dataset:bench', ground: applyProposals(emptyRelations(), world(), PROPOSALS, NOW).file.relations.find(item => item.id === 'evaluated-on:method:alpha>dataset:bench')?.grounds[0]?.id, by: 'user' }, NOW).file, world())
    // With its only 32K ground rejected, the pair is still named in one passage, and the cell says one source was rejected.
    expect(gapMatrix(rejected, { axis: 'setting', rows: ['method:alpha'], columns: ['32K'] }, passageIndex(world())).cells[0]?.[0])
      .toMatchObject({ state: 'mentioned', papers: 0, rejected: 1, passages: 1 })
    const relationRejected = relationGraph(rejectRelation(applyProposals(emptyRelations(), world(), PROPOSALS, NOW).file,
      { relation: 'evaluated-on:method:alpha>dataset:corpus', by: 'user' }, NOW).file, world())
    expect(gapMatrix(relationRejected, { axis: 'dataset', rows: ['method:alpha'], columns: ['dataset:corpus'] }, passageIndex(world())).cells[0]?.[0])
      .toMatchObject({ state: 'mentioned', rejected: 1 })
  })

  it('caps the relations listed in a cell', () => {
    const data = world()
    const many = Array.from({ length: 10 }, (_, i) => r('is-a', m(`Sub${i}`), m('Alpha'), { type: 'quote', evidenceId: 'x', revision: 1, quote: '' }, 'user'))
    const sources = Array.from({ length: 10 }, (_, i) => source(`s${i}`, 'literature', [[{ page: 1 }, `Sub${i} is a kind of Alpha. Sub${i} is evaluated on Bench.`]]))
    const withSources = { ...data, evidence: [...data.evidence, ...sources] }
    const proposals = many.flatMap((proposal, i) => [
      { ...proposal, ground: q(`s${i}`, `Sub${i} is a kind of Alpha.`) },
      r('evaluated-on', m(`Sub${i}`), d('Bench'), q(`s${i}`, `Sub${i} is evaluated on Bench.`)),
    ])
    const file = applyProposals(applyProposals(emptyRelations(), withSources, PROPOSALS, NOW).file, withSources, proposals, NOW).file
    const matrix = gapMatrix(relationGraph(file, withSources), { axis: 'dataset', rows: ['method:alpha'], columns: ['dataset:bench'] }, passageIndex(withSources))
    expect(matrix.cells[0]?.[0]).toMatchObject({ papers: 11, viaSubtypes: 10 })
    expect(matrix.cells[0]?.[0]?.relations).toHaveLength(8)
  })
})

describe('finding entities by name', () => {
  it('lists exact names first, then aliases and names containing it, within a kind', () => {
    const data = world()
    const file = applyProposals(emptyRelations(), data, [...PROPOSALS, r('compares-with', { kind: 'method', name: 'Alpha Two', aliases: ['A2'] }, m('Alpha'), q('a', 'Alpha outperforms Dense on Bench at 32K.'), 'user')], NOW).file
    const graph = relationGraph(file, data)
    expect(findEntities(graph, 'alpha')).toEqual(['method:alpha', 'method:alpha-two'])
    expect(findEntities(graph, 'A2')).toEqual(['method:alpha-two'])
    expect(findEntities(graph, 'bench', 'method')).toEqual([])
    expect(findEntities(graph, '—')).toEqual([])
  })
})
