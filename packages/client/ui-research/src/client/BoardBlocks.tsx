/**
 * The blocks a board section is made of. Each one draws what the agent laid
 * out; a value that follows runs is resolved against the live record here,
 * so it fills in the moment a run finishes.
 */
import type { ReactNode } from 'react'
import type { BoardBlock, BoardSection, BoardSnapshot, BoardTone, ExperimentRecord, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import { ACTIVE_RUN_STATUS, fieldPoints, latestRun, nameMatches, numberText, shownValue, xKey, type Shown } from './boardValues.ts'
import { durationText, elapsedOf, type Translate } from './format.ts'
import { LineChart } from './LineChart.tsx'
import type { ResearchKey } from './locales.ts'
import styles from './Board.module.css'

const TONES: Record<BoardTone, string | undefined> = { good: styles.good, warning: styles.warning, bad: styles.bad, muted: styles.muted }
/** List statuses with a mark of their own; anything else reads as pending. */
const MARKS: Record<string, string | undefined> = {
  running: styles.markRunning, queued: styles.markRunning, done: styles.markDone, completed: styles.markDone,
  failed: styles.markAttention, blocked: styles.markAttention, interrupted: styles.markAttention, unknown: styles.markAttention,
}
const STATUS_KEYS: Record<string, ResearchKey> = {
  pending: 'boardStatusPending', running: 'boardStatusRunning', done: 'boardStatusDone', failed: 'boardStatusFailed', blocked: 'boardStatusBlocked',
}
const RUN_STATUS_KEYS: Record<ExperimentRecord['status'], ResearchKey> = {
  queued: 'queued', running: 'running', completed: 'completed', failed: 'failed', cancelled: 'cancelled', interrupted: 'interrupted', unknown: 'unknown',
}
/** Metric columns a `runs` block shows when it names none. */
const DEFAULT_METRICS = 4

export interface BlockProps {
  t: Translate
  project: ResearchProject
  snapshot: BoardSnapshot
}

const toneClass = (tone: BoardTone | undefined): string | undefined => tone === undefined ? undefined : TONES[tone]
const alignClass = (align: 'left' | 'center' | 'right' | undefined): string | undefined => align === undefined ? undefined : styles[align]

/** A status mark: the small dot that says running, done, needs a look, or not yet. */
export function Mark(props: { status: string }): ReactNode {
  return <span className={MARKS[props.status] ?? styles.markIdle} aria-hidden="true" />
}

/** A thin bar for a fraction from 0 to 1; `warn` turns it amber, for a disk or memory nearly full. */
export function Meter(props: { value: number; warn?: boolean | undefined }): ReactNode {
  const width = Math.max(0, Math.min(1, props.value)) * 100
  return <span className={styles.meter}><span className={props.warn ? styles.meterWarn : styles.meterFill} style={{ width: `${width}%` }} /></span>
}

/** A value with its note underneath. */
function Value(props: { shown: Shown }): ReactNode {
  const { shown } = props
  return <>
    <span className={[styles.cellText, toneClass(shown.tone)].filter(Boolean).join(' ')}>{shown.text}</span>
    {shown.sub !== undefined && <small className={styles.cellSub}>{shown.sub}</small>}
  </>
}

/** One stat tile, also used for the board's overview row. */
export function StatTile(props: { label: string; shown: Shown; progress?: number | undefined }): ReactNode {
  return <div className={styles.tile}>
    <span className={styles.tileLabel}>{props.label}</span>
    <span className={styles.tileValue}><Value shown={props.shown} /></span>
    {props.progress !== undefined && <Meter value={props.progress} />}
  </div>
}

function StatsBlock(props: BlockProps & { block: Extract<BoardBlock, { type: 'stats' }> }): ReactNode {
  return <div className={styles.tiles}>{props.block.items.map((item, index) => <StatTile
    key={index} label={item.label} shown={shownValue(props.project, item, props.t)} progress={item.progress}
  />)}</div>
}

function TableBlock(props: BlockProps & { block: Extract<BoardBlock, { type: 'table' }> }): ReactNode {
  const { block, project, t } = props
  // A cell that follows a run's metric is one the experiments still have to fill.
  let followed = 0
  let filled = 0
  const shown = block.rows.map(row => block.columns.map((column) => {
    const cell = row.cells[column.key]
    const value = shownValue(project, cell, t)
    if (cell !== null && typeof cell === 'object' && cell.run !== undefined && cell.metric !== undefined) {
      followed++
      if (value.state === 'value') filled++
    }
    return value
  }))
  return <div className={styles.tableWrap}>
    {followed > 0 && <p className={styles.blockMeta}>{t('boardFilled', { done: filled, total: followed })}</p>}
    <table className={styles.table}>
      <thead><tr>{block.columns.map(column => <th key={column.key} className={alignClass(column.align)}>{column.label}</th>)}</tr></thead>
      <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex} className={toneClass(row.tone)}>
        {block.columns.map((column, columnIndex) => <td key={column.key} className={alignClass(column.align)}>
          <Value shown={shown[rowIndex]?.[columnIndex] as Shown} />
        </td>)}
      </tr>)}</tbody>
    </table>
  </div>
}

