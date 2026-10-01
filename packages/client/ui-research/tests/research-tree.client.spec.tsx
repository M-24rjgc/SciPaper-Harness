// @vitest-environment jsdom

/**
 * The sidebar's research tree as the person uses it: what each row says and
 * where a click, a key or a menu row takes them, the dialogs the menus open,
 * the search over names and conversation text, and the collapsed rail. The
 * lists and the record are plain values a test changes between renders; the
 * viewing store is the real one, and every command the tree sends is handed
 * to the validator the service parses commands with.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { publicProject } from '@deepseek-ai/dsh-research-workbench/src/index.ts'
import { initializeResearchExamples } from '@deepseek-ai/dsh-research-workbench/src/examples.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type { CreateProjectRequest, ResearchCommand, ResearchProject, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import { ResearchTree, searchable, type ResearchTreeProps } from '../src/client/ResearchTree.tsx'
import { createResearchTreeStore } from '../src/client/treeStore.ts'
import { SshWorkspaceError, type ResearchView, type SshAuthChoice } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'
import { MODES } from './fixtures/modes.ts'
import { standingOf } from './fixtures/standing.ts'

const roots: string[] = []
afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** The Chinese dictionary, interpolating `{name}` the way the locale seat does. */
function t(key: string, params?: Record<string, unknown>): string {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}

const day = (n: number): number => Date.parse(`2026-09-${String(n).padStart(2, '0')}T08:00:00.000Z`)
const iso = (n: number): string => new Date(day(n)).toISOString()

function research(title: string, root: string, workspaceId: string, extra: Partial<ResearchProject> = {}): ResearchProject {
  return { ...newProject({ title, root, brief: '' }, workspaceId as WorkspaceId), updatedAt: iso(1), ...extra }
}

function session(id: string, cwd: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id: id as SessionId, displayTitle: id, cwd, execution: { kind: 'local' }, running: false, retainedBy: {}, blank: false, updatedAt: day(2), ...extra }
}

function workspace(id: string, path: string, title = path): WorkspaceView {
  return { workspaceId: id as WorkspaceId, path, location: { kind: 'local', path }, title, sessionIds: [], createdAt: iso(1), updatedAt: iso(1) }
}

const draft = research('新研究', '/home/SciPaper/2026-09-26-1', 'w-draft', { draft: true, untitled: true, updatedAt: iso(26) })
const sparse = research('块稀疏注意力', '/r/sparse', 'w-sparse', {
  mode: 'spark-to-paper', updatedAt: iso(20), standing: standingOf([['plan', 'done'], ['cite', 'current'], ['experiments', 'pending']]),
})
const long = research('长上下文', '/r/long', 'w-long', { updatedAt: iso(10) })
const quiet = research('未登记的研究', '/r/quiet', 'w-quiet', { updatedAt: iso(5) })
const example = research('示例：摘要评测', '/demo/x', 'w-x', { example: true })
const bare = research('空示例', '/demo/y', 'w-y', { example: true })

const SESSIONS: SessionSummary[] = [
  session('s-cite', '/r/sparse', { displayTitle: '引用核对', updatedAt: day(25), running: true }),
  session('s-plan', '/r/sparse', { displayTitle: '规划', updatedAt: day(24) }),
  session('s-draft', '/home/SciPaper/2026-09-26-1', { blank: true, updatedAt: day(26) }),
  session('s-example', '/demo/x', { displayTitle: '示例对话', updatedAt: day(3) }),
  session('s-legacy', '/legacy', { displayTitle: '旧笔记' }),
  session('s-loose', '/elsewhere', { displayTitle: '零散想法' }),
]

const WORKSPACES: WorkspaceView[] = [
  workspace('w-draft', '/home/SciPaper/2026-09-26-1'), workspace('w-sparse', '/r/sparse'), workspace('w-long', '/r/long'),
  workspace('w-x', '/demo/x'), workspace('w-y', '/demo/y'), { ...workspace('w-legacy', '/legacy', 'legacy'), sessionIds: ['s-legacy' as SessionId] },
]

/** What the tree reads, which a test may change between renders. */
interface World {
  drafts?: Record<string, { text: string; attachmentCount: number }>
  projects?: ResearchProject[] | null
  sessions?: SessionSummary[]
  current?: string | undefined
  workspaces?: WorkspaceView[]
  pending?: [string, string][]
  panel?: string | null
  canReveal?: boolean
  showExamples?: boolean
  wide?: boolean
}

function propsOf(w: World, face: ReturnType<typeof faceOf>, store: ReturnType<ReturnType<typeof createResearchTreeStore>['create']>): ResearchTreeProps {
  const sessions = w.sessions ?? SESSIONS
  const list: SessionListState = {
    ids: sessions.map(item => item.id), byId: Object.fromEntries(sessions.map(item => [item.id, item])),
    projectionsBySession: {}, phase: 'ready',
  }
  const workspaces: WorkspaceSnapshot = { items: w.workspaces ?? WORKSPACES, pinnedSessionIds: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null }
  const pending = new Map((w.pending ?? [])
    .map(([id, kind]) => [id as SessionId, {
      pendingInteraction: { key: id, kind, sessionId: id as SessionId }, running: undefined, completionUnread: false,
    }]))
  const projects = w.projects === undefined ? [draft, sparse, long, quiet, example, bare] : w.projects
  const view: ResearchView = {
    snapshot: projects === null
      ? null
      : { projects, preferences: w.showExamples === undefined ? {} : { showExamples: w.showExamples }, components: [], modes: MODES },
    tasks: [],
  }
  return {
    t, wide: w.wide ?? true,
    useSessions: (select: (value: SessionListState) => unknown) => select(list),
    useCurrentSession: (select: (value: string | undefined) => unknown) => select(w.current),
    useWorkspaces: (select: (value: WorkspaceSnapshot) => unknown) => select(workspaces),
    useSessionStatus: (select: (value: unknown) => unknown) => select(pending),
    usePanelInfo: (select: (value: { activePanelId: string | null }) => unknown) => select({ activePanelId: w.panel ?? null }),
    useResearch: (select: (value: ResearchView) => unknown) => select(view),
    useDrafts: (select: (value: NonNullable<World['drafts']>) => unknown) => select(w.drafts ?? {}),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select({}),
    useCanReveal: (select: (value: boolean) => unknown) => select(w.canReveal ?? true),
    useStore: function useStore(select: (value: { expanded: Record<string, boolean> }) => unknown) {
      return useSyncExternalStore(listener => store.subscribe(listener), () => select(store.getSnapshot()))
    },
    actions: store.actions,
    ...face,
  } as unknown as ResearchTreeProps
}

