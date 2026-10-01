import { describe, expect, it } from 'vitest'
import type { MapRegionView } from '@deepseek-ai/dsh-research-workbench/types'
import {
  MAX_ZOOM, MIN_ZOOM, REGION_COLOURS, base64Bytes, buildPointIndex, clampCamera, clipped, colourGroups, crowdingOf, decodeMap, drawPoints,
  fitScale, gapRadius, labelWidth, nearestPoint, panBy, placeLabels, pointRadius, regionColours, safeLink, transformOf, wholeMap, zoomAt,
  type BuiltMap, type PointCanvas,
} from '../src/client/mapValues.ts'

/** A built map page of these points and regions, encoded the way the host encodes it. */
function page(points: readonly (readonly [number, number])[], regions: readonly number[]): BuiltMap {
  const bytes = Buffer.alloc(points.length * 4)
  points.forEach(([x, y], at) => {
    bytes.writeUInt16LE(Math.round(x * 65535), at * 4)
    bytes.writeUInt16LE(Math.round(y * 65535), at * 4 + 2)
  })
  return {
    built: true, graph: { name: 'ai', papers: points.length, patterns: 1 }, points: bytes.toString('base64'),
    regionOf: Buffer.from(regions).toString('base64'), regions: [], gaps: [],
  }
}
const region = (index: number, x: number, y: number, papers: number): MapRegionView => ({ index, label: `r${index}`, keywords: [], papers, domain: '', x, y })

describe('decoding', () => {
  it('reads positions, regions and the extent, and an empty map spans the unit square', () => {
    expect([...base64Bytes(Buffer.from([1, 2, 255]).toString('base64'))]).toEqual([1, 2, 255])
    const map = decodeMap(page([[0.25, 0.5], [0.75, 1]], [3, 255]))
    expect(map.count).toBe(2)
    expect(map.x[0]).toBeCloseTo(0.25, 4)
    expect(map.y[1]).toBe(1)
    expect([...map.region]).toEqual([3, -1])
    expect(map.bounds.minX).toBeCloseTo(0.25, 4)
    expect(map.bounds.maxY).toBe(1)
    expect(decodeMap(page([], [])).bounds).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 })
    // A region list shorter than the points bounds what is decoded.
    expect(decodeMap(page([[0, 0], [1, 1]], [0])).count).toBe(1)
  })
})

describe('regionColours and colourGroups', () => {
  it('gives the largest region the first colour and its nearest neighbour another', () => {
    const colours = regionColours([region(0, 0.1, 0.1, 5), region(1, 0.12, 0.1, 9), region(2, 0.9, 0.9, 1), region(3, 0.5, 0.5, 5)])
    expect(colours.get(1)).toBe(0)
    expect(colours.get(0)).not.toBe(colours.get(1))
    expect(new Set(colours.values()).size).toBeGreaterThan(2)
    // Equal sizes are taken in index order, so the colouring does not depend on the input order.
    expect(regionColours([region(3, 0.5, 0.5, 5), region(0, 0.1, 0.1, 5)]).get(0)).toBe(0)
    expect(regionColours([], 2).size).toBe(0)
  })
  it('groups papers by their region\'s colour and puts the rest last', () => {
    const map = decodeMap(page([[0, 0], [0.5, 0.5], [1, 1], [0.2, 0.2]], [0, 255, 7, 0]))
    const groups = colourGroups(map, new Map([[0, 2]]), 3)
    expect(groups.map(group => [...group])).toEqual([[], [], [0, 3], [1, 2]])
    expect(colourGroups(map, new Map())).toHaveLength(REGION_COLOURS + 1)
  })
})

describe('the camera', () => {
  const bounds = { minX: 0.2, minY: 0.2, maxX: 0.8, maxY: 0.6 }
  const viewport = { width: 600, height: 400 }
  it('fits the extent, never dividing by a degenerate one', () => {
    expect(wholeMap(bounds)).toEqual({ cx: 0.5, cy: 0.4, zoom: MIN_ZOOM })
    expect(fitScale(bounds, viewport)).toBeCloseTo(Math.min(600 / 0.6, 400 / 0.4) * 0.92)
    expect(fitScale({ minX: 0.5, minY: 0.5, maxX: 0.5, maxY: 0.5 }, viewport)).toBeCloseTo(400 / 0.05 * 0.92)
    const transform = transformOf({ cx: 0.5, cy: 0.4, zoom: 2 }, viewport, 100)
    expect(transform).toEqual({ scale: 200, offsetX: 200, offsetY: 120 })
  })
  it('zooms about the pointer and pans by screen pixels, clamped to the map', () => {
    const camera = wholeMap(bounds)
    const base = fitScale(bounds, viewport)
    const at = { x: 100, y: 50 }
    const before = transformOf(camera, viewport, base)
    const zoomed = zoomAt(camera, viewport, base, 2, at)
    const after = transformOf(zoomed, viewport, base)
    expect((at.x - after.offsetX) / after.scale).toBeCloseTo((at.x - before.offsetX) / before.scale)
    expect(zoomed.zoom).toBe(2)
    expect(zoomAt({ ...camera, zoom: MAX_ZOOM }, viewport, base, 4, at).zoom).toBe(MAX_ZOOM)
    expect(zoomAt(camera, viewport, base, 0.1, at).zoom).toBe(MIN_ZOOM)
    expect(panBy({ cx: 0.5, cy: 0.5, zoom: 2 }, 100, 50, -20)).toEqual({ cx: 0.25, cy: 0.6, zoom: 2 })
    expect(clampCamera({ cx: -1, cy: 9, zoom: 99 }, bounds)).toEqual({ cx: 0.2, cy: 0.6, zoom: MAX_ZOOM })
    expect(clampCamera({ cx: 0.5, cy: 0.5, zoom: 0 }, bounds)).toEqual({ cx: 0.5, cy: 0.5, zoom: MIN_ZOOM })
    expect(pointRadius(1)).toBeCloseTo(1.1)
    expect(pointRadius(MAX_ZOOM)).toBe(3.5)
  })
})

