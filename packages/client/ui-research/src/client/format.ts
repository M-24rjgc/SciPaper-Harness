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
import type {
  CreateProjectRequest, ExperimentRecord, LocalizedText, ModeSummary, ResearchProject, SourceLocator,
} from '@deepseek-ai/dsh-research-workbench/types'
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

/**
 * A mode pack's text in the interface language. Packs carry their own names
 * in both languages; the dictionary only says which one this interface reads.
 * @param text - the pack's text in each language.
 * @param t - bound dictionary lookup.
 * @returns the text for the current language.
 */
export function packText(text: LocalizedText, t: Translate): string {
  return t('packLocale') === 'zh' ? text.zh : text.en
}

/**
 * The name a project's mode goes by; a pack no longer installed shows its id.
 * @param modes - the installed modes, as the snapshot carries them.
 * @param mode - the recorded mode id.
 * @param t - bound dictionary lookup.
 * @returns the mode's name.
 */
export function modeName(modes: readonly ModeSummary[], mode: string, t: Translate): string {
  const pack = modes.find(item => item.id === mode)
  return pack ? packText(pack.name, t) : mode
}

/**
 * A phase's label in its mode; an unknown phase shows its id.
 * @param modes - the installed modes.
 * @param mode - the mode the phase belongs to.
 * @param phase - the phase id.
 * @param t - bound dictionary lookup.
 * @returns the phase's label.
 */
export function phaseName(modes: readonly ModeSummary[], mode: string, phase: string, t: Translate): string {
  const label = modes.find(item => item.id === mode)?.phases.find(item => item.id === phase)?.label
  return label ? packText(label, t) : phase
}

/**
 * The phases a project's mode has on its route; none for the general mode or
 * a pack that is no longer installed.
 * @param modes - the installed modes.
 * @param project - the recorded mode and route.
 * @returns the phase ids in order.
 */
export function modePhases(modes: readonly ModeSummary[], project: Pick<ResearchProject, 'mode' | 'route'>): string[] {
  const pack = modes.find(item => item.id === project.mode)
  const route = project.route ?? pack?.defaultRoute
  const onRoute = (routes: string[] | undefined): boolean => routes === undefined || (route !== undefined && routes.includes(route))
  return (pack?.phases ?? []).filter(phase => onRoute(phase.routes)).map(phase => phase.id)
}

/** The value one mode choice carries in a form: the mode id, and the route after a slash. */
export function modeChoice(mode: string, route?: string): string {
  return route === undefined ? mode : `${mode}/${route}`
}

/**
 * Split a mode choice back into mode and route.
 * @param value - a value {@link modeChoice} produced.
 * @returns the mode, and the route when the choice names one.
 */
export function parseModeChoice(value: string): { mode: string; route?: string } {
  const [mode = '', route] = value.split('/')
  return route === undefined ? { mode } : { mode, route }
}

/**
 * The mode a creation form chose, ready to spread into the request. A form
 * rendered before the modes arrived chose nothing, and the service then
 * starts the project in the general mode.
 * @param form - the submitted form, whose `mode` field a mode select fills.
 * @returns the mode and route fields of the request.
 */
export function chosenMode(form: FormData): Pick<CreateProjectRequest, 'mode' | 'route'> {
  const value = form.get('mode')
  return typeof value === 'string' && value ? parseModeChoice(value) : {}
}

/**
 * Where a project stands, from its last check: the first unfinished phase and
 * how many are done, or the mode alone when there is no phase list.
 * @param project - the project as the snapshot carries it.
 * @param modes - the installed modes.
 * @param t - bound dictionary lookup.
 * @returns one line of standing text.
 */
export function standingText(project: ResearchProject, modes: readonly ModeSummary[], t: Translate): string {
  const check = project.lastCheck
  const current = check?.mode === project.mode && check.route === project.route ? check : undefined
  const phases = current?.phases ?? []
  const mode = modeName(modes, project.mode, t)
  if (phases.length === 0) return mode
  const next = phases.find(phase => !phase.done)
  const done = phases.filter(phase => phase.done).length
  return next ? `${mode} · ${phaseName(modes, project.mode, next.id, t)} ${done}/${phases.length}` : `${mode} · ${t('checkClean')}`
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