function faceOf() {
  const commands: ResearchCommand[] = []
  return {
    commands,
    expandSidebar: vi.fn(),
    openSession: vi.fn(),
    openWorkspace: vi.fn((_workspaceId: string) => Promise.resolve()),
    startSession: vi.fn(),
    createSshWorkspace: vi.fn(async (_host: string, _path: string, _auth: SshAuthChoice) => 'w-ssh' as WorkspaceId),
    run: vi.fn((command: ResearchCommand): Promise<ResearchResponse> => {
      commands.push(command)
      expect(commandSchema.parse(command)).toBeTruthy()
      return Promise.resolve({ message: '' })
    }),
    create: vi.fn((request: CreateProjectRequest) => Promise.resolve(research(request.title, request.root, 'w-legacy'))),
    renameConversation: vi.fn((_sessionId: string, _title: string) => Promise.resolve()),
    archiveConversation: vi.fn((_sessionId: string) => Promise.resolve()),
    removeFolder: vi.fn((_workspaceId: string) => Promise.resolve()),
    reveal: vi.fn((_path: string) => Promise.resolve()),
    searchConversations: vi.fn((_query: string, _signal: AbortSignal) =>
      Promise.resolve({ items: [] as { sessionId: SessionId; snippet: string }[], hasMore: false })),
    searchResultLimit: 20,
  }
}

function mount(w: World = {}) {
  const face = faceOf()
  const store = createResearchTreeStore().create()
  const view = render(<ResearchTree {...propsOf(w, face, store)} />)
  return { ...view, face, store, update: (next: World) => { view.rerender(<ResearchTree {...propsOf(next, face, store)} />) } }
}

