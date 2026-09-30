/**
 * A project's progress: what research_check reports established, merged
 * report by report into `project.progress`, and where the project stands for
 * the person reading it (`standing`), derived from that progress, the mode
 * pack and the project's files. research_check is the only writer; nothing
 * here writes a record or a file.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { checkLabel, decidingChecks, ERRORS_KEY_PREFIX, explainsCondition, reportedChecks } from './checks.ts'
import { requirementKey, type ModePhase, type ResolvedMode } from './modes.ts'
import type {
  CheckFinding, CheckReport, LocalizedText, PhaseProgress, PhaseState, ResearchProgress, ResearchProject, ResearchStanding, StandingIssues,
  StandingPhase,
} from './types.ts'

/** How long one listing of a project's file and directory times is reused. */
const FILE_TIMES_TTL_MS = 30_000
/** The most files listed for a project's newest file time; past it the time is unknown. */
const FILE_LISTING_CAP = 5000
/** Directories whose files are not the person's work: service records and exports at the top, VCS and dependencies anywhere. */
const TOP_SKIPPED = new Set(['.research', 'exports'])
const ANYWHERE_SKIPPED = new Set(['.git', 'node_modules'])

/**
 * Fold one report into the progress it follows. A phase changes only when the
 * report ran every gate that decides it; the findings of every check the
 * report ran are replaced; `full` changes only with a scope-`all` report; a
 * report for another mode or route starts afresh.
 * @param previous - the progress so far, if any.
 * @param report - a report runChecks produced under the mode.
 * @param mode - the mode the report was produced under.
 * @returns the new progress; `previous` is left as it was.
 */
export function mergeProgress(previous: ResearchProgress | undefined, report: CheckReport, mode: ResolvedMode): ResearchProgress {
  const reportMode = report.mode ?? mode.pack.id
  const same = previous !== undefined && previous.mode === reportMode && previous.route === report.route
  const progress: ResearchProgress = same
    ? structuredClone(previous)
    : { mode: reportMode, ...(report.route === undefined ? {} : { route: report.route }), phases: {}, findings: {} }
  const { checkedAt } = report
  const ran = new Set(report.gatesRun)
  for (const status of report.phases) {
    const phase = mode.phases.find(item => item.id === status.id)
    if (phase === undefined) continue
    const deciding = decidingChecks(phase, mode)
    if (mode.gates.some(gate => deciding.has(gate.id) && !ran.has(gate.id))) continue
    progress.phases[status.id] = { done: status.done, unmet: [...status.unmet], checkedAt }
  }
  for (const check of reportedChecks(report, mode)) {
    progress.findings[check] = { items: report.findings.filter(finding => finding.check === check), checkedAt }
  }
  if (report.scope === 'all') progress.full = fullOf(report)
  return progress
}

/** The whole-paper summary of a scope-`all` report. */
function fullOf(report: CheckReport): NonNullable<ResearchProgress['full']> {
  const errors = report.findings.filter(finding => finding.severity === 'error').length
  return { clean: report.clean, errors, warnings: report.findings.length - errors, checkedAt: report.checkedAt }
}

/**
 * The project's progress as stored, or, for a record from before progress was
 * stored, the progress its last scope-`all` report establishes. Such a
 * report named unmet requirements only in words; they are matched to the
 * mode's requirements by their message or reason.
 * @param project - the record.
 * @param mode - the mode the project resolves to.
 * @returns the progress, or undefined when there is none to read.
 */
export function storedProgress(project: ResearchProject, mode: ResolvedMode): ResearchProgress | undefined {
  if (project.progress !== undefined) return project.progress
  const report = project.lastCheck
  if (report?.scope !== 'all' || report.mode === undefined) return undefined
  const { checkedAt } = report
  const phases: Record<string, PhaseProgress> = {}
  for (const status of report.phases) {
    const unmet = status.unmet.length ? status.unmet : legacyKeys(mode.phases.find(phase => phase.id === status.id), status.missing)
    phases[status.id] = { done: status.done, unmet, checkedAt }
  }
  const findings: ResearchProgress['findings'] = {}
  for (const finding of report.findings) (findings[finding.check] ??= { items: [], checkedAt }).items.push(finding)
  return { mode: report.mode, ...(report.route === undefined ? {} : { route: report.route }), phases, findings, full: fullOf(report) }
}

