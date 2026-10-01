/**
 * The domain map as a client draws it: the map compressed into base64 typed arrays, placements and marks
 * described by name, paper details for a hover card. Pure functions over a parsed map and the built-in graph.
 */
import { paperUrl, type GraphFile, type GraphPaper } from './knowledge.ts'
import { locateTarget, type Annotation } from './knowledge-annotations.ts'
import { densityAt, describeGap, paperPosition, regionAt, type KnowledgeMap, type MapPlacement, type MapRegion } from './knowledge-map.ts'
import type { KnowledgeMarkView, MapPaperView, MapPlacementView, MapViewPage } from './types.ts'

/** A paper's region value where no region reaches it. */
export const NO_REGION = 255
/** Papers named per placement. */
const NEAREST = 5
const QUANTA = 65535

/**
 * Encode the map for a client: paper positions as uint16 pairs and each paper's region as one byte, both base64.
 * @param map - the parsed map.
 * @param graph - the built-in graph it belongs to.
 * @returns the page a client draws.
 */
export function encodeMapView(map: KnowledgeMap, graph: GraphFile): Extract<MapViewPage, { built: true }> {
  const count = map.x.length
  const points = new DataView(new ArrayBuffer(count * 4))
  const regionOf = new Uint8Array(count)
  for (let at = 0; at < count; at++) {
    const x = map.x[at] as number, y = map.y[at] as number
    points.setUint16(at * 4, Math.round(Math.min(1, Math.max(0, x)) * QUANTA), true)
    points.setUint16(at * 4 + 2, Math.round(Math.min(1, Math.max(0, y)) * QUANTA), true)
    const region = regionAt(map, { x, y })
    regionOf[at] = region === undefined || region.index >= NO_REGION ? NO_REGION : region.index
  }
  const domain = (index: number): string => graph.domains[index] ?? ''
  const label = (index: number): string => (map.regions[index] as MapRegion).label
  return {
    built: true,
    graph: { name: graph.name, papers: graph.papers.length, patterns: graph.patterns.length },
    points: Buffer.from(points.buffer).toString('base64'),
    regionOf: Buffer.from(regionOf).toString('base64'),
    regions: map.regions.map(region => ({
      index: region.index, label: region.label, keywords: region.keywords, papers: region.papers, domain: domain(region.domain),
      x: region.x, y: region.y,
    })),
    gaps: map.gaps.map(gap => ({
      index: gap.index, x: gap.x, y: gap.y, area: gap.area, borders: gap.borders.map(border => label(border.region)),
      recurs: gap.recurs, runs: gap.runs, description: describeGap(map, gap, index => graph.patterns[index]?.name),
    })),
  }
}

/**
 * Describe a placement by name.
 * @param map - the map.
 * @param graph - the built-in graph.
 * @param placement - where `placeFromHits` put a text.
 * @returns the placement as a client shows it.
 */
export function placementView(map: KnowledgeMap, graph: GraphFile, placement: MapPlacement): MapPlacementView {
  return {
    x: placement.x, y: placement.y, confidence: placement.confidence,
    ...placement.region === undefined ? {} : { region: placement.region.label },
    alternatives: placement.alternatives.map(({ x, y, share }) => ({ x, y, share })),
    nearest: placement.support.filter(hit => hit.kind === 'paper').slice(0, NEAREST)
      .map(hit => ({ index: hit.index, title: (graph.papers[hit.index] as GraphPaper).title })),
    crowding: densityAt(map, placement).percentile,
  }
}

/**
 * A placement exactly on one paper of the map: an imported reference the built-in graph also holds.
 * @param map - the map.
 * @param graph - the built-in graph.
 * @param index - the paper's index.
 * @returns the placement, or undefined for an index the map does not hold.
 */
export function exactPlacement(map: KnowledgeMap, graph: GraphFile, index: number): MapPlacementView | undefined {
  const point = paperPosition(map, index)
  if (point === undefined) return undefined
  const region = regionAt(map, point)
  return {
    ...point, confidence: 1, ...region === undefined ? {} : { region: region.label }, alternatives: [],
    nearest: [{ index, title: (graph.papers[index] as GraphPaper).title }], crowding: densityAt(map, point).percentile, exact: true,
  }
}

/** A title reduced to lowercase letters and digits, for matching a reference to a paper of the graph. */
export function titleKey(title: string): string {
  return title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

const titleIndexes = new WeakMap<GraphFile, Map<string, number>>()

/**
 * The paper of the graph with exactly this title, ignoring case, accents, spacing and punctuation.
 * @param graph - the graph.
 * @param title - a reference's title.
 * @returns the paper's index, or undefined; titles shorter than 12 characters never match.
 */
export function paperByTitle(graph: GraphFile, title: string): number | undefined {
  let byTitle = titleIndexes.get(graph)
  if (byTitle === undefined) {
    byTitle = new Map()
    for (const [at, paper] of graph.papers.entries()) {
      const key = titleKey(paper.title)
      if (!byTitle.has(key)) byTitle.set(key, at)
    }
    titleIndexes.set(graph, byTitle)
  }
  const key = titleKey(title)
  return key.length < 12 ? undefined : byTitle.get(key)
}

/**
 * Details of papers of the map.
 * @param map - the map.
 * @param graph - the built-in graph.
 * @param indices - paper indices; those outside the graph are left out.
 * @returns one view per known index, in the order asked.
 */
export function mapPaperViews(map: KnowledgeMap, graph: GraphFile, indices: readonly number[]): MapPaperView[] {
  return indices.flatMap((index) => {
    const paper = graph.papers[index]
    const point = paperPosition(map, index)
    if (paper === undefined || point === undefined) return []
    const pattern = paper.pattern >= 0 ? graph.patterns[paper.pattern]?.name : undefined
    const region = regionAt(map, point)?.label
    const url = paperUrl(graph, paper)
    return [{
      index, id: paper.id, title: paper.title, idea: paper.idea, story: paper.story, score: paper.score,
      ...url === undefined ? {} : { url }, ...pattern === undefined ? {} : { pattern }, ...region === undefined ? {} : { region },
    }]
  })
}

/**
 * The marks as the panels show them, named from the graphs that still hold their targets.
 * @param annotations - the project's marks.
 * @param graphs - the graphs at hand by source.
 * @returns one view per mark; `index` is set for a built-in paper.
 */
export function markViews(annotations: readonly Annotation[], graphs: Partial<Record<'ai' | 'project', GraphFile>>): KnowledgeMarkView[] {
  return annotations.map((mark) => {
    const graph = graphs[mark.target.graph]
    const found = graph === undefined ? [] : locateTarget(graph, mark.target)
    const first = found[0]
    const title = first === undefined || graph === undefined ? undefined
      : mark.target.kind === 'paper' ? graph.papers[first]?.title : graph.patterns[first]?.name
    return {
      id: mark.id, target: mark.target, verdict: mark.verdict, by: mark.by, at: mark.at,
      ...mark.note === undefined ? {} : { note: mark.note },
      ...title === undefined ? {} : { title },
      ...first !== undefined && mark.target.graph === 'ai' && mark.target.kind === 'paper' ? { index: first } : {},
    }
  })
}
