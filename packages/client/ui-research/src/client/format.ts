/**
 * What the research surfaces derive from a record before showing it: elapsed
 * time, a source locator, a moment, a digest, and the address that reaches a
 * project file. Every sentence and every date pattern
 * lives in the dictionary and carries its own `{name}` placeholders, so the
 * functions here only pick a template and hand it the numbers. Nothing formats
 * through `toLocaleString`, which follows the browser language rather than the
 * interface language and would mix the two after a switch.
 *
 * @module @deepseek-ai/dsh-client-ui-research/format
 */
import type { ExperimentRecord, PhaseId, ResearchMode, ResearchProject, SourceLocator } from '@deepseek-ai/dsh-research-workbench/types'
import type { ResearchKey } from './locales.ts'

/** Run statuses that still occupy a supervisor, and may therefore still be moving. */
const OPEN_RUN_STATUS: readonly string[] = ['queued', 'running', 'unknown']

/** Bound lookup over this package's dictionary, as the slot framework supplies it. */
export type Translate = (key: ResearchKey, params?: Record<string, unknown>) => string

const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60

/** Two-digit clock field. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * Elapsed time in the two largest units that still carry information: hours
 * and minutes past the hour, minutes and seconds below one hour.
 * @param ms - duration in milliseconds; anything negative reads as zero.
 * @param t - bound dictionary lookup.
 * @returns the duration as one localized string.
 */
export function durationText(ms: number, t: Translate): string {
  const total = Math.max(0, Math.floor(ms / MS_PER_SECOND))
  const h = Math.floor(total / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR))
  const m = Math.floor(total / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR
  const s = total % SECONDS_PER_MINUTE
  if (h > 0) return t('durationHours', { h, m })
  if (m > 0) return t('durationMinutes', { m, s })
  return t('durationSeconds', { s })
}

/**
 * Where inside a source a quote sits, as precisely as the locator states it.
 * @param locator - page, paragraph, line and citation key, each optional.
 * @param t - bound dictionary lookup.
 * @returns the stated parts joined by spaces; empty for a bare locator.
 */
export function locatorText(locator: SourceLocator, t: Translate): string {
  const parts: string[] = []
  if (locator.page !== undefined) parts.push(t('locatorPage', { n: locator.page }))
  if (locator.paragraph !== undefined) parts.push(t('locatorParagraph', { n: locator.paragraph }))
  if (locator.line !== undefined) parts.push(t('locatorLine', { n: locator.line }))
  if (locator.key !== undefined) parts.push(locator.key)
  return parts.join(' ')
}

/**
 * A recorded moment as the reader's calendar date, without a clock.
 * @param iso - an ISO timestamp carried by a research record.
 * @param t - bound dictionary lookup.
 * @returns the formatted date, or the input unchanged when it does not parse.
 */
export function dateText(iso: string, t: Translate): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return t('dateMonthDay', { m: at.getMonth() + 1, d: at.getDate() })
}

/**
 * A recorded moment as the reader's calendar date and clock time.
 * @param iso - an ISO timestamp carried by a research record.
 * @param t - bound dictionary lookup.
 * @returns the formatted moment, or the input unchanged when it does not parse.
 */
export function momentText(iso: string, t: Translate): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return t('dateMonthDayTime', {
    m: at.getMonth() + 1,
    d: at.getDate(),
    h: pad2(at.getHours()),
    min: pad2(at.getMinutes()),
  })
}

/** Leading and trailing characters kept when a digest is elided. */
const DIGEST_HEAD = 6
const DIGEST_TAIL = 4

/**
 * A content digest short enough for one line and long enough to compare by eye.
 * @param sha256 - the full hex digest recorded with the source.
 * @returns the elided digest, or the input when it is already that short.
 */
export function digestText(sha256: string): string {
  if (sha256.length <= DIGEST_HEAD + DIGEST_TAIL) return sha256
  return `${sha256.slice(0, DIGEST_HEAD)}…${sha256.slice(-DIGEST_TAIL)}`
}

