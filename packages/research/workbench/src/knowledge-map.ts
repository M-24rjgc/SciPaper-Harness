/**
 * The domain map of the built-in knowledge graph: one point per paper (nearby points are similar papers),
 * the centre of every pattern, labelled regions, a paper-density grid, and the sparse areas that recur across
 * layout runs. scripts/build_kg_map.py writes runtime/kg/ai-map.bin offline; runtime/kg/MAP-FORMAT.md
 * documents its bytes and runtime/kg/MAP-QUALITY.md how the layout and the placement were chosen and how
 * accurate they are. This module parses the asset, places a text on the map from its recall hits, and
 * answers lookups for a point. It makes no network request and needs no embedding model of its own.
 *
 * Coordinates: x grows rightward and y downward, both in [0, 1]. Distance is meaningful within a
 * neighbourhood (a few hundredths); the arrangement of far-apart regions carries little meaning.
 */
import { readFile } from 'node:fs/promises'
import { builtinIndices, type Embedder, type KnowledgeBase, type RecallIndices, type RecallResult } from './knowledge.ts'

/** The asset format version this module reads. */
export const KNOWLEDGE_MAP_VERSION = 1
/** Gaussian kernel width, in map units, of one paper hit during placement (MAP-QUALITY.md, "Placement accuracy"). */
export const PLACEMENT_BANDWIDTH = 0.02
/** Hits within this distance of a placed point support it; their share of the hit weight is its confidence. */
export const SUPPORT_RADIUS = 0.05
/** How many of a recall's fused patterns join its paper hits. */
export const PATTERN_HITS = 5
/**
 * The patterns' combined weight relative to the papers' combined weight when both are present: a weak prior.
 * Pattern centres are coarse, and at 0.5 or more they move held-out papers away from their true positions.
 */
export const PATTERN_WEIGHT = 0.1

const MAGIC = [0x89, 0x4b, 0x47, 0x4d, 0x41, 0x50, 0x0d, 0x0a]
const HEADER_BYTES = 40
const PATTERN_BYTES = 8
const REGION_BYTES = 28
const GAP_BYTES = 24
const LEVELS = 256
const NONE16 = 0xffff
const NONE8 = 0xff
/** Mean-shift searches start from this many of the heaviest hits. */
const MODE_STARTS = 12
/** A distinct mode holding at least this share of the hit weight is reported as an alternative position. */
const ALTERNATIVE_SHARE = 0.15

/** A point on the map. */
export interface MapPoint {
  x: number
  y: number
}

/** A pattern's position: the geometric median of its papers, and their median distance from it. */
export interface MapPattern extends MapPoint {
  index: number
  spread: number
  /** Papers assigned to the pattern; a pattern without papers has no position and takes no part in placement. */
  members: number
}

/** A labelled region: the papers of one density basin or of several merged along shallow valleys. */
export interface MapRegion extends MapPoint {
  index: number
  /** One to three keywords, joined by " / ", that the map shows at (x, y); unique within the map. */
  label: string
  /** Up to five title keywords, most distinctive first. */
  keywords: string[]
  papers: number
  /** Index into the graph's domains: the most common domain of the region's papers. */
  domain: number
  /** Indices of the region's most common patterns, most common first (at most three). */
  patterns: number[]
}

/**
 * An area that holds few papers in this map but is enclosed by regions that hold many. It is a fact about
 * the map, not evidence that the topic between its neighbours is unexplored.
 */
export interface MapGap extends MapPoint {
  index: number
  /** Share of the map's area. */
  area: number
  /** Mean density inside, relative to the median paper's local density. */
  depth: number
  /** Papers on its rim. */
  rimPapers: number
  /** Other layout runs, out of `runs - 1`, in which a gap with an overlapping rim appears. */
  recurs: number
  /** Layout runs the gap was tested on, the shipped one included. */
  runs: number
  /** The regions around it with their share of its rim, largest first (two or three). */
  borders: { region: number; share: number }[]
  /** The most common patterns of its rim papers, most common first. */
  patterns: number[]
}

