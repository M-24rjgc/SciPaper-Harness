import { describe, expect, it } from 'vitest'
import type { GraphFile } from '../src/knowledge.ts'
import type { Annotation } from '../src/knowledge-annotations.ts'
import type { KnowledgeMap, MapPlacement } from '../src/knowledge-map.ts'
import {
  encodeMapView, exactPlacement, mapPaperViews, markViews, NO_REGION, paperByTitle, placementView, searchView, titleKey,
} from '../src/knowledge-map-view.ts'

const paper = (id: string, title: string, pattern: number, extra: Partial<GraphFile['papers'][number]> = {}): GraphFile['papers'][number] => ({
  id, title, pattern, domain: 0, idea: `${title} idea`, problem: '', solution: '', story: `${title} story`, score: 0.5, similar: [], ...extra,
})
const GRAPH: GraphFile = {
  version: 1, name: 'ai', description: 'test', paperUrl: 'https://openreview.net/forum?id={id}', domains: ['Machine Learning'],
  patterns: [{
    id: 'pat0', name: 'Sparse attention at scale', domain: 0, subDomains: [], size: 2, coherence: null, tier: 'A', summary: '', details: '', ideas: [],
    exemplars: [0], works: [],
  }],
  papers: [
    paper('p0', 'Block Sparse Attention Kernels for Long Context', 0),
    paper('p1', 'Linear attention', -1, { url: 'https://example.org/p1' }),
    paper('p2', 'Edge case paper outside every region', 0),
  ],
}

/** A 2 x 2 grid: the top-left cell is region 0, the top-right region 1, the bottom row no region; a gap fills the bottom-right cell. */
function map(): KnowledgeMap {
  return {
    grid: 2,
    x: Float32Array.of(0.25, 0.75, 0.75),
    y: Float32Array.of(0.25, 0.25, 0.9),
    patterns: [{ index: 0, x: 0.3, y: 0.3, spread: 0.05, members: 2 }],
    regions: [
      { index: 0, label: 'attention / sparse', keywords: ['attention', 'sparse'], papers: 1, domain: 0, patterns: [0], x: 0.25, y: 0.25 },
      { index: 1, label: 'linear / kernels', keywords: ['linear'], papers: 1, domain: 3, patterns: [], x: 0.75, y: 0.25 },
    ],
    gaps: [{
      index: 0, x: 0.75, y: 0.75, area: 0.25, depth: 0.05, rimPapers: 2, recurs: 3, runs: 5,
      borders: [{ region: 0, share: 0.6 }, { region: 1, share: 0.4 }], patterns: [0, 9],
    }],
    levels: Uint8Array.of(255, 128, 0, 0),
    densityScale: 100, medianDensity: 25,
    cdf: Float64Array.from({ length: 256 }, (_, q) => q / 255),
    regionCells: Int16Array.of(0, 1, -1, -1),
    gapCells: Int16Array.of(-1, -1, -1, 0),
  }
}

describe('encodeMapView', () => {
  it('packs positions as little-endian uint16 pairs and regions as bytes, and names regions and gaps', () => {
    const page = encodeMapView(map(), GRAPH)
    expect(page.graph).toEqual({ name: 'ai', papers: 3, patterns: 1 })
    const points = Buffer.from(page.points, 'base64')
    expect(points.readUInt16LE(0) / 65535).toBeCloseTo(0.25, 4)
    expect(points.readUInt16LE(10) / 65535).toBeCloseTo(0.9, 4)
    expect([...Buffer.from(page.regionOf, 'base64')]).toEqual([0, 1, NO_REGION])
    expect(page.regions[1]).toMatchObject({ label: 'linear / kernels', domain: '' })
    expect(page.regions[0]?.domain).toBe('Machine Learning')
    expect(page.gaps[0]).toMatchObject({ borders: ['attention / sparse', 'linear / kernels'], recurs: 3, runs: 5 })
    expect(page.gaps[0]?.description).toMatch(/^Sparse in this map/)
    expect(page.gaps[0]?.description).toContain('Sparse attention at scale')
  })

  it('clamps positions outside the map and keeps a region index the byte cannot hold as no region', () => {
    const wide = map()
    wide.x = Float32Array.of(-0.5, 1.5, 0.75)
    wide.regions = [{ ...wide.regions[0]!, index: 300 }]
    wide.gaps = []
    wide.regionCells = Int16Array.of(0, 0, 0, 0)
    const page = encodeMapView(wide, GRAPH)
    const points = Buffer.from(page.points, 'base64')
    expect([points.readUInt16LE(0), points.readUInt16LE(4)]).toEqual([0, 65535])
    expect([...Buffer.from(page.regionOf, 'base64')]).toEqual([NO_REGION, NO_REGION, NO_REGION])
  })
})

