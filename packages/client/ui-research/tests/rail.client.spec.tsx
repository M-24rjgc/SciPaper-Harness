// @vitest-environment jsdom

/**
 * 研究记录 (Research record), the research tab beside the conversation. It
 * reports what the research is and where it stands, by the host's standing
 * and what is live in it, and offers its tabs and tools. The assistant sets
 * the mode and runs the checks, and the person changes the autonomy in the
 * composer, so the record writes nothing: a suggested sentence is only added
 * to the composer's draft.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { EvidenceId, ExperimentRecord, ResearchCommand, ResearchGoal, ResearchProject, RunStatus } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchRail, ResearchRailTitle } from '../src/client/Rail.tsx'
import { sessionDirectoriesOf, type SessionDirectories, type WorkbenchProps } from '../src/client/contract.ts'
import type { PresetDefaults } from '../src/client/presets.ts'
import type { ResearchTabProps } from '../src/client/Tabs.tsx'
import { zh } from '../src/client/locales.ts'
import { MODES } from './fixtures/modes.ts'
import { standingOf } from './fixtures/standing.ts'

afterEach(() => { cleanup() })

const SESSION = 'session-rail'
const ROOT = 'C:\\research\\sparse'

interface Log {
  commands: ResearchCommand[]
  opened: [string, string][]
  /** Each tab a row or tool asked for: the board, the gallery, Sources (and its section), the files. */
  tabs: string[]
  /** Each folder shown in the file manager. */
  revealed: string[]
  /** Each conversation 跳过去 (Go there) opened, with the Workspace it falls back to. */
  conversations: [string, string][]
  /** Each draft the record set in the composer. */
  drafts: string[]
  /** How many times the saved default preset was reset. */
  resets: number
}

/** How the host and the page answer; everything is accepted and nothing is live unless a test says otherwise. */
interface Host {
  openFile?: () => void
  openFiles?: () => void
  reveal?: () => Promise<void>
  openConversation?: () => Promise<void>
  resetDefaultPreset?: () => Promise<void>
  /** Whether the host can show a folder in the file manager; yes by default. */
  canReveal?: boolean
  presets?: PresetDefaults | null
  /** The session list; this conversation alone, titled 稀疏注意力, by default. */
  sessions?: SessionSummary[]
  pending?: [string, string][]
  /** What the composer holds. */
  draft?: string
}

/** The Chinese dictionary, interpolating `{name}` the way the locale seat does. */
function t(key: string, params?: Record<string, unknown>): string {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}

/** A project in the given mode and route; the general mode, chosen by the person, when none is named. */
function project(mode?: string, route?: string): ResearchProject {
  const record = newProject({ root: ROOT, title: 'Sparse attention scaling study', brief: '', mode: mode ?? 'general', ...(route ? { route } : {}) }, 'workspace' as WorkspaceId)
  record.sessionId = SESSION
  return record
}

/** One recorded run in the given state. */
function run(id: string, status: RunStatus): ExperimentRecord {
  return { id: id as never, spec: {} as never, status, createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: {}, message: '', snapshotPath: '', collected: false }
}

function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id: id as SessionId, displayTitle: id, cwd: ROOT, running: false, retainedBy: {}, blank: false, updatedAt: 1, ...extra }
}

const goal = (sessionId: string, phase: ResearchGoal['phase']): ResearchGoal => ({ sessionId, objective: 'the paper', phase, roundsStarted: 1, updatedAt: 1 })