/** The row with this key. */
function row(key: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-key="${key}"]`)
  if (found === null) throw new Error(`no row ${key}`)
  return found
}

/** The keys of the rows on screen, in order. */
function keys(): (string | undefined)[] {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"][data-key]')].map(element => element.dataset.key)
}

/** The open menu's rows. */
function menuItems(): string[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(element => element.textContent)
}

function menuItem(name: string): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(element => element.textContent === name)
  if (found === undefined) throw new Error(`no menu item ${name}`)
  return found
}

/** Open a row's ⋯ menu with the pointer. */
function openMenu(key: string): void {
  fireEvent.click(within(row(key)).getByRole('button'))
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
}

const R = (project: ResearchProject): string => `research:${project.id}`

describe('what the tree lists', () => {
  it('lists initialized product examples and restores their read-only conversations when examples are shown again', async () => {
    const home = await mkdtemp(join(tmpdir(), 'research-ui-examples-'))
    roots.push(home)
    vi.stubEnv('DSH_HOME', home)
    const projects: ResearchProject[] = []
    const workspaces: WorkspaceView[] = [workspace('w-sparse', sparse.root)]
    const sessions: SessionSummary[] = []
    await initializeResearchExamples(home, resolve('packages/research/workbench/runtime/examples/v1'), {
      find: root => projects.find(project => project.root === root),
      workspace: (root, title) => {
        const folder = workspace(`w-example-${workspaces.length}`, root, title)
        workspaces.push(folder)
        return Promise.resolve(folder.workspaceId)
      },
      put: (project) => { projects.push(project); return Promise.resolve() },
      conversation: (project, material) => {
        if (project.sessionId === undefined) throw new Error('Bundled example has no conversation identity')
        sessions.push(session(project.sessionId, project.root, { displayTitle: material.question }))
        return Promise.resolve()
      },
    })
    const examples = projects.map(project => publicProject(project))
    expect(examples).toHaveLength(2)
    expect(examples.every(project => project.example === true && project.evidence.length > 0 && project.artifacts.length > 0)).toBe(true)
    const [summary, attention] = examples
    if (summary === undefined || attention === undefined || summary.sessionId === undefined || attention.sessionId === undefined) {
      throw new Error('Bundled examples have no readable conversations')
    }
    const world: World = {
      projects: [sparse, ...examples], showExamples: true, current: summary.sessionId, sessions, workspaces,
    }
    const tree = mount(world)
    expect(row('group:examples').getAttribute('aria-expanded')).toBe('true')
    expect(row(R(summary)).textContent).toContain(summary.title)
    expect(row(R(attention)).textContent).toContain(attention.title)
    expect(row(`conversation:${summary.sessionId}`).getAttribute('aria-selected')).toBe('true')
    openMenu(R(summary))
    expect(menuItems()).toEqual([zh.folderReveal])
    openMenu(R(summary))
    tree.update({ ...world, showExamples: false })
    expect(keys()).not.toContain('group:examples')
    expect(keys()).not.toContain(R(summary))
    expect(keys()).not.toContain(R(attention))
    expect(keys()).toContain(R(sparse))
    tree.update({ ...world, showExamples: true })
    expect(row(R(summary)).textContent).toContain(summary.title)
    expect(row(R(attention)).textContent).toContain(attention.title)
    expect(row(`conversation:${summary.sessionId}`).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(row(R(attention)))
    await settle()
    expect(tree.face.openSession).toHaveBeenCalledWith(attention.sessionId)
    expect(tree.face.openWorkspace).not.toHaveBeenCalled()
    expect(tree.face.startSession).not.toHaveBeenCalled()
    expect(tree.face.commands).toEqual([])
    expect(keys()).not.toContain(`add:${summary.id}`)
    expect(keys()).not.toContain(`add:${attention.id}`)
    // Installing the shipped example files takes longer than the default five seconds on a hosted Windows runner.
  }, 30000)

  it('keeps text and attachment drafts reachable while hiding empty non-current conversations', async () => {
    const world: World = {
      projects: [draft, sparse], current: 'new-draft', workspaces: WORKSPACES,
      sessions: [
        session('old-draft', '/r/sparse', { blank: true }),
        session('new-draft', '/r/sparse', { blank: true }),
        session('file-draft', '/r/sparse', { blank: true }),
        session('empty', '/r/sparse', { blank: true }),
      ],
      drafts: {
        'old-draft': { text: 'X saved before switching\nmore text', attachmentCount: 0 },
        'new-draft': { text: 'Y carried here', attachmentCount: 0 },
        'file-draft': { text: '', attachmentCount: 2 },
      },
    }
    const tree = mount(world)
    expect(row('conversation:old-draft').textContent).toContain('草稿 · X saved before switching')
    expect(row('conversation:new-draft').textContent).toContain('草稿 · Y carried here')
    expect(row('conversation:file-draft').textContent).toContain('草稿 · 2 个附件')
    expect(keys()).not.toContain('conversation:empty')
    expect(row(R(draft)).getAttribute('aria-expanded')).toBeNull()
    fireEvent.click(row('conversation:old-draft'))
    await settle()
    expect(tree.face.openSession).toHaveBeenCalledWith('old-draft')
    tree.update({ ...world, current: 'old-draft' })
    fireEvent.click(row('conversation:new-draft'))
    await settle()
    expect(tree.face.openSession).toHaveBeenLastCalledWith('new-draft')
    const remaining = { ...world.drafts }
    delete remaining['old-draft']
    tree.update({ ...world, drafts: remaining })
    expect(keys()).not.toContain('conversation:old-draft')
  })

  it('lists the draft, the person\'s researches with their standing and dots, then the examples and other folders', () => {
    const tree = mount({ current: 's-cite', pending: [['s-plan', 'question']] })
    expect(tree.getByRole('tree', { name: zh.treeTitle })).toBeTruthy()
    expect(tree.getByText(zh.treeTitle)).toBeTruthy()
    expect(keys()).toEqual([
      R(draft), R(sparse), 'conversation:s-cite', 'conversation:s-plan', `add:${sparse.id}`, R(long), R(quiet), 'group:examples', 'group:others',
    ])
    // The draft reads 新研究 in italics and opens nothing under it.
    const first = row(R(draft))
    expect(first.getAttribute('aria-expanded')).toBeNull()
    expect(within(first).getByText(zh.treeUntitled)).toBeTruthy()
    // A research names where it stands; one waiting for the person says so before its running work.
    const research = row(R(sparse))
    expect(research.getAttribute('aria-expanded')).toBe('true')
    expect(research.getAttribute('aria-level')).toBe('1')
    expect(within(research).getByText('引用 1/3')).toBeTruthy()
    expect(within(research).getByText(zh.treeWaiting)).toBeTruthy()
    expect(within(row('conversation:s-cite')).getByText(zh.treeOngoing)).toBeTruthy()
    expect(within(row('conversation:s-plan')).getByText(zh.treeWaiting)).toBeTruthy()
    // The general mode shows no standing.
    expect(row(R(long)).textContent).toBe('长上下文')
    // The conversation on screen is the selected row, and the one the tab key reaches.
    const current = row('conversation:s-cite')
    expect([current.getAttribute('aria-selected'), current.getAttribute('aria-level'), current.tabIndex]).toEqual(['true', '2', 0])
    expect(row(R(draft)).tabIndex).toBe(-1)
    expect(row('conversation:s-plan').getAttribute('aria-posinset')).toBe('2')
    expect(row('conversation:s-plan').getAttribute('aria-setsize')).toBe('3')
    const add = row(`add:${sparse.id}`)
    expect(add.getAttribute('aria-label')).toBe('在「块稀疏注意力」中新建对话')
    expect(add.textContent).toBe(zh.treeAddConversation)
    expect(row('group:examples').getAttribute('aria-expanded')).toBe('false')
  })

  it('marks examples with a dashed tag, lists nothing before the record arrives, and says so when there is nothing', () => {
    const none = mount({ projects: [draft, example], sessions: [], workspaces: [] })
    expect(keys()).toEqual([R(draft), 'group:examples', R(example)])
    expect(within(row(R(example))).getByText(zh.exampleTag)).toBeTruthy()
    none.unmount()
    const loading = mount({ projects: null, sessions: [], workspaces: [] })
    expect(keys()).toEqual([])
    expect(loading.queryByText(zh.treeEmpty)).toBeNull()
    loading.update({ projects: [], sessions: [], workspaces: [] })
    expect(loading.getByText(zh.treeEmpty)).toBeTruthy()
    // With the examples hidden, the group goes too.
    loading.update({ projects: [draft, example], sessions: [], workspaces: [], showExamples: false })
    expect(keys()).toEqual([R(draft)])
  })

  it('selects nothing while a panel covers the conversation, and selects the draft while its blank conversation is on screen', () => {
    const covered = mount({ current: 's-cite', panel: 'research' })
    expect(document.querySelector('[aria-selected="true"]')).toBeNull()
    // Nothing selected: the first row is the one the tab key reaches.
    expect(row(R(draft)).tabIndex).toBe(0)
    covered.update({ current: 's-draft' })
    expect(row(R(draft)).getAttribute('aria-selected')).toBe('true')
  })
})

describe('where a click goes', () => {
  it('opens a research on its newest started conversation, or its blank one, and toggles the one on screen', async () => {
    const tree = mount({ current: 's-draft' })
    fireEvent.click(row(R(sparse)))
    await settle()
    expect(tree.face.openSession).toHaveBeenLastCalledWith('s-cite')
    expect(tree.store.getSnapshot().expanded[R(sparse)]).toBe(true)
    // A research whose conversations have not started opens its folder's blank conversation.
    fireEvent.click(row(R(long)))
    await settle()
    expect(tree.face.openWorkspace).toHaveBeenLastCalledWith('w-long')
    // One whose folder is gone from the list opens nothing, and only unfolds.
    fireEvent.click(row(R(quiet)))
    await settle()
    expect(tree.face.openWorkspace).toHaveBeenCalledTimes(1)
    expect(row(R(quiet)).getAttribute('aria-expanded')).toBe('true')
    // The research on screen folds and unfolds without going anywhere.
    tree.update({ current: 's-cite' })
    fireEvent.click(row(R(sparse)))
    await settle()
    expect(row(R(sparse)).getAttribute('aria-expanded')).toBe('false')
    expect(tree.face.openSession).toHaveBeenCalledTimes(1)
  })

  it('opens the draft\'s blank conversation unless it is on screen or its folder is gone', async () => {
    const tree = mount({ current: 's-cite' })
    fireEvent.click(row(R(draft)))
    await settle()
    expect(tree.face.openWorkspace).toHaveBeenCalledWith('w-draft')
    tree.update({ current: 's-draft' })
    fireEvent.click(row(R(draft)))
    await settle()
    tree.update({ current: 's-cite', workspaces: WORKSPACES.filter(item => item.workspaceId !== 'w-draft') })
    fireEvent.click(row(R(draft)))
    await settle()
    expect(tree.face.openWorkspace).toHaveBeenCalledTimes(1)
  })

  it('opens an example on its conversation, and makes none in an example that has none', async () => {
    const tree = mount({ projects: [draft, example, bare] })
    fireEvent.click(row(R(example)))
    await settle()
    expect(tree.face.openSession).toHaveBeenCalledWith('s-example')
    // An example's conversations are read only: no ＋ 新对话 under it.
    expect(keys()).toContain('conversation:s-example')
    expect(keys().some(key => key?.startsWith('add:'))).toBe(false)
    fireEvent.click(row(R(bare)))
    await settle()
    expect(tree.face.openWorkspace).not.toHaveBeenCalled()
  })

  it('opens a conversation, starts ＋ 新对话 in its research, folds the groups, and says why an open failed', async () => {
    const tree = mount({ current: 's-cite' })
    fireEvent.click(row('conversation:s-plan'))
    await settle()
    expect(tree.face.openSession).toHaveBeenCalledWith('s-plan')
    fireEvent.click(row(`add:${sparse.id}`))
    await settle()
    expect(tree.face.startSession).toHaveBeenCalledWith('w-sparse')
    fireEvent.click(row('group:others'))
    await settle()
    expect(keys().slice(-3)).toEqual(['group:others', 'folder:w-legacy', 'group:loose'])
    fireEvent.click(row('folder:w-legacy'))
    fireEvent.click(row('group:loose'))
    await settle()
    expect(keys().slice(-4)).toEqual(['folder:w-legacy', 'conversation:s-legacy', 'group:loose', 'conversation:s-loose'])
    tree.face.openWorkspace.mockRejectedValueOnce(new Error('那个文件夹不见了'))
    fireEvent.click(row(R(long)))
    await settle()
    expect(within(row(R(long))).getByRole('alert').textContent).toBe(t('actionFailed', { reason: '那个文件夹不见了' }))
  })
})

describe('the keyboard', () => {
  const press = (key: string, extra: Partial<KeyboardEventInit> = {}): void => {
    fireEvent.keyDown(document.activeElement!, { key, ...extra })
  }

  it('moves between rows, opens, closes, goes to the parent, and activates', async () => {
    const tree = mount({ current: 's-cite', projects: [draft, sparse, long, example, bare] })
    row(R(draft)).focus()
    press('ArrowUp')
    expect(document.activeElement).toBe(row(R(draft)))
    press('ArrowDown')
    expect(document.activeElement).toBe(row(R(sparse)))
    // The focused row is the one in the tab order now.
    expect(row(R(sparse)).tabIndex).toBe(0)
    press('End')
    expect(document.activeElement).toBe(row('group:others'))
    press('ArrowDown')
    expect(document.activeElement).toBe(row('group:others'))
    press('Home')
    expect(document.activeElement).toBe(row(R(draft)))
    // A leaf neither opens nor has a parent to go to.
    press('ArrowRight')
    press('ArrowLeft')
    expect(document.activeElement).toBe(row(R(draft)))
    row('group:examples').focus()
    press('ArrowRight')
    expect(row('group:examples').getAttribute('aria-expanded')).toBe('true')
    press('ArrowRight')
    expect(document.activeElement).toBe(row(R(example)))
    press('ArrowLeft')
    expect(document.activeElement).toBe(row('group:examples'))
    // An open row without anything under it keeps the focus.
    row(R(bare)).focus()
    press('ArrowRight')
    expect(row(R(bare)).getAttribute('aria-expanded')).toBe('true')
    press('ArrowRight')
    expect(document.activeElement).toBe(row(R(bare)))
    row('group:examples').focus()
    press('ArrowLeft')
    expect(row('group:examples').getAttribute('aria-expanded')).toBe('false')
    // Enter and Space do what a click does; any other key is left alone.
    row('conversation:s-plan').focus()
    press('Enter')
    await settle()
    expect(tree.face.openSession).toHaveBeenLastCalledWith('s-plan')
    row(`add:${sparse.id}`).focus()
    press(' ')
    await settle()
    expect(tree.face.startSession).toHaveBeenCalledWith('w-sparse')
    press('a')
    expect(document.activeElement).toBe(row(`add:${sparse.id}`))
  })

  it('opens a row\'s menu from the keyboard and comes back to the row, and leaves keys inside the row\'s own controls alone', async () => {
    const tree = mount({ current: 's-cite' })
    const target = row(R(sparse))
    target.focus()
    press('F10')
    expect(menuItems()).toEqual([])
    press('ContextMenu')
    expect(menuItems()).toEqual([zh.treeRename, zh.folderReveal, zh.treeRemove])
    expect(document.activeElement).toBe(menuItem(zh.treeRename))
    // Keys inside the menu are the menu's.
    press('ArrowDown')
    expect(document.activeElement).toBe(menuItem(zh.folderReveal))
    fireEvent.keyDown(document, { key: 'Escape' })
    await settle()
    expect(menuItems()).toEqual([])
    expect(document.activeElement).toBe(target)
    press('F10', { shiftKey: true })
    fireEvent.click(menuItem(zh.treeRemove))
    await settle()
    expect(tree.face.commands).toEqual([{ action: 'archive-project', projectId: sparse.id }])
    expect(document.activeElement).toBe(target)
    // The ⋯ button's own keys and focus are not the row's.
    const more = within(target).getByRole('button')
    more.focus()
    fireEvent.keyDown(more, { key: 'ArrowDown' })
    fireEvent.keyDown(more, { key: 'Enter' })
    expect(document.activeElement).toBe(more)
    // A row without a menu opens none.
    row('group:examples').focus()
    press('ContextMenu')
    expect(menuItems()).toEqual([])
  })
})

describe('the row menus', () => {
  it('adds an SSH workspace from the research sidebar and opens its first conversation', async () => {
    const tree = mount()
    fireEvent.click(tree.getByRole('button', { name: zh.treeSshAdd }))
    const dialog = tree.getByRole('dialog', { name: zh.treeSshTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: zh.treeSshHost }), { target: { value: 'lab' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: zh.treeSshPath }), { target: { value: '/home/research' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
    await settle()
    expect(tree.face.createSshWorkspace).toHaveBeenCalledWith('lab', '/home/research', { kind: 'key' })
    expect(tree.face.openWorkspace).toHaveBeenCalledWith('w-ssh')
    expect(tree.queryByRole('dialog')).toBeNull()
  })

  /** Open the dialog and fill what the person typed; `fields` leaves the rest empty. */
  function openSshDialog(tree: ReturnType<typeof mount>, fields: { host?: string; port?: string; path?: string; password?: string } = {}) {
    fireEvent.click(tree.getByRole('button', { name: zh.treeSshAdd }))
    const dialog = tree.getByRole('dialog', { name: zh.treeSshTitle })
    if (fields.password !== undefined) fireEvent.change(within(dialog).getByRole('combobox', { name: zh.treeSshAuth }), { target: { value: 'password' } })
    if (fields.host !== undefined) fireEvent.change(within(dialog).getByRole('textbox', { name: zh.treeSshHost }), { target: { value: fields.host } })
    if (fields.port !== undefined) fireEvent.change(within(dialog).getByRole('textbox', { name: zh.treeSshPort }), { target: { value: fields.port } })
    if (fields.path !== undefined) fireEvent.change(within(dialog).getByRole('textbox', { name: zh.treeSshPath }), { target: { value: fields.path } })
    if (fields.password !== undefined) {
      fireEvent.change(within(dialog).getByLabelText(zh.treeSshPassword), { target: { value: fields.password } })
    }
    return dialog
  }

  it('offers key login by default and shows a password field only for the password login', () => {
    const tree = mount()
    const dialog = openSshDialog(tree)
    const login = within(dialog).getByRole<HTMLSelectElement>('combobox', { name: zh.treeSshAuth })
    expect(login.value).toBe('key')
    expect(within(dialog).getAllByRole('option').map(option => option.textContent)).toEqual([zh.treeSshAuthKey, zh.treeSshAuthPassword])
    expect(within(dialog).queryByLabelText(zh.treeSshPassword)).toBeNull()
    expect(within(dialog).getByText(zh.treeSshHintKey)).toBeTruthy()
    fireEvent.change(login, { target: { value: 'password' } })
    const password = within(dialog).getByLabelText<HTMLInputElement>(zh.treeSshPassword)
    expect(password.type).toBe('password')
    expect(password.autocomplete).toBe('off')
    expect(within(dialog).getByText(zh.treeSshHintPassword)).toBeTruthy()
    expect(within(dialog).queryByText(zh.treeSshHintKey)).toBeNull()
    fireEvent.change(login, { target: { value: 'key' } })
    expect(within(dialog).queryByLabelText(zh.treeSshPassword)).toBeNull()
  })

  it('sends user@host with its port and the typed password, and never shows the password again', async () => {
    const tree = mount()
    const dialog = openSshDialog(tree, { host: ' alice@192.0.2.10 ', port: ' 2222 ', path: ' /home/research ', password: ' pa ss ' })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
    await settle()
    expect(tree.face.createSshWorkspace).toHaveBeenCalledWith(
      'alice@192.0.2.10:2222', '/home/research', { kind: 'password', password: ' pa ss ' },
    )
    expect(tree.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).not.toContain('pa ss')
  })

  it('leaves the port off when none is typed', async () => {
    const tree = mount()
    const dialog = openSshDialog(tree, { host: 'alice@lab', path: '/home/research', password: 'pw' })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
    await settle()
    expect(tree.face.createSshWorkspace).toHaveBeenCalledWith('alice@lab', '/home/research', { kind: 'password', password: 'pw' })
  })

  it.each([
    ['a blank host', { host: '   ', path: '/p' }, zh.treeSshInvalid],
    ['a relative path', { host: 'lab', path: 'p' }, zh.treeSshInvalid],
    ['a port inside the host', { host: 'lab:22', path: '/p' }, zh.treeSshHostInvalid],
    ['an option-like host', { host: '-oProxyCommand=x', path: '/p' }, zh.treeSshHostInvalid],
    ['a port that is not a number', { host: 'lab', port: '22a', path: '/p' }, zh.treeSshPortInvalid],
    ['port zero', { host: 'lab', port: '0', path: '/p' }, zh.treeSshPortInvalid],
    ['a port above 65535', { host: 'lab', port: '65536', path: '/p' }, zh.treeSshPortInvalid],
    ['a password login without a password', { host: 'lab', path: '/p', password: '' }, zh.treeSshPasswordMissing],
  ])('rejects %s before asking the host', async (_name, fields, message) => {
    const tree = mount()
    const dialog = openSshDialog(tree, fields)
    fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
    await settle()
    expect(within(dialog).getByRole('alert').textContent).toBe(message)
    expect(tree.face.createSshWorkspace).not.toHaveBeenCalled()
  })

  it('accepts the highest port, and clears a rejection once the entry is valid', async () => {
    const tree = mount()
    const dialog = openSshDialog(tree, { host: 'lab', port: '70000', path: '/p' })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
    expect(within(dialog).getByRole('alert').textContent).toBe(zh.treeSshPortInvalid)
    fireEvent.change(within(dialog).getByRole('textbox', { name: zh.treeSshPort }), { target: { value: '65535' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
    await settle()
    expect(tree.face.createSshWorkspace).toHaveBeenCalledWith('lab:65535', '/p', { kind: 'key' })
    expect(tree.queryByRole('dialog')).toBeNull()
  })

  it.each([
    ['auth', { host: 'alice@lab', path: '/p' }, zh.treeSshFailAuthKey],
    ['auth', { host: 'alice@lab', path: '/p', password: 'pw' }, zh.treeSshFailAuthPassword],
    ['unreachable', { host: 'alice@lab', path: '/p', password: 'pw' }, zh.treeSshFailUnreachable],
    ['host-key', { host: 'alice@lab', port: '2222', path: '/p', password: 'pw' }, zh.treeSshFailHostKey.replace('{command}', 'ssh -p 2222 alice@lab')],
    ['host-key', { host: 'alice@lab', path: '/p' }, zh.treeSshFailHostKey.replace('{command}', 'ssh alice@lab')],
    ['host-key-changed', { host: 'alice@lab', path: '/p' }, zh.treeSshFailHostKeyChanged],
    ['unsupported', { host: 'alice@lab', path: '/p', password: 'pw' }, zh.treeSshFailUnsupported],
  ] as const)('words an SSH %s failure in the reader’s language and keeps the form', async (reason, fields, message) => {
    const tree = mount()
    tree.face.createSshWorkspace.mockRejectedValueOnce(new SshWorkspaceError(reason, 'The host says: Permission denied (publickey).'))
    const dialog = openSshDialog(tree, fields)
    fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
    await settle()
    expect(within(dialog).getByRole('alert').textContent).toBe(message)
    expect(tree.getByRole('dialog', { name: zh.treeSshTitle })).toBeTruthy()
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: zh.treeSshHost }).value).toBe('alice@lab')
    expect(tree.face.openWorkspace).not.toHaveBeenCalled()
  })

  describe('the first connection to an unknown host', () => {
    const KEY = { type: 'ED25519', fingerprint: 'SHA256:zCYWjkRQRY+WeviSPL50T/cy+RxRuyZ6L09VwGtUuEM' }
    const unknownHost = () => new SshWorkspaceError('host-key', 'SSH host key is not trusted yet', KEY)

    it('shows the key and its fingerprint, and records nothing until the person trusts it', async () => {
      const tree = mount()
      tree.face.createSshWorkspace.mockRejectedValueOnce(unknownHost())
      const dialog = openSshDialog(tree, { host: 'alice@192.0.2.10', port: '2222', path: '/home/research' })
      fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
      await settle()
      const offer = within(dialog).getByRole('group', { name: zh.treeSshTrustTitle })
      expect(within(offer).getByText(zh.treeSshTrustBody.replace('{host}', 'alice@192.0.2.10:2222').replace('{type}', 'ED25519'))).toBeTruthy()
      expect(within(offer).getByText(KEY.fingerprint)).toBeTruthy()
      expect(within(offer).getByText(zh.treeSshTrustAdvice)).toBeTruthy()
      expect(within(dialog).queryByRole('alert')).toBeNull()
      expect(tree.face.createSshWorkspace).toHaveBeenCalledTimes(1)
      expect(tree.face.createSshWorkspace).toHaveBeenLastCalledWith('alice@192.0.2.10:2222', '/home/research', { kind: 'key' })
    })

    it('asks the host to trust exactly the fingerprint it showed, then opens the workspace', async () => {
      const tree = mount()
      tree.face.createSshWorkspace.mockRejectedValueOnce(unknownHost())
      const dialog = openSshDialog(tree, { host: 'alice@lab', path: '/home/research', password: 'pw' })
      fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
      await settle()
      fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshTrust }))
      await settle()
      expect(tree.face.createSshWorkspace).toHaveBeenCalledTimes(2)
      expect(tree.face.createSshWorkspace).toHaveBeenLastCalledWith(
        'alice@lab', '/home/research', { kind: 'password', password: 'pw' }, KEY.fingerprint,
      )
      expect(tree.face.openWorkspace).toHaveBeenCalledWith('w-ssh')
      expect(tree.queryByRole('dialog')).toBeNull()
    })

    it('goes back to the form without trusting when the person declines or changes the host', async () => {
      const tree = mount()
      tree.face.createSshWorkspace.mockRejectedValue(unknownHost())
      const dialog = openSshDialog(tree, { host: 'alice@lab', path: '/home/research' })
      fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
      await settle()
      fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshTrustDecline }))
      expect(within(dialog).queryByRole('group', { name: zh.treeSshTrustTitle })).toBeNull()
      fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
      await settle()
      expect(within(dialog).getByRole('group', { name: zh.treeSshTrustTitle })).toBeTruthy()
      fireEvent.change(within(dialog).getByRole('textbox', { name: zh.treeSshHost }), { target: { value: 'alice@other' } })
      expect(within(dialog).queryByRole('group', { name: zh.treeSshTrustTitle })).toBeNull()
      fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
      await settle()
      expect(within(dialog).getByRole('group', { name: zh.treeSshTrustTitle })).toBeTruthy()
      fireEvent.change(within(dialog).getByRole('textbox', { name: zh.treeSshPort }), { target: { value: '2200' } })
      expect(within(dialog).queryByRole('group', { name: zh.treeSshTrustTitle })).toBeNull()
      expect(tree.face.createSshWorkspace.mock.calls.every(call => call[3] === undefined)).toBe(true)
    })

    it('does not offer a key twice, and words what goes wrong after the person trusted it', async () => {
      const tree = mount()
      tree.face.createSshWorkspace.mockRejectedValueOnce(unknownHost()).mockRejectedValueOnce(unknownHost())
      const dialog = openSshDialog(tree, { host: 'alice@lab', path: '/home/research' })
      fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
      await settle()
      fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshTrust }))
      await settle()
      expect(within(dialog).queryByRole('group', { name: zh.treeSshTrustTitle })).toBeNull()
      expect(within(dialog).getByRole('alert').textContent).toBe(zh.treeSshFailHostKey.replace('{command}', 'ssh alice@lab'))
    })

    it('shows a host key that changed as a refusal and offers no way to trust it', async () => {
      const tree = mount()
      tree.face.createSshWorkspace.mockRejectedValueOnce(new SshWorkspaceError('host-key-changed', 'changed', KEY))
      const dialog = openSshDialog(tree, { host: 'alice@lab', path: '/home/research' })
      fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
      await settle()
      expect(within(dialog).getByRole('alert').textContent).toBe(zh.treeSshFailHostKeyChanged)
      expect(within(dialog).queryByRole('button', { name: zh.treeSshTrust })).toBeNull()
      expect(within(dialog).queryByRole('group', { name: zh.treeSshTrustTitle })).toBeNull()
    })

    it('keeps the buttons off while the trusted connection is being made', async () => {
      const tree = mount()
      tree.face.createSshWorkspace.mockRejectedValueOnce(unknownHost())
      const dialog = openSshDialog(tree, { host: 'alice@lab', path: '/home/research' })
      fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
      await settle()
      let release: () => void = () => {}
      tree.face.createSshWorkspace.mockReturnValueOnce(new Promise<WorkspaceId>((resolve) => { release = () => { resolve('w-ssh' as WorkspaceId) } }))
      fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshTrust }))
      await settle()
      expect(within(dialog).queryByRole('group', { name: zh.treeSshTrustTitle })).toBeNull()
      release()
      await settle()
      expect(tree.queryByRole('dialog')).toBeNull()
    })
  })

  it('closes on Cancel, but not while the host is still being asked', async () => {
    const tree = mount()
    let release: () => void = () => {}
    tree.face.createSshWorkspace.mockReturnValueOnce(new Promise<WorkspaceId>((resolve) => { release = () => { resolve('w-ssh' as WorkspaceId) } }))
    const dialog = openSshDialog(tree, { host: 'lab', path: '/p' })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
    await settle()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await settle()
    expect(tree.queryByRole('dialog', { name: zh.treeSshTitle })).not.toBeNull()
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: zh.treeSshHost }).disabled).toBe(true)
    release()
    await settle()
    expect(tree.queryByRole('dialog')).toBeNull()
    fireEvent.click(tree.getByRole('button', { name: zh.treeSshAdd }))
    fireEvent.click(within(tree.getByRole('dialog', { name: zh.treeSshTitle })).getByRole('button', { name: zh.cancel }))
    expect(tree.queryByRole('dialog')).toBeNull()
  })

  it('clears an earlier refusal when the entry is sent again', async () => {
    const tree = mount()
    tree.face.createSshWorkspace.mockRejectedValueOnce(new SshWorkspaceError('unreachable', 'down'))
    const dialog = openSshDialog(tree, { host: 'lab', path: '/p' })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
    await settle()
    expect(within(dialog).getByRole('alert').textContent).toBe(zh.treeSshFailUnreachable)
    fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
    await settle()
    expect(tree.queryByRole('dialog')).toBeNull()
  })

  it('keeps the SSH form open with the connection error when the remote session cannot open', async () => {
    const tree = mount()
    tree.face.openWorkspace.mockRejectedValueOnce(new Error('SSH host unavailable'))
    fireEvent.click(tree.getByRole('button', { name: zh.treeSshAdd }))
    const dialog = tree.getByRole('dialog', { name: zh.treeSshTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: zh.treeSshHost }), { target: { value: 'lab' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: zh.treeSshPath }), { target: { value: '/home/research' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.treeSshAdd }))
    await settle()
    expect(within(dialog).getByRole('alert').textContent).toContain('SSH host unavailable')
    expect(tree.getByRole('dialog', { name: zh.treeSshTitle })).toBeTruthy()
  })

  it('shows the host on an SSH folder and offers a conversation without local research creation', async () => {
    const remote = { ...workspace('w-ssh', '/home/research', 'Research'),
      location: { kind: 'ssh' as const, host: 'lab', path: '/home/research' } }
    const tree = mount({ projects: [], sessions: [], workspaces: [remote] })
    fireEvent.click(row('group:others'))
    await settle()
    expect(within(row('folder:w-ssh')).getByText('Research · lab:/home/research')).toBeTruthy()
    openMenu('folder:w-ssh')
    expect(menuItems()).toEqual([zh.treeAddConversation, zh.treeRemove])
    fireEvent.click(menuItem(zh.treeAddConversation))
    await settle()
    expect(tree.face.startSession).toHaveBeenCalledWith(remote.workspaceId)
    expect(tree.face.create).not.toHaveBeenCalled()
  })

  it('offers each kind of row what it may do', () => {
    const tree = mount({ current: 's-example', projects: [draft, sparse, example] })
    openMenu(R(sparse))
    expect(menuItems()).toEqual([zh.treeRename, zh.folderReveal, zh.treeRemove])
    openMenu(R(sparse))
    // The untouched draft cannot be removed: 新研究 reopens it.
    openMenu(R(draft))
    expect(menuItems()).toEqual([zh.treeRename, zh.folderReveal])
    openMenu(R(draft))
    // An example is only read.
    openMenu(R(example))
    expect(menuItems()).toEqual([zh.folderReveal])
    openMenu(R(example))
    expect(within(row('conversation:s-example')).queryByRole('button')).toBeNull()
    // Without a file manager the row offers none, and an example then has no menu at all.
    tree.update({ current: 's-example', projects: [draft, sparse, example], canReveal: false })
    expect(within(row(R(example))).queryByRole('button')).toBeNull()
    openMenu(R(sparse))
    expect(menuItems()).toEqual([zh.treeRename, zh.treeRemove])
    openMenu(R(sparse))
    // A blank conversation has nothing to rename or remove yet.
    tree.update({ current: 's-new', projects: [sparse], sessions: [...SESSIONS, session('s-new', '/r/sparse', { blank: true })] })
    expect(row('conversation:s-new').textContent).toBe(zh.treeBlankConversation)
    expect(within(row('conversation:s-new')).queryByRole('button')).toBeNull()
    expect(keys()).not.toContain(`add:${sparse.id}`)
  })

  it('shows a folder in the file manager, removes a research, and says why either failed under the row', async () => {
    const tree = mount({ current: 's-cite' })
    openMenu(R(sparse))
    fireEvent.click(menuItem(zh.folderReveal))
    await settle()
    expect(tree.face.reveal).toHaveBeenCalledWith('/r/sparse')
    tree.face.reveal.mockRejectedValueOnce(new Error('这台主机没有桌面'))
    openMenu(R(sparse))
    fireEvent.click(menuItem(zh.folderReveal))
    await settle()
    expect(within(row(R(sparse))).getByRole('alert').textContent).toBe(t('actionFailed', { reason: '这台主机没有桌面' }))
    openMenu(R(long))
    fireEvent.click(menuItem(zh.treeRemove))
    await settle()
    expect(tree.face.commands).toEqual([{ action: 'archive-project', projectId: long.id }])
  })

  it('renames a research, holding the dialog while the host answers and keeping its reason when refused', async () => {
    const tree = mount({ current: 's-cite' })
    openMenu(R(sparse))
    fireEvent.click(menuItem(zh.treeRename))
    const dialog = tree.getByRole('dialog', { name: zh.treeRenameResearchTitle })
    const field = within(dialog).getByLabelText(zh.treeNameLabel) as HTMLInputElement
    const submit = within(dialog).getByRole('button', { name: zh.treeRename }) as HTMLButtonElement
    expect(field.value).toBe('块稀疏注意力')
    // The same name, or no name, changes nothing.
    expect(submit.disabled).toBe(true)
    fireEvent.change(field, { target: { value: '   ' } })
    expect(submit.disabled).toBe(true)
    fireEvent.submit(field.closest('form')!)
    expect(tree.face.run).not.toHaveBeenCalled()
    let refuse!: (error: Error) => void
    tree.face.run.mockImplementationOnce((command: ResearchCommand) => {
      tree.face.commands.push(command)
      return new Promise((_resolve, reject) => { refuse = reject })
    })
    fireEvent.change(field, { target: { value: '  稀疏注意力的代价 ' } })
    fireEvent.click(submit)
    await settle()
    expect(tree.face.commands).toEqual([{ action: 'rename', projectId: sparse.id, title: '稀疏注意力的代价' }])
    // While the host answers the dialog stays, whatever closes it.
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
    expect(tree.queryByRole('dialog')).not.toBeNull()
    await act(async () => { refuse(new Error('名字太长了')) })
    await settle()
    expect(within(tree.getByRole('dialog')).getByRole('alert').textContent).toBe(t('actionFailed', { reason: '名字太长了' }))
    fireEvent.click(within(tree.getByRole('dialog')).getByRole('button', { name: zh.treeRename }))
    await settle()
    expect(tree.queryByRole('dialog')).toBeNull()
    expect(tree.face.commands).toHaveLength(2)
  })

  it('names the draft from an empty field, and renames or removes a conversation through its own session', async () => {
    const tree = mount({ current: 's-cite' })
    openMenu(R(draft))
    fireEvent.click(menuItem(zh.treeRename))
    const field = within(tree.getByRole('dialog')).getByLabelText(zh.treeNameLabel) as HTMLInputElement
    expect(field.value).toBe('')
    fireEvent.change(field, { target: { value: '长上下文的代价' } })
    fireEvent.submit(field.closest('form')!)
    await settle()
    expect(tree.face.commands).toEqual([{ action: 'rename', projectId: draft.id, title: '长上下文的代价' }])
    expect(tree.queryByRole('dialog')).toBeNull()
    openMenu('conversation:s-plan')
    fireEvent.click(menuItem(zh.treeRename))
    const dialog = tree.getByRole('dialog', { name: zh.treeRenameConversationTitle })
    const title = within(dialog).getByLabelText(zh.treeNameLabel) as HTMLInputElement
    expect(title.value).toBe('规划')
    // Keeping a conversation's title is allowed: it pins the automatic one.
    fireEvent.click(within(dialog).getByRole('button', { name: zh.treeRename }))
    await settle()
    expect(tree.face.renameConversation).toHaveBeenCalledWith('s-plan', '规划')
    openMenu('conversation:s-plan')
    fireEvent.click(menuItem(zh.treeRemove))
    await settle()
    expect(tree.face.archiveConversation).toHaveBeenCalledWith('s-plan')
    // Cancelling a dialog changes nothing.
    openMenu('conversation:s-cite')
    fireEvent.click(menuItem(zh.treeRename))
    fireEvent.click(within(tree.getByRole('dialog')).getByRole('button', { name: zh.cancel }))
    expect(tree.queryByRole('dialog')).toBeNull()
  })

  it('makes a folder a research under the name the person gives, opening it, or takes the folder out of the list', async () => {
    const tree = mount({ current: 's-legacy' })
    openMenu('folder:w-legacy')
    expect(menuItems()).toEqual([zh.treeMakeResearch, zh.treeRemove])
    fireEvent.click(menuItem(zh.treeMakeResearch))
    const dialog = tree.getByRole('dialog', { name: '把「legacy」设为研究' })
    expect(within(dialog).getByText(zh.treeMakeResearchHint)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: zh.treeMakeResearchSubmit }))
    await settle()
    expect(tree.face.create).toHaveBeenCalledWith({ root: '/legacy', title: 'legacy', brief: '' })
    const made = await tree.face.create.mock.results[0]!.value as ResearchProject
    expect(Object.entries(tree.store.getSnapshot().expanded)).toContainEqual([`research:${made.id}`, true])
    openMenu('folder:w-legacy')
    fireEvent.click(menuItem(zh.treeRemove))
    await settle()
    expect(tree.face.removeFolder).toHaveBeenCalledWith('w-legacy')
  })
})

describe('searching', () => {
  it('keeps a query inside the session search\'s bound without splitting a character', () => {
    expect(searchable('a\0b')).toBe('ab')
    expect(searchable('x'.repeat(600))).toHaveLength(500)
    const pair = `${'x'.repeat(499)}😀tail`
    expect(searchable(pair)).toBe('x'.repeat(499))
  })

  it('finds names at once and conversation text after a pause, and opens what the person picks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tree = mount({ current: 's-draft' })
    fireEvent.click(tree.getByRole('button', { name: zh.treeSearch }))
    const box = tree.getByRole('textbox', { name: zh.treeSearch })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(document.activeElement).toBe(box)
    tree.face.searchConversations.mockResolvedValueOnce({
      items: [{ sessionId: 's-legacy' as SessionId, snippet: '注意力的旧笔记' }, { sessionId: 's-loose' as SessionId, snippet: '注意到的问题' }],
      hasMore: true,
    })
    fireEvent.change(box, { target: { value: '注意' } })
    const results = tree.getByRole('tree', { name: zh.treeSearchResults })
    expect(within(results).getAllByRole('treeitem').map(item => item.textContent)).toEqual(['块稀疏注意力'])
    expect(tree.getByRole('status').textContent).toBe(zh.treeSearchPending)
    expect(tree.face.searchConversations).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(tree.face.searchConversations).toHaveBeenCalledWith('注意', expect.any(AbortSignal))
    expect(within(results).getAllByRole('treeitem').map(item => item.textContent)).toEqual([
      '块稀疏注意力', '旧笔记legacy注意力的旧笔记', `零散想法${zh.treeLoose}注意到的问题`,
    ])
    expect(tree.getByText(t('treeSearchMore', { n: 20 }))).toBeTruthy()
    // A conversation opens with its place unfolded, and the search closes.
    fireEvent.click(within(results).getByText('旧笔记'))
    expect(tree.face.openSession).toHaveBeenCalledWith('s-legacy')
    expect(tree.queryByRole('textbox')).toBeNull()
    expect(keys().slice(-3)).toEqual(['folder:w-legacy', 'conversation:s-legacy', 'group:loose'])
  })

  it('opens a research, an example and the draft from their names, and conversations in each kind of place', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tree = mount({ current: 's-cite' })
    const search = async (query: string): Promise<HTMLElement> => {
      fireEvent.click(tree.getByRole('button', { name: zh.treeSearch }))
      fireEvent.change(tree.getByRole('textbox', { name: zh.treeSearch }), { target: { value: query } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      return tree.getByRole('tree', { name: zh.treeSearchResults })
    }
    fireEvent.click(within(await search('长上下文')).getByText('长上下文'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(tree.face.openWorkspace).toHaveBeenLastCalledWith('w-long')
    // An example opens inside its group.
    fireEvent.click(within(await search('摘要评测')).getByText('示例：摘要评测'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(tree.face.openSession).toHaveBeenLastCalledWith('s-example')
    expect(row('group:examples').getAttribute('aria-expanded')).toBe('true')
    // The draft opens its blank conversation; a failure to open leaves the tree as it was.
    tree.face.openWorkspace.mockRejectedValueOnce(new Error('那个文件夹不见了'))
    const drafts = await search('新研究')
    fireEvent.click(within(drafts).getByText(zh.treeUntitled))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(tree.face.openWorkspace).toHaveBeenLastCalledWith('w-draft')
    fireEvent.click(within(await search('示例对话')).getByText('示例对话'))
    expect(tree.face.openSession).toHaveBeenLastCalledWith('s-example')
    act(() => { tree.store.actions.setExpanded(`research:${sparse.id}`, false) })
    const own = await search('引用核对')
    // The conversation on screen reads as selected among the results, with its dot.
    const hit = within(own).getByRole('treeitem', { selected: true })
    expect(within(hit).getByText(zh.treeOngoing)).toBeTruthy()
    fireEvent.click(hit)
    expect(row(R(sparse)).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(within(await search('零散')).getByText('零散想法'))
    expect(keys().slice(-2)).toEqual(['group:loose', 'conversation:s-loose'])
    expect(tree.face.openSession).toHaveBeenLastCalledWith('s-loose')
  })

  it('says when the text could not be searched or nothing matched, and drops an answer a newer query replaced', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tree = mount({})
    fireEvent.click(tree.getByRole('button', { name: zh.treeSearch }))
    const box = tree.getByRole('textbox', { name: zh.treeSearch })
    tree.face.searchConversations.mockRejectedValueOnce(new Error('content search is off'))
    fireEvent.change(box, { target: { value: 'zzz' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(tree.getByRole('status').textContent).toBe(zh.treeSearchUnavailable)
    expect(tree.getByText(zh.treeSearchNone)).toBeTruthy()
    // An answer, or a failure, that lands after the query changed is dropped.
    let late!: (value: { items: never[]; hasMore: boolean }) => void
    let failLate!: (error: Error) => void
    tree.face.searchConversations
      .mockImplementationOnce(() => new Promise((resolve) => { late = resolve }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failLate = reject }))
    fireEvent.change(box, { target: { value: 'yy' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    fireEvent.change(box, { target: { value: 'xx' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    fireEvent.change(box, { target: { value: 'ww' } })
    await act(async () => {
      late({ items: [], hasMore: true })
      failLate(new Error('too late'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(tree.getByRole('status').textContent).toBe(zh.treeSearchPending)
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(tree.queryByRole('status')).toBeNull()
    expect(tree.queryByText(t('treeSearchMore', { n: 20 }))).toBeNull()
  })

  it('closes on Escape, on its clear button, and when an empty box loses focus', () => {
    const tree = mount({})
    const open = (): HTMLElement => {
      fireEvent.click(tree.getByRole('button', { name: zh.treeSearch }))
      return tree.getByRole('textbox', { name: zh.treeSearch })
    }
    fireEvent.change(open(), { target: { value: '注意' } })
    fireEvent.keyDown(tree.getByRole('textbox'), { key: 'a' })
    fireEvent.keyDown(tree.getByRole('textbox'), { key: 'Escape' })
    expect(tree.queryByRole('textbox')).toBeNull()
    expect(keys()[0]).toBe(R(draft))
    fireEvent.change(open(), { target: { value: '注意' } })
    fireEvent.click(tree.getByRole('button', { name: zh.treeSearchClear }))
    expect(tree.queryByRole('textbox')).toBeNull()
    // A box with a query stays when focus leaves; an empty one closes, unless focus went to its own clear button.
    const box = open()
    fireEvent.change(box, { target: { value: '注意' } })
    fireEvent.blur(box, { relatedTarget: document.body })
    expect(tree.queryByRole('textbox')).not.toBeNull()
    fireEvent.change(box, { target: { value: '' } })
    fireEvent.blur(box, { relatedTarget: tree.getByRole('button', { name: zh.treeSearchClear }) })
    expect(tree.queryByRole('textbox')).not.toBeNull()
    fireEvent.blur(box, { relatedTarget: null })
    expect(tree.queryByRole('textbox')).toBeNull()
  })
})

describe('the collapsed rail', () => {
  it('keeps the search alone, widens the sidebar, and puts the cursor in the box once the slide is over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tree = mount({ wide: false })
    expect(tree.queryByRole('tree')).toBeNull()
    expect(tree.queryByText(zh.treeTitle)).toBeNull()
    fireEvent.click(tree.getByRole('button', { name: zh.treeSearch }))
    expect(tree.face.expandSidebar).toHaveBeenCalledOnce()
    tree.update({ wide: true })
    const box = tree.getByRole('textbox', { name: zh.treeSearch })
    await act(async () => { await vi.advanceTimersByTimeAsync(299) })
    expect(document.activeElement).not.toBe(box)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(document.activeElement).toBe(box)
    // Collapsing again before a focus is due leaves nothing behind.
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.click(tree.getByRole('button', { name: zh.treeSearch }))
    tree.update({ wide: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(tree.queryByRole('textbox')).toBeNull()
  })
})