describe('placements', () => {
  const placement = (patch: Partial<MapPlacement> = {}): MapPlacement => ({
    x: 0.25, y: 0.25, confidence: 0.8, region: map().regions[0], alternatives: [{ x: 0.8, y: 0.2, share: 0.2 }],
    support: [{ kind: 'pattern', index: 0, weight: 1, distance: 0.01 }, { kind: 'paper', index: 0, weight: 0.9, distance: 0 }], ...patch,
  })
  it('names the region and the supporting papers, not the patterns, and reports crowding', () => {
    const view = placementView(map(), GRAPH, placement())
    expect(view).toMatchObject({ region: 'attention / sparse', confidence: 0.8, alternatives: [{ x: 0.8, y: 0.2, share: 0.2 }] })
    expect(view.nearest).toEqual([{ index: 0, title: 'Block Sparse Attention Kernels for Long Context', weight: 1 }])
    expect(view.crowding).toBeGreaterThan(0.5)
    expect(placementView(map(), GRAPH, placement({ region: undefined }))).not.toHaveProperty('region')
  })
  it('weighs each nearby paper against the heaviest, and a placement no paper supports names none', () => {
    const support: MapPlacement['support'] = [
      { kind: 'paper', index: 1, weight: 0.4, distance: 0.1 }, { kind: 'pattern', index: 0, weight: 2, distance: 0 },
      { kind: 'paper', index: 0, weight: 0.3, distance: 0.2 },
    ]
    expect(placementView(map(), GRAPH, placement({ support })).nearest.map(paper => paper.weight)).toEqual([1, 0.75])
    expect(placementView(map(), GRAPH, placement({ support: [{ kind: 'paper', index: 2, weight: 0, distance: 0 }] })).nearest[0]?.weight).toBe(0)
    expect(placementView(map(), GRAPH, placement({ support: [] })).nearest).toEqual([])
  })
  it('sits exactly on a paper the map holds, with or without a region', () => {
    expect(exactPlacement(map(), GRAPH, 0)).toMatchObject({ x: 0.25, y: 0.25, confidence: 1, exact: true, region: 'attention / sparse' })
    expect(exactPlacement(map(), GRAPH, 2)).not.toHaveProperty('region')
    expect(exactPlacement(map(), GRAPH, 9)).toBeUndefined()
  })
})

describe('searchView', () => {
  it('places a search, lists its papers and keeps only the patterns that hold papers on the map', () => {
    const wide = map()
    wide.patterns.push({ index: 1, x: 0.8, y: 0.8, spread: 0, members: 0 })
    const view = searchView(wide, GRAPH, 'sparse attention', 'semantic+lexical', {
      papers: [{ index: 0, score: 2 }, { index: 1, score: 1 }], patterns: [{ index: 1, score: 0.5 }, { index: 0, score: 0.4 }],
    })
    expect(view).toMatchObject({ query: 'sparse attention', basis: 'semantic+lexical', papers: [{ index: 0, title: GRAPH.papers[0]?.title }, { index: 1 }] })
    expect(view.patterns).toEqual([{ index: 0, name: 'Sparse attention at scale', x: 0.3, y: 0.3 }])
    expect(view.placement?.region).toBe('attention / sparse')
  })
  it('places nothing when nothing matched', () => {
    expect(searchView(map(), GRAPH, 'zzz', 'lexical', { papers: [], patterns: [] })).toEqual({ query: 'zzz', basis: 'lexical', papers: [], patterns: [] })
  })
})