/** Unmet keys for the `missing` lines of a report stored before keys existed, in the order a check lists them now. */
function legacyKeys(phase: ModePhase | undefined, missing: string[]): string[] {
  const requirements: string[] = []
  const errors: string[] = []
  for (const line of missing) {
    const counted = /^\d+ error\(s\) in (.+)$/.exec(line)
    if (counted) {
      errors.push(...String(counted[1]).split(', ').map(check => `${ERRORS_KEY_PREFIX}${check}`))
      continue
    }
    const requirement = phase?.requires.find(item => item.message === line
      || (Array.isArray(item.when) ? item.when : [item.when]).some(condition => explainsCondition(condition, line)))
    if (requirement) requirements.push(requirementKey(requirement))
  }
  return [...requirements, ...errors]
}

/** What `standing` reads of the project's files. */
export interface ProjectFiles {
  /** The newest file or directory modification time, in epoch milliseconds, or `unknown` when a complete listing is unavailable. */
  newest(): Promise<number | 'unknown'>
  /** Whether a project-relative (or absolute) file exists now. */
  exists(path: string): boolean
}

/**
 * Where a project stands for the person: its phases, the next one and what
 * it lacks, the open issues, and whether anything changed since the last
 * check. Progress stored for another mode or route counts as none.
 * @param project - the record.
 * @param mode - the mode the project resolves to.
 * @param files - reads of the project's files.
 * @returns the standing.
 */
export async function projectStanding(project: ResearchProject, mode: ResolvedMode, files: ProjectFiles): Promise<ResearchStanding> {
  const stored = storedProgress(project, mode)
  const progress = stored?.mode === mode.pack.id && stored.route === mode.route ? stored : undefined
  const decided = new Set(project.decisions.flatMap(decision => decision.key === undefined ? [] : [decision.key]))
  const phases: StandingPhase[] = []
  let next: StandingPhase | undefined
  for (const phase of mode.phases) {
    const checked = progress?.phases[phase.id]
    let state: PhaseState
    if (checked?.done === true) state = 'done'
    else if (phase.deferrable !== undefined && decided.has(phase.deferrable)) state = 'deferred'
    else state = next === undefined ? 'current' : 'pending'
    const hints = checked === undefined || checked.done ? [] : checked.unmet.flatMap(key => hintFor(phase, key, mode))
    const item: StandingPhase = {
      id: phase.id, label: phase.label, state, checkpoint: phase.checkpoint, hints, ...(checked ? { checkedAt: checked.checkedAt } : {}),
    }
    if (state === 'current') next = item
    phases.push(item)
  }
  const checkedAt = progress === undefined ? undefined : latest(progress)
  // Files are listed only when there is a check to compare them with.
  const newest = checkedAt === undefined ? 0 : await files.newest()
  const changedAfter = (at: string): boolean | 'unknown' => newest === 'unknown' ? 'unknown' : newest > Date.parse(at)
  const full = progress?.full
  const hint = next?.hints[0]
  return {
    phases,
    ...(next ? { next: next.id } : {}),
    ...(hint ? { hint } : {}),
    // Unknown file times cannot show that nothing changed, so they never count as finished.
    finished: full?.clean === true && phases.every(phase => phase.state === 'done') && changedAfter(full.checkedAt) === false,
    ...(checkedAt === undefined ? {} : { checkedAt }),
    changedSinceCheck: checkedAt === undefined ? false : changedAfter(checkedAt),
    issues: progress === undefined ? [] : issuesOf(progress, mode, files),
  }
}