function seat(projects: ResearchProject[], host: Host): { props: ResearchTabProps; log: Log } {
  const log: Log = { commands: [], opened: [], tabs: [], revealed: [], conversations: [], drafts: [], resets: 0 }
  const view = { snapshot: { projects, preferences: {}, components: [], modes: MODES }, tasks: [] }
  const sessions = host.sessions ?? [session(SESSION, { displayTitle: '稀疏注意力' })]
  const list: SessionListState = {
    ids: sessions.map(item => item.id), byId: Object.fromEntries(sessions.map(item => [item.id, item])),
    projectionsBySession: {}, phase: 'ready',
  }
  const pending = new Map((host.pending ?? []).map(([id, kind]) => [
    id as SessionId, { pendingInteraction: { key: `${id}-${kind}`, kind, sessionId: id as SessionId }, running: undefined, completionUnread: false },
  ]))
  const input = { draft: host.draft ?? '' }
  const presets = host.presets === undefined ? { research: 'research' } : host.presets
  const directories = sessionDirectoriesOf(list.byId)
  const props = {
    sessionId: SESSION,
    t,
    useResearch: (select: (value: typeof view) => unknown) => select(view),
    useDirectories: (select: (value: SessionDirectories) => unknown) => select(directories),
    useSessions: (select: (value: SessionListState) => unknown) => select(list),
    useSessionStatus: (select: (value: typeof pending) => unknown) => select(pending),
    useInput: (select: (value: typeof input) => unknown) => select(input),
    useCanReveal: (select: (value: boolean) => unknown) => select(host.canReveal ?? true),
    usePresets: (select: (value: PresetDefaults | null) => unknown) => select(presets),
    inputActions: { setDraft: (text: string) => { log.drafts.push(text) } },
    run: (command: ResearchCommand) => {
      log.commands.push(command)
      return Promise.resolve({ message: '' })
    },
    openFile: (root: string, path: string) => { log.opened.push([root, path]); host.openFile?.() },
    openFiles: () => { log.tabs.push('files'); host.openFiles?.() },
    openBoard: () => { log.tabs.push('board') },
    openGallery: () => { log.tabs.push('gallery') },
    openSources: (section?: string) => { log.tabs.push(section === undefined ? 'sources' : `sources:${section}`) },
    reveal: (path: string) => { log.revealed.push(path); return host.reveal?.() ?? Promise.resolve() },
    openConversation: (sessionId: string, workspaceId: string) => {
      log.conversations.push([sessionId, workspaceId])
      return host.openConversation?.() ?? Promise.resolve()
    },
    resetDefaultPreset: () => { log.resets += 1; return host.resetDefaultPreset?.() ?? Promise.resolve() },
  } as ResearchTabProps
  return { props, log }
}

/** The record beside the conversation `SESSION`. */
function mount(projects: ResearchProject[], host: Host = {}): { rail: ReturnType<typeof render>; log: Log } {
  const { props, log } = seat(projects, host)
  return { rail: render(<ResearchRail {...props} />), log }
}

/** The 现在 (Now) section of a mounted record. */
function nowOf(rail: ReturnType<typeof render>): HTMLElement {
  return rail.getByText(zh.nowTitle).closest('section')!
}

/** Let the host's answers land. */
const settle = async (): Promise<void> => { await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }) }

describe('the research record names the research', () => {
  it('names itself, and says so when the conversation belongs to no research', () => {
    expect(render(<ResearchRailTitle t={t as WorkbenchProps['t']} />).container.textContent).toBe(zh.railTitle)
    cleanup()
    const stranger = project()
    stranger.sessionId = 'elsewhere'
    stranger.root = 'D:\\elsewhere'
    expect(mount([stranger]).rail.getByText(zh.railNoProject)).toBeTruthy()
  })

  it('shows a local research ledger beside its uniquely configured SSH conversation', () => {
    const record = project()
    record.sessionId = undefined
    record.environments.push({
      id: 'environment-ssh' as never, name: 'Lab', kind: 'existing', target: 'ssh', python: 'python3',
      sshHost: 'lab', remoteRoot: '/srv/sparse', requirements: [], fingerprint: 'remote', status: 'ready', details: '', isDefault: true,
    })
    const { rail } = mount([record], { sessions: [session(SESSION, { cwd: '/srv/sparse/code', execution: { kind: 'ssh', host: 'lab' } })] })
    expect(rail.getByText('Sparse attention scaling study')).toBeTruthy()
    expect(rail.getByText(ROOT)).toBeTruthy()
    expect(rail.queryByText(zh.railNoProject)).toBeNull()
  })

  it('names the research and its folder, and shows the folder in the file manager where the host can', async () => {
    const { rail, log } = mount([project()])
    expect(rail.getByText('Sparse attention scaling study')).toBeTruthy()
    expect(rail.getByText(ROOT)).toBeTruthy()
    fireEvent.click(rail.getByRole('button', { name: zh.folderReveal }))
    await settle()
    expect(log.revealed).toEqual([ROOT])
    expect(rail.queryByRole('alert')).toBeNull()
    cleanup()
    const refused = mount([project()], { reveal: () => Promise.reject(new Error('no file manager')) }).rail
    fireEvent.click(refused.getByRole('button', { name: zh.folderReveal }))
    await settle()
    expect(refused.getByRole('alert').textContent).toBe(t('actionFailed', { reason: 'no file manager' }))
    cleanup()
    expect(mount([project()], { canReveal: false }).rail.queryByRole('button', { name: zh.folderReveal })).toBeNull()
  })

  it('marks an example with its banner and tag, and credits its answers to the example\'s author', () => {
    const shipped = project('spark-to-paper')
    shipped.example = true
    shipped.decisions.push(
      { id: 'd0', question: 'Q0', answer: 'A0', by: 'user', rationale: '', at: '' },
      { id: 'd1', question: 'Q1', answer: 'A1', by: 'agent', rationale: '', at: '' },
    )
    const { rail } = mount([shipped])
    expect(rail.container.firstElementChild?.firstElementChild?.textContent).toBe(zh.exampleBanner)
    expect(rail.getByText(zh.exampleTag)).toBeTruthy()
    expect(rail.getByText(`${zh.exampleAuthor} · Q0`)).toBeTruthy()
    expect(rail.getByText(`${zh.decisionByAgent} · Q1`)).toBeTruthy()
    expect(rail.queryByText(`${zh.decisionByUser} · Q0`)).toBeNull()
    // An example's autonomy is its own: named, with nowhere to change it.
    expect(rail.getByText(zh.autonomyShortCheckpoints)).toBeTruthy()
    expect(rail.queryByText(/在输入框下方更改/)).toBeNull()
    cleanup()
    const own = mount([project('spark-to-paper')]).rail
    expect(own.queryByText(zh.exampleBanner)).toBeNull()
    expect(own.queryByText(zh.exampleTag)).toBeNull()
  })
})

