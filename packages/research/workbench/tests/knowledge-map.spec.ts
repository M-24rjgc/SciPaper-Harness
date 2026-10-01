import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, gunzipSync, gzipSync } from 'node:zlib'
import { builtinIndices, KnowledgeBase, PROJECT_GRAPH, type GraphFile } from '../src/knowledge.ts'
import {
  describeGap, densityAt, gapAt, hitsFromRecall, KNOWLEDGE_MAP_VERSION, loadKnowledgeMap, nearestGap, paperPosition,
  parseKnowledgeMap, PATTERN_HITS, PATTERN_WEIGHT, placeFromHits, PLACEMENT_BANDWIDTH, recallHits, regionAt, SUPPORT_RADIUS, type MapHit,
} from '../src/knowledge-map.ts'

const roots: string[] = []
const bases: KnowledgeBase[] = []
afterEach(async () => {
  for (const base of bases.splice(0)) base.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true })
})
const signal = new AbortController().signal

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'research knowledge map '))
  roots.push(root)
  return root
}

/** The fields of a synthetic asset, in the units the file stores. */
interface Fixture {
  version: number
  grid: number
  runs: number
  scale: number
  median: number
  papers: [number, number][]
  patterns: { x: number; y: number; spread: number; members: number }[]
  regions: { x: number; y: number; papers: number; label: string; keywords: string; domain: number; patterns: number[] }[]
  gaps: {
    x: number
    y: number
    cells: number
    depth: number
    rim: number
    recurs: number
    borders: [number, number][]
    patterns: number[]
  }[]
  cdf: number[]
  levels: number[]
  regionCells: number[]
  gapCells: number[]
}

const unit = (value: number): number => Math.round(value * 0xffff)

/** A 4 x 4 map: two regions (left and right halves), one gap between them in the top middle, six papers, three patterns. */
function fixture(): Fixture {
  const grid = 4
  const levels = Array.from({ length: 16 }, (_, cell) => [0, 3].includes(cell % 4) ? 255 : 51)
  return {
    version: 1, grid, runs: 5, scale: 4000, median: 1000,
    papers: [[0.1, 0.1], [0.12, 0.11], [0.11, 0.13], [0.9, 0.9], [0.88, 0.91], [0.5, 0.5]],
    patterns: [
      { x: 0.11, y: 0.11, spread: 0.01, members: 3 }, { x: 0.89, y: 0.9, spread: 0.3, members: 2 }, { x: 0, y: 0, spread: 0, members: 0 },
    ],
    regions: [
      {
        x: 0.2, y: 0.5, papers: 3, label: 'graph / gnns', keywords: 'graph, gnns, message passing', domain: 2, patterns: [0, 0xffff, 0xffff],
      },
      { x: 0.8, y: 0.5, papers: 3, label: 'causal / treatment', keywords: '', domain: 1, patterns: [1, 2, 0xffff] },
    ],
    gaps: [{ x: 0.5, y: 0.125, cells: 2, depth: 420, rim: 6, recurs: 4, borders: [[0, 55], [1, 45]], patterns: [0, 1, 0xffff] }],
    cdf: Array.from({ length: 256 }, (_, level) => Math.round(Math.min(1, level / 200) * 0xffff)),
    levels,
    regionCells: Array.from({ length: 16 }, (_, cell) => cell === 8 ? 255 : cell % 4 < 2 ? 0 : 1),
    gapCells: Array.from({ length: 16 }, (_, cell) => [1, 2].includes(cell) ? 0 : 255),
  }
}

