/**
 * The domain map's pure parts: decoding the packed map the host sends, colouring its regions, the pan and zoom
 * transform, drawing the points, finding the point under the pointer and laying out labels that do not overlap.
 */
import type { MapRegionView, MapViewPage } from '@deepseek-ai/dsh-research-workbench/types'

/** The map page once the host has a map. */
export type BuiltMap = Extract<MapViewPage, { built: true }>

/** World extent of the decoded points; the world is the unit square, x rightward and y downward. */
export interface MapBounds { minX: number; minY: number; maxX: number; maxY: number }

/** The packed map decoded once per page. */
export interface DecodedMap {
  count: number
  x: Float32Array
  y: Float32Array
  /** Region index per paper, -1 where no region reaches it. */
  region: Int16Array
  bounds: MapBounds
}

/** Colours the stylesheet defines for regions; papers outside every region take one more, the last. */
export const REGION_COLOURS = 8
/** Already-coloured regions that weigh on the next region's colour. */
const NEIGHBOURS = 4
const QUANTA = 65535
const NO_REGION = 255

/**
 * The bytes of a base64 string.
 * @param text - base64 as the host encodes it.
 * @returns the decoded bytes.
 */
export function base64Bytes(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at)
  return bytes
}

/**
 * Decode the map's positions and regions.
 * @param page - the built map page.
 * @returns the positions in [0, 1], the region per paper and the points' extent.
 */
export function decodeMap(page: BuiltMap): DecodedMap {
  const points = base64Bytes(page.points)
  const regions = base64Bytes(page.regionOf)
  const count = Math.min(Math.floor(points.length / 4), regions.length)
  const view = new DataView(points.buffer, points.byteOffset, points.byteLength)
  const x = new Float32Array(count), y = new Float32Array(count), region = new Int16Array(count)
  const bounds: MapBounds = { minX: 1, minY: 1, maxX: 0, maxY: 0 }
  for (let at = 0; at < count; at++) {
    const px = view.getUint16(at * 4, true) / QUANTA, py = view.getUint16(at * 4 + 2, true) / QUANTA
    x[at] = px; y[at] = py
    region[at] = regions[at] === NO_REGION ? -1 : regions[at] as number
    bounds.minX = Math.min(bounds.minX, px); bounds.maxX = Math.max(bounds.maxX, px)
    bounds.minY = Math.min(bounds.minY, py); bounds.maxY = Math.max(bounds.maxY, py)
  }
  return { count, x, y, region, bounds: count === 0 ? { minX: 0, minY: 0, maxX: 1, maxY: 1 } : bounds }
}

/**
 * A colour per region such that neighbouring regions rarely share one: the largest region goes first, and each
 * region takes the colour least used among the nearest regions already coloured, nearer ones counting more.
 * @param regions - the map's regions.
 * @param colours - how many colours there are.
 * @returns the colour index by region index.
 */
export function regionColours(regions: readonly MapRegionView[], colours: number = REGION_COLOURS): Map<number, number> {
  const assigned: { region: MapRegionView; colour: number }[] = []
  const result = new Map<number, number>()
  for (const region of [...regions].sort((a, b) => b.papers - a.papers || a.index - b.index)) {
    const use = Array.from({ length: colours }, () => 0)
    assigned.map(item => ({ item, distance: (item.region.x - region.x) ** 2 + (item.region.y - region.y) ** 2 }))
      .sort((a, b) => a.distance - b.distance).slice(0, NEIGHBOURS)
      .forEach(({ item }, rank) => { use[item.colour] = (use[item.colour] as number) + NEIGHBOURS - rank })
    const colour = use.indexOf(Math.min(...use))
    result.set(region.index, colour)
    assigned.push({ region, colour })
  }
  return result
}

/**
 * The papers grouped by colour, so the canvas changes its fill once per colour.
 * @param map - the decoded map.
 * @param colours - the colour by region index.
 * @param count - how many region colours there are; papers outside every region go in the group after them.
 * @returns paper indices per colour group.
 */