describe('the record reads the mode and the autonomy, and changes neither', () => {
  it('reads the mode with its route, who chose it and why, and 模式待定 before it is chosen', () => {
    const general = mount([project()]).rail
    expect(general.getByText('通用 · 你选定')).toBeTruthy()
    cleanup()
    const routed = project('spark-to-paper', 'data')
    routed.modeSetBy = 'agent'
    routed.modeReason = '已有实测结果'
    const agent = mount([routed]).rail
    expect(agent.getByText('从实测结果开始 · 助手选定', { exact: false })).toBeTruthy()
    expect(agent.getByText('已有实测结果')).toBeTruthy()
    cleanup()
    // Without a recorded route the pack's default route is the one it runs.
    const defaulted = project('spark-to-paper')
    expect(mount([defaulted]).rail.getByText(`spark-to-paper · ${MODES[1]!.routes.find(item => item.id === MODES[1]!.defaultRoute)!.name.zh} · 你选定`)).toBeTruthy()
    cleanup()
    const retired = project('retired-pack')
    expect(mount([retired]).rail.getByText('retired-pack · 你选定')).toBeTruthy()
    cleanup()
    const unchosen = project()
    unchosen.modeSetBy = undefined
    expect(mount([unchosen]).rail.getByText(zh.modeUnchosen)).toBeTruthy()
    cleanup()
    const shipped = project('spark-to-paper', 'data')
    shipped.example = true
    expect(mount([shipped]).rail.getByText('从实测结果开始 · 示例作者选定', { exact: false })).toBeTruthy()
  })

  it('adds a sentence asking for another mode to the draft, after what was typed, and sends nothing', () => {
    const { rail, log } = mount([project()], { draft: '先看一下数据。' })
    const change = rail.getByRole('button', { name: zh.modeChange })
    expect(change.getAttribute('title')).toBe(zh.entryTryHint)
    fireEvent.click(change)
    expect(log.drafts).toEqual([`先看一下数据。\n${zh.modeChangeDraft}`])
    expect(log.commands).toEqual([])
    cleanup()
    const shipped = project()
    shipped.example = true
    expect(mount([shipped]).rail.queryByRole('button', { name: zh.modeChange })).toBeNull()
  })

  it('names the autonomy and says it is changed under the message box', () => {
    const { rail, log } = mount([project()])
    expect(rail.queryByRole('combobox')).toBeNull()
    expect(rail.getByText(zh.autonomy)).toBeTruthy()
    expect(rail.getByText('检查点（在输入框下方更改）')).toBeTruthy()
    expect(log.commands).toEqual([])
    cleanup()
    const automatic = project()
    automatic.autonomy = 'automatic'
    expect(mount([automatic]).rail.getByText('全自动（在输入框下方更改）')).toBeTruthy()
  })
})

