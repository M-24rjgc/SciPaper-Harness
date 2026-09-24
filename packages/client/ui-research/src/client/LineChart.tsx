/**
 * Line charts for the experiment board: one value axis, thin lines, a dot on
 * each line's latest point, a legend once there are two lines, and a
 * crosshair that reads every line at the pointer. A compact chart is a bare
 * sparkline in the brand accent for a tile that states its value in text.
 */
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { numberText, ticks } from './boardValues.ts'
import type { Translate } from './format.ts'
import styles from './LineChart.module.css'

export interface ChartLine {
  label: string
  points: [number, number][]
}

export interface LineChartProps {
  t: Translate
  lines: ChartLine[]
  /** Accessible name of the chart. */
  name: string
  xLabel?: string | undefined
  yLabel?: string | undefined
  min?: number | undefined
  max?: number | undefined
  /** The values are fractions, drawn and read as percentages. */
  percent?: boolean | undefined
  /** How an x value reads; a plain number by default. */
  formatX?: ((x: number) => string) | undefined
  /** A bare sparkline: no axes, legend, crosshair or data table. */
  compact?: boolean | undefined
  /** Drawn for a narrow column, such as a machine card, so its labels keep their size. */
  narrow?: boolean | undefined
}

const FULL = { width: 640, height: 200, left: 46, right: 14, top: 10, bottom: 26 }
const NARROW = { width: 320, height: 150, left: 40, right: 10, top: 8, bottom: 24 }
/** The narrowest drawing width, however narrow the column. */
const MIN_WIDTH = 240
const COMPACT = { width: 240, height: 48, left: 3, right: 5, top: 5, bottom: 5 }
const SERIES_CLASSES = [styles.line1, styles.line2, styles.line3, styles.line4, styles.line5, styles.line6]
const DOT_CLASSES = [styles.dot1, styles.dot2, styles.dot3, styles.dot4, styles.dot5, styles.dot6]
const SWATCH_CLASSES = [styles.swatch1, styles.swatch2, styles.swatch3, styles.swatch4, styles.swatch5, styles.swatch6]
/** Rows the data table lists before thinning. */
const TABLE_ROWS = 60
const Y_TICKS = 4
const PAD = 0.06

/** The chart's value domain: the asked bounds, else the data's with a little air. */
function domain(values: number[], min: number | undefined, max: number | undefined): [number, number] {
  const low = min ?? Math.min(...values)
  const high = max ?? Math.max(...values)
  if (high <= low) {
    const pad = Math.abs(low) * PAD || 1
    return [low - pad, low + pad]
  }
  const air = (high - low) * PAD
  return [min ?? low - air, max ?? high + air]
}

/** The point of a line nearest an x value. */
function nearest(points: [number, number][], x: number): [number, number] | undefined {
  let best: [number, number] | undefined
  for (const point of points) if (best === undefined || Math.abs(point[0] - x) < Math.abs(best[0] - x)) best = point
  return best
}