export function colourGroups(map: DecodedMap, colours: ReadonlyMap<number, number>, count: number = REGION_COLOURS): Int32Array[] {
  const groups: number[][] = Array.from({ length: count + 1 }, () => [])
  for (let at = 0; at < map.count; at++) {
    const region = map.region[at] as number
    ;(groups[region < 0 ? count : colours.get(region) ?? count] as number[]).push(at)
  }
  return groups.map(group => Int32Array.from(group))
}

/** Where the map is looked at from: the world point at the viewport's centre, and the zoom over the fitted scale. */
export interface MapCamera { cx: number; cy: number; zoom: number }
/** The drawing area in CSS pixels. */
export interface Viewport { width: number; height: number }
/** World to screen: screen = world * scale + offset. */
export interface Transform { scale: number; offsetX: number; offsetY: number }

export const MIN_ZOOM = 1
export const MAX_ZOOM = 48
/** The smallest extent fitted, so a map of one point still has a scale. */
const MIN_SPAN = 0.05
const MARGIN = 0.92

/**
 * The camera that shows the whole map.
 * @param bounds - the points' extent.
 * @returns the centred camera at zoom 1.
 */
export function wholeMap(bounds: MapBounds): MapCamera {
  return { cx: (bounds.minX + bounds.maxX) / 2, cy: (bounds.minY + bounds.maxY) / 2, zoom: MIN_ZOOM }
}

/**
 * Pixels per world unit at zoom 1: the scale that fits the points' extent into the viewport.
 * @param bounds - the points' extent.
 * @param viewport - the drawing area.
 * @returns the fitted scale.
 */
export function fitScale(bounds: MapBounds, viewport: Viewport): number {
  const spanX = Math.max(bounds.maxX - bounds.minX, MIN_SPAN), spanY = Math.max(bounds.maxY - bounds.minY, MIN_SPAN)
  return Math.min(viewport.width / spanX, viewport.height / spanY) * MARGIN
}

/**
 * The world-to-screen transform of a camera.
 * @param camera - the camera.
 * @param viewport - the drawing area.
 * @param base - the fitted scale.
 * @returns the transform.
 */
export function transformOf(camera: MapCamera, viewport: Viewport, base: number): Transform {
  const scale = base * camera.zoom
  return { scale, offsetX: viewport.width / 2 - camera.cx * scale, offsetY: viewport.height / 2 - camera.cy * scale }
}

/**
 * Keep the camera's zoom in range and its centre over the map.
 * @param camera - the camera.
 * @param bounds - the points' extent.
 * @returns the clamped camera.
 */
export function clampCamera(camera: MapCamera, bounds: MapBounds): MapCamera {
  return {
    cx: Math.min(bounds.maxX, Math.max(bounds.minX, camera.cx)),
    cy: Math.min(bounds.maxY, Math.max(bounds.minY, camera.cy)),
    zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom)),
  }
}

/**
 * Zoom by a factor, keeping the world point under a screen point where it is.
 * @param camera - the camera.
 * @param viewport - the drawing area.
 * @param base - the fitted scale.
 * @param factor - above 1 zooms in.
 * @param at - the screen point that stays put.
 * @returns the zoomed camera, before clamping.
 */
export function zoomAt(camera: MapCamera, viewport: Viewport, base: number, factor: number, at: { x: number; y: number }): MapCamera {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor))
  const before = transformOf(camera, viewport, base)
  const worldX = (at.x - before.offsetX) / before.scale, worldY = (at.y - before.offsetY) / before.scale
  const scale = base * zoom
  return { cx: worldX - (at.x - viewport.width / 2) / scale, cy: worldY - (at.y - viewport.height / 2) / scale, zoom }
}

