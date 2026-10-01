import { describe, expect, it } from 'vitest'
import type {
  ArtifactId, ArtifactRecord, ClaimRecord, EnvironmentId, EnvironmentRecord, EvidenceId, EvidenceRecord, ExperimentRecord,
} from '../src/types.ts'
import { buildEvidenceGraph, claimStatus, isOutdated, type EvidenceGraphInput } from '../src/knowledge-evidence.ts'

const source = (id: string, patch: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: id as EvidenceId, title: `Source ${id}`, kind: 'literature', path: `.research/sources/${id}.json`, sha256: 'x', revision: 1,
  importedAt: '2026-10-01T00:00:00Z', chunks: [], coverage: 'abstract', verified: true, stale: false, ...patch,
})
const environment = (id: string, patch: Partial<EnvironmentRecord> = {}): EnvironmentRecord => ({
  id: id as EnvironmentId, name: id, kind: 'uv', target: 'local', python: 'python', requirements: [], fingerprint: '', status: 'ready',
  details: '', isDefault: false, ...patch,
})
const run = (id: string, patch: Partial<ExperimentRecord> = {}, name = `run-${id}`): ExperimentRecord => ({
  id: id as ExperimentRecord['id'],
  spec: { environmentId: 'env-local' as EnvironmentId, name, argv: [], cwd: '.', seed: 42, maxSeconds: 60, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'm.json' },
  status: 'completed', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: { accuracy: 0.814 },
  message: '', snapshotPath: '', collected: true, ...patch,
})
const claim = (id: string, patch: Partial<ClaimRecord> = {}): ClaimRecord => ({
  id, text: `Claim ${id}`, kind: 'empirical', state: 'supported', evidence: [], artifactIds: [], ...patch,
})
const artifact = (id: string, path: string, patch: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  id: id as ArtifactId, path, kind: 'manuscript', revision: 2, sha256: '', evidence: [], claimIds: [], inputArtifacts: [], stale: false,
  updatedAt: '', author: 'agent', ...patch,
})
const cite = (id: string, revision = 1, quote = 'a quote'): ClaimRecord['evidence'][number] => ({ evidenceId: id as EvidenceId, revision, locator: { page: 3 }, quote })
const project = (patch: Partial<EvidenceGraphInput> = {}): EvidenceGraphInput => ({
  brief: 'Does dynamic block selection keep accuracy at a quarter of the FLOPs?', title: 'Sparse', claims: [], evidence: [], artifacts: [],
  experiments: [], environments: [environment('env-local')], ...patch,
})
const output = (id: string, runId: string, patch: Partial<EvidenceRecord> = {}): EvidenceRecord =>
  source(id, { kind: 'experiment', coverage: 'data', path: `.research/runs/${runId}/metrics.json`, ...patch })

describe('isOutdated', () => {
  it('is true for a source that is gone, recorded stale or on another revision, and false for a current one', () => {
    expect(isOutdated({ revision: 1 }, undefined)).toBe(true)
    expect(isOutdated({ revision: 1 }, { revision: 1, stale: true })).toBe(true)
    expect(isOutdated({ revision: 1 }, { revision: 2, stale: false })).toBe(true)
    expect(isOutdated({ revision: 2 }, { revision: 2, stale: false })).toBe(false)
  })
})

describe('claimStatus', () => {
  it('keeps a recorded contradiction whatever the claim cites', () => {
    expect(claimStatus(claim('1', { state: 'contradicted', evidence: [cite('a')] }), true)).toBe('contradicted')
    expect(claimStatus(claim('1', { state: 'contradicted' }), false)).toBe('contradicted')
  })
  it('calls a claim without citations proposed when it is a hypothesis and missing its evidence otherwise', () => {
    expect(claimStatus(claim('2', { kind: 'hypothesis', state: 'proposed' }), false)).toBe('proposed')
    for (const kind of ['empirical', 'method', 'literature'] as const) expect(claimStatus(claim('3', { kind }), false)).toBe('missing')
  })
  it('calls a claim stale when a citation is outdated or the record says stale', () => {
    expect(claimStatus(claim('4', { evidence: [cite('a')] }), true)).toBe('stale')
    expect(claimStatus(claim('5', { state: 'stale', evidence: [cite('a')] }), false)).toBe('stale')
  })
  it('keeps a recorded proposal that cites current sources, and calls every other claim supported', () => {
    expect(claimStatus(claim('6', { state: 'proposed', evidence: [cite('a')] }), false)).toBe('proposed')
    expect(claimStatus(claim('7', { evidence: [cite('a')] }), false)).toBe('supported')
  })
})