/** Encode a fixture exactly as scripts/build_kg_map.py does. */
function encode(f: Fixture): Uint8Array {
  const strings: number[] = []
  const string = (text: string): [number, number] => {
    const raw = new TextEncoder().encode(text)
    const offset = strings.length
    strings.push(...raw)
    return [offset, raw.length]
  }
  const body: number[] = []
  const u8 = (value: number): void => { body.push(value & 0xff) }
  const u16 = (value: number): void => { u8(value); u8(value >>> 8) }
  const u32 = (value: number): void => { u16(value & 0xffff); u16(value >>> 16) }
  for (const [x, y] of f.papers) { u16(unit(x)); u16(unit(y)) }
  for (const p of f.patterns) { u16(unit(p.x)); u16(unit(p.y)); u16(unit(p.spread)); u16(p.members) }
  for (const r of f.regions) {
    const [lo, ll] = string(r.label)
    const [ko, kl] = string(r.keywords)
    u16(unit(r.x)); u16(unit(r.y)); u32(r.papers); u32(lo); u16(ll); u32(ko); u16(kl); u16(r.domain)
    for (const p of r.patterns) u16(p)
  }
  for (const g of f.gaps) {
    u16(unit(g.x)); u16(unit(g.y)); u16(g.cells); u16(g.depth); u16(g.rim); u8(g.recurs); u8(g.borders.length)
    for (let slot = 0; slot < 3; slot++) u8(g.borders[slot]?.[0] ?? 0xff)
    for (let slot = 0; slot < 3; slot++) u8(g.borders[slot]?.[1] ?? 0)
    for (const p of g.patterns) u16(p)
  }
  for (const value of f.cdf) u16(value)
  body.push(...f.levels, ...f.regionCells, ...f.gapCells, ...strings)
  const header = new DataView(new ArrayBuffer(40))
  ;[0x89, 0x4b, 0x47, 0x4d, 0x41, 0x50, 0x0d, 0x0a].forEach((value, at) => { header.setUint8(at, value) })
  header.setUint16(8, f.version, true)
  header.setUint16(10, f.grid, true)
  header.setUint32(12, f.papers.length, true)
  header.setUint16(16, f.patterns.length, true)
  header.setUint16(18, f.regions.length, true)
  header.setUint16(20, f.gaps.length, true)
  header.setUint16(22, f.runs, true)
  header.setFloat32(24, f.scale, true)
  header.setFloat32(28, f.median, true)
  header.setUint32(32, strings.length, true)
  const bytes = new Uint8Array(40 + body.length)
  bytes.set(new Uint8Array(header.buffer))
  bytes.set(body, 40)
  return reseal(bytes)
}

/** Recompute the checksum after a deliberate edit. */
function reseal(bytes: Uint8Array): Uint8Array {
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(36, crc32(bytes.subarray(40)), true)
  return bytes
}

function edited(change: (f: Fixture) => void): Uint8Array {
  const f = fixture()
  change(f)
  return encode(f)
}

const map = parseKnowledgeMap(encode(fixture()))