/**
 * How long the supervisor has had the child, from its own clock.
 *
 * A run still occupying a supervisor is measured to now. One that has stopped
 * is measured to the moment it reported finishing, or — for a run the
 * supervisor never got to stamp, which is what an interruption leaves behind —
 * to the observation that found it stopped. Without that fallback a terminal
 * run with no `finishedAt` would keep accruing time forever.
 * @param run - the experiment record as the snapshot carries it.
 * @returns elapsed milliseconds, or undefined for a run that never started.
 */
export function elapsedOf(run: ExperimentRecord): number | undefined {
  if (run.startedAt === undefined) return undefined
  const started = Date.parse(run.startedAt)
  if (Number.isNaN(started)) return undefined
  const observed = Date.parse(run.updatedAt)
  const fallback = OPEN_RUN_STATUS.includes(run.status) || Number.isNaN(observed) ? Date.now() : observed
  const reported = run.finishedAt === undefined ? fallback : Date.parse(run.finishedAt)
  const ended = Number.isNaN(reported) ? fallback : reported
  return Math.max(0, ended - started)
}

/**
 * The right sidebar's address for a file inside a project, in the
 * `dsh-resource://file/absolute/…` grammar the native file preview opens.
 * @param root - absolute project root, either separator.
 * @param path - path relative to the project root.
 * @returns the resource address; `:` stays literal so a drive letter reads as written.
 */
export function projectFileAddress(root: string, path: string): string {
  const absolute = `${root.replaceAll('\\', '/').replace(/\/+$/, '')}/${path.replaceAll('\\', '/').replace(/^\.?\//, '')}`
  const unc = absolute.startsWith('//')
  const encoded = absolute.replace(/^\/+/, '').split('/').map(segment => encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/')
  return `dsh-resource://file/absolute/${unc ? '/' : ''}${encoded}`
}

/** Dictionary key of each pipeline phase's name. */
export const PHASE_KEYS: Record<PhaseId, ResearchKey> = {
  idea: 'phase_idea', literature: 'phase_literature', plan: 'phase_plan', draft: 'phase_draft',
  experiments: 'phase_experiments', results: 'phase_results', polish: 'phase_polish', submission: 'phase_submission',
  ingest: 'phase_ingest', write: 'phase_write', figures: 'phase_figures',
}

/** Dictionary key of each mode's short name; an unrouted project reads as such. */
export function modeShortKey(mode: ResearchMode | undefined): ResearchKey {
  if (mode === 'paper-first') return 'modeShortPaperFirst'
  if (mode === 'from-results') return 'modeShortFromResults'
  if (mode === 'free') return 'modeShortFree'
  return 'modeUnset'
}

/**
 * Where a project stands, from its last check: the first unfinished phase and
 * how many are done, or the mode alone when there is no phase list.
 * @param project - the project as the snapshot carries it.
 * @param t - bound dictionary lookup.
 * @returns one line of standing text.
 */
export function standingText(project: ResearchProject, t: Translate): string {
  const phases = project.lastCheck?.phases ?? []
  const mode = t(modeShortKey(project.mode))
  if (phases.length === 0) return mode
  const next = phases.find(phase => !phase.done)
  const done = phases.filter(phase => phase.done).length
  return next ? `${mode} · ${t(PHASE_KEYS[next.id])} ${done}/${phases.length}` : `${mode} · ${t('checkClean')}`
}

/**
 * Address of one file inside a project, as the research file route serves it.
 * Pass the immutable snapshot under `.research/`, never a user-absolute path:
 * the route refuses anything outside the project root.
 * @param projectId - project the file belongs to.
 * @param path - path relative to the project root.
 * @param page - 1-based page for a PDF viewer, when the locator states one.
 * @returns the route URL, carrying the PDF open parameter when a page is given.
 */
export function researchFileUrl(projectId: string, path: string, page?: number): string {
  const base = `/api/research/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`
  return page === undefined ? base : `${base}#page=${page}`
}
