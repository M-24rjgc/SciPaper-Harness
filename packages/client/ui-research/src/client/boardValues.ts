/**
 * What the experiment board derives from the record before drawing it: the
 * runs a board value follows, the value it shows, the sections collectors add,
 * and the points a chart line plots. The service reads the machines and
 * progress lines; everything that follows runs is resolved here against the
 * live project record, so a finished run fills its cells without a new read.
 */
import type {
  BoardCell, BoardCollected, BoardSection, BoardSpec, BoardTone, BoardValue, ExperimentRecord, ResearchProject,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { Translate } from './format.ts'

/** Run statuses still occupying a supervisor. */
export const ACTIVE_RUN_STATUS: readonly string[] = ['queued', 'running', 'unknown']
/** Run statuses a person should look at. */
export const PROBLEM_RUN_STATUS: readonly string[] = ['failed', 'interrupted', 'unknown']
/** Progress fields that mark the horizontal axis, in the order they are preferred. */
const X_KEYS = ['epoch', 'step', 'iteration', 'iter']
/** Progress fields that are bookkeeping rather than something to watch. */
const QUIET_KEYS = new Set(['progress', 't', 'time', 'timestamp', 'elapsed', 'seconds'])
const SIGNIFICANT_DIGITS = 4

type Ref = { run?: string | undefined; seed?: number | undefined }

/**
 * The runs a board value follows: the run with that id, else every run of that name (and seed).
 * @param project - the runs on record.
 * @param ref - the run it names (an id, or a name) and the seed, when one is picked.
 * @returns the followed runs, in record order.
 */
export function followedRuns(project: Pick<ResearchProject, 'experiments'>, ref: Ref): ExperimentRecord[] {
  if (ref.run === undefined) return []
  const byId = project.experiments.filter(run => run.id === ref.run)
  if (byId.length) return byId
  return project.experiments.filter(run => run.spec.name === ref.run && (ref.seed === undefined || run.spec.seed === ref.seed))
}

/**
 * The run a chart line follows: the latest of those {@link followedRuns} finds.
 * @param project - the runs on record.
 * @param ref - the run it names (an id, or a name) and the seed, when one is picked.
 * @returns the latest followed run, or undefined when none is.
 */
export function latestRun(project: Pick<ResearchProject, 'experiments'>, ref: Ref): ExperimentRecord | undefined {
  return followedRuns(project, ref).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
}

/**
 * Whether a run name matches a pattern in which `*` matches anything.
 * @param pattern - the name, with `*` for any run of characters.
 * @param name - a run name.
 * @returns whether the whole name matches.
 */
export function nameMatches(pattern: string, name: string): boolean {
  const expression = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${expression}$`).test(name)
}

/**
 * A number in the digits asked for, else in four significant digits; never
 * through `toLocaleString`, which follows the browser rather than the interface.
 * @param value - the number.
 * @param digits - decimal places, when the value asks for them.
 * @returns the number as text.
 */
export function numberText(value: number, digits?: number): string {
  if (digits !== undefined) return value.toFixed(digits)
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toPrecision(SIGNIFICANT_DIGITS)))
}

/** A value as one board cell shows it. */
export interface Shown {
  text: string
  sub?: string | undefined
  tone?: BoardTone | undefined
  /** `value` for a number or text; otherwise where the followed runs stand. */
  state: 'value' | 'empty' | 'pending' | 'running' | 'failed' | 'missing'
}

function mean(values: number[]): number { return values.reduce((a, b) => a + b, 0) / values.length }
/** Sample standard deviation: the spread over seeds as papers report it. */
function deviation(values: number[]): number {
  const m = mean(values)
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1))
}

function targetTone(value: BoardValue, shown: number): BoardTone | undefined {
  if (value.target === undefined) return value.tone
  const reached = value.better === 'lower' ? shown <= value.target : shown >= value.target
  return reached ? 'good' : 'warning'
}

/**
 * What a board value shows: its fixed value, or the metric of the runs it
 * follows — their mean once any finished, with the spread over seeds.
 * @param project - the runs on record.
 * @param cell - the value as the layout gives it.
 * @param t - bound dictionary lookup.
 * @returns the text, its note, its tone and where the followed runs stand.
 */
export function shownValue(project: Pick<ResearchProject, 'experiments'>, cell: BoardCell | undefined, t: Translate): Shown {
  if (cell === undefined || cell === null || cell === '') return { text: '—', state: 'empty' }
  if (typeof cell === 'string') return { text: cell, state: 'value' }
  if (typeof cell === 'number') return { text: numberText(cell), state: 'value' }
  const unit = cell.unit ?? ''
  const scaled = (value: number): number => value * (cell.scale ?? 1)
  if (cell.run === undefined) {
    if (cell.value === undefined) return { text: '—', sub: cell.sub, state: 'empty' }
    if (typeof cell.value === 'string') return { text: cell.value, sub: cell.sub, tone: cell.tone, state: 'value' }
    const shown = scaled(cell.value)
    return { text: `${numberText(shown, cell.digits)}${unit}`, sub: cell.sub, tone: targetTone(cell, shown), state: 'value' }
  }
  const runs = followedRuns(project, cell)
  if (runs.length === 0) return { text: t('boardNotRun'), state: 'pending', tone: 'muted' }
  const metric = cell.metric
  const done = metric === undefined ? [] : runs.filter(run => run.status === 'completed' && run.metrics[metric] !== undefined)
  if (done.length === 0) {
    const active = runs.find(run => ACTIVE_RUN_STATUS.includes(run.status))
    if (active) {
      const fraction = active.progress?.fraction
      return { text: t('runRunning'), sub: fraction === undefined ? undefined : t('boardPercent', { n: Math.round(fraction * 100) }), state: 'running' }
    }
    const completed = runs.some(run => run.status === 'completed')
    if (completed) return metric === undefined
      ? { text: t('completed'), state: 'value', tone: 'good' }
      : { text: '—', sub: t('boardNoMetric', { metric }), state: 'missing', tone: 'muted' }
    return runs.some(run => run.status === 'failed' || run.status === 'interrupted')
      ? { text: t('failed'), state: 'failed', tone: 'bad' }
      : { text: t('cancelled'), state: 'failed', tone: 'muted' }
  }
  const values = done.map(run => scaled(run.metrics[metric as string] as number))
  const average = mean(values)
  const notes = [
    ...values.length > 1 ? [`± ${numberText(deviation(values), cell.digits)} · ${t('boardSeeds', { n: values.length })}`] : cell.sub ? [cell.sub] : [],
    ...done.length < runs.length ? [t('boardDoneOf', { done: done.length, total: runs.length })] : [],
  ]
  return { text: `${numberText(average, cell.digits)}${unit}`, sub: notes.join(' · ') || undefined, tone: targetTone(cell, average), state: 'value' }
}

/**
 * The board's sections with what the collectors printed: a collector section
 * with a board section's id adds its blocks there, any other is appended.
 * @param spec - the agent's layout.
 * @param collected - what each collector printed last.
 * @returns new sections; the layout is left as it was.
 */
export function mergedSections(spec: BoardSpec, collected: Record<string, BoardCollected>): BoardSection[] {
  const sections = spec.sections.map(section => ({ ...section, blocks: [...section.blocks] }))
  for (const output of Object.values(collected)) {
    for (const section of output.sections) {
      const target = sections.find(item => item.id === section.id)
      if (target) target.blocks.push(...section.blocks)
      else sections.push({ ...section, blocks: [...section.blocks] })
    }
  }
  return sections
}

/**
 * The field a run's progress lines are plotted against; undefined means the line number.
 * @param rows - the progress lines.
 * @param preferred - the field the chart names, used when the lines carry it.
 * @returns the axis field, or undefined for the line number.
 */
export function xKey(rows: readonly Record<string, number>[], preferred?: string): string | undefined {
  if (preferred !== undefined && rows.some(row => row[preferred] !== undefined)) return preferred
  return X_KEYS.find(key => rows.some(row => row[key] !== undefined))
}

/**
 * One field of progress lines as chart points against `x` (the line number when absent).
 * @param rows - the progress lines.
 * @param key - the field plotted.
 * @param x - the axis field, or undefined for the line number.
 * @returns the points of the lines that carry both.
 */
export function fieldPoints(rows: readonly Record<string, number>[], key: string, x: string | undefined): [number, number][] {
  const points: [number, number][] = []
  rows.forEach((row, index) => {
    const y = row[key]
    const at = x === undefined ? index + 1 : row[x]
    if (y !== undefined && at !== undefined) points.push([at, y])
  })
  return points
}

/**
 * The fields of a run's progress worth drawing, at most `limit`: numbers that change, never the axis or bookkeeping.
 * @param rows - the progress lines.
 * @param x - the axis field, left out.
 * @param limit - the most fields returned.
 * @returns the fields in the order the lines first carry them.
 */
export function watchedKeys(rows: readonly Record<string, number>[], x: string | undefined, limit: number): string[] {
  const keys: string[] = []
  for (const row of rows) for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key)
  return keys.filter(key => key !== x && !QUIET_KEYS.has(key)).slice(0, limit)
}

/**
 * Round tick values covering a range, about `count` of them.
 * @param min - the low end of the range.
 * @param max - the high end.
 * @param count - about how many ticks.
 * @returns the ticks, low to high.
 */
export function ticks(min: number, max: number, count: number): number[] {
  if (!(max > min)) return [min]
  const raw = (max - min) / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * magnitude).find(candidate => candidate >= raw) as number
  const first = Math.ceil(min / step) * step
  const result: number[] = []
  for (let value = first; value <= max + step * 1e-9; value += step) result.push(Number(value.toPrecision(12)))
  return result
}

/**
 * Bytes as gigabytes with one decimal.
 * @param bytes - a size in bytes.
 * @returns the size in gigabytes, as text.
 */
export function gigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}