describe('the 现在 (Now) line', () => {
  const routed = (): ResearchProject => {
    const record = project('spark-to-paper', 'proposal')
    record.standing = standingOf([['plan', 'done'], ['cite', 'current'], ['submission', 'pending']], {
      checkedAt: new Date().toISOString(), hint: { en: 'No bibliography yet', zh: '还没有参考文献库' },
    })
    return record
  }

  it('says a conversation of the research waits for an answer, and goes there unless it is this one', async () => {
    const sessions = [session(SESSION, { displayTitle: '稀疏注意力' }), session('other', { displayTitle: '补充相关工作' })]
    const { rail, log } = mount([routed()], { sessions, pending: [['other', 'question']] })
    const now = nowOf(rail)
    expect(within(now).getByText('等你回答（对话「补充相关工作」）').className).toContain('nowWarn')
    fireEvent.click(within(now).getByRole('button', { name: zh.nowJump }))
    await settle()
    expect(log.conversations).toEqual([['other', 'workspace']])
    cleanup()
    const here = nowOf(mount([routed()], { sessions, pending: [[SESSION, 'approval']] }).rail)
    expect(within(here).getByText('等你回答（对话「稀疏注意力」）')).toBeTruthy()
    expect(within(here).queryByRole('button', { name: zh.nowJump })).toBeNull()
    cleanup()
    // A blank conversation goes by 新对话; a failed open says why in place.
    const blank = mount([routed()], {
      sessions: [session(SESSION), session('fresh', { blank: true })], pending: [['fresh', 'question']],
      openConversation: () => Promise.reject(new Error('not listed')),
    }).rail
    expect(within(nowOf(blank)).getByText('等你回答（对话「新对话」）')).toBeTruthy()
    fireEvent.click(within(nowOf(blank)).getByRole('button', { name: zh.nowJump }))
    await settle()
    expect(within(nowOf(blank)).getByRole('alert').textContent).toBe(t('actionFailed', { reason: 'not listed' }))
  })

  it('says the assistant is working on the current phase in a conversation, or on the research without phases', () => {
    const driving = routed()
    driving.goals = [goal('other', 'active')]
    const sessions = [session(SESSION), session('other', { displayTitle: '写作' })]
    const now = nowOf(mount([driving], { sessions }).rail)
    expect(within(now).getByText('助手正在推进：引用（对话「写作」）').className).toContain('nowOngoing')
    expect(within(now).queryByRole('button')).toBeNull()
    cleanup()
    const general = project()
    general.goals = [goal('gone', 'active')]
    expect(within(nowOf(mount([general]).rail)).getByText('助手正在推进（对话「新对话」）')).toBeTruthy()
  })

  it('says how many runs are running and opens the board', () => {
    const busy = routed()
    busy.experiments.push(run('a', 'running'), run('b', 'queued'))
    const { rail, log } = mount([busy])
    expect(within(nowOf(rail)).getByText('1 个实验运行中')).toBeTruthy()
    fireEvent.click(within(nowOf(rail)).getByRole('button', { name: zh.nowOpenBoard }))
    expect(log.tabs).toEqual(['board'])
    cleanup()
    const twice = routed()
    twice.experiments.push(run('a', 'running'), run('b', 'running'))
    expect(within(nowOf(mount([twice]).rail)).getByText('2 个实验运行中')).toBeTruthy()
  })

  it('says the assistant waits for the person in a blocked goal\'s conversation', async () => {
    const blocked = routed()
    blocked.goals = [goal('other', 'blocked')]
    const { rail, log } = mount([blocked], { sessions: [session(SESSION), session('other', { displayTitle: '实验' })] })
    expect(within(nowOf(rail)).getByText('助手在等你：见对话「实验」')).toBeTruthy()
    fireEvent.click(within(nowOf(rail)).getByRole('button', { name: zh.nowJump }))
    await settle()
    expect(log.conversations).toEqual([['other', 'workspace']])
  })

  it('names the next phase and what it lacks, and suggests continuing it in the conversation', () => {
    const { rail, log } = mount([routed()], { draft: '' })
    const now = nowOf(rail)
    expect(within(now).getByText('下一步：引用 — 还没有参考文献库')).toBeTruthy()
    fireEvent.click(within(now).getByRole('button', { name: '在对话中提出：继续：引用' }))
    expect(log.drafts).toEqual(['继续：引用'])
    expect(log.commands).toEqual([])
    cleanup()
    const bare = routed()
    bare.standing = { ...bare.standing!, hint: undefined }
    expect(within(nowOf(mount([bare]).rail)).getByText('下一步：引用')).toBeTruthy()
  })

  it('says a deferred end, a finished paper, a research never checked and one that needs another check', () => {
    const deferred = project('spark-to-paper', 'proposal')
    deferred.standing = standingOf([['plan', 'done'], ['experiments', 'deferred']], { checkedAt: new Date().toISOString() })
    const held = within(nowOf(mount([deferred]).rail))
    expect(held.getByText('实验已推迟：结果格保留「--」，等你补上结果后继续').className).toContain('nowWarn')
    expect(held.queryByRole('button')).toBeNull()
    cleanup()
    const finished = project('spark-to-paper', 'proposal')
    finished.standing = standingOf([['plan', 'done']], { checkedAt: new Date().toISOString(), finished: true })
    const { rail, log } = mount([finished])
    const done = nowOf(rail)
    expect(within(done).getByText(zh.nowFinished, { exact: false }).textContent).toBe(`${zh.nowFinished} ✓`)
    fireEvent.click(within(done).getByRole('button', { name: `在对话中提出：${zh.nowExport}` }))
    expect(log.drafts).toEqual([zh.nowExport])
    cleanup()
    const unchecked = project('spark-to-paper', 'proposal')
    unchecked.standing = standingOf([['plan', 'current'], ['cite', 'pending']])
    const never = within(nowOf(mount([unchecked]).rail))
    expect(never.getByText(zh.nowUnchecked)).toBeTruthy()
    expect(never.getByRole('button', { name: `在对话中提出：${zh.nowCheck}` })).toBeTruthy()
    cleanup()
    const recheck = project('spark-to-paper', 'proposal')
    recheck.standing = standingOf([['plan', 'done']], { checkedAt: new Date().toISOString() })
    const again = within(nowOf(mount([recheck]).rail))
    expect(again.getByText(zh.nowRecheck)).toBeTruthy()
    expect(again.getByRole('button', { name: `在对话中提出：${zh.nowCheck}` })).toBeTruthy()
  })

  it('says the general mode is asked in the conversation, offers an example nothing to say, and says nothing for a pack before its standing', () => {
    expect(within(nowOf(mount([project()]).rail)).getByText(zh.nowGeneral)).toBeTruthy()
    cleanup()
    const shipped = routed()
    shipped.example = true
    expect(within(nowOf(mount([shipped]).rail)).queryByRole('button')).toBeNull()
    cleanup()
    expect(mount([project('spark-to-paper', 'proposal')]).rail.queryByText(zh.nowTitle)).toBeNull()
  })
})