describe('parseKnowledgeMap', () => {
  it('reads every section of a version-1 asset', () => {
    expect(KNOWLEDGE_MAP_VERSION).toBe(1)
    expect(map.grid).toBe(4)
    expect(map.x[0]).toBeCloseTo(0.1, 4)
    expect(map.y[3]).toBeCloseTo(0.9, 4)
    expect(map.patterns[1]).toMatchObject({ index: 1, members: 2 })
    expect(map.patterns[1]?.spread).toBeCloseTo(0.3, 4)
    expect(map.regions[0]).toMatchObject({
      index: 0, label: 'graph / gnns', keywords: ['graph', 'gnns', 'message passing'], papers: 3, domain: 2, patterns: [0],
    })
    expect(map.regions[1]).toMatchObject({ keywords: [], patterns: [1, 2] })
    expect(map.gaps[0]).toMatchObject({
      index: 0, area: 2 / 16, depth: 0.042, rimPapers: 6, recurs: 4, runs: 5, patterns: [0, 1],
      borders: [{ region: 0, share: 0.55 }, { region: 1, share: 0.45 }],
    })
    expect(map.cdf[200]).toBe(1)
    expect(map.levels[0]).toBe(255)
    expect(map.regionCells[8]).toBe(-1)
    expect(map.gapCells[1]).toBe(0)
    expect(map.gapCells[0]).toBe(-1)
    expect(map.densityScale).toBe(4000)
    expect(map.medianDensity).toBe(1000)
  })

  it('checks the paper count against the graph when given one', () => {
    expect(parseKnowledgeMap(encode(fixture()), 6).x).toHaveLength(6)
    expect(() => parseKnowledgeMap(encode(fixture()), 7)).toThrow('it places 6 papers but the graph has 7')
  })

  it('refuses a truncated, foreign, newer, resized or damaged file', () => {
    const good = encode(fixture())
    expect(() => parseKnowledgeMap(good.subarray(0, 39))).toThrow('39 bytes is shorter than the 40-byte header')
    const foreign = good.slice()
    foreign[1] = 0x50
    expect(() => parseKnowledgeMap(foreign)).toThrow('the signature is missing')
    expect(() => parseKnowledgeMap(edited((f) => { f.version = 2 }))).toThrow('format version 2 is not 1')
    expect(() => parseKnowledgeMap(good.subarray(0, good.length - 1)))
      .toThrow(`it holds ${good.length - 1} bytes where its header implies ${good.length}`)
    const damaged = good.slice()
    damaged[50] = (damaged[50] as number) ^ 0xff
    expect(() => parseKnowledgeMap(damaged)).toThrow('the checksum does not match')
  })

  it('refuses header values out of range', () => {
    const outOfRange = 'a header value is out of range'
    expect(() => parseKnowledgeMap(edited((f) => { f.grid = 0; f.levels = []; f.regionCells = []; f.gapCells = [] }))).toThrow(outOfRange)
    expect(() => parseKnowledgeMap(edited((f) => { f.runs = 0; f.gaps = [] }))).toThrow(outOfRange)
    expect(() => parseKnowledgeMap(edited((f) => { f.scale = Number.NaN }))).toThrow(outOfRange)
    expect(() => parseKnowledgeMap(edited((f) => { f.median = 0 }))).toThrow(outOfRange)
    const region = (fixture().regions[0] as Fixture['regions'][number])
    expect(() => parseKnowledgeMap(edited((f) => { f.regions = Array.from({ length: 255 }, () => region) }))).toThrow(outOfRange)
    const gap = (fixture().gaps[0] as Fixture['gaps'][number])
    expect(() => parseKnowledgeMap(edited((f) => { f.gaps = Array.from({ length: 255 }, () => gap) }))).toThrow(outOfRange)
  })

  it('refuses labels outside the string table or not in UTF-8', () => {
    const outside = encode(fixture())
    const view = new DataView(outside.buffer)
    const region = 40 + 4 * 6 + 8 * 3
    view.setUint32(region + 8, 1000, true)
    expect(() => parseKnowledgeMap(reseal(outside))).toThrow('a label points outside the string table')
    const invalid = encode(fixture())
    invalid[invalid.length - 1] = 0xff
    expect(() => parseKnowledgeMap(reseal(invalid))).toThrow('a label is not UTF-8')
  })

  it('refuses references to patterns, regions and gaps that do not exist', () => {
    const unknownPattern = edited((f) => { (f.regions[0] as Fixture['regions'][number]).patterns = [3, 0xffff, 0xffff] })
    expect(() => parseKnowledgeMap(unknownPattern)).toThrow('pattern 3 does not exist')
    const gap = (change: (g: Fixture['gaps'][number]) => void): Uint8Array =>
      edited((f) => { change(f.gaps[0] as Fixture['gaps'][number]) })
    expect(() => parseKnowledgeMap(gap((g) => { g.recurs = 5 }))).toThrow('gap 0 has an out-of-range count')
    expect(() => parseKnowledgeMap(gap((g) => { g.borders = [[0, 100]] }))).toThrow('gap 0 has an out-of-range count')
    const fourBorders = gap((g) => { g.borders = [[0, 25], [1, 25], [0, 25], [1, 25]] })
    expect(() => parseKnowledgeMap(fourBorders)).toThrow('gap 0 has an out-of-range count')
    expect(() => parseKnowledgeMap(gap((g) => { g.borders = [[0, 50], [2, 50]] }))).toThrow('gap 0 borders a region that does not exist')
    expect(() => parseKnowledgeMap(gap((g) => { g.borders = [[0, 101], [1, 50]] }))).toThrow('gap 0 borders a region that does not exist')
    expect(() => parseKnowledgeMap(edited((f) => { f.regionCells[0] = 2 }))).toThrow('a cell names region 2, which does not exist')
    expect(() => parseKnowledgeMap(edited((f) => { f.gapCells[0] = 1 }))).toThrow('a cell names gap 1, which does not exist')
  })

  it('loads the asset from a file', async () => {
    const path = join(await temp(), 'ai-map.bin')
    await writeFile(path, encode(fixture()))
    expect((await loadKnowledgeMap(path, 6)).regions.map(region => region.label)).toEqual(['graph / gnns', 'causal / treatment'])
  })

  it('accepts the shipped map, which belongs to the shipped graph', async () => {
    const kg = fileURLToPath(new URL('../runtime/kg/ai-kg.json.gz', import.meta.url))
    const graph = JSON.parse(gunzipSync(await readFile(kg)).toString('utf8')) as GraphFile
    const shipped = await loadKnowledgeMap(fileURLToPath(new URL('../runtime/kg/ai-map.bin', import.meta.url)), graph.papers.length)
    expect(shipped.patterns).toHaveLength(graph.patterns.length)
    expect(shipped.regions.length).toBeGreaterThanOrEqual(25)
    expect(new Set(shipped.regions.map(region => region.label)).size).toBe(shipped.regions.length)
    expect(shipped.gaps.length).toBeGreaterThan(0)
    expect(shipped.gaps.every(gap => gap.recurs >= 6 && gap.runs === 10)).toBe(true)
  })
})