function ChartBlock(props: BlockProps & { block: Extract<BoardBlock, { type: 'chart' }> }): ReactNode {
  const { block, project, snapshot, t } = props
  const lines = block.series.map((series, index) => {
    const label = series.label ?? series.key ?? t('boardSeriesN', { n: index + 1 })
    if (series.points !== undefined) return { label, points: series.points }
    const run = latestRun(project, series)
    const rows = run === undefined ? [] : snapshot.series[run.id] ?? []
    return { label, points: fieldPoints(rows, series.key as string, xKey(rows, block.x)) }
  })
  return <LineChart
    t={t} lines={lines} name={block.title ?? lines.map(line => line.label).join(', ')}
    xLabel={block.xLabel} yLabel={block.yLabel} min={block.min} max={block.max}
  />
}

/** A run's status as a board list or table shows it. */
function runStatus(run: ExperimentRecord, t: Translate): string {
  const fraction = run.progress?.fraction
  const status = t(RUN_STATUS_KEYS[run.status])
  return fraction !== undefined && ACTIVE_RUN_STATUS.includes(run.status) ? `${status} · ${t('boardPercent', { n: Math.round(fraction * 100) })}` : status
}

function ListBlock(props: BlockProps & { block: Extract<BoardBlock, { type: 'list' }> }): ReactNode {
  const { project, t } = props
  return <ul className={styles.list}>{props.block.items.map((item, index) => {
    const run = latestRun(project, item)
    const status = run?.status ?? item.status ?? 'pending'
    const statusKey = STATUS_KEYS[status]
    const statusText = run ? runStatus(run, t) : item.status === undefined ? undefined : statusKey ? t(statusKey) : item.status
    const progress = run?.progress?.fraction ?? item.progress
    return <li key={index} className={toneClass(item.tone)}>
      <Mark status={status} />
      <div className={styles.listBody}>
        <div className={styles.listHead}>
          <span className={styles.listTitle}>{item.title}</span>
          {statusText !== undefined && <span className={styles.listStatus}>{statusText}</span>}
        </div>
        {item.detail !== undefined && <p className={styles.listDetail}>{item.detail}</p>}
        {progress !== undefined && <Meter value={progress} />}
      </div>
    </li>
  })}</ul>
}

function RunsBlock(props: BlockProps & { block: Extract<BoardBlock, { type: 'runs' }> }): ReactNode {
  const { block, project, t } = props
  const runs = project.experiments.filter(run => nameMatches(block.match, run.spec.name))
  if (runs.length === 0) return <p className={styles.blockMeta}>{t('boardNoRunsYet', { match: block.match })}</p>
  const metrics = block.metrics ?? [...new Set(runs.flatMap(run => Object.keys(run.metrics)))].slice(0, DEFAULT_METRICS)
  const done = runs.filter(run => run.status === 'completed').length
  return <div className={styles.tableWrap}>
    <p className={styles.blockMeta}>{t('boardDoneOf', { done, total: runs.length })}</p>
    <table className={styles.table}>
      <thead><tr>
        <th>{t('boardColumnRun')}</th><th>{t('boardColumnStatus')}</th><th className={styles.right}>{t('boardColumnTime')}</th>
        {metrics.map(metric => <th key={metric} className={styles.right}>{metric}</th>)}
      </tr></thead>
      <tbody>{runs.map((run) => {
        const elapsed = elapsedOf(run)
        return <tr key={run.id}>
          <td><Mark status={run.status} /> {run.spec.name} <span className={styles.muted}>· {t('runSeed')} {run.spec.seed}</span></td>
          <td>{runStatus(run, t)}</td>
          <td className={styles.right}>{elapsed === undefined ? '—' : durationText(elapsed, t)}</td>
          {metrics.map((metric) => {
            const value = run.metrics[metric]
            return <td key={metric} className={styles.right}>{value === undefined ? '—' : numberText(value * (block.scale ?? 1), block.digits)}</td>
          })}
        </tr>
      })}</tbody>
    </table>
  </div>
}

/** One block, whatever its type. */
export function BlockView(props: BlockProps & { block: BoardBlock }): ReactNode {
  const { block } = props
  let body: ReactNode
  switch (block.type) {
    case 'stats': body = <StatsBlock {...props} block={block} />; break
    case 'table': body = <TableBlock {...props} block={block} />; break
    case 'chart': body = <ChartBlock {...props} block={block} />; break
    case 'list': body = <ListBlock {...props} block={block} />; break
    case 'runs': body = <RunsBlock {...props} block={block} />; break
    case 'text': body = <div className={toneClass(block.tone) ?? styles.text}>{block.text.split(/\n{2,}/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>; break
    case 'kv': body = <dl className={styles.kv}>{block.items.map((item, index) => <div key={index}><dt>{item.label}</dt><dd className={toneClass(item.tone)}>{typeof item.value === 'number' ? numberText(item.value) : item.value}</dd></div>)}</dl>; break
    case 'log': body = <pre className={styles.log}>{block.text}</pre>; break
  }
  return <div className={styles.block}>
    {block.title !== undefined && <h4>{block.title}</h4>}
    {block.note !== undefined && <p className={styles.blockNote}>{block.note}</p>}
    {body}
  </div>
}

/** A section: its title and note, then its blocks; a collapsed one opens on request. */
export function SectionView(props: BlockProps & { section: BoardSection }): ReactNode {
  const { section } = props
  const blocks = section.blocks.map((block, index) => <BlockView key={index} {...props} block={block} />)
  if (section.collapsed) {
    return <details className={styles.panel}>
      <summary className={styles.panelSummary}><h3>{section.title}</h3></summary>
      {section.note !== undefined && <p className={styles.panelNote}>{section.note}</p>}
      {blocks}
    </details>
  }
  return <section className={styles.panel}>
    <h3>{section.title}</h3>
    {section.note !== undefined && <p className={styles.panelNote}>{section.note}</p>}
    {blocks}
  </section>
}