describe('the record reads where the paper stands', () => {
  it('marks each phase done, current, not started or deferred, with the current phase\'s hint and the checkpoint note', () => {
    const routed = project('spark-to-paper', 'proposal')
    routed.standing = standingOf([['plan', 'done'], ['cite', 'current'], ['experiments', 'deferred'], ['submission', 'pending']], {
      checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      hint: { en: 'There is no bibliography of verified sources yet', zh: '还没有核实过的参考文献库' },
    })
    const { rail } = mount([routed])
    expect(rail.getByText(zh.phasesTitle)).toBeTruthy()
    expect(rail.getByText('规划')).toBeTruthy()
    // Each mark says what it means; done is a check mark, the current phase a ring.
    expect(rail.getAllByRole('img').map(mark => [mark.tagName.toLowerCase(), mark.getAttribute('aria-label')])).toEqual([
      ['svg', zh.phaseDone], ['span', zh.phaseCurrent], ['span', zh.phaseDeferred], ['span', zh.phasePending],
    ])
    // The caption is the pack's own sentence, never the words a check wrote for the assistant.
    expect(rail.getAllByText('还没有核实过的参考文献库')).toHaveLength(1)
    expect(rail.getByText(zh.phaseDeferred, { selector: 'span:not([role])' })).toBeTruthy()
    expect(rail.getAllByText(zh.phaseCheckpoint)).toHaveLength(1)
    expect(rail.getByText('检查于 5 分钟前')).toBeTruthy()
    expect(rail.queryByText(zh.changedSinceCheck, { exact: false })).toBeNull()
    cleanup()
    // Without a hint the current phase carries no caption.
    const bare = project('spark-to-paper', 'proposal')
    bare.standing = standingOf([['plan', 'current']], { checkedAt: new Date().toISOString() })
    const quiet = mount([bare]).rail
    expect(quiet.container.querySelectorAll('li span').length).toBe(3)
  })

  it('says when the research was last checked and whether a file changed since, and nothing before a check', () => {
    const routed = project('spark-to-paper', 'proposal')
    routed.standing = standingOf([['plan', 'current']], { checkedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), changedSinceCheck: true })
    const changed = mount([routed]).rail
    expect(changed.getByText(/^检查于 2 小时前/)).toBeTruthy()
    expect(changed.getByText(zh.changedSinceCheck, { exact: false })).toBeTruthy()
    cleanup()
    // Too many files to tell says nothing.
    routed.standing = standingOf([['plan', 'current']], { checkedAt: new Date().toISOString(), changedSinceCheck: 'unknown' })
    expect(mount([routed]).rail.queryByText(zh.changedSinceCheck, { exact: false })).toBeNull()
    cleanup()
    const unchecked = project('spark-to-paper', 'proposal')
    unchecked.standing = standingOf([['plan', 'current'], ['cite', 'pending']])
    const never = mount([unchecked]).rail
    expect(never.queryByText(/^检查于/)).toBeNull()
    expect(never.queryByText(zh.issuesTitle)).toBeNull()
    cleanup()
    // Before the first snapshot carries a standing nothing is shown.
    expect(mount([project('spark-to-paper', 'proposal')]).rail.queryByRole('img')).toBeNull()
  })

  it('lists at most three groups of open issues in the reader\'s language, each opening its file only when it exists', async () => {
    const routed = project('spark-to-paper', 'proposal')
    const finding = (check: string, severity: 'error' | 'warning', message: string, file?: string, line?: number) =>
      ({ check, severity, message, ...(file === undefined ? {} : { file }), ...(line === undefined ? {} : { line }) })
    routed.standing = standingOf([['plan', 'current']], {
      checkedAt: new Date().toISOString(),
      issues: [
        { check: 'cite', label: { en: 'Citations', zh: '引用' }, errors: 2, warnings: 1, file: 'paper/main.tex', line: 12, findings: [
          finding('cite', 'error', 'Citation key has no bibliography entry: x', 'paper/main.tex', 12),
          finding('cite', 'error', 'Incomplete bibliography entry y', 'paper/refs.bib'),
          finding('cite', 'warning', 'Not verified'),
        ] },
        { check: 'submission-checks', label: { en: 'Submission checks', zh: '投稿检查' }, errors: 1, warnings: 0, findings: [
          finding('submission-checks', 'error', 'submission/checks.md is missing'),
        ] },
        { check: 'review', label: { en: 'Review', zh: '评审' }, errors: 0, warnings: 1, findings: [finding('review', 'warning', 'No review yet')] },
        { check: 'prose', label: { en: 'Prose', zh: '行文' }, errors: 0, warnings: 4, findings: [finding('prose', 'warning', 'hidden fourth group')] },
      ],
    })
    const { rail, log } = mount([routed])
    expect(rail.getByText(zh.issuesTitle)).toBeTruthy()
    // A group whose file exists opens it; one without a file is only named.
    const cite = rail.getByRole('button', { name: '引用 · 2 个错误 · 1 个提醒' })
    expect(cite.getAttribute('title')).toBe('打开 paper/main.tex')
    expect(rail.getByText('投稿检查 · 1 个错误').tagName.toLowerCase()).toBe('span')
    expect(rail.getByText('评审 · 1 个提醒')).toBeTruthy()
    expect(rail.queryByText(/^行文/)).toBeNull()
    // The checks' own words wait behind Details, with where each one points.
    expect(rail.getAllByText(zh.issueDetails)).toHaveLength(3)
    expect(rail.getByText('Citation key has no bibliography entry: x').closest('details')).toBeTruthy()
    expect(rail.getByText('paper/main.tex:12', { exact: false })).toBeTruthy()
    expect(rail.getByText('paper/refs.bib', { exact: false })).toBeTruthy()
    fireEvent.click(cite)
    await settle()
    expect(log.opened).toEqual([[ROOT, 'paper/main.tex']])
    cleanup()
    // A general project has no phases: its issues carry the time of the check, and a clean check says so.
    const general = project()
    general.standing = standingOf([], { checkedAt: new Date().toISOString() })
    const clean = mount([general]).rail
    expect(clean.getByText(zh.issuesNone)).toBeTruthy()
    expect(clean.getByText(zh.checkedJustNow)).toBeTruthy()
  })

  it('says why an issue\'s file could not be opened', async () => {
    const routed = project('spark-to-paper', 'proposal')
    routed.standing = standingOf([['plan', 'current']], {
      checkedAt: new Date().toISOString(),
      issues: [{ check: 'compile', label: { en: 'Compile', zh: '编译' }, errors: 1, warnings: 0, file: 'paper/main.tex', findings: [
        { check: 'compile', severity: 'error', message: 'The paper has not been compiled yet', file: 'paper/main.tex' },
      ] }],
    })
    const { rail } = mount([routed], { openFile: () => { throw new Error('no sidebar') } })
    expect(rail.queryByRole('alert')).toBeNull()
    fireEvent.click(rail.getByRole('button', { name: '编译 · 1 个错误' }))
    await settle()
    expect(rail.getByRole('alert').textContent).toBe(t('actionFailed', { reason: 'no sidebar' }))
  })

  it('lists the three newest decisions with who made them, and the mode decision by its mode and route names', () => {
    const routed = project('spark-to-paper')
    const { rail } = mount([routed])
    expect(rail.getByText(zh.noDecisions)).toBeTruthy()
    cleanup()
    for (let index = 0; index < 4; index++) {
      routed.decisions.push({ id: `d${index}`, question: `Q${index}`, answer: `A${index}`, by: index % 2 === 0 ? 'user' : 'agent', rationale: 'because data', at: '' })
    }
    routed.decisions.push({ id: 'mode', question: '模式与路线', answer: 'spark-to-paper · data', by: 'user', rationale: 'measured', at: '', key: 'mode' })
    const next = mount([routed]).rail
    expect(next.queryByText(zh.noDecisions)).toBeNull()
    expect(next.queryByText('A1')).toBeNull()
    expect(next.getByText(`${zh.decisionByUser} · ${zh.decisionModeQuestion}`)).toBeTruthy()
    expect(next.getByText('spark-to-paper · 从实测结果开始')).toBeTruthy()
    expect(next.getByText(`${zh.decisionByAgent} · Q3`)).toBeTruthy()
    expect(next.getByText(`${zh.decisionByUser} · Q2`)).toBeTruthy()
    // The rationale is the assistant's; the record lists what was decided.
    expect(next.queryByText('because data')).toBeNull()
    cleanup()
    // A pack no longer installed, a route it does not know and a decision without a route keep their ids.
    routed.decisions.push(
      { id: 'm1', question: '模式与路线', answer: 'spark-to-paper · sideways', by: 'agent', rationale: '', at: '', key: 'mode' },
      { id: 'm2', question: '模式与路线', answer: 'retired-pack', by: 'agent', rationale: '', at: '', key: 'mode' },
    )
    const kept = mount([routed]).rail
    expect(kept.getByText('spark-to-paper · sideways')).toBeTruthy()
    expect(kept.getByText('retired-pack')).toBeTruthy()
  })
})