describe('point lookups', () => {
  it('finds a paper, the region and the gap at a point, and nothing outside the map', () => {
    expect(paperPosition(map, 5)).toEqual({ x: map.x[5], y: map.y[5] })
    expect(paperPosition(map, 6)).toBeUndefined()
    expect(regionAt(map, { x: 0.1, y: 0.9 })?.label).toBe('graph / gnns')
    expect(regionAt(map, { x: 0.9, y: 0.1 })?.label).toBe('causal / treatment')
    expect(regionAt(map, { x: 1, y: 1 })?.label).toBe('causal / treatment')
    expect(regionAt(map, { x: 0.1, y: 0.6 })).toBeUndefined()
    expect(regionAt(map, { x: -0.01, y: 0.5 })).toBeUndefined()
    expect(regionAt(map, { x: Number.NaN, y: 0.5 })).toBeUndefined()
    expect(gapAt(map, { x: 0.4, y: 0.1 })?.index).toBe(0)
    expect(gapAt(map, { x: 0.4, y: 0.6 })).toBeUndefined()
    expect(gapAt(map, { x: 0.5, y: 2 })).toBeUndefined()
  })

  it('finds the nearest gap, if the map has any', () => {
    const two = parseKnowledgeMap(edited((f) => { f.gaps.push({ ...(f.gaps[0] as Fixture['gaps'][number]), x: 0.5, y: 0.9 }) }))
    const near = nearestGap(two, { x: 0.5, y: 0.8 })
    expect(near?.gap).toBe(two.gaps[1])
    expect(near?.distance).toBeCloseTo(0.1, 4)
    expect(nearestGap(two, { x: 0.5, y: 0.2 })?.gap.index).toBe(0)
    expect(nearestGap(parseKnowledgeMap(edited((f) => { f.gaps = []; f.gapCells.fill(255) })), { x: 0.5, y: 0.5 })).toBeUndefined()
  })

  it('interpolates the density between cell centres and gives its percentile among the papers', () => {
    const centre = densityAt(map, { x: 0.125, y: 0.125 })
    expect(centre).toEqual({ value: 4000, relative: 4, percentile: 1 })
    const between = densityAt(map, { x: 0.25, y: 0.125 })
    expect(between.value).toBeCloseTo((4000 + 4000 * 0.04) / 2, 6)
    expect(between.percentile).toBeCloseTo(Math.round(255 * Math.sqrt(between.value / 4000)) / 200, 4)
    expect(densityAt(map, { x: 0.375, y: 0.375 }).relative).toBeCloseTo(0.16, 6)
    expect(densityAt(map, { x: 0, y: 0 }).value).toBeCloseTo(1000, 6)
    expect(densityAt(map, { x: 2, y: 2 })).toEqual({ value: 0, relative: 0, percentile: 0 })
  })

  it('describes a gap by its neighbours, as a fact about the map', () => {
    const gap = map.gaps[0] as NonNullable<(typeof map.gaps)[number]>
    expect(describeGap(map, gap)).toBe('Sparse in this map, between "graph / gnns" and "causal / treatment".')
    expect(describeGap(map, gap, index => index === 0 ? 'Message passing reframed' : undefined))
      .toBe('Sparse in this map, between "graph / gnns" and "causal / treatment"; rim patterns: Message passing reframed.')
    expect(describeGap(map, gap, () => undefined)).toBe('Sparse in this map, between "graph / gnns" and "causal / treatment".')
    const three = parseKnowledgeMap(edited((f) => {
      f.regions.push({ ...(f.regions[0] as Fixture['regions'][number]), label: 'optimal transport' })
      ;(f.gaps[0] as Fixture['gaps'][number]).borders = [[0, 40], [1, 30], [2, 30]]
    }))
    expect(describeGap(three, three.gaps[0] as NonNullable<(typeof three.gaps)[number]>))
      .toBe('Sparse in this map, between "graph / gnns", "causal / treatment" and "optimal transport".')
  })
})