describe('drawPoints', () => {
  it('fills each visible point in its group\'s colour and skips the ones off screen', () => {
    const calls: string[] = []
    const context: PointCanvas = {
      fillStyle: '', globalAlpha: 1,
      clearRect: (x: number, y: number, w: number, h: number) => { calls.push(`clear ${x} ${y} ${w} ${h}`) },
      fillRect(x: number, y: number) { calls.push(`${this.fillStyle as string} ${this.globalAlpha} ${Math.round(x)} ${Math.round(y)}`) },
    }
    const map = decodeMap(page([[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]], [0, 255, 0]))
    const groups = [Int32Array.of(0, 2), Int32Array.of(1)]
    drawPoints(context, map, groups, ['teal'], { scale: 100, offsetX: 0, offsetY: 0 }, { width: 60, height: 60 }, 1)
    expect(calls).toEqual(['clear 0 0 60 60', 'teal 0.8 9 9', ' 0.5 49 49'])
    expect(context.globalAlpha).toBe(1)
  })
})

describe('the point index', () => {
  it('finds the nearest paper within the radius, and none beyond it', () => {
    const map = decodeMap(page([[0.1, 0.1], [0.12, 0.1], [1, 1], [0.5, 0.5]], [0, 0, 0, 0]))
    const index = buildPointIndex(map, 8)
    expect(nearestPoint(index, map, { x: 0.115, y: 0.1 }, 0.05)).toBe(1)
    expect(nearestPoint(index, map, { x: 0.1, y: 0.1 }, 0.05)).toBe(0)
    expect(nearestPoint(index, map, { x: 0.99, y: 0.99 }, 0.05)).toBe(2)
    expect(nearestPoint(index, map, { x: 0.3, y: 0.3 }, 0.05)).toBeUndefined()
    expect(nearestPoint(buildPointIndex(map), map, { x: 0.5, y: 0.5 }, 0.01)).toBe(3)
  })
})

describe('labels and words', () => {
  it('shows the highest labels that fit without overlapping', () => {
    const viewport = { width: 200, height: 100 }
    const shown = placeLabels([
      { key: 'low', x: 50, y: 50, width: 40, height: 20, priority: 1 },
      { key: 'high', x: 55, y: 52, width: 40, height: 20, priority: 9 },
      { key: 'beside', x: 120, y: 52, width: 40, height: 20, priority: 2 },
      { key: 'below', x: 55, y: 80, width: 40, height: 20, priority: 3 },
      { key: 'outside', x: 5, y: 50, width: 40, height: 20, priority: 8 },
      { key: 'low-edge', x: 150, y: 95, width: 20, height: 20, priority: 8 },
    ], viewport)
    expect([...shown].sort()).toEqual(['below', 'beside', 'high'])
  })
  it('measures CJK and full-width characters at a full em and the rest at a little over half', () => {
    expect(labelWidth('ab', 10, 0)).toBeCloseTo(11.6)
    expect(labelWidth('中', 10, 0)).toBe(10)
    expect(labelWidth(String.fromCodePoint(0xa000), 10)).toBeCloseTo(23.8)
    expect(labelWidth(String.fromCodePoint(0xf900) + String.fromCodePoint(0xff21), 10, 0)).toBe(20)
  })
  it('bands crowding, sizes sparse areas, cuts text and keeps only web links', () => {
    expect([0.1, 0.5, 0.9].map(crowdingOf)).toEqual(['sparse', 'moderate', 'crowded'])
    expect(gapRadius(Math.PI)).toBe(1)
    expect(gapRadius(-1)).toBe(0)
    expect(clipped('short', 10)).toBe('short')
    expect(clipped('a longer title', 6)).toBe('a lon…')
    expect(safeLink(undefined)).toBeUndefined()
    expect(safeLink('https://openreview.net/forum?id=x')).toBe('https://openreview.net/forum?id=x')
    expect(safeLink('javascript:alert(1)')).toBeUndefined()
    expect(safeLink('not a url')).toBeUndefined()
  })
})