describe('the record counts what the research holds and opens its tools', () => {
  it('counts sources, claims, files and runs by the names of their tabs, each opening its tab beside the conversation', async () => {
    const routed = project('spark-to-paper')
    routed.evidence.push({ id: 'e' as EvidenceId, title: 't', kind: 'file', path: 'p', sha256: 's', revision: 1, importedAt: '', chunks: [], coverage: 'data', verified: true, stale: true })
    routed.experiments.push(run('done', 'completed'), run('waiting', 'queued'))
    const { rail, log } = mount([routed])
    expect(rail.getByText('1 待更新')).toBeTruthy()
    expect(rail.getByTitle(zh.railExperimentsLabel).textContent).toBe(`${zh.railExperimentsLabel}${zh.runRunning}2`)
    for (const label of [zh.sourcesTab, zh.claims, zh.railFilesLabel, zh.railExperimentsLabel]) fireEvent.click(rail.getByTitle(label))
    await settle()
    // Claims open the Sources tab scrolled to them, runs the board, and files the research folder's file tab once its action runs.
    expect(log.tabs).toEqual(['sources', 'sources:claims', 'board', 'files'])
    cleanup()
    // Nothing stale and nothing moving: the rows carry no tags.
    const quiet = project('spark-to-paper')
    quiet.experiments.push(run('done', 'completed'))
    const calm = mount([quiet]).rail
    expect(calm.getByTitle(zh.sourcesTab).textContent).toBe(`${zh.sourcesTab}0`)
    expect(calm.getByTitle(zh.railFilesLabel).textContent).toBe(`${zh.railFilesLabel}0`)
    expect(calm.getByTitle(zh.railExperimentsLabel).textContent).toBe(`${zh.railExperimentsLabel}1`)
  })

  it('calls runs running only while one is being started or running, and says 状态待确认 in the needs-you colour for one whose launch reply was lost', () => {
    const routed = project('spark-to-paper')
    routed.experiments.push(run('done', 'completed'), run('lost', 'unknown'))
    const unsure = mount([routed]).rail.getByTitle(zh.railExperimentsLabel)
    expect(unsure.textContent).toBe(`${zh.railExperimentsLabel}${zh.unknown}2`)
    expect(within(unsure).getByText(zh.unknown).className).toContain('unconfirmedTag')
    expect(within(unsure).queryByText(zh.runRunning)).toBeNull()
    cleanup()
    // A running run beside it keeps its own tag, in the ongoing colour.
    routed.experiments.push(run('going', 'running'))
    const row = mount([routed]).rail.getByTitle(zh.railExperimentsLabel)
    expect(row.textContent).toBe(`${zh.railExperimentsLabel}${zh.unknown}${zh.runRunning}3`)
    expect(within(row).getByText(zh.runRunning).className).toContain('runningTag')
  })

  it('shows the runs row only on a route with an experiments phase, or once a run exists', () => {
    // A route that plans experiments says none has started yet.
    expect(mount([project('spark-to-paper', 'proposal')]).rail.getByTitle(zh.railExperimentsLabel).textContent).toBe(`${zh.railExperimentsLabel}${zh.railNotStarted}`)
    cleanup()
    expect(mount([project('spark-to-paper', 'data')]).rail.queryByTitle(zh.railExperimentsLabel)).toBeNull()
    cleanup()
    expect(mount([project()]).rail.queryByTitle(zh.railExperimentsLabel)).toBeNull()
    cleanup()
    // A run the assistant registered anyway is part of the record.
    const general = project()
    general.experiments.push(run('probe', 'failed'))
    expect(mount([general]).rail.getByTitle(zh.railExperimentsLabel).textContent).toBe(`${zh.railExperimentsLabel}1`)
  })

  it('opens the experiment board, the figure gallery and the research files from its tools row', async () => {
    const { rail, log } = mount([project()])
    fireEvent.click(rail.getByRole('button', { name: zh.boardTitle }))
    fireEvent.click(rail.getByRole('button', { name: zh.gallery }))
    fireEvent.click(rail.getByRole('button', { name: zh.researchFiles }))
    await settle()
    expect(log.tabs).toEqual(['board', 'gallery', 'files'])
    expect(rail.queryByRole('alert')).toBeNull()
  })

  it('says why the research files could not be shown, from the files count and from the tools row', async () => {
    const { rail } = mount([project()], { openFiles: () => { throw new Error('no sidebar') } })
    fireEvent.click(rail.getByTitle(zh.railFilesLabel))
    fireEvent.click(rail.getByRole('button', { name: zh.researchFiles }))
    await settle()
    expect(rail.getAllByRole('alert').map(line => line.textContent)).toEqual([
      t('actionFailed', { reason: 'no sidebar' }), t('actionFailed', { reason: 'no sidebar' }),
    ])
  })
})