/** A parsed domain map. */
export interface KnowledgeMap {
  /**
   * Cells per side of the density, region and gap grids; cell (row, column) spans [column, column + 1) / grid
   * in x and [row, row + 1) / grid in y, and grids are stored row by row from the top.
   */
  grid: number
  /** Paper x positions, index-aligned with the built-in graph's papers. */
  x: Float32Array
  /** Paper y positions, index-aligned with the built-in graph's papers. */
  y: Float32Array
  patterns: MapPattern[]
  regions: MapRegion[]
  gaps: MapGap[]
  /** Density level per cell, row-major from the top-left; level q stands for (q / 255)^2 * densityScale papers per unit area. */
  levels: Uint8Array
  densityScale: number
  /** The median paper's local density, in papers per unit area. */
  medianDensity: number
  /** `cdf[q]`: the share of papers whose own cell has density level q or lower. */
  cdf: Float64Array
  /** Region index per cell; -1 where no region reaches. */
  regionCells: Int16Array
  /** Gap index per cell; -1 outside every gap. */
  gapCells: Int16Array
}

/** Local paper density at a point. */
export interface MapDensity {
  /** Papers per unit area. */
  value: number
  /** `value` relative to the median paper's local density: 1 is typical, 0.1 sparse. */
  relative: number
  /** The share of papers whose own surroundings are at most this dense. */
  percentile: number
}

/** One ranked item to place: a paper or a pattern of the built-in graph, with a non-negative weight. */
export interface MapHit {
  kind: 'paper' | 'pattern'
  index: number
  weight: number
}

/** A hit near a placed point. */
export interface MapSupport extends MapHit {
  distance: number
}