/**
 * Move the camera by a screen distance, as a drag does.
 * @param camera - the camera.
 * @param base - the fitted scale.
 * @param dx - screen pixels rightward.
 * @param dy - screen pixels downward.
 * @returns the moved camera, before clamping.
 */
export function panBy(camera: MapCamera, base: number, dx: number, dy: number): MapCamera {
  const scale = base * camera.zoom
  return { ...camera, cx: camera.cx - dx / scale, cy: camera.cy - dy / scale }
}

/**
 * The radius of a drawn point in CSS pixels: points grow slowly as the map zooms in.
 * @param zoom - the camera's zoom.
 * @returns the radius.
 */
export function pointRadius(zoom: number): number {
  return Math.min(3.5, 1.1 * Math.sqrt(zoom))
}

/** What drawing the points needs of a 2D canvas context. */
export type PointCanvas = Pick<CanvasRenderingContext2D, 'clearRect' | 'fillRect' | 'fillStyle' | 'globalAlpha'>

/**
 * Draw every visible point as a small square, one fill per colour group.
 * @param context - the canvas context, already scaled to CSS pixels.
 * @param map - the decoded map.
 * @param groups - paper indices per colour group; the last group is the papers outside every region.
 * @param palette - one fill per group.
 * @param transform - world to screen.
 * @param viewport - the drawing area.
 * @param radius - the point radius.
 */
export function drawPoints(
  context: PointCanvas, map: DecodedMap, groups: readonly Int32Array[], palette: readonly string[],
  transform: Transform, viewport: Viewport, radius: number,
): void {
  context.clearRect(0, 0, viewport.width, viewport.height)
  const side = radius * 2
  groups.forEach((group, colour) => {
    context.fillStyle = palette[colour] ?? ''
    context.globalAlpha = colour === groups.length - 1 ? 0.5 : 0.8
    for (const at of group) {
      const sx = (map.x[at] as number) * transform.scale + transform.offsetX
      const sy = (map.y[at] as number) * transform.scale + transform.offsetY
      if (sx < -side || sy < -side || sx > viewport.width + side || sy > viewport.height + side) continue
      context.fillRect(sx - radius, sy - radius, side, side)
    }
  })
  context.globalAlpha = 1
}

/** Papers bucketed on a grid over the unit square, for finding the one under the pointer. */
export interface PointIndex { cells: number; start: Int32Array; items: Int32Array }

const INDEX_CELLS = 64

/**
 * Bucket the papers on a grid.
 * @param map - the decoded map.
 * @param cells - cells per side.
 * @returns the index.
 */
export function buildPointIndex(map: DecodedMap, cells: number = INDEX_CELLS): PointIndex {
  const cellOf = (at: number): number => {
    const column = Math.min(cells - 1, Math.floor((map.x[at] as number) * cells))
    const row = Math.min(cells - 1, Math.floor((map.y[at] as number) * cells))
    return row * cells + column
  }
  const start = new Int32Array(cells * cells + 1)
  for (let at = 0; at < map.count; at++) start[cellOf(at) + 1] = (start[cellOf(at) + 1] as number) + 1
  for (let cell = 0; cell < cells * cells; cell++) start[cell + 1] = (start[cell + 1] as number) + (start[cell] as number)
  const fill = start.slice(0, cells * cells)
  const items = new Int32Array(map.count)
  for (let at = 0; at < map.count; at++) {
    const cell = cellOf(at)
    items[fill[cell] as number] = at
    fill[cell] = (fill[cell] as number) + 1
  }
  return { cells, start, items }
}

/**
 * The paper nearest to a world point within a radius.
 * @param index - the grid of papers.
 * @param map - the decoded map.
 * @param point - the world point.
 * @param radius - the largest world distance that counts.
 * @returns the paper's index, or undefined when none is that close.
 */
