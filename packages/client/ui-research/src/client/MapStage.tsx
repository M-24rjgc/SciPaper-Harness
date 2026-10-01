/**
 * The domain map's drawing: every paper of the built-in graph as a point on a canvas, coloured by region, with the
 * region names, the research's marks, the legend and the zoom controls laid over it. Dragging moves the map, the
 * wheel and the + and − keys zoom, and a click selects the paper under the pointer.
 */
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import type { MapGapView, MapPaperView, MapRegionView } from '@deepseek-ai/dsh-research-workbench/types'
import type { Translate } from './format.ts'
import {
  REGION_COLOURS, drawPoints, fitScale, gapRadius, labelWidth, nearestPoint, panBy, placeLabels, pointRadius, transformOf, zoomAt,
  type DecodedMap, type LabelCandidate, type MapCamera, type PointIndex, type Viewport,
} from './mapValues.ts'
import styles from './KnowledgeMap.module.css'

/** One mark the stage draws over the points, in world coordinates. */
export interface StageMarker {
  key: string
  kind: 'idea' | 'alternative' | 'library' | 'recall' | 'search' | 'search-place' | 'selected'
  x: number
  y: number
  /** Shown beside the mark when there is room. */
  label?: string | undefined
  /** The mark's full description, for its tooltip. */
  title: string
  /** library: `exact` or `placed`; recall: the person's verdict, or `none`. */
  variant?: string | undefined
  /** Higher labels win the room. */
  priority: number
}

/** The stage's inputs. */
export interface StageProps {
  t: Translate
  map: DecodedMap
  groups: readonly Int32Array[]
  index: PointIndex
  regions: readonly MapRegionView[]
  colours: ReadonlyMap<number, number>
  /** The sparse areas to draw; absent while their layer is off. */
  gaps: readonly MapGapView[] | undefined
  markers: readonly StageMarker[]
  camera: MapCamera
  /** Change the camera; the owner clamps the result. */
  move: (update: (camera: MapCamera) => MapCamera) => void
  /** The paper under the pointer changed. */
  hover: (index: number | undefined) => void
  /** The details of the paper under the pointer, once read. */
  hovered: MapPaperView | undefined
  select: (index: number | undefined) => void
  /** Return to the idea, or show the whole map when there is none. */
  recenter: () => void
  hasIdea: boolean
  caption: string
  legend: readonly ('paper' | 'recall' | 'library' | 'gaps' | 'search')[]
}

/** The size drawn before the stage is measured, and where nothing measures it. */
const DEFAULT_VIEWPORT: Viewport = { width: 640, height: 520 }
/** The canvas reads its region fills from these custom properties of its own style, in colour-group order. */
const PALETTE = [...Array.from({ length: REGION_COLOURS }, (_, at) => `--km-c${at}`), '--km-none']
const ZOOM_STEP = 1.5
const PAN_PX = 60
/** A press that moves less than this is a click. */
const DRAG_SLOP = 4
const HOVER_PX = 6
const CLICK_PX = 9
const LEGEND_KEYS = { paper: 'kmLegendPaper', recall: 'kmLegendRecall', library: 'kmLegendLibrary', gaps: 'kmLegendGaps', search: 'kmLegendSearch' } as const

/** Component-local lengths handed to the stylesheet. */
function lengths(values: Record<`--km-${string}`, number>): CSSProperties {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, `${value}px`]))
}

/**
 * The map's canvas and everything drawn over it.
 * @param props - the decoded map, its marks and the camera.
 * @returns the stage.
 */