/** Where a set of hits places a text, and how much the hits agree. */
export interface MapPlacement extends MapPoint {
  /**
   * The share of the hit weight within SUPPORT_RADIUS of the point: near 1 when the hits agree, low when they
   * spread over distant parts of the map, in which case `alternatives` lists the other concentrations.
   */
  confidence: number
  /** The region at the point, if any. */
  region: MapRegion | undefined
  /** The hits within SUPPORT_RADIUS, heaviest first. */
  support: MapSupport[]
  /** Other concentrations of the hits, farther than SUPPORT_RADIUS away, with their weight share; largest first. */
  alternatives: (MapPoint & { share: number })[]
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

/** CRC-32 (IEEE 802.3, as zlib.crc32 computes it). */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Parse and validate a domain-map asset.
 * @param bytes - the asset's bytes.
 * @param papers - the paper count of the graph the map must belong to, when known.
 * @returns the map.
 * @throws Error when the bytes are not a complete, undamaged version-1 map, or place a different number of papers.
 */
export function parseKnowledgeMap(bytes: Uint8Array, papers?: number): KnowledgeMap {
  const fail = (why: string): never => { throw new Error(`Not a valid knowledge map: ${why}`) }
  if (bytes.length < HEADER_BYTES) fail(`${bytes.length} bytes is shorter than the ${HEADER_BYTES}-byte header`)
  if (MAGIC.some((value, at) => bytes[at] !== value)) fail('the signature is missing')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (at: number): number => view.getUint16(at, true)
  const u32 = (at: number): number => view.getUint32(at, true)
  const version = u16(8)
  if (version !== KNOWLEDGE_MAP_VERSION) fail(`format version ${version} is not ${KNOWLEDGE_MAP_VERSION}`)
  const grid = u16(10), count = u32(12), patternCount = u16(16), regionCount = u16(18), gapCount = u16(20), runs = u16(22)
  const densityScale = view.getFloat32(24, true), medianDensity = view.getFloat32(28, true), stringBytes = u32(32)
  const cells = grid * grid
  const expected = HEADER_BYTES + 4 * count + PATTERN_BYTES * patternCount + REGION_BYTES * regionCount + GAP_BYTES * gapCount
    + 2 * LEVELS + 3 * cells + stringBytes
  if (bytes.length !== expected) fail(`it holds ${bytes.length} bytes where its header implies ${expected}`)
  if (crc32(bytes.subarray(HEADER_BYTES)) !== u32(36)) fail('the checksum does not match, so the file is damaged')
  if (papers !== undefined && count !== papers) fail(`it places ${count} papers but the graph has ${papers}`)
  if (grid === 0 || regionCount >= NONE8 || gapCount >= NONE8 || runs === 0 || !(densityScale > 0) || !(medianDensity > 0)) {
    fail('a header value is out of range')
  }
  const strings = bytes.subarray(bytes.length - stringBytes)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const text = (offset: number, length: number): string => {
    if (offset + length > stringBytes) fail('a label points outside the string table')
    try {
      return decoder.decode(strings.subarray(offset, offset + length))
    } catch {
      return fail('a label is not UTF-8')
    }
  }
  const unit = (at: number): number => u16(at) / 0xffff
  const patternList = (at: number, slots: number): number[] => {
    const out: number[] = []
    for (let slot = 0; slot < slots; slot++) {
      const value = u16(at + 2 * slot)
      if (value === NONE16) continue
      if (value >= patternCount) fail(`pattern ${value} does not exist`)
      out.push(value)
    }
    return out
  }

  let at = HEADER_BYTES
  const x = new Float32Array(count), y = new Float32Array(count)
  for (let index = 0; index < count; index++, at += 4) {
    x[index] = unit(at)
    y[index] = unit(at + 2)
  }
  const patterns: MapPattern[] = []
  for (let index = 0; index < patternCount; index++, at += PATTERN_BYTES) {
    patterns.push({ index, x: unit(at), y: unit(at + 2), spread: unit(at + 4), members: u16(at + 6) })
  }
  const regions: MapRegion[] = []
  for (let index = 0; index < regionCount; index++, at += REGION_BYTES) {
    const keywords = text(u32(at + 14), u16(at + 18))
    regions.push({
      index, x: unit(at), y: unit(at + 2), papers: u32(at + 4), label: text(u32(at + 8), u16(at + 12)),
      keywords: keywords === '' ? [] : keywords.split(', '), domain: u16(at + 20), patterns: patternList(at + 22, 3),
    })
  }
  const gaps: MapGap[] = []
  for (let index = 0; index < gapCount; index++, at += GAP_BYTES) {
    const recurs = bytes[at + 10] as number, borderCount = bytes[at + 11] as number
    if (recurs >= runs || borderCount < 2 || borderCount > 3) fail(`gap ${index} has an out-of-range count`)
    const borders = Array.from({ length: borderCount }, (_, slot) => {
      const region = bytes[at + 12 + slot] as number, share = bytes[at + 15 + slot] as number
      if (region >= regionCount || share > 100) fail(`gap ${index} borders a region that does not exist`)
      return { region, share: share / 100 }
    })
    gaps.push({
      index, x: unit(at), y: unit(at + 2), area: u16(at + 4) / cells, depth: u16(at + 6) / 10000, rimPapers: u16(at + 8),
      recurs, runs, borders, patterns: patternList(at + 18, 3),
    })
  }
  const cdf = Float64Array.from({ length: LEVELS }, (_, level) => u16(at + 2 * level) / 0xffff)
  at += 2 * LEVELS
  const levels = bytes.slice(at, at + cells)
  const indexCells = (offset: number, limit: number, what: string): Int16Array =>
    Int16Array.from(bytes.subarray(offset, offset + cells), (value) => {
      if (value === NONE8) return -1
      if (value >= limit) fail(`a cell names ${what} ${value}, which does not exist`)
      return value
    })
  const regionCells = indexCells(at + cells, regionCount, 'region')
  const gapCells = indexCells(at + 2 * cells, gapCount, 'gap')
  return { grid, x, y, patterns, regions, gaps, levels, densityScale, medianDensity, cdf, regionCells, gapCells }
}

/**
 * Read and parse a domain-map asset.
 * @param path - the asset, normally runtime/kg/ai-map.bin.
 * @param papers - the paper count of the graph the map must belong to, when known.
 * @returns the map.
 */
export async function loadKnowledgeMap(path: string, papers?: number): Promise<KnowledgeMap> {
  return parseKnowledgeMap(await readFile(path), papers)
}

/**
 * A paper's position.
 * @param map - the map.
 * @param index - the paper's index in the built-in graph.
 * @returns the position, or undefined for an index the map does not hold.
 */
export function paperPosition(map: KnowledgeMap, index: number): MapPoint | undefined {
  const x = map.x[index], y = map.y[index]
  return x === undefined || y === undefined ? undefined : { x, y }
}

/** The cell index of a point, or undefined outside [0, 1]^2. */
function cellAt(map: KnowledgeMap, point: MapPoint): number | undefined {
  if (!(point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)) return undefined
  const column = Math.min(Math.floor(point.x * map.grid), map.grid - 1)
  const row = Math.min(Math.floor(point.y * map.grid), map.grid - 1)
  return row * map.grid + column
}

/**
 * The region at a point.
 * @param map - the map.
 * @param point - a point in [0, 1]^2.
 * @returns the region whose cells hold the point, or undefined where no region reaches or outside the map.
 */
export function regionAt(map: KnowledgeMap, point: MapPoint): MapRegion | undefined {
  const cell = cellAt(map, point)
  return cell === undefined ? undefined : map.regions[map.regionCells[cell] as number]
}

/**
 * The gap at a point.
 * @param map - the map.
 * @param point - a point in [0, 1]^2.
 * @returns the gap whose cells hold the point, or undefined.
 */
export function gapAt(map: KnowledgeMap, point: MapPoint): MapGap | undefined {
  const cell = cellAt(map, point)
  return cell === undefined ? undefined : map.gaps[map.gapCells[cell] as number]
}

/**
 * The gap whose centre is closest to a point.
 * @param map - the map.
 * @param point - any point.
 * @returns the gap and the distance to its centre, or undefined when the map has no gaps.
 */
export function nearestGap(map: KnowledgeMap, point: MapPoint): { gap: MapGap; distance: number } | undefined {
  let best: { gap: MapGap; distance: number } | undefined
  for (const gap of map.gaps) {
    const distance = Math.hypot(gap.x - point.x, gap.y - point.y)
    if (best === undefined || distance < best.distance) best = { gap, distance }
  }
  return best
}

/**
 * Local paper density, interpolated between cell centres.
 * @param map - the map.
 * @param point - any point; the density outside the map is zero.
 * @returns the density, relative to the median paper's, and its percentile among the papers.
 */
export function densityAt(map: KnowledgeMap, point: MapPoint): MapDensity {
  const { grid } = map
  const value = (row: number, column: number): number => {
    if (row < 0 || column < 0 || row >= grid || column >= grid) return 0
    return ((map.levels[row * grid + column] as number) / 255) ** 2 * map.densityScale
  }
  const u = point.x * grid - 0.5, v = point.y * grid - 0.5
  const column = Math.floor(u), row = Math.floor(v)
  const fu = u - column, fv = v - row
  const density = (1 - fv) * ((1 - fu) * value(row, column) + fu * value(row, column + 1))
    + fv * ((1 - fu) * value(row + 1, column) + fu * value(row + 1, column + 1))
  const level = Math.min(LEVELS - 1, Math.round(255 * Math.sqrt(density / map.densityScale)))
  return { value: density, relative: density / map.medianDensity, percentile: map.cdf[level] as number }
}

/**
 * One sentence that describes a gap by its neighbours, worded as a fact about the map.
 * @param map - the map the gap belongs to.
 * @param gap - the gap.
 * @param patternName - names a pattern index, when the caller has the graph at hand.
 * @returns e.g. "Sparse in this map, between "graph / gnns" and "optimal transport"; rim patterns: …".
 */
export function describeGap(map: KnowledgeMap, gap: MapGap, patternName?: (index: number) => string | undefined): string {
  const names = gap.borders.map(border => `"${(map.regions[border.region] as MapRegion).label}"`)
  const between = names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}` : names.join(' and ')
  const patterns = patternName ? gap.patterns.flatMap(index => patternName(index) ?? []) : []
  return `Sparse in this map, between ${between}${patterns.length ? `; rim patterns: ${patterns.join('; ')}` : ''}.`
}

/** A hit as a Gaussian kernel on the map. */
interface Kernel extends MapPoint {
  hit: MapHit
  weight: number
  width: number
}

function kernelsOf(map: KnowledgeMap, hits: readonly MapHit[]): Kernel[] {
  return hits.flatMap((hit): Kernel[] => {
    if (!Number.isFinite(hit.weight) || hit.weight < 0) throw new RangeError(`A map hit's weight must be finite and non-negative, not ${hit.weight}`)
    if (hit.weight === 0) return []
    if (hit.kind === 'paper') {
      const point = paperPosition(map, hit.index)
      if (point === undefined) throw new RangeError(`Paper ${hit.index} is not on the map`)
      return [{ ...point, hit, weight: hit.weight, width: PLACEMENT_BANDWIDTH }]
    }
    const pattern = map.patterns[hit.index]
    if (pattern === undefined) throw new RangeError(`Pattern ${hit.index} is not on the map`)
    const width = Math.hypot(PLACEMENT_BANDWIDTH, pattern.spread)
    return pattern.members === 0 ? [] : [{ x: pattern.x, y: pattern.y, hit, weight: hit.weight, width }]
  })
}

