import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkLabel, CHECK_LABELS, decidingChecks, explainsCondition, reportedChecks, resolveScope } from '../src/checks.ts'
import { ModeRegistry, type ResolvedMode } from '../src/modes.ts'
import { FileTimes, mergeProgress, newestFileTime, projectStanding, storedProgress, type ProjectFiles } from '../src/progress.ts'
import { newProject } from '../src/project.ts'
import type { CheckFinding, CheckReport, PhaseStatus, ResearchProgress, ResearchProject } from '../src/types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** A file whose stat fails as if it vanished between listing and reading its time. */
const vanishing = vi.hoisted(() => ({ name: '\0' }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: (path: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => String(path).endsWith(vanishing.name)
      ? Promise.reject(Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' }))
      : (actual.stat as (...args: unknown[]) => ReturnType<typeof actual.stat>)(path, ...rest),
  }
})

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

// The fixture pipeline (base checks only) and the shipped packs, whose gates and hints are real.
let fixture: ModeRegistry
let shipped: ModeRegistry
beforeAll(async () => {
  const loud = { warn: (...args: unknown[]) => { throw new Error(args.join(' ')) } }
  fixture = await ModeRegistry.load([join(import.meta.dirname, 'fixtures/modes')], loud)
  shipped = await ModeRegistry.load([join(import.meta.dirname, '../runtime/modes')], loud)
})

const T1 = '2026-09-25T10:00:00.000Z'
const T2 = '2026-09-25T11:00:00.000Z'
const T3 = '2026-09-25T12:00:00.000Z'
const error = (check: string, message = `${check} failed`, file?: string, line?: number): CheckFinding =>
  ({ check, severity: 'error', message, ...(file === undefined ? {} : { file }), ...(line === undefined ? {} : { line }) })
const warning = (check: string, message = `${check} warns`): CheckFinding => ({ check, severity: 'warning', message })
const status = (id: string, done: boolean, unmet: string[] = []): PhaseStatus => ({ id, done, missing: unmet, unmet })

function project(mode: string, route?: string): ResearchProject {
  return newProject({ root: join(tmpdir(), 'research-progress-none'), title: 'P', brief: '', mode, ...(route === undefined ? {} : { route }) }, 'w' as WorkspaceId)
}

/** A report as runChecks makes it, for the given mode, scope and gates. */
function report(mode: ResolvedMode, scope: string, over: Partial<CheckReport> = {}): CheckReport {
  return {
    clean: false, scope, mode: mode.pack.id, ...(mode.route === undefined ? {} : { route: mode.route }), gatesRun: [],
    phases: mode.phases.map(phase => status(phase.id, false, ['x'])), findings: [], checkedAt: T1, ...over,
  }
}

/** Files that exist when named here, with a fixed newest time. */
function files(newest: number | 'unknown', existing: string[] = []): ProjectFiles & { listed: number } {
  const probe = { listed: 0, newest: async () => { probe.listed++; return newest }, exists: (path: string) => existing.includes(path) }
  return probe
}

describe('check scopes and names', () => {
  it('reads a scope as a phase first, then a base check or gate, else everything', () => {
    const mode = shipped.resolve({ mode: 'spark-to-paper', route: 'data' })
    expect(resolveScope(mode, 'cite')).toMatchObject({ kind: 'phase', phase: { id: 'cite' } })
    expect(resolveScope(mode, 'compile')).toEqual({ kind: 'check', id: 'compile' })
    expect(resolveScope(mode, 'draft-lint')).toEqual({ kind: 'check', id: 'draft-lint' })
    expect(resolveScope(mode, 'story-lint')).toEqual({ kind: 'all' })
    expect(resolveScope(mode, 'all')).toEqual({ kind: 'all' })
    const submission = mode.phases.find(phase => phase.id === 'submission')!
    expect([...decidingChecks(submission, mode)]).toEqual(expect.arrayContaining(['cite', 'prose', 'draft-lint', 'figure-critique']))
  })

  it('knows which checks a report carries in full', () => {
    const mode = shipped.resolve({ mode: 'spark-to-paper', route: 'data' })
    expect(reportedChecks(report(mode, 'compile'), mode)).toEqual(['compile'])
    expect(reportedChecks(report(mode, 'draft-lint', { gatesRun: ['draft-lint'] }), mode)).toEqual(['draft-lint'])
    expect(reportedChecks(report(mode, 'write', { gatesRun: ['draft-lint', 'citations-lint'] }), mode)).toEqual(['draft-lint', 'citations-lint'])
    expect(reportedChecks(report(mode, 'latex'), mode)).toEqual(['cite', 'compile', 'visual', 'structure'])
    expect(reportedChecks(report(mode, 'all', { gatesRun: ['draft-lint'] }), mode)).toHaveLength(12)
  })

  it('names base checks in both languages, gates by their pack label, and anything else by its id', () => {
    const mode = shipped.resolve({ mode: 'ccfa', route: 'full-paper' })
    expect(Object.keys(CHECK_LABELS)).toHaveLength(11)
    expect(checkLabel(mode, 'placeholders')).toEqual({ en: 'Placeholders', zh: '占位内容' })
    expect(checkLabel(mode, 'submission-checks')).toEqual({ en: 'Submission checks', zh: '投稿检查' })
    // A gate of another route of the same pack still has its name.
    expect(checkLabel(mode, 'revision-ledger')).toEqual({ en: 'Revision ledger', zh: '修订台账' })
    expect(checkLabel(mode, 'retired-gate')).toEqual({ en: 'retired-gate', zh: 'retired-gate' })
  })

  it('recognises the words a check gives for each unmet condition', () => {
    expect(explainsCondition('noActiveRuns', '2 run(s) still in progress')).toBe(true)
    expect(explainsCondition('noActiveRuns', 'No current review')).toBe(false)
    expect(explainsCondition('reviewCurrent', 'No current review')).toBe(true)
    expect(explainsCondition('manuscript', 'No current review')).toBe(false)
    expect(explainsCondition({ file: 'story.json' }, 'No file matching story.json')).toBe(true)
    expect(explainsCondition({ file: 'sections/*.tex', min: 3 }, 'Fewer than 3 files matching sections/*.tex (1)')).toBe(true)
    expect(explainsCondition({ file: 'sections/*.tex', min: 3 }, 'No file matching refs.bib')).toBe(false)
    expect(explainsCondition({ bibEntries: 3 }, 'No bibliography entries yet')).toBe(true)
    expect(explainsCondition({ sections: 4 }, 'Fewer than 4 sections (2)')).toBe(true)
    expect(explainsCondition({ figures: 1 }, 'No sections yet')).toBe(false)
  })
})

describe('progress merges report by report', () => {
  it('moves a phase only when every gate that decides it ran, and replaces the findings of each check that ran', () => {
    const mode = shipped.resolve({ mode: 'spark-to-paper', route: 'data' })
    const plan = report(mode, 'plan', { gatesRun: ['template-lint', 'blueprint-lint'], findings: [error('blueprint-lint')], checkedAt: T1 })
    const first = mergeProgress(undefined, plan, mode)
    expect(Object.keys(first.phases).sort()).toEqual(['data', 'latex', 'plan', 'review'])
    expect(first.findings).toEqual({ 'template-lint': { items: [], checkedAt: T1 }, 'blueprint-lint': { items: [error('blueprint-lint')], checkedAt: T1 } })
    expect(first).not.toHaveProperty('full')
    const all = report(mode, 'all', {
      gatesRun: mode.gates.map(gate => gate.id), checkedAt: T2, findings: [error('cite'), warning('review')],
      phases: mode.phases.map(phase => status(phase.id, phase.id === 'data')),
    })
    const second = mergeProgress(first, all, mode)
    expect(first.full).toBeUndefined()
    expect(Object.keys(second.phases)).toHaveLength(9)
    expect(second.phases.data).toEqual({ done: true, unmet: [], checkedAt: T2 })
    expect(second.findings['blueprint-lint']).toEqual({ items: [], checkedAt: T2 })
    expect(second.full).toEqual({ clean: false, errors: 1, warnings: 1, checkedAt: T2 })
    // A single base check replaces only its own findings and leaves the whole-paper summary alone.
    const third = mergeProgress(second, report(mode, 'compile', { checkedAt: T3, phases: [status('plan', true), status('retired', true)] }), mode)
    expect(third.findings.compile?.checkedAt).toBe(T3)
    expect(third.findings.cite?.checkedAt).toBe(T2)
    expect(third.full?.checkedAt).toBe(T2)
    // plan needs gates this report did not run; a phase the pack no longer has is dropped.
    expect(third.phases.plan?.checkedAt).toBe(T2)
    expect(third.phases).not.toHaveProperty('retired')
  })

  it('starts afresh for another mode or route, and takes a report without a mode as the mode it ran under', () => {
    const data = shipped.resolve({ mode: 'spark-to-paper', route: 'data' })
    const before = mergeProgress(undefined, report(data, 'all', { checkedAt: T1 }), data)
    const proposal = shipped.resolve({ mode: 'spark-to-paper', route: 'proposal' })
    const after = mergeProgress(before, report(proposal, 'cite', { gatesRun: ['citations-bib'], checkedAt: T2 }), proposal)
    expect(after).toMatchObject({ mode: 'spark-to-paper', route: 'proposal' })
    expect(after.full).toBeUndefined()
    expect(Object.values(after.phases).every(phase => phase.checkedAt === T2)).toBe(true)
    const general = fixture.resolve({ mode: 'general' })
    const { mode: _mode, ...bare } = report(general, 'all', { findings: [warning('prose')] })
    const fresh = mergeProgress(undefined, bare, general)
    expect(fresh).toMatchObject({ mode: 'general', phases: {}, full: { clean: false, errors: 0, warnings: 1 } })
    expect(fresh).not.toHaveProperty('route')
  })
})

describe('progress stored before this version', () => {
  it('reads the stored progress when there is one, and otherwise only a full check that names its mode', () => {
    const mode = shipped.resolve({ mode: 'spark-to-paper', route: 'data' })
    const p = project('spark-to-paper', 'data')
    expect(storedProgress(p, mode)).toBeUndefined()
    p.lastCheck = report(mode, 'plan')
    expect(storedProgress(p, mode)).toBeUndefined()
    const { mode: _mode, ...unnamed } = report(mode, 'all')
    p.lastCheck = unnamed
    expect(storedProgress(p, mode)).toBeUndefined()
    const progress: ResearchProgress = { mode: 'spark-to-paper', route: 'data', phases: {}, findings: {} }
    p.progress = progress
    expect(storedProgress(p, mode)).toBe(progress)
  })

  it('matches the words of an old report to the requirements they describe', () => {
    const mode = shipped.resolve({ mode: 'ccfa', route: 'full-paper' })
    const p = project('ccfa', 'full-paper')
    p.lastCheck = {
      clean: false, scope: 'all', mode: 'ccfa', route: 'full-paper', gatesRun: [], checkedAt: T1,
      phases: [
        { id: 'scaffold', done: true, missing: [], unmet: [] },
        // One requirement by its message, one by the reason a check gives for it, and errors by their count.
        { id: 'experiments', done: false, missing: ['Run the designed experiments and collect them (research_experiment), or import the author\'s measured results', '1 run(s) still in progress'], unmet: [] },
        { id: 'submission', done: false, missing: ['5 error(s) in placeholders, review-report', 'Compiled pages not inspected', 'Something no pack says'], unmet: [] },
        { id: 'retired', done: false, missing: ['No file matching ghost.md'], unmet: [] },
        // A report that already carries keys keeps them.
        { id: 'writing', done: false, missing: ['anything'], unmet: ['pagesInspected'] },
      ],
      findings: [error('placeholders', 'one'), error('placeholders', 'two'), warning('prose')],
    }
    const seeded = storedProgress(p, mode)!
    expect(seeded).toMatchObject({ mode: 'ccfa', route: 'full-paper', full: { clean: false, errors: 2, warnings: 1, checkedAt: T1 } })
    expect(seeded.phases.experiments?.unmet).toEqual(['resultsOrData', 'noActiveRuns'])
    expect(seeded.phases.submission?.unmet).toEqual(['pagesInspected', 'errors:placeholders', 'errors:review-report'])
    expect(seeded.phases.retired?.unmet).toEqual([])
    expect(seeded.phases.writing?.unmet).toEqual(['pagesInspected'])
    expect(seeded.findings.placeholders?.items).toHaveLength(2)
    expect(seeded.findings.prose?.items).toEqual([warning('prose')])
    const { route: _route, ...unrouted } = p.lastCheck
    p.lastCheck = unrouted
    expect(storedProgress(p, mode)).not.toHaveProperty('route')
    // A requirement with alternatives is recognised by the reason of any one of them.
    const plan = fixture.resolve({ mode: 'spark-to-paper', route: 'proposal' })
    const q = project('spark-to-paper', 'proposal')
    q.lastCheck = { ...report(plan, 'all'), phases: [{ id: 'plan', done: false, missing: ['Fewer than 4 sections (1)'], unmet: [] }] }
    expect(storedProgress(q, plan)?.phases.plan?.unmet).toEqual(['file:blueprint.json | file:{outline,plan}*.md | sections>=4'])
  })
})

describe('where a project stands', () => {
  it('shows every phase as current or pending before any check, and lists nothing to compare', async () => {
    const p = project('spark-to-paper', 'proposal')
    const probe = files(Date.parse(T3))
    const standing = await projectStanding(p, shipped.resolve(p), probe)
    expect(standing.phases.map(phase => phase.state)).toEqual(['current', ...Array.from({ length: 8 }, () => 'pending')])
    expect(standing.phases.find(phase => phase.id === 'experiments')).toMatchObject({ checkpoint: true, hints: [] })
    expect(standing).toEqual(expect.objectContaining({ next: 'plan', finished: false, changedSinceCheck: false, issues: [] }))
    expect(standing).not.toHaveProperty('hint')
    expect(standing).not.toHaveProperty('checkedAt')
    expect(standing.phases[0]).not.toHaveProperty('checkedAt')
    expect(probe.listed).toBe(0)
  })

  it('marks done, current and pending phases with the pack\'s hints, and a recorded deferral', async () => {
    const p = project('spark-to-paper', 'proposal')
    const mode = shipped.resolve(p)
    p.progress = {
      mode: 'spark-to-paper', route: 'proposal', findings: {},
      phases: {
        plan: { done: true, unmet: [], checkedAt: T1 },
        cite: { done: false, unmet: ['file:refs.bib', 'errors:citations-bib', 'errors:retired-gate', 'file:gone.bib'], checkedAt: T2 },
        experiments: { done: false, unmet: ['resultsOrData'], checkedAt: T2 },
      },
    }
    p.decisions.push({ id: 'a', question: 'Q', answer: 'A', by: 'agent', rationale: '', at: T1 })
    const standing = await projectStanding(p, mode, files(Date.parse(T1)))
    const byId = new Map(standing.phases.map(phase => [phase.id, phase]))
    expect(byId.get('plan')).toEqual({ id: 'plan', label: { en: 'Plan', zh: '规划' }, state: 'done', checkpoint: false, hints: [], checkedAt: T1 })
    expect(byId.get('cite')?.state).toBe('current')
    expect(byId.get('cite')?.hints).toEqual([
      { en: 'There is no bibliography of verified sources yet', zh: '还没有核实过的参考文献库' },
      { en: 'Fix the errors in Bibliography check', zh: '处理「参考文献检查」里的错误' },
      { en: 'Fix the errors in retired-gate', zh: '处理「retired-gate」里的错误' },
    ])
    expect(standing).toMatchObject({ next: 'cite', hint: { en: 'There is no bibliography of verified sources yet' }, checkedAt: T2, changedSinceCheck: false })
    expect(byId.get('experiments')?.state).toBe('pending')
    // A decision under the phase's key defers it while it is not done, and a deferred phase is never current.
    p.decisions.push({ id: 'b', question: 'Run here?', answer: 'No', by: 'user', rationale: '', at: T2, key: 'experiments-deferred' })
    p.progress.phases.cite = { done: true, unmet: [], checkedAt: T2 }
    for (const phase of ['write', 'refine', 'review', 'figures', 'latex']) p.progress.phases[phase] = { done: true, unmet: [], checkedAt: T2 }
    const deferred = await projectStanding(p, mode, files(Date.parse(T1)))
    expect(deferred.phases.find(phase => phase.id === 'experiments')).toMatchObject({ state: 'deferred', hints: [{ en: 'There are no experiment results yet', zh: '还没有实验结果' }] })
    expect(deferred).toMatchObject({ next: 'submission', finished: false })
    // Once the phase's own check passes it is done: the deferral no longer holds it.
    p.progress.phases.experiments = { done: true, unmet: [], checkedAt: T3 }
    expect((await projectStanding(p, mode, files(Date.parse(T1)))).phases.find(phase => phase.id === 'experiments')?.state).toBe('done')
  })

  it('is finished only when the full check is clean, every phase is done, and no file changed after it', async () => {
    const p = project('spark-to-paper', 'data')
    const mode = shipped.resolve(p)
    const done = Object.fromEntries(mode.phases.map(phase => [phase.id, { done: true, unmet: [], checkedAt: T2 }]))
    p.progress = { mode: 'spark-to-paper', route: 'data', phases: done, findings: {}, full: { clean: true, errors: 0, warnings: 0, checkedAt: T2 } }
    expect(await projectStanding(p, mode, files(Date.parse(T1)))).toMatchObject({ finished: true, changedSinceCheck: false, checkedAt: T2 })
    expect(await projectStanding(p, mode, files(Date.parse(T3)))).toMatchObject({ finished: false, changedSinceCheck: true })
    // Too many files to list: whether anything changed is unknown, and unknown is not finished.
    expect(await projectStanding(p, mode, files('unknown'))).toMatchObject({ finished: false, changedSinceCheck: 'unknown' })
    p.progress.full = { clean: false, errors: 1, warnings: 0, checkedAt: T2 }
    expect((await projectStanding(p, mode, files(Date.parse(T1)))).finished).toBe(false)
    // A newer phase check is the one the change is compared with.
    p.progress.full = { clean: true, errors: 0, warnings: 0, checkedAt: T1 }
    const later = await projectStanding(p, mode, files(Date.parse(T1) + 1))
    expect(later).toMatchObject({ finished: false, changedSinceCheck: false, checkedAt: T2 })
    // Progress stored for another route says nothing about this one; progress that records nothing was never a check.
    p.route = 'proposal'
    expect(await projectStanding(p, shipped.resolve(p), files(Date.parse(T1)))).toMatchObject({ next: 'plan', changedSinceCheck: false, issues: [] })
    p.route = 'data'
    p.progress = { mode: 'spark-to-paper', route: 'data', phases: {}, findings: {} }
    expect(await projectStanding(p, mode, files(Date.parse(T3)))).not.toHaveProperty('checkedAt')
  })

  it('groups the open issues by check, errors first, each with the first of its files that exists', async () => {
    const p = project('general')
    const mode = shipped.resolve(p)
    p.progress = {
      mode: 'general', phases: {},
      findings: {
        prose: { items: [warning('prose')], checkedAt: T1 },
        compile: { items: [], checkedAt: T1 },
        cite: { items: [warning('cite', 'unverified'), error('cite', 'gone', 'paper/old.bib', 2), error('cite', 'missing key', 'paper/main.tex', 7)], checkedAt: T1 },
        visual: { items: [error('visual', 'not looked at', 'paper/main.pdf')], checkedAt: T1 },
        placeholders: { items: [error('placeholders')], checkedAt: T1 },
      },
      full: { clean: false, errors: 3, warnings: 2, checkedAt: T1 },
    }
    const standing = await projectStanding(p, mode, files(Date.parse(T1), ['paper/main.tex', 'paper/main.pdf']))
    expect(standing.phases).toEqual([])
    expect(standing.issues.map(group => [group.check, group.errors, group.warnings])).toEqual([['cite', 2, 1], ['visual', 1, 0], ['placeholders', 1, 0], ['prose', 0, 1]])
    expect(standing.issues[0]).toMatchObject({ label: { en: 'Citations', zh: '引用' }, file: 'paper/main.tex', line: 7 })
    expect(standing.issues[0]?.findings.map(finding => finding.severity)).toEqual(['error', 'error', 'warning'])
    expect(standing.issues[1]).toMatchObject({ file: 'paper/main.pdf' })
    expect(standing.issues[1]).not.toHaveProperty('line')
    expect(standing.issues[2]).not.toHaveProperty('file')
    // A general project is finished once its full check is clean and nothing changed since.
    p.progress = { mode: 'general', phases: {}, findings: {}, full: { clean: true, errors: 0, warnings: 0, checkedAt: T1 } }
    expect((await projectStanding(p, mode, files(0))).finished).toBe(true)
  })
})

describe('the newest file time of a project', () => {
  async function tree(paths: Record<string, number>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'research-times-'))
    roots.push(root)
    for (const [path, seconds] of Object.entries(paths)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), path)
      await utimes(join(root, path), seconds, seconds)
    }
    return root
  }

  it('reads the person\'s files only: not the service records, exports, VCS data or dependencies', async () => {
    const root = await tree({
      'paper/main.tex': 1000, 'code/exports/table.csv': 2000,
      '.research/runs/a.json': 9000, 'exports/draft.zip': 9000, '.git/index': 9000, 'code/node_modules/x/index.js': 9000,
    })
    expect(await newestFileTime(root)).toBe(2000 * 1000)
    // A link is neither a file nor a folder to the listing.
    await symlink(await tree({ 'far.txt': 9000 }), join(root, 'linked'), 'junction')
    expect(await newestFileTime(root)).toBe(2000 * 1000)
    // A file that is gone before its time is read counts for nothing; an unreadable root has no files.
    vanishing.name = 'vanishing.txt'
    try {
      await writeFile(join(root, 'vanishing.txt'), 'x')
      expect(await newestFileTime(root)).toBe(2000 * 1000)
    } finally { vanishing.name = '\0' }
    expect(await newestFileTime(join(root, 'missing'))).toBe(0)
  })

  it('stops listing past its cap, however deep the extra file lies', async () => {
    const nested = await tree({ 'deep/a.txt': 1000, 'deep/b.txt': 1000 })
    expect(await newestFileTime(nested, 2)).toBe(1000 * 1000)
    expect(await newestFileTime(nested, 1)).toBe('unknown')
    const flat = await tree({ 'a.txt': 1000, 'b.txt': 1000 })
    expect(await newestFileTime(flat, 1)).toBe('unknown')
  })

  it('lists one root at most once every thirty seconds', async () => {
    let now = 0
    const listed: string[] = []
    const times = new FileTimes(() => now, async (root) => { listed.push(root); return listed.length })
    expect(await times.newest('a')).toBe(1)
    now = 29_999
    expect(await times.newest('a')).toBe(1)
    expect(await times.newest('b')).toBe(2)
    now = 30_000
    expect(await times.newest('a')).toBe(3)
    expect(listed).toEqual(['a', 'b', 'a'])
    expect(await new FileTimes().newest(join(tmpdir(), 'research-times-none'))).toBe(0)
  })
})