/** The person's sentence for one unmet key: the requirement's hint, or whose errors to fix; none for a key the pack no longer has. */
function hintFor(phase: ModePhase, key: string, mode: ResolvedMode): LocalizedText[] {
  if (key.startsWith(ERRORS_KEY_PREFIX)) {
    const label = checkLabel(mode, key.slice(ERRORS_KEY_PREFIX.length))
    return [{ en: `Fix the errors in ${label.en}`, zh: `处理「${label.zh}」里的错误` }]
  }
  const requirement = phase.requires.find(item => requirementKey(item) === key)
  return requirement ? [requirement.hint] : []
}

/** The newest moment any part of the progress was checked (ISO times order as text); undefined when it records nothing. */
function latest(progress: ResearchProgress): string | undefined {
  return [
    ...Object.values(progress.phases).map(phase => phase.checkedAt),
    ...Object.values(progress.findings).map(check => check.checkedAt),
    ...progress.full ? [progress.full.checkedAt] : [],
  ].sort().at(-1)
}

/** One group per check with findings: groups with errors first, then in the order the checks were stored. */
function issuesOf(progress: ResearchProgress, mode: ResolvedMode, files: ProjectFiles): StandingIssues[] {
  const groups: StandingIssues[] = []
  for (const [check, { items }] of Object.entries(progress.findings)) {
    if (items.length === 0) continue
    const findings: CheckFinding[] = [...items].sort((a, b) => Number(a.severity === 'warning') - Number(b.severity === 'warning'))
    const errors = findings.filter(finding => finding.severity === 'error').length
    const located = findings.find(finding => finding.file !== undefined && files.exists(finding.file))
    groups.push({
      check, label: checkLabel(mode, check), errors, warnings: findings.length - errors,
      ...(located?.file === undefined ? {} : { file: located.file, ...(located.line === undefined ? {} : { line: located.line }) }),
      findings,
    })
  }
  return groups.sort((a, b) => Number(a.errors === 0) - Number(b.errors === 0))
}

/**
 * The newest modification time of a project's own files and directories: everything outside
 * `.research` and `exports` at its top and `.git` and `node_modules` anywhere.
 * Directory times include file additions, removals and renames. An incomplete
 * listing cannot establish that the last check is still current.
 * @param root - the project root.
 * @param cap - the most files to list.
 * @returns epoch milliseconds, or `unknown` when a read fails or the project holds more than `cap` files.
 */
export async function newestFileTime(root: string, cap: number = FILE_LISTING_CAP): Promise<number | 'unknown'> {
  let newest = 0
  let count = 0
  const walk = async (directory: string, top: boolean): Promise<boolean> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
      newest = Math.max(newest, (await stat(directory)).mtimeMs)
    } catch { return false }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (ANYWHERE_SKIPPED.has(entry.name) || (top && TOP_SKIPPED.has(entry.name))) continue
        if (!await walk(path, false)) return false
      } else if (entry.isFile()) {
        if (++count > cap) return false
        try { newest = Math.max(newest, (await stat(path)).mtimeMs) } catch { return false }
      }
    }
    return true
  }
  return await walk(root, true) ? newest : 'unknown'
}

/** Each project's newest file time, listed at most once every thirty seconds per root. */
export class FileTimes {
  private readonly cache = new Map<string, { at: number; newest: Promise<number | 'unknown'> }>()

  /**
   * @param clock - the current time in epoch milliseconds.
   * @param list - lists one root's newest file time.
   */
  constructor(private readonly clock: () => number = Date.now, private readonly list: (root: string) => Promise<number | 'unknown'> = newestFileTime) {}

  /**
   * One root's newest file time, from a listing at most thirty seconds old.
   * @param root - the project root.
   * @returns the time, as {@link newestFileTime} reports it.
   */
  newest(root: string): Promise<number | 'unknown'> {
    const now = this.clock()
    const cached = this.cache.get(root)
    if (cached !== undefined && now - cached.at < FILE_TIMES_TTL_MS) return cached.newest
    const newest = this.list(root)
    this.cache.set(root, { at: now, newest })
    return newest
  }
}