export function LineChart(props: LineChartProps): ReactNode {
  const { lines, t } = props
  const [hover, setHover] = useState<number | null>(null)
  // The drawing takes its column's own width, so labels keep their size at any width.
  const plot = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState<number | undefined>(undefined)
  const drawn = lines.filter(line => line.points.length > 0)
  useEffect(() => {
    const element = plot.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width > 0) setMeasured(Math.max(MIN_WIDTH, Math.round(width)))
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [drawn.length > 0])
  const base = props.compact ? COMPACT : props.narrow ? NARROW : FULL
  const box = props.compact || measured === undefined ? base : { ...base, width: measured }
  const plotWidth = box.width - box.left - box.right
  const plotHeight = box.height - box.top - box.bottom
  if (drawn.length === 0) return <p className={styles.empty}>{t('boardWaiting')}</p>
  const xs = drawn.flatMap(line => line.points.map(point => point[0]))
  const ys = drawn.flatMap(line => line.points.map(point => point[1]))
  const first = Math.min(...xs)
  const last = Math.max(...xs)
  const [x0, x1] = last > first ? [first, last] : [first - 1, last + 1]
  const [y0, y1] = domain(ys, props.min, props.max)
  const sx = (x: number): number => box.left + (x - x0) / (x1 - x0) * plotWidth
  const sy = (y: number): number => box.top + (1 - (y - y0) / (y1 - y0)) * plotHeight
  const valueText = (y: number): string => props.percent ? `${numberText(y * 100, 1)}%` : numberText(y)
  const xText = (x: number): string => props.formatX ? props.formatX(x) : numberText(x)
  const path = (points: [number, number][]): string => points.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ')
  if (props.compact) {
    return <svg className={styles.spark} viewBox={`0 0 ${box.width} ${box.height}`} preserveAspectRatio="none" role="img" aria-label={props.name}>
      {drawn.map((line, index) => <polyline key={index} className={styles.sparkLine} points={path(line.points)} />)}
    </svg>
  }
  const move = (event: PointerEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const at = x0 + ((event.clientX - rect.left) / rect.width * box.width - box.left) / plotWidth * (x1 - x0)
    setHover((nearest(xs.map(x => [x, 0]), at) as [number, number])[0])
  }
  const yTicks = ticks(y0, y1, Y_TICKS)
  const rows = [...new Set(xs)].sort((a, b) => a - b)
  const step = Math.max(1, Math.ceil(rows.length / TABLE_ROWS))
  const listed = rows.filter((_, index) => index % step === 0 || index === rows.length - 1)
  return <figure className={styles.chart}>
    <div className={styles.plot} ref={plot}>
      <svg
        className={styles.svg} viewBox={`0 0 ${box.width} ${box.height}`} role="img" aria-label={props.name}
        onPointerMove={move} onPointerLeave={() => { setHover(null) }}
      >
        {yTicks.map(value => <g key={value}>
          <line className={styles.grid} x1={box.left} x2={box.width - box.right} y1={sy(value)} y2={sy(value)} />
          <text className={styles.tick} x={box.left - 6} y={sy(value) + 3} textAnchor="end">{valueText(value)}</text>
        </g>)}
        <line className={styles.axis} x1={box.left} x2={box.width - box.right} y1={box.top + plotHeight} y2={box.top + plotHeight} />
        <text className={styles.tick} x={box.left} y={box.height - 8}>{xText(first)}</text>
        <text className={styles.tick} x={box.width - box.right} y={box.height - 8} textAnchor="end">{xText(last)}</text>
        {props.xLabel && <text className={styles.tick} x={box.left + plotWidth / 2} y={box.height - 8} textAnchor="middle">{props.xLabel}</text>}
        {hover !== null && <line className={styles.crosshair} x1={sx(hover)} x2={sx(hover)} y1={box.top} y2={box.top + plotHeight} />}
        {drawn.map((line, index) => <polyline key={index} className={SERIES_CLASSES[index]} points={path(line.points)} />)}
        {drawn.map((line, index) => {
          const [x, y] = line.points.at(-1) as [number, number]
          return <circle key={index} className={DOT_CLASSES[index]} cx={sx(x)} cy={sy(y)} r={4} />
        })}
      </svg>
      {hover !== null && <div className={styles.tooltip} style={{ left: `${(sx(hover) / box.width * 100).toFixed(1)}%` }} role="status">
        <strong>{props.xLabel ? `${props.xLabel} ` : ''}{xText(hover)}</strong>
        {drawn.map((line, index) => {
          const point = nearest(line.points, hover) as [number, number]
          return <span key={index}><i className={SWATCH_CLASSES[index]} />{line.label} {valueText(point[1])}</span>
        })}
      </div>}
    </div>
    {(drawn.length > 1 || props.yLabel) && <figcaption className={styles.legend}>
      {props.yLabel && <span className={styles.unit}>{props.yLabel}</span>}
      {drawn.length > 1 && drawn.map((line, index) => <span key={index}>
        <i className={SWATCH_CLASSES[index]} />{line.label} <b>{valueText((line.points.at(-1) as [number, number])[1])}</b>
      </span>)}
    </figcaption>}
    <details className={styles.data}>
      <summary>{t('boardChartData')}</summary>
      <table>
        <thead><tr><th>{props.xLabel ?? t('boardChartX')}</th>{drawn.map((line, index) => <th key={index}>{line.label}</th>)}</tr></thead>
        <tbody>{listed.map(x => <tr key={x}>
          <td>{xText(x)}</td>
          {drawn.map((line, index) => {
            const point = line.points.find(item => item[0] === x)
            return <td key={index}>{point ? valueText(point[1]) : ''}</td>
          })}
        </tr>)}</tbody>
      </table>
    </details>
  </figure>
}
