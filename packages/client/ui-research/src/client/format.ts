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
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type {
  Autonomy, ExperimentRecord, LocalizedText, ModeSummary, ResearchProject, SourceLocator, StandingPhase,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { ResearchKey } from './locales.ts'

/** Run statuses that still occupy a supervisor, and may therefore still be moving. */
const OPEN_RUN_STATUS: readonly string[] = ['queued', 'running', 'unknown']
/** The short name of each autonomy. */
const AUTONOMY_NAMES: Record<Autonomy, ResearchKey> = { checkpoints: 'autonomyShortCheckpoints', automatic: 'autonomyShortAutomatic' }

/** Bound lookup over this package's dictionary, as the slot framework supplies it. */
export type Translate = (key: ResearchKey, params?: Record<string, unknown>) => string

/**
 * An autonomy's short name, as the composer chip and the research tab show it.
 * @param autonomy - the research's autonomy.
 * @param t - bound dictionary lookup.
 * @returns 检查点 or 全自动, in the reader's language.
 */
export function autonomyName(autonomy: Autonomy, t: Translate): string {
  return t(AUTONOMY_NAMES[autonomy])
}

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
 * The right sidebar's address for a file inside a project, read through one
 * conversation: the `dsh-resource://file/session/<id>/<absolute path>` address
 * the native file viewers open (they refuse the session-less `absolute` scope).
 * @param sessionId - the conversation whose host reads the file.
 * @param root - absolute project root, either separator.
 * @param path - path relative to the project root.
 * @returns the resource address; `:` stays literal so a drive letter reads as written.
 */
export function projectFileAddress(sessionId: string, root: string, path: string): string {
  return sessionFileAddress(sessionId, `${root.replaceAll('\\', '/').replace(/\/+$/, '')}/${path.replaceAll('\\', '/').replace(/^\.?\//, '')}`)
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

/**
 * Where a project stands among its phases, from the standing the host
 * derives: finished; a deferred phase that nothing before it still waits
 * on; the current phase and how many are done; or, once every phase is done
 * but the paper is not finished, that it needs another check.
 */
export type StandingPlace =
  | { kind: 'finished' }
  | { kind: 'deferred'; phase: StandingPhase }
  | { kind: 'current'; phase: StandingPhase; done: number; total: number }
  | { kind: 'recheck' }

/**
 * Where a project stands among its phases.
 * @param project - the project as the snapshot carries it.
 * @returns the place, or undefined for a mode without phases or a snapshot without a standing.
 */
export function standingPlace(project: ResearchProject): StandingPlace | undefined {
  const phases = project.standing?.phases ?? []
  if (phases.length === 0) return undefined
  if (project.standing?.finished === true) return { kind: 'finished' }
  const current = phases.find(phase => phase.state === 'current')
  const deferred = phases.find(phase => phase.state === 'deferred')
  if (deferred && (!current || phases.indexOf(deferred) < phases.indexOf(current))) return { kind: 'deferred', phase: deferred }
  if (!current) return { kind: 'recheck' }
  return { kind: 'current', phase: current, done: phases.filter(phase => phase.state === 'done').length, total: phases.length }
}

/**
 * Where a project stands among its phases, in words: 已完成 ✓; `{phase}已推迟`;
 * the current phase and how many are done (`引用 3/9`); or 待复查.
 * @param project - the project as the snapshot carries it.
 * @param t - bound dictionary lookup.
 * @returns the phrase, or undefined for a mode without phases or a snapshot without a standing.
 */
export function standingPhrase(project: ResearchProject, t: Translate): string | undefined {
  const place = standingPlace(project)
  switch (place?.kind) {
    case undefined: return undefined
    case 'finished': return t('standingFinished')
    case 'deferred': return t('standingDeferred', { phase: packText(place.phase.label, t) })
    case 'recheck': return t('standingRecheck')
    case 'current': return `${packText(place.phase.label, t)} ${place.done}/${place.total}`
  }
}

/**
 * Where a project stands, named with its mode: `{mode} · {phrase}` from
 * {@link standingPhrase}, or the mode alone when it has no phases.
 * @param project - the project as the snapshot carries it.
 * @param modes - the installed modes.
 * @param t - bound dictionary lookup.
 * @returns one line of standing text.
 */
export function standingText(project: ResearchProject, modes: readonly ModeSummary[], t: Translate): string {
  const mode = modeName(modes, project.mode, t)
  const phrase = standingPhrase(project, t)
  return phrase === undefined ? mode : `${mode} · ${phrase}`
}

/**
 * A count in words, from the dictionary's own sentence for one and for many.
 * @param n - the count.
 * @param one - the key that says it for exactly one.
 * @param many - the key that says it for any other count, with `{n}`.
 * @param t - bound dictionary lookup.
 * @returns the localized phrase.
 */
export function counted(n: number, one: ResearchKey, many: ResearchKey, t: Translate): string {
  return n === 1 ? t(one) : t(many, { n })
}

/**
 * What a check found, one phrase per kind that it found any of: `2 个错误`,
 * `1 个提醒`, errors first.
 * @param errors - errors found.
 * @param warnings - warnings found.
 * @param t - bound dictionary lookup.
 * @returns the phrases; none when it found nothing.
 */
export function findingCounts(errors: number, warnings: number, t: Translate): string[] {
  return [
    ...errors === 0 ? [] : [counted(errors, 'issueOneError', 'checkErrors', t)],
    ...warnings === 0 ? [] : [counted(warnings, 'issueOneWarning', 'checkWarnings', t)],
  ]
}

const MS_PER_MINUTE = 60_000
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR

/**
 * When the last check ran, as the reader counts it: just now, minutes or hours
 * ago, and the date and clock time after a day.
 * @param iso - the check's ISO timestamp.
 * @param now - the current time in epoch milliseconds.
 * @param t - bound dictionary lookup.
 * @returns one localized sentence; a timestamp that does not parse is shown as written.
 */
export function checkedText(iso: string, now: number, t: Translate): string {
  const minutes = Math.floor((now - Date.parse(iso)) / MS_PER_MINUTE)
  if (minutes < 1) return t('checkedJustNow')
  if (minutes < MINUTES_PER_HOUR) return t('checkedMinutesAgo', { n: minutes })
  if (minutes < MINUTES_PER_DAY) return t('checkedHoursAgo', { n: Math.floor(minutes / MINUTES_PER_HOUR) })
  return t('checkedOn', { time: momentText(iso, t) })
}

/**
 * A composer draft with one suggested sentence added: the sentence alone into
 * an empty draft, otherwise on its own line after what was already typed. A
 * suggestion never replaces the person's words.
 * @param draft - the composer draft as it stands.
 * @param sentence - the text to add.
 * @returns the draft to set.
 */
export function appendedDraft(draft: string, sentence: string): string {
  return draft.trim() === '' ? sentence : `${draft.trimEnd()}\n${sentence}`
}

/**
 * The address of a figure gallery image; the host fetches it into its cache on first view.
 * @param id - a gallery figure id.
 * @returns the host route that serves it.
 */
export function galleryImageUrl(id: string): string {
  return `/api/research/gallery/image?id=${encodeURIComponent(id)}`
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