describe('titles and paper details', () => {
  it('matches a reference title ignoring case, accents and punctuation, but never a short one', () => {
    expect(titleKey('Block-Sparse  Attention: Kernels!')).toBe('blocksparseattentionkernels')
    expect(titleKey('Résumé')).toBe('resume')
    expect(paperByTitle(GRAPH, 'block sparse attention kernels for long-context')).toBe(0)
    const repeated = { ...GRAPH, papers: [...GRAPH.papers, paper('p3', 'Tiny', -1), paper('p4', 'Block sparse attention kernels for long context', 0)] }
    expect(paperByTitle(repeated, 'Tiny')).toBeUndefined()
    // A title the graph holds twice resolves to its first paper.
    expect(paperByTitle(repeated, 'Block Sparse Attention Kernels for Long Context')).toBe(0)
    expect(paperByTitle(GRAPH, 'An unrelated paper title')).toBeUndefined()
    // The index is built once per graph file.
    expect(paperByTitle(GRAPH, 'Edge case paper outside every region')).toBe(2)
  })
  it('details known papers with their pattern, region and link, and leaves unknown indices out', () => {
    const views = mapPaperViews(map(), GRAPH, [1, 0, 42, 2])
    expect(views.map(view => view.index)).toEqual([1, 0, 2])
    expect(views[0]).toMatchObject({ url: 'https://example.org/p1', region: 'linear / kernels' })
    expect(views[0]).not.toHaveProperty('pattern')
    expect(views[1]).toMatchObject({ pattern: 'Sparse attention at scale', url: 'https://openreview.net/forum?id=p0' })
    expect(views[2]).not.toHaveProperty('region')
    const plain = { ...GRAPH }
    delete plain.paperUrl
    expect(mapPaperViews(map(), plain, [0])[0]).not.toHaveProperty('url')
  })
})

describe('markViews', () => {
  const mark = (target: Annotation['target'], patch: Partial<Annotation> = {}): Annotation => ({
    id: `${target.graph}:${target.kind}:${target.id}`, target, verdict: 'pin', by: 'user', at: '2026-10-01T00:00:00.000Z', ...patch,
  })
  it('names marks from the graphs that hold them and gives built-in papers their map index', () => {
    const project: GraphFile = { ...GRAPH, name: 'project', papers: [paper('q0', 'Project paper', 0)] }
    const views = markViews([
      mark({ kind: 'paper', graph: 'ai', id: 'p1' }, { note: 'baseline', verdict: 'irrelevant', by: 'agent' }),
      mark({ kind: 'pattern', graph: 'ai', id: 'pat0' }),
      mark({ kind: 'paper', graph: 'project', id: 'q0' }),
      mark({ kind: 'paper', graph: 'ai', id: 'gone' }),
    ], { ai: GRAPH, project })
    expect(views[0]).toEqual({ id: 'ai:paper:p1', target: { kind: 'paper', graph: 'ai', id: 'p1' }, verdict: 'irrelevant', by: 'agent', at: '2026-10-01T00:00:00.000Z',
      note: 'baseline', title: 'Linear attention', index: 1 })
    expect(views[1]).toMatchObject({ title: 'Sparse attention at scale' })
    expect(views[1]).not.toHaveProperty('index')
    expect(views[2]).toMatchObject({ title: 'Project paper' })
    expect(views[2]).not.toHaveProperty('index')
    expect(views[3]).not.toHaveProperty('title')
    expect(markViews([mark({ kind: 'paper', graph: 'project', id: 'q0' })], {})[0]).not.toHaveProperty('title')
  })
})
