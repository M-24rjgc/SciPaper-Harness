import { describe, expect, it } from 'vitest'
import type { ArtifactId, ArtifactRecord, ClaimRecord, EvidenceId, EvidenceRecord, ExperimentRecord, ResearchProject } from '../src/types.ts'
import { buildEvidenceGraph, claimState } from '../src/knowledge-evidence.ts'

const source = (id: string, patch: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: id as EvidenceId, title: `Source ${id}`, kind: 'literature', path: `.research/sources/${id}.json`, sha256: 'x', revision: 1,
  importedAt: '2026-10-01T00:00:00Z', chunks: [], coverage: 'abstract', verified: true, stale: false, ...patch,
})
const run = (id: string, patch: Partial<ExperimentRecord> = {}): ExperimentRecord => ({
  id: id as ExperimentRecord['id'], spec: { name: 'ruler-32k-dynamic', seed: 42 } as ExperimentRecord['spec'], status: 'completed',
  createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: { accuracy: 0.814, perplexity: 6.3199999, epochs: 3 },
  message: '', snapshotPath: '', collected: true, ...patch,
})
const claim = (id: string, patch: Partial<ClaimRecord> = {}): ClaimRecord => ({
  id, text: `Claim ${id}`, kind: 'empirical', state: 'supported', evidence: [], artifactIds: [], ...patch,
})
const artifact = (id: string, path: string, kind: ArtifactRecord['kind'], stale: boolean): ArtifactRecord => ({
  id: id as ArtifactId, path, kind, revision: 1, sha256: '', evidence: [], claimIds: [], inputArtifacts: [], stale, updatedAt: '', author: 'agent',
})
const link = (id: string, revision = 1, quote = 'a quote'): ClaimRecord['evidence'][number] => ({ evidenceId: id as EvidenceId, revision, locator: {}, quote })
const project = (patch: Partial<ResearchProject> = {}): Pick<ResearchProject, 'brief' | 'title' | 'claims' | 'evidence' | 'artifacts' | 'experiments'> => ({
  brief: 'Does dynamic block selection keep accuracy at a quarter of the FLOPs?', title: 'Sparse', claims: [], evidence: [], artifacts: [], experiments: [], ...patch,
})

describe('claimState', () => {
  const sources = new Map([['a', source('a')], ['old', source('old', { revision: 3 })], ['gone', source('gone', { stale: true })]])
  it('keeps contradicted, and treats a hypothesis without sources as proposed but any other claim without sources as missing', () => {
    expect(claimState(claim('1', { state: 'contradicted', evidence: [link('a')] }), sources)).toBe('contradicted')
    expect(claimState(claim('2', { kind: 'hypothesis', state: 'proposed' }), sources)).toBe('proposed')
    expect(claimState(claim('3'), sources)).toBe('missing')
  })
  it('turns stale when a cited source is newer, stale or unknown, or when the record says so', () => {
    expect(claimState(claim('4', { evidence: [link('a'), link('old', 1)] }), sources)).toBe('stale')
    expect(claimState(claim('5', { evidence: [link('gone')] }), sources)).toBe('stale')
    expect(claimState(claim('6', { evidence: [link('missing-record')] }), sources)).toBe('stale')
    expect(claimState(claim('7', { state: 'stale', evidence: [link('a')] }), sources)).toBe('stale')
  })
  it('returns the recorded state for a claim whose sources are current', () => {
    expect(claimState(claim('8', { evidence: [link('a')] }), sources)).toBe('supported')
    expect(claimState(claim('9', { state: 'proposed', evidence: [link('old', 3)] }), sources)).toBe('proposed')
  })
})