/** The kernel density of the hits at a point (up to a constant factor). */
function densityOf(kernels: readonly Kernel[], point: MapPoint): number {
  let sum = 0
  for (const k of kernels) sum += k.weight / k.width ** 2 * Math.exp(-((point.x - k.x) ** 2 + (point.y - k.y) ** 2) / (2 * k.width ** 2))
  return sum
}

/** Mean shift from a kernel's centre to the density mode above it. */
function climb(kernels: readonly Kernel[], start: MapPoint): MapPoint {
  let { x, y } = start
  for (let step = 0; step < 200; step++) {
    let sx = 0, sy = 0, sw = 0
    for (const k of kernels) {
      const g = k.weight / k.width ** 4 * Math.exp(-((x - k.x) ** 2 + (y - k.y) ** 2) / (2 * k.width ** 2))
      sx += g * k.x
      sy += g * k.y
      sw += g
    }
    const moved = Math.hypot(sx / sw - x, sy / sw - y)
    x = sx / sw
    y = sy / sw
    if (moved < 1e-7) break
  }
  return { x, y }
}

/** The share of the kernels' weight within SUPPORT_RADIUS of a point. */
function shareNear(kernels: readonly Kernel[], point: MapPoint, total: number): number {
  let near = 0
  for (const k of kernels) if (Math.hypot(k.x - point.x, k.y - point.y) <= SUPPORT_RADIUS) near += k.weight
  return near / total
}