describe('the record says when the research assistant is not in use', () => {
  const composed = (preset: string | null): SessionSummary[] => [session(SESSION, { projectionValues: { agentPreset: preset } })]

  it('says a conversation composed from another preset has no research tools, and that a new one will', () => {
    const { rail } = mount([project()], { sessions: composed('standard') })
    expect(rail.getByRole('note').textContent).toBe(zh.legacyConversation)
    cleanup()
    // The research assistant's own conversation, one whose preset is unknown and an example say nothing.
    expect(mount([project()], { sessions: composed('research') }).rail.queryByRole('note')).toBeNull()
    cleanup()
    expect(mount([project()], { sessions: composed(null) }).rail.queryByRole('note')).toBeNull()
    cleanup()
    const shipped = project()
    shipped.example = true
    expect(mount([shipped], { sessions: composed('standard'), presets: { research: 'research', saved: 'standard' } }).rail.queryByRole('note')).toBeNull()
    cleanup()
    // Before the settings are read nothing is said.
    expect(mount([project()], { sessions: composed('standard'), presets: null }).rail.queryByRole('note')).toBeNull()
  })

  it('says new conversations use a saved default preset, and puts the research assistant back', async () => {
    const { rail, log } = mount([project()], { sessions: composed('standard'), presets: { research: 'research', saved: 'standard' } })
    const note = rail.getByRole('note')
    expect(within(note).getByText(zh.legacyConversationStale)).toBeTruthy()
    expect(within(note).getByText('新对话会使用「standard」而不是科研助手：设置里把它存成了默认。')).toBeTruthy()
    fireEvent.click(within(note).getByRole('button', { name: zh.legacyReset }))
    await settle()
    expect(log.resets).toBe(1)
    expect(within(note).queryByRole('alert')).toBeNull()
    cleanup()
    // In a research assistant's conversation the saved default is said alone; a refused reset says why.
    const kept = mount([project()], {
      sessions: composed('research'), presets: { research: 'research', saved: 'standard' },
      resetDefaultPreset: () => Promise.reject(new Error(zh.legacyResetUnchanged)),
    }).rail
    const alone = kept.getByRole('note')
    expect(within(alone).queryByText(zh.legacyConversationStale)).toBeNull()
    fireEvent.click(within(alone).getByRole('button', { name: zh.legacyReset }))
    await settle()
    expect(within(alone).getByRole('alert').textContent).toBe(t('actionFailed', { reason: zh.legacyResetUnchanged }))
  })
})