export function MapStage(props: StageProps): ReactNode {
  const { t, map, camera, move } = props
  const stage = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT)
  const [pointer, setPointer] = useState<{ x: number; y: number } | undefined>()
  const drag = useRef<{ x: number; y: number; camera: MapCamera; moved: boolean } | undefined>(undefined)
  const base = fitScale(map.bounds, viewport)
  const transform = transformOf(camera, viewport, base)
  const live = useRef({ viewport, base })
  live.current = { viewport, base }

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      for (const { contentRect } of entries) {
        // A hidden stage measures nothing; it keeps the size it had, so the map is not refitted to a point.
        if (contentRect.width <= 0 || contentRect.height <= 0) continue
        setViewport({ width: Math.round(contentRect.width), height: Math.round(contentRect.height) })
      }
    })
    observer.observe(stage.current as HTMLDivElement)
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    const element = canvas.current as HTMLCanvasElement
    const ratio = Math.max(1, window.devicePixelRatio)
    element.width = Math.round(viewport.width * ratio)
    element.height = Math.round(viewport.height * ratio)
    const context = element.getContext('2d')
    if (context === null) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    const style = getComputedStyle(element)
    const palette = PALETTE.map(name => style.getPropertyValue(name).trim())
    drawPoints(context, map, props.groups, palette, transform, viewport, pointRadius(camera.zoom))
  }, [map, props.groups, camera.cx, camera.cy, camera.zoom, viewport.width, viewport.height])

  useEffect(() => {
    const element = stage.current as HTMLDivElement
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const { viewport: area, base: scale } = live.current
      const at = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      move(current => zoomAt(current, area, scale, Math.exp(-event.deltaY * 0.0015), at))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => { element.removeEventListener('wheel', wheel) }
  }, [move])

  const local = (event: PointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const pick = (at: { x: number; y: number }, radius: number): number | undefined => nearestPoint(props.index, map, {
    x: (at.x - transform.offsetX) / transform.scale, y: (at.y - transform.offsetY) / transform.scale,
  }, radius / transform.scale)
  const centre = { x: viewport.width / 2, y: viewport.height / 2 }
  const keys: Record<string, ((current: MapCamera) => MapCamera) | undefined> = {
    '+': current => zoomAt(current, viewport, base, ZOOM_STEP, centre),
    '=': current => zoomAt(current, viewport, base, ZOOM_STEP, centre),
    '-': current => zoomAt(current, viewport, base, 1 / ZOOM_STEP, centre),
    ArrowLeft: current => panBy(current, base, PAN_PX, 0),
    ArrowRight: current => panBy(current, base, -PAN_PX, 0),
    ArrowUp: current => panBy(current, base, 0, PAN_PX),
    ArrowDown: current => panBy(current, base, 0, -PAN_PX),
  }

  const screen = (x: number, y: number): { x: number; y: number } => ({
    x: x * transform.scale + transform.offsetX, y: y * transform.scale + transform.offsetY,
  })
  const inside = (at: { x: number; y: number }, margin: number): boolean =>
    at.x >= -margin && at.y >= -margin && at.x <= viewport.width + margin && at.y <= viewport.height + margin
  const markers = props.markers.map(marker => ({ marker, at: screen(marker.x, marker.y) })).filter(({ at }) => inside(at, 12))
  const regions = props.regions.map(region => ({ region, at: screen(region.x, region.y) }))
  const gaps = (props.gaps ?? []).map(gap => ({ gap, at: screen(gap.x, gap.y), radius: gapRadius(gap.area) * transform.scale }))
  const gapTitle = (gap: MapGapView): string => `${t('kmGapLabel', { regions: gap.borders.slice(0, 2).join(' · ') })} · ${t('kmGapRecurs', { recurs: gap.recurs, others: gap.runs - 1 })}`
  // The caption keeps its corner: it takes room from the labels first and is never drawn by them.
  const captionWidth = labelWidth(props.caption, 11.5, 16)
  const candidates: LabelCandidate[] = [
    { key: 'caption', x: 12 + captionWidth / 2, y: 21, width: captionWidth, height: 22, priority: Infinity },
    ...markers.flatMap(({ marker, at }) => {
      if (marker.label === undefined) return []
      const width = labelWidth(marker.label, 11, 12)
      return [{ key: marker.key, x: at.x + 10 + width / 2, y: at.y, width, height: 18, priority: 1e6 * marker.priority }]
    }),
    ...gaps.map(({ gap, at, radius }) => ({ key: `gap${gap.index}`, x: at.x, y: at.y + radius + 12, width: labelWidth(t('kmGapShort'), 11), height: 18, priority: 5e5 })),
    ...regions.map(({ region, at }) => ({ key: `region${region.index}`, x: at.x, y: at.y, width: labelWidth(region.label, 11), height: 22, priority: region.papers })),
  ]
  const shown = placeLabels(candidates, viewport)
  const card = pointer !== undefined && props.hovered !== undefined ? { paper: props.hovered, at: pointer } : undefined

  return <div ref={stage} className={styles.stage} role="application" aria-label={t('kmStage')} tabIndex={0} data-map-stage
    onPointerDown={(event) => {
      if (event.button !== 0) return
      drag.current = { ...local(event), camera, moved: false }
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={(event) => {
      const at = local(event)
      const held = drag.current
      if (held !== undefined) {
        const dx = at.x - held.x, dy = at.y - held.y
        if (!held.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
        held.moved = true
        move(() => panBy(held.camera, base, dx, dy))
        return
      }
      const hit = pick(at, HOVER_PX)
      setPointer(hit === undefined ? undefined : at)
      props.hover(hit)
    }}
    onPointerUp={(event) => {
      const held = drag.current
      drag.current = undefined
      if (held === undefined || held.moved) return
      props.select(pick(local(event), CLICK_PX))
    }}
    onPointerLeave={() => { setPointer(undefined); props.hover(undefined) }}
    onKeyDown={(event) => {
      const action = keys[event.key]
      if (action === undefined) return
      event.preventDefault()
      move(action)
    }}>
    <canvas ref={canvas} className={styles.canvas} aria-hidden="true" />
    <p className={styles.caption}>{props.caption}</p>
    <div className={styles.layer} aria-hidden="true">
      {gaps.map(({ gap, at, radius }) => <span key={`gap${gap.index}`}>
        <span className={styles.gap} title={gapTitle(gap)} style={lengths({ '--km-x': at.x, '--km-y': at.y, '--km-r': radius })} />
        {shown.has(`gap${gap.index}`) && <span className={styles.gapLabel} style={lengths({ '--km-x': at.x, '--km-y': at.y + radius + 12 })}>{t('kmGapShort')}</span>}
      </span>)}
      {regions.filter(({ region }) => shown.has(`region${region.index}`)).map(({ region, at }) => <span key={region.index} className={styles.region}
        data-tone={props.colours.get(region.index)} style={lengths({ '--km-x': at.x, '--km-y': at.y })}>{region.label}</span>)}
      {markers.map(({ marker, at }) => <span key={marker.key}>
        <span className={styles.marker} data-kind={marker.kind} data-variant={marker.variant} title={marker.title}
          style={lengths({ '--km-x': at.x, '--km-y': at.y })} />
        {shown.has(marker.key) && <span className={styles.markerLabel} data-kind={marker.kind} data-variant={marker.variant}
          style={lengths({ '--km-x': at.x + 10, '--km-y': at.y })}>{marker.label}</span>}
      </span>)}
    </div>
    {card !== undefined && <div className={styles.hover} role="tooltip"
      style={lengths({ '--km-x': Math.min(card.at.x + 14, viewport.width - 270), '--km-y': Math.min(card.at.y + 14, viewport.height - 110) })}>
      <strong>{card.paper.title}</strong>
      {card.paper.pattern !== undefined && <span>{t('kmPattern', { pattern: card.paper.pattern })}</span>}
      {card.paper.region !== undefined && <span>{card.paper.region}</span>}
      <span className={styles.hoverHint}>{t('kmHoverHint')}</span>
    </div>}
    <div className={styles.legend}>
      {props.legend.map(item => <span key={item} className={styles.legendItem}>
        <span className={styles.swatch} data-kind={item} aria-hidden="true" />{t(LEGEND_KEYS[item])}
      </span>)}
    </div>
    <div className={styles.controls}>
      <button type="button" className={styles.control} aria-label={t('kmZoomIn')} title={t('kmZoomIn')}
        onClick={() => { move(current => zoomAt(current, viewport, base, ZOOM_STEP, centre)) }}>+</button>
      <button type="button" className={styles.control} aria-label={t('kmZoomOut')} title={t('kmZoomOut')}
        onClick={() => { move(current => zoomAt(current, viewport, base, 1 / ZOOM_STEP, centre)) }}>−</button>
      <button type="button" className={styles.control} aria-label={t(props.hasIdea ? 'kmRecenter' : 'kmWholeMap')} title={t(props.hasIdea ? 'kmRecenter' : 'kmWholeMap')}
        onClick={props.recenter}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>
      </button>
    </div>
  </div>
}