/**
 * Place a text on the map from the papers and patterns its retrieval ranked. Each hit is a Gaussian kernel
 * (a paper's of width PLACEMENT_BANDWIDTH; a pattern's widened by its spread); mean shift from the heaviest
 * hits finds the density modes, and the densest one is the placement. Hits split between distant regions do
 * not average into the empty space between them: the densest concentration wins, `confidence` reports its
 * share of the weight, and `alternatives` names the others.
 * @param map - the map.
 * @param hits - paper and pattern hits with non-negative weights, such as `hitsFromRecall` gives.
 * @returns the placement, or undefined when no hit has positive weight.
 * @throws RangeError for a hit whose index is not on the map or whose weight is negative or not finite.
 */
export function placeFromHits(map: KnowledgeMap, hits: readonly MapHit[]): MapPlacement | undefined {
  const kernels = kernelsOf(map, hits)
  if (kernels.length === 0) return undefined
  const total = kernels.reduce((sum, k) => sum + k.weight, 0)
  const starts = kernels.map((k, at) => ({ k, at })).sort((a, b) => b.k.weight - a.k.weight || a.at - b.at).slice(0, MODE_STARTS)
  const modes = starts.map(({ k }) => climb(kernels, k)).map(point => ({ ...point, density: densityOf(kernels, point) }))
    .sort((a, b) => b.density - a.density)
  const distinct: MapPoint[] = []
  for (const mode of modes) {
    if (distinct.every(kept => Math.hypot(kept.x - mode.x, kept.y - mode.y) > SUPPORT_RADIUS)) distinct.push({ x: mode.x, y: mode.y })
  }
  const [best, ...others] = distinct as [MapPoint, ...MapPoint[]]
  const support = kernels.map(k => ({ ...k.hit, distance: Math.hypot(k.x - best.x, k.y - best.y) }))
    .filter(item => item.distance <= SUPPORT_RADIUS).sort((a, b) => b.weight - a.weight)
  const alternatives = others.map(point => ({ ...point, share: shareNear(kernels, point, total) }))
    .filter(item => item.share >= ALTERNATIVE_SHARE).sort((a, b) => b.share - a.share)
  return { ...best, confidence: shareNear(kernels, best, total), region: regionAt(map, best), support, alternatives }
}