describe('placeFromHits', () => {
  const paper = (index: number, weight: number): MapHit => ({ kind: 'paper', index, weight })
  const pattern = (index: number, weight: number): MapHit => ({ kind: 'pattern', index, weight })

  it('places agreeing hits at their concentration with full confidence', () => {
    const placed = placeFromHits(map, [paper(0, 1), paper(1, 1), paper(2, 0.5), pattern(0, 0.5)])
    expect(placed?.x).toBeCloseTo(0.11, 2)
    expect(placed?.y).toBeCloseTo(0.11, 2)
    expect(placed?.confidence).toBe(1)
    expect(placed?.region?.label).toBe('graph / gnns')
    expect(placed?.alternatives).toEqual([])
    expect(placed?.support.map(item => [item.kind, item.index])).toEqual([['paper', 0], ['paper', 1], ['paper', 2], ['pattern', 0]])
    expect(placed?.support.every(item => item.distance <= SUPPORT_RADIUS)).toBe(true)
  })

  it('does not average hits split between distant regions: the heavier side wins and the other is an alternative', () => {
    const placed = placeFromHits(map, [paper(3, 1), paper(4, 1), paper(0, 0.7), paper(1, 0.7), paper(5, 0.1)])
    expect(placed?.x).toBeCloseTo(0.89, 2)
    expect(placed?.confidence).toBeCloseTo(2 / 3.5, 6)
    expect(placed?.region?.label).toBe('causal / treatment')
    expect(placed?.alternatives).toHaveLength(1)
    expect(placed?.alternatives[0]?.x).toBeCloseTo(0.11, 2)
    expect(placed?.alternatives[0]?.share).toBeCloseTo(1.4 / 3.5, 6)
  })

  it('lists every concentration of at least 15% of the weight as an alternative, largest first', () => {
    const placed = placeFromHits(map, [paper(5, 1), paper(3, 1), paper(4, 1), paper(0, 0.6), paper(1, 0.6)])
    expect(placed?.x).toBeCloseTo(0.89, 2)
    const rounded = placed?.alternatives.map(item => [Math.round(item.x * 10) / 10, Math.round(item.share * 1000) / 1000])
    expect(rounded).toEqual([[0.1, 0.286], [0.5, 0.238]])
  })

  it('widens a pattern by its spread and ignores a pattern without papers', () => {
    const wide = placeFromHits(map, [pattern(1, 1), pattern(2, 5)])
    expect(wide).toMatchObject({ confidence: 1, alternatives: [] })
    expect(wide?.x).toBeCloseTo(0.89, 3)
    expect(placeFromHits(map, [pattern(2, 1)])).toBeUndefined()
  })

  it('starts from at most a dozen hits, breaking weight ties by order', () => {
    const many = Array.from({ length: 20 }, (_, at) => paper(at % 3, 1))
    expect(placeFromHits(map, many)?.confidence).toBe(1)
  })

  it('returns nothing without weighted hits and refuses hits that are not on the map', () => {
    expect(placeFromHits(map, [])).toBeUndefined()
    expect(placeFromHits(map, [paper(0, 0)])).toBeUndefined()
    expect(() => placeFromHits(map, [paper(0, -1)])).toThrow('must be finite and non-negative, not -1')
    expect(() => placeFromHits(map, [paper(0, Number.POSITIVE_INFINITY)])).toThrow(RangeError)
    expect(() => placeFromHits(map, [paper(6, 1)])).toThrow('Paper 6 is not on the map')
    expect(() => placeFromHits(map, [pattern(3, 1)])).toThrow('Pattern 3 is not on the map')
  })

  it('uses the documented kernel and support radius', () => {
    expect(PLACEMENT_BANDWIDTH).toBe(0.02)
    expect(SUPPORT_RADIUS).toBe(0.05)
  })
})