describe('buildEvidenceGraph', () => {
  it('starts from the brief, falls back to the title, and clips a long label', () => {
    expect(buildEvidenceGraph(project()).nodes[0]?.label).toContain('dynamic block')
    expect(buildEvidenceGraph(project()).nodes[0]).toMatchObject({ id: 'question', kind: 'question' })
    expect(buildEvidenceGraph(project({ brief: '' })).nodes[0]?.label).toBe('Sparse')
    const long = buildEvidenceGraph(project({ brief: 'word '.repeat(80) })).nodes[0]?.label ?? ''
    expect(long.length).toBe(160)
    expect(long.endsWith('…')).toBe(true)
    expect(buildEvidenceGraph(project()).summary).toEqual({ claims: 0, supported: 0, proposed: 0, stale: 0, contradicted: 0, missing: 0 })
  })

  it('links claims to literature, to runs recognised by their output path, and to the files they appear in', () => {
    const graph = buildEvidenceGraph(project({
      evidence: [
        source('lit', { doi: '10.1/x' }),
        source('url', { sourceUrl: 'https://example.org/p' }),
        source('plain', { kind: 'file' }),
        source('r1', { kind: 'experiment', path: '.research/runs/run-1/metrics.json' }),
        source('r9', { kind: 'experiment', path: '.research/runs/unknown/metrics.json' }),
      ],
      experiments: [run('run-1'), run('run-2', { metrics: {} })],
      artifacts: [
        artifact('art-1', 'paper/main.tex', 'manuscript', true),
        artifact('art-2', 'paper/fig1.pdf', 'figure', false),
      ],
      claims: [
        claim('c1', { evidence: [link('lit'), link('r1'), link('url')], artifactIds: ['art-1' as ArtifactId, 'art-2' as ArtifactId, 'missing-art' as ArtifactId] }),
        claim('c2', { evidence: [link('r1'), link('plain'), link('r9'), link('absent')], artifactIds: ['art-1' as ArtifactId] }),
      ],
    }))
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    expect(byId.get('claim:c1')).toMatchObject({ kind: 'claim', state: 'supported', detail: 'empirical', where: ['paper/main.tex', 'paper/fig1.pdf'], ref: { claimId: 'c1' } })
    expect(byId.get('run:run-1')).toMatchObject({ kind: 'run', label: 'ruler-32k-dynamic · seed 42', detail: 'accuracy 0.814 · perplexity 6.32 · epochs 3', ref: { experimentId: 'run-1' } })
    expect(byId.get('evidence:lit')).toMatchObject({ kind: 'literature', detail: '10.1/x', ref: { evidenceId: 'lit', path: '.research/sources/lit.json' } })
    expect(byId.get('evidence:url')).toMatchObject({ kind: 'literature', detail: 'https://example.org/p' })
    expect(byId.get('evidence:plain')).toMatchObject({ kind: 'file' })
    expect(byId.get('evidence:r9')).toMatchObject({ kind: 'file' })
    expect(byId.get('evidence:absent')).toMatchObject({ kind: 'file', label: 'absent', state: 'stale' })
    expect(byId.get('artifact:art-1')).toMatchObject({ kind: 'artifact', label: 'paper/main.tex', state: 'stale' })
    // The run cited by two claims is one node.
    expect(graph.nodes.filter(node => node.id === 'run:run-1')).toHaveLength(1)
    const supports = graph.edges.filter(edge => edge.kind === 'supports')
    expect(supports).toHaveLength(7)
    expect(graph.edges.filter(edge => edge.kind === 'asks').map(edge => edge.to)).toEqual(['claim:c1', 'claim:c2'])
    expect(graph.edges.find(edge => edge.kind === 'appears-in')).toMatchObject({ from: 'claim:c1', to: 'artifact:art-1', stale: true })
    expect(byId.get('artifact:art-2')).toMatchObject({ state: 'supported' })
    expect(graph.edges.find(edge => edge.to === 'evidence:absent')?.stale).toBe(true)
    expect(supports[0]).toMatchObject({ quote: 'a quote', stale: false })
  })

  it('shows a run without recorded metrics by its status, marks a stale run, and counts the claims by state', () => {
    const graph = buildEvidenceGraph(project({
      evidence: [source('r2', { kind: 'experiment', path: '.research/runs/run-2/metrics.json', stale: true })],
      experiments: [run('run-2', { metrics: {}, status: 'completed' })],
      claims: [
        claim('c1', { evidence: [link('r2')] }),
        claim('c2', { kind: 'hypothesis', state: 'proposed' }),
        claim('c3'),
        claim('c4', { state: 'contradicted', evidence: [link('r2')] }),
        claim('c5', { evidence: [link('r2')], text: 'x'.repeat(200) }),
      ],
    }))
    expect(graph.nodes.find(node => node.id === 'run:run-2')).toMatchObject({ detail: 'completed', state: 'stale' })
    expect(graph.summary).toEqual({ claims: 5, supported: 0, proposed: 1, stale: 2, contradicted: 1, missing: 1 })
    expect(graph.edges.find(edge => edge.to === 'run:run-2')?.stale).toBe(true)
    expect(graph.nodes.find(node => node.id === 'claim:c5')?.label.length).toBe(160)
  })

  it('marks a support and its literature stale when the source moved on after the claim cited it', () => {
    const graph = buildEvidenceGraph(project({
      evidence: [source('lit', { revision: 4, stale: true })],
      claims: [claim('c1', { evidence: [link('lit', 2)] })],
    }))
    expect(graph.nodes.find(node => node.id === 'evidence:lit')).toMatchObject({ kind: 'literature', state: 'stale' })
    const fresh = buildEvidenceGraph(project({ evidence: [source('lit', { revision: 4 })], claims: [claim('c1', { evidence: [link('lit', 2)] })] }))
    expect(fresh.edges.find(edge => edge.kind === 'supports')?.stale).toBe(true)
    expect(fresh.nodes.find(node => node.id === 'evidence:lit')?.state).toBe('supported')
  })

  it('leaves out the quote of a support that has none', () => {
    const graph = buildEvidenceGraph(project({ evidence: [source('a')], claims: [claim('c1', { evidence: [link('a', 1, '')] })] }))
    expect(graph.edges.find(edge => edge.kind === 'supports')).not.toHaveProperty('quote')
  })
})