/**
 * Weighted map hits from the built-in graph's rankings behind one recall. A paper weighs its BM25 score
 * relative to the best paper's; the first PATTERN_HITS fused patterns share PATTERN_WEIGHT times the papers'
 * combined weight in proportion to their fused scores, or all the weight when no paper matched.
 * @param indices - what `builtinIndices` returned for the recall.
 * @returns the hits, papers first.
 */
export function hitsFromRecall(indices: RecallIndices): MapHit[] {
  const best = indices.papers[0]?.score ?? 0
  const papers = indices.papers.map(({ index, score }): MapHit => ({ kind: 'paper', index, weight: score / best }))
  const ranked = indices.patterns.slice(0, PATTERN_HITS)
  const scoreSum = ranked.reduce((sum, { score }) => sum + score, 0)
  const budget = papers.length > 0 ? PATTERN_WEIGHT * papers.reduce((sum, hit) => sum + hit.weight, 0) : 1
  const patterns = ranked.map(({ index, score }): MapHit => ({ kind: 'pattern', index, weight: budget * score / scoreSum }))
  return [...papers, ...patterns]
}

/**
 * Recall a text against the knowledge graphs and turn the built-in graph's rankings into map hits.
 * @param base - the knowledge base.
 * @param root - the project root, as for `KnowledgeBase.recall`.
 * @param query - the text to place: an idea, or an imported paper's title and abstract.
 * @param topK - how many patterns the recall result lists; the hits do not depend on it.
 * @param embedder - semantic pattern ranking, when configured.
 * @param signal - cancellation.
 * @returns the recall result and its map hits; no hits when the built-in graph was unavailable.
 */
export async function recallHits(
  base: KnowledgeBase, root: string, query: string, topK: number, embedder: Embedder | undefined, signal: AbortSignal,
): Promise<{ recall: RecallResult; hits: MapHit[] }> {
  const recall = await base.recall(root, query, topK, embedder, signal)
  const indices = builtinIndices(recall)
  return { recall, hits: indices ? hitsFromRecall(indices) : [] }
}