describe('buildEvidenceGraph', () => {
  it('asks the brief, falls back to the title when the brief is blank, and counts nothing for an empty record', () => {
    expect(buildEvidenceGraph(project({ brief: '  Is it sparse?  ' })).question).toBe('Is it sparse?')
    expect(buildEvidenceGraph(project({ brief: ' \n ' })).question).toBe('Sparse')
    expect(buildEvidenceGraph(project())).toMatchObject({
      claims: [], sources: [], summary: { claims: 0, supported: 0, stale: 0, missing: 0, proposed: 0, contradicted: 0 },
    })
  })

  it('reads a record like the prototype: two supported claims share a baseline run, one claim lacks a run, one rests on changed literature', () => {
    const graph = buildEvidenceGraph(project({
      environments: [environment('env-local'), environment('env-lab', { target: 'ssh', sshHost: 'lab-a100' })],
      experiments: [
        run('r-dyn', {}, 'ruler-32k-dynamic'),
        run('r-full', { metrics: { accuracy: 0.821, peak_memory_gb: 61.5 } }, 'ruler-32k-full'),
        run('r-fixed', { metrics: { peak_memory_gb: 37.9 } }, 'ruler-32k-fixed'),
        run('r-64k', { status: 'queued', collected: false, spec: { ...run('x').spec, name: 'ruler-64k-dynamic', environmentId: 'env-lab' as EnvironmentId } }),
      ],
      evidence: [
        output('e-dyn', 'r-dyn'), output('e-full', 'r-full'), output('e-fixed', 'r-fixed'),
        source('lf'), source('bb', { revision: 2, stale: true }),
      ],
      artifacts: [artifact('paper', 'paper/main.tex', { claimIds: ['c1'] }), artifact('fig', 'figures/a.pdf', { kind: 'figure' })],
      claims: [
        claim('c1', { text: 'Dynamic is within one point', evidence: [cite('e-dyn'), cite('e-full')], artifactIds: ['paper' as ArtifactId] }),
        claim('c2', { evidence: [cite('e-fixed'), cite('e-full')], artifactIds: ['paper' as ArtifactId, 'fig' as ArtifactId] }),
        claim('c3', { text: 'The edge grows at 64K', state: 'proposed' }),
        claim('c4', { kind: 'literature', evidence: [cite('lf'), cite('bb')] }),
      ],
    }))
    expect(graph.summary).toEqual({ claims: 4, supported: 2, stale: 1, missing: 1, proposed: 0, contradicted: 0 })
    expect(graph.claims.map(item => [item.id, item.status])).toEqual([['c1', 'supported'], ['c2', 'supported'], ['c3', 'missing'], ['c4', 'stale']])
    expect(graph.claims[0]).toMatchObject({
      text: 'Dynamic is within one point', kind: 'empirical', files: [{ path: 'paper/main.tex', revision: 2, stale: false }], expected: [], expectedMore: 0,
      links: [{ sourceId: 'run:r-dyn', revision: 1, outdated: false, locator: { page: 3 }, quote: 'a quote' }, { sourceId: 'run:r-full', outdated: false }],
    })
    expect(graph.claims[1]?.files.map(file => file.path)).toEqual(['paper/main.tex', 'figures/a.pdf'])
    expect(graph.claims[2]).toMatchObject({ links: [], expected: ['expected:r-64k'], expectedMore: 0 })
    const byId = new Map(graph.sources.map(item => [item.id, item]))
    expect(byId.get('run:r-dyn')).toMatchObject({
      kind: 'run', label: 'ruler-32k-dynamic', seed: 42, host: 'local', status: 'completed', metrics: { accuracy: 0.814 }, changed: false, path: '.research/runs/r-dyn/metrics.json',
    })
    expect(graph.sources.filter(item => item.id === 'run:r-full')).toHaveLength(1)
    expect(byId.get('expected:r-64k')).toMatchObject({ kind: 'expected-run', label: 'ruler-64k-dynamic', status: 'queued', host: 'lab-a100', changed: false })
    expect(byId.get('source:lf')).toMatchObject({ kind: 'literature', label: 'Source lf', verified: true, coverage: 'abstract', changed: false, path: '.research/sources/lf.json' })
    expect(byId.get('source:bb')).toMatchObject({ kind: 'literature', changed: true })
    expect(graph.claims[3]?.links.map(link => link.outdated)).toEqual([false, true])
  })

  it('shows one run node for several outputs of the run and where the run executes, whatever its environment', () => {
    const graph = buildEvidenceGraph(project({
      environments: [environment('env-local'), environment('env-ssh', { target: 'ssh' }), environment('env-lab', { target: 'ssh', sshHost: 'lab' })],
      experiments: [
        run('a', { spec: { ...run('x').spec, environmentId: 'env-ssh' as EnvironmentId } }),
        run('b', { spec: { ...run('x').spec, environmentId: 'env-lab' as EnvironmentId } }),
        run('c', { spec: { ...run('x').spec, environmentId: 'env-gone' as EnvironmentId } }),
      ],
      evidence: [output('a1', 'a'), output('a2', 'a', { path: '.research/runs/a/log.json' }), output('b1', 'b'), output('c1', 'c')],
      claims: [claim('k', { evidence: [cite('a1'), cite('a2'), cite('b1'), cite('c1')] })],
    }))
    expect(graph.sources.map(item => [item.id, item.host])).toEqual([['run:a', 'ssh'], ['run:b', 'lab'], ['run:c', undefined]])
    expect(graph.sources[2]).not.toHaveProperty('host')
    expect(graph.sources[0]?.path).toBe('.research/runs/a/metrics.json')
    expect(graph.claims[0]?.links.map(link => link.sourceId)).toEqual(['run:a', 'run:a', 'run:b', 'run:c'])
  })

  it('treats a file source or an experiment source without a recorded run as a plain source, and a missing record as a changed file', () => {
    const graph = buildEvidenceGraph(project({
      evidence: [source('f', { kind: 'file', coverage: 'data' }), output('orphan', 'unknown-run')],
      claims: [claim('k', { evidence: [cite('f'), cite('orphan'), cite('gone')] })],
    }))
    const byId = new Map(graph.sources.map(item => [item.id, item]))
    expect(byId.get('source:f')).toMatchObject({ kind: 'file', coverage: 'data', changed: false })
    expect(byId.get('source:orphan')).toMatchObject({ kind: 'file', label: 'Source orphan' })
    expect(byId.get('source:gone')).toEqual({ id: 'source:gone', kind: 'file', label: 'gone', changed: true })
    expect(graph.claims[0]).toMatchObject({ status: 'stale' })
    expect(graph.claims[0]?.links[2]).toMatchObject({ sourceId: 'source:gone', outdated: true })
  })

  it('marks a source changed when any claim cites an older revision, leaving the claim that cites the current one supported', () => {
    const graph = buildEvidenceGraph(project({
      evidence: [source('lit', { revision: 3 })],
      claims: [claim('old', { evidence: [cite('lit', 1)] }), claim('new', { evidence: [cite('lit', 3)] })],
    }))
    expect(graph.claims.map(item => item.status)).toEqual(['stale', 'supported'])
    expect(graph.sources).toHaveLength(1)
    expect(graph.sources[0]?.changed).toBe(true)
  })

  it('expects evidence of an untested claim only from runs that can still deliver, shows three of them and counts the rest', () => {
    const experiments = [
      run('q', { status: 'queued', collected: false }), run('r', { status: 'running', collected: false }),
      run('u', { status: 'unknown', collected: false }), run('d', { status: 'completed', collected: false }),
      run('failed', { status: 'failed', collected: false }), run('cancelled', { status: 'cancelled', collected: false }),
      run('interrupted', { status: 'interrupted', collected: false }), run('collected', { status: 'completed', collected: true }),
    ]
    const graph = buildEvidenceGraph(project({
      experiments,
      claims: [claim('empirical'), claim('hyp', { kind: 'hypothesis', state: 'proposed' }), claim('method', { kind: 'method' })],
    }))
    expect(graph.claims[0]).toMatchObject({ status: 'missing', expected: ['expected:q', 'expected:r', 'expected:u'], expectedMore: 1 })
    expect(graph.claims[1]).toMatchObject({ status: 'proposed', expected: ['expected:q', 'expected:r', 'expected:u'], expectedMore: 1 })
    expect(graph.claims[2]).toMatchObject({ status: 'missing', expected: ['none:method'], expectedMore: 0 })
    expect(graph.sources.filter(item => item.kind === 'expected-run').map(item => item.id)).toEqual(['expected:q', 'expected:r', 'expected:u'])
    expect(graph.sources.find(item => item.id === 'none:method')).toEqual({ id: 'none:method', kind: 'none', label: '', changed: false })
  })

  it('marks a claim nothing is expected for when no run is in progress, and expects nothing for a claim that cites a source', () => {
    const graph = buildEvidenceGraph(project({
      experiments: [run('q', { status: 'queued', collected: false })],
      evidence: [source('lit')],
      claims: [claim('cited', { evidence: [cite('lit')] }), claim('bare')],
    }))
    expect(graph.claims[0]).toMatchObject({ expected: [], expectedMore: 0 })
    expect(graph.claims[1]).toMatchObject({ expected: ['expected:q'] })
    const idle = buildEvidenceGraph(project({ claims: [claim('bare', { state: 'contradicted' })] }))
    expect(idle.claims[0]).toMatchObject({ status: 'contradicted', expected: ['none:bare'] })
    expect(idle.summary).toMatchObject({ claims: 1, contradicted: 1 })
  })

  it('lists a file once when the claim and the file both record the link, and leaves out the quote of a citation that has none', () => {
    const graph = buildEvidenceGraph(project({
      evidence: [source('lit')],
      artifacts: [artifact('both', 'paper/a.tex', { claimIds: ['k'] }), artifact('other', 'paper/b.tex', { stale: true })],
      claims: [claim('k', { evidence: [cite('lit', 1, '')], artifactIds: ['both' as ArtifactId, 'other' as ArtifactId] })],
    }))
    expect(graph.claims[0]?.files).toEqual([
      { id: 'both', path: 'paper/a.tex', revision: 2, stale: false }, { id: 'other', path: 'paper/b.tex', revision: 2, stale: true },
    ])
    expect(graph.claims[0]?.links[0]).not.toHaveProperty('quote')
  })
})