export function nearestPoint(index: PointIndex, map: DecodedMap, point: { x: number; y: number }, radius: number): number | undefined {
  const { cells } = index
  const span = (value: number): [number, number] => [
    Math.max(0, Math.floor((value - radius) * cells)), Math.min(cells - 1, Math.floor((value + radius) * cells)),
  ]
  const [left, right] = span(point.x), [top, bottom] = span(point.y)
  let best: number | undefined, bestDistance = radius * radius
  for (let row = top; row <= bottom; row++) {
    for (let column = left; column <= right; column++) {
      const cell = row * cells + column
      for (let slot = index.start[cell] as number; slot < (index.start[cell + 1] as number); slot++) {
        const at = index.items[slot] as number
        const distance = ((map.x[at] as number) - point.x) ** 2 + ((map.y[at] as number) - point.y) ** 2
        if (distance <= bestDistance) { best = at; bestDistance = distance }
      }
    }
  }
  return best
}

/** A label that may be shown, centred at (x, y) in screen pixels. */
export interface LabelCandidate { key: string; x: number; y: number; width: number; height: number; priority: number }

/**
 * The labels to show: highest priority first, each only where it overlaps no label already shown and fits the viewport.
 * @param candidates - the labels that could be shown.
 * @param viewport - the drawing area.
 * @param gap - the free space kept around each label.
 * @returns the keys of the labels shown.
 */
export function placeLabels(candidates: readonly LabelCandidate[], viewport: Viewport, gap: number = 4): Set<string> {
  const shown: LabelCandidate[] = []
  for (const label of [...candidates].sort((a, b) => b.priority - a.priority)) {
    const left = label.x - label.width / 2, top = label.y - label.height / 2
    if (left < 0 || top < 0 || left + label.width > viewport.width || top + label.height > viewport.height) continue
    const clear = shown.every(other => Math.abs(other.x - label.x) * 2 >= other.width + label.width + gap * 2
      || Math.abs(other.y - label.y) * 2 >= other.height + label.height + gap * 2)
    if (clear) shown.push(label)
  }
  return new Set(shown.map(label => label.key))
}

/** Code point ranges a label sets a full em wide: CJK radicals to unified ideographs, compatibility ideographs, full-width forms. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [[0x2e80, 0x9fff], [0xf900, 0xfaff], [0xff00, 0xffef]]

/**
 * An estimate of a label's width: a CJK character takes a full em, anything else a little over half of one.
 * @param text - the label.
 * @param fontPx - the font size.
 * @param padding - the label's horizontal padding in total.
 * @returns the width in pixels.
 */
export function labelWidth(text: string, fontPx: number, padding: number = 18): number {
  let width = padding
  for (const char of text) {
    const code = char.codePointAt(0) as number
    width += WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? fontPx : fontPx * 0.58
  }
  return width
}

/** How crowded the map is around a placement. */
export type Crowding = 'sparse' | 'moderate' | 'crowded'

/**
 * The crowding band of a density percentile.
 * @param percentile - the share of papers whose surroundings are at most this crowded.
 * @returns the band: below one third sparse, below two thirds moderate, else crowded.
 */
export function crowdingOf(percentile: number): Crowding {
  return percentile < 1 / 3 ? 'sparse' : percentile < 2 / 3 ? 'moderate' : 'crowded'
}

/**
 * The radius of the circle with a sparse area's share of the map.
 * @param area - the share of the unit square.
 * @returns the radius in world units.
 */
export function gapRadius(area: number): number {
  return Math.sqrt(Math.max(0, area) / Math.PI)
}

/**
 * A link a graph record names, only when it opens a web page.
 * @param url - the record's URL.
 * @returns the URL for an http or https address, else undefined, so a record never runs as script.
 */
export function safeLink(url: string | undefined): string | undefined {
  if (!url) return undefined
  try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : undefined } catch { return undefined }
}

/**
 * A text cut to a length, with an ellipsis when cut.
 * @param text - the text.
 * @param max - the longest result.
 * @returns the text or its cut.
 */
export function clipped(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}