describe('hitsFromRecall', () => {
  it('weighs papers by relative BM25 score and gives the leading patterns a share of their weight', () => {
    const hits = hitsFromRecall({
      papers: [{ index: 4, score: 8 }, { index: 2, score: 4 }],
      patterns: Array.from({ length: PATTERN_HITS + 2 }, (_, at) => ({ index: at, score: at === 0 ? 3 : 1 })),
    })
    expect(hits.slice(0, 2)).toEqual([{ kind: 'paper', index: 4, weight: 1 }, { kind: 'paper', index: 2, weight: 0.5 }])
    const patterns = hits.slice(2)
    expect(patterns.map(hit => hit.index)).toEqual([0, 1, 2, 3, 4])
    expect(patterns.reduce((sum, hit) => sum + hit.weight, 0)).toBeCloseTo(PATTERN_WEIGHT * 1.5, 10)
    expect(patterns[0]?.weight).toBeCloseTo(PATTERN_WEIGHT * 1.5 * 3 / 7, 10)
  })

  it('gives the patterns all the weight when no paper matched, and nothing when nothing did', () => {
    const hits = hitsFromRecall({ papers: [], patterns: [{ index: 1, score: 2 }, { index: 0, score: 2 }] })
    expect(hits).toEqual([{ kind: 'pattern', index: 1, weight: 0.5 }, { kind: 'pattern', index: 0, weight: 0.5 }])
    expect(hitsFromRecall({ papers: [], patterns: [] })).toEqual([])
    expect(hitsFromRecall({ papers: [{ index: 0, score: 2 }], patterns: [] })).toEqual([{ kind: 'paper', index: 0, weight: 1 }])
  })
})

describe('recallHits', () => {
  const graphPaper = (id: string, title: string, pattern: number, similar: number[] = []): GraphFile['papers'][number] => ({
    id, title, pattern, domain: 0, idea: `${title} idea`, problem: 'problem', solution: 'solution', story: `${title} story`,
    score: 0.6, similar,
  })
  const graphPattern = (id: string, name: string, exemplars: number[]): GraphFile['patterns'][number] => ({
    id, name, domain: 0, subDomains: [], size: 2, coherence: 0.7, tier: 'A', summary: `${name} summary`, details: '', ideas: [],
    exemplars, works: [],
  })
  const builtin: GraphFile = {
    version: 1, name: 'ai', description: 'Test graph', domains: ['Machine Learning'],
    patterns: [graphPattern('pattern_0', 'Sparse attention at scale', [0]), graphPattern('pattern_1', 'Message passing reframed', [2])],
    papers: [
      graphPaper('p0', 'Block sparse attention kernels', 0, [1]), graphPaper('p1', 'Linear attention approximations', 0, [0]),
      graphPaper('p2', 'Graph message passing networks', 1, [3]), graphPaper('p3', 'Unclustered sparse attention note', -1, [2]),
    ],
  }

  async function base(file: GraphFile | undefined): Promise<{ base: KnowledgeBase; root: string }> {
    const root = await temp()
    const path = join(root, 'kg.json.gz')
    if (file) await writeFile(path, gzipSync(JSON.stringify(file)))
    const created = new KnowledgeBase(path)
    bases.push(created)
    return { base: created, root }
  }

  it('turns the built-in graph rankings behind a recall into paper and pattern hits', async () => {
    const { base: knowledge, root } = await base(builtin)
    const project: GraphFile = {
      ...builtin, name: 'project', papers: [graphPaper('q0', 'Sparse attention for proteins', 0)],
      patterns: [graphPattern('pattern_0', 'Protein attention', [0])],
    }
    await mkdir(dirname(join(root, PROJECT_GRAPH)), { recursive: true })
    await writeFile(join(root, PROJECT_GRAPH), JSON.stringify(project))
    const { recall, hits } = await recallHits(knowledge, root, 'sparse attention kernels', 2, undefined, signal)
    expect(recall.patterns).toHaveLength(2)
    const indices = builtinIndices(recall)
    expect(indices?.papers.map(item => item.index)).toEqual([0, 3, 1])
    expect(indices?.patterns.map(item => item.index)).toEqual([0, 1])
    expect(hits.filter(hit => hit.kind === 'paper').map(hit => hit.index)).toEqual([0, 3, 1])
    expect(hits.filter(hit => hit.kind === 'pattern').map(hit => hit.index)).toEqual([0, 1])
    expect(builtinIndices({ ...recall })).toBeUndefined()
  })

  it('has no hits when the built-in graph is unavailable', async () => {
    const { base: knowledge, root } = await base(undefined)
    const { recall, hits } = await recallHits(knowledge, root, 'sparse attention', 3, undefined, signal)
    expect(recall.note).toContain('Unavailable graphs')
    expect(hits).toEqual([])
  })
})
