/**
 * Where the person lands and what 新研究 opens, over the real snapshot stores
 * and a recording host. Every navigation here waits on the host and on the
 * lists, so each case also checks what a newer navigation, a selection made
 * meanwhile, a move in flight, or the plugin going away leaves alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { ResearchCommand, ResearchProject, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import { createResearchEntry, landingTarget, until, type EntrySources } from '../src/client/entry.ts'
import type { EntryView, ResearchView } from '../src/client/contract.ts'

afterEach(() => { vi.useRealTimers() })

const LISTING_MS = 40
const NOTICE_MS = 40

/** Let promise chains and store notifications run. */
async function flush(): Promise<void> {
  for (let round = 0; round < 8; round++) await Promise.resolve()
}

/** Wait on the real clock. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** A research record, as the snapshot carries it. */
function research(title: string, root: string, workspaceId: string, extra: Partial<ResearchProject> = {}): ResearchProject {
  return { ...newProject({ title, root, brief: '' }, workspaceId as WorkspaceId), ...extra }
}

function session(id: string, cwd: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id: id as SessionId, displayTitle: id, cwd, running: false, blank: false, updatedAt: 1000, ...extra }
}

function workspace(id: string, path: string, sessionIds: string[]): WorkspaceView {
  return { workspaceId: id as WorkspaceId, path, title: path, sessionIds: sessionIds as SessionId[], createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z' }
}

function listOf(sessions: SessionSummary[], current?: string, phase: SessionListState['phase'] = 'ready'): SessionListState {
  return {
    ids: sessions.map(item => item.id), byId: Object.fromEntries(sessions.map(item => [item.id, item])),
    current: current as SessionId | undefined, phase, subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
}

function workspacesOf(items: readonly WorkspaceView[], archived: string[] = [], phase: WorkspaceSnapshot['phase'] = 'ready'): WorkspaceSnapshot {
  return { items, archivedSessionIds: archived as SessionId[], state: 'idle', phase, error: null }
}

/** One world: the lists, the record, the host and the navigation calls, all recorded. */
function world(init: { sessions?: SessionListState; workspaces?: WorkspaceSnapshot; projects?: ResearchProject[] | null } = {}) {
  const sessions = createSnapshotStore<SessionListState>(init.sessions ?? listOf([]))
  const workspaces = createSnapshotStore<WorkspaceSnapshot>(init.workspaces ?? workspacesOf([]))
  const projects = init.projects === undefined ? [] : init.projects
  const research = createSnapshotStore<ResearchView>({
    snapshot: projects === null ? null : { projects, preferences: {}, components: [], modes: [] }, tasks: [],
  })
  const entry = createSnapshotStore<EntryView>({ notice: null })
  const lifetime = new AbortController()
  let navigation = new AbortController()
  const answers: ((request: ResearchCommand) => ResearchResponse | Promise<ResearchResponse>)[] = []
  const command = vi.fn((request: ResearchCommand): Promise<ResearchResponse> => {
    const answer = answers.shift()
    return answer === undefined ? Promise.reject(new Error(`unexpected ${request.action}`)) : Promise.resolve().then(() => answer(request))
  })
  const select = (id: string | undefined): void => { sessions.update((state) => { state.current = id as SessionId | undefined }) }
  const openSession = vi.fn((id: SessionId) => { select(id) })
  const openWorkspace = vi.fn((_id: WorkspaceId) => Promise.resolve())
  let reading: Promise<void> = Promise.resolve()
  const reread = vi.fn(() => reading)
  const sources: EntrySources = {
    sessions: { list: sessions }, workspaces: { list: workspaces }, research, entry,
    reread, command, openSession, openWorkspace,
    beginNavigation: () => {
      navigation.abort()
      navigation = new AbortController()
      return navigation.signal
    },
    lifetime: lifetime.signal,
    t: key => `t:${key}`,
    timing: { listingMs: LISTING_MS, noticeMs: NOTICE_MS },
  }
  return {
    sessions, workspaces, research, entry, lifetime, command, answers, openSession, openWorkspace, reread, select,
    flows: createResearchEntry(sources),
    /** Hold the next reads until the returned release is called. */
    holdReads: (): (() => void) => {
      let release!: () => void
      reading = new Promise((resolve) => { release = resolve })
      return () => { release(); reading = Promise.resolve() }
    },
    /** Supersede whatever navigation is pending, as another click would. */
    navigateElsewhere: () => { sources.beginNavigation() },
    listSessions: (items: SessionSummary[]) => {
      sessions.update((state) => {
        const next = listOf(items, state.current)
        state.ids = next.ids
        state.byId = next.byId
      })
    },
    listWorkspaces: (items: readonly WorkspaceView[], archived: string[] = []) => { workspaces.set(workspacesOf(items, archived)) },
    setProjects: (next: ResearchProject[]) => {
      research.set({ snapshot: { projects: next, preferences: {}, components: [], modes: [] }, tasks: [] })
    },
  }
}

describe('waiting for a fact', () => {
  it('answers at once when the fact holds or the waiter is gone, and otherwise when the fact comes, the wait ends or the waiter leaves', async () => {
    const store = createSnapshotStore({ ready: false })
    const alive = new AbortController()
    expect(await until(() => true, [store], 10, alive.signal)).toBe(true)
    const gone = new AbortController()
    gone.abort()
    expect(await until(() => store.getSnapshot().ready, [store], 10, gone.signal)).toBe(false)

    const arriving = until(() => store.getSnapshot().ready, [store], 1000, alive.signal)
    store.set({ ready: false })
    store.set({ ready: true })
    expect(await arriving).toBe(true)

    store.set({ ready: false })
    expect(await until(() => store.getSnapshot().ready, [store], 10, alive.signal)).toBe(false)
    const leaving = until(() => store.getSnapshot().ready, [store], 1000, alive.signal)
    alive.abort()
    expect(await leaving).toBe(false)
  })
})

describe('where the person lands', () => {
  const own = research('Sparse attention', '/research/sparse', 'w-sparse')
  const stale = research('Long context', '/research/long', 'w-long')
  const example = research('Example', '/demo/example', 'w-example', { example: true })
  const draft = research('新研究', '/home/SciPaper/2026-09-26-1', 'w-draft', { draft: true, untitled: true })
  const registered = workspacesOf([
    workspace('w-sparse', '/research/sparse', []), workspace('w-long', '/research/long', []),
    workspace('w-example', '/demo/example', []), workspace('w-draft', '/home/SciPaper/2026-09-26-1', []),
  ], ['s-archived'])

  it('is nowhere of the person\'s own without a research of theirs: examples, the draft, removed folders and removed researches do not count', () => {
    const removed = research('Removed', '/research/removed', 'w-removed')
    const archived = research('Taken out of the list', '/research/sparse', 'w-sparse', { archived: true })
    const list = listOf([
      session('s-example', '/demo/example', { updatedAt: 9000 }), session('s-draft', '/home/SciPaper/2026-09-26-1', { blank: true }),
      session('s-restored', '/research/sparse', { updatedAt: 9000 }),
    ])
    expect(landingTarget([example, draft, removed, archived], list, registered)).toBeUndefined()
  })

  it('is the research used last, on its newest conversation that has started', () => {
    // Both records last changed long ago, so the conversations decide.
    const long = '1970-01-01T00:00:00.001Z'
    const review = { artifactId: 'a' as never, artifactRevision: 1, status: 'rendered' as const, findings: '', createdAt: '' }
    const reviewer = { ...own, updatedAt: long, visualReviews: [{ ...review, sessionId: 's-reviewer' }, review] }
    const older = { ...stale, updatedAt: long }
    const quiet = { ...research('Quiet', '/research/quiet', 'w-quiet'), updatedAt: long }
    const list = listOf([
      session('s-old', '/research/sparse', { updatedAt: 2000 }),
      session('s-new', '/research/sparse/paper', { updatedAt: 3000 }),
      session('s-older', '/research/sparse', { updatedAt: 1500 }),
      session('s-blank', '/research/sparse', { blank: true, updatedAt: 9000 }),
      session('s-archived', '/research/sparse', { updatedAt: 9000 }),
      session('s-child', '/research/sparse', { parentId: 's-new' as SessionId, updatedAt: 9000 }),
      session('s-agent', '/research/sparse', { origin: 'subagent', updatedAt: 9000 }),
      session('s-reviewer', '/research/sparse', { updatedAt: 9000 }),
      session('s-long', '/research/long', { updatedAt: 2500 }),
      session('s-outside', '/elsewhere', { updatedAt: 9999 }),
    ])
    // A listed id whose row has gone reads as nothing.
    list.ids.push('s-ghost' as SessionId)
    const withQuiet = workspacesOf([...registered.items, workspace('w-quiet', '/research/quiet', [])], ['s-archived'])
    expect(landingTarget([older, reviewer, quiet, example], list, withQuiet)).toEqual({ workspaceId: 'w-sparse', sessionId: 's-new' })
  })

  it('is a research whose record changed last, on its folder\'s blank conversation when none has started', () => {
    const recent = research('Recent record', '/research/recent', 'w-recent', { updatedAt: new Date(Date.now() + 60_000).toISOString() })
    const list = listOf([session('s-sparse', '/research/sparse', { updatedAt: 5000 })])
    const both = workspacesOf([...registered.items, workspace('w-recent', '/research/recent', [])])
    expect(landingTarget([own, recent], list, both)).toEqual({ workspaceId: 'w-recent', sessionId: undefined })
  })
})

describe('landing', () => {
  const own = research('Sparse attention', '/research/sparse', 'w-sparse')
  const registered = [workspace('w-sparse', '/research/sparse', ['s-sparse'])]

  it('opens the research used last on its conversation, after reading the record again', async () => {
    const w = world({ sessions: listOf([session('s-sparse', '/research/sparse')]), workspaces: workspacesOf(registered), projects: [own] })
    await w.flows.land()
    expect(w.reread).toHaveBeenCalledOnce()
    expect(w.openSession).toHaveBeenCalledWith('s-sparse')
    expect(w.command).not.toHaveBeenCalled()
  })

  it('opens the folder\'s blank conversation when no conversation of it has started, and says so when that fails', async () => {
    const w = world({ workspaces: workspacesOf(registered), projects: [own] })
    await w.flows.land()
    expect(w.openWorkspace).toHaveBeenCalledWith('w-sparse')
    w.openWorkspace.mockRejectedValueOnce(new Error('the folder is gone'))
    await expect(w.flows.land()).rejects.toThrow('the folder is gone')
    expect(w.entry.getSnapshot().notice).toEqual({ kind: 'failed', action: 'land', reason: 'the folder is gone', sessionId: undefined })
  })

  it('opens the untouched draft when the person has no research of their own', async () => {
    const w = world({ projects: [] })
    w.answers.push(() => ({ message: 'New research created', sessionId: 's-draft' }))
    const landing = w.flows.land()
    await flush()
    expect(w.command).toHaveBeenCalledWith({ action: 'start-new' })
    // The draft's conversation opens once the list carries it.
    expect(w.openSession).not.toHaveBeenCalled()
    w.listSessions([session('s-draft', '/home/SciPaper/2026-09-26-1', { blank: true })])
    await landing
    expect(w.openSession).toHaveBeenCalledWith('s-draft')
  })

  it('says the record could not be read rather than making a draft beside researches it cannot see', async () => {
    const w = world({ projects: null })
    await w.flows.land()
    expect(w.command).not.toHaveBeenCalled()
    expect(w.entry.getSnapshot().notice).toEqual({ kind: 'failed', action: 'land', reason: 't:entryRecordUnavailable', sessionId: undefined })
  })

  it('opens nothing once a newer navigation, a selection or the plugin\'s end superseded it', async () => {
    const w = world({ sessions: listOf([session('s-sparse', '/research/sparse'), session('s-other', '/elsewhere')]), workspaces: workspacesOf(registered), projects: [own] })
    let release = w.holdReads()
    const superseded = w.flows.land()
    w.navigateElsewhere()
    release()
    await superseded
    release = w.holdReads()
    const selected = w.flows.land()
    w.select('s-other')
    release()
    await selected
    w.select(undefined)
    release = w.holdReads()
    const ended = w.flows.land()
    w.lifetime.abort()
    release()
    await ended
    expect(w.openSession).not.toHaveBeenCalledWith('s-sparse')
  })

  it('runs once for callers that ask together, and replaces the selection it was told it may replace', async () => {
    const w = world({ sessions: listOf([session('s-sparse', '/research/sparse'), session('s-example', '/demo/x')], 's-example'), workspaces: workspacesOf(registered), projects: [own] })
    const release = w.holdReads()
    const first = w.flows.land('s-example' as SessionId)
    const second = w.flows.land()
    expect(second).toBe(first)
    release()
    await first
    expect(w.reread).toHaveBeenCalledOnce()
    expect(w.openSession).toHaveBeenCalledWith('s-sparse')
  })
})

describe('新研究', () => {
  it('says the draft is already here when it is the conversation on screen, for a few seconds', async () => {
    const w = world({ sessions: listOf([session('s-draft', '/home/SciPaper/d', { blank: true })], 's-draft') })
    w.answers.push(() => ({ message: 'The untouched new research', sessionId: 's-draft' }))
    await w.flows.startNew()
    expect(w.openSession).not.toHaveBeenCalled()
    expect(w.entry.getSnapshot().notice).toEqual({ kind: 'here', sessionId: 's-draft' })
    await sleep(NOTICE_MS + 20)
    expect(w.entry.getSnapshot().notice).toBeNull()
  })

  it('opens the draft once it is listed, unless the person went elsewhere meanwhile', async () => {
    const w = world({ sessions: listOf([session('s-talk', '/research/a')], 's-talk') })
    w.answers.push(() => ({ message: 'New research created', sessionId: 's-draft' }))
    await w.flows.startNew().then(() => { throw new Error('opened before listing') }, (error: unknown) => { expect(String(error)).toContain('t:entryNotListed') })
    expect(w.entry.getSnapshot().notice).toMatchObject({ kind: 'failed', action: 'new', reason: 't:entryNotListed', sessionId: 's-talk' })

    w.answers.push(() => ({ message: 'New research created', sessionId: 's-draft' }))
    const opening = w.flows.startNew()
    await flush()
    w.listSessions([session('s-talk', '/research/a'), session('s-draft', '/home/SciPaper/d', { blank: true })])
    await opening
    expect(w.openSession).toHaveBeenLastCalledWith('s-draft')

    // Another navigation, or another selection, before the draft is listed: it stays where the person went.
    w.select('s-talk')
    w.listSessions([session('s-talk', '/research/a')])
    w.answers.push(() => ({ message: 'The untouched new research', sessionId: 's-draft' }))
    const superseded = w.flows.startNew()
    await flush()
    w.navigateElsewhere()
    w.listSessions([session('s-talk', '/research/a'), session('s-draft', '/home/SciPaper/d', { blank: true })])
    await superseded
    w.answers.push(() => ({ message: 'The untouched new research', sessionId: 's-draft' }))
    const moved = w.flows.startNew()
    w.select(undefined)
    await moved
    expect(w.openSession).toHaveBeenCalledTimes(1)
  })

  it('says why the host refused, in the entry line of the screen it was asked from', async () => {
    const w = world()
    w.answers.push(() => { throw new Error('研究存放位置在研究「甲」里面') })
    await expect(w.flows.startNew()).rejects.toThrow('研究存放位置')
    expect(w.entry.getSnapshot().notice).toEqual({ kind: 'failed', action: 'new', reason: '研究存放位置在研究「甲」里面', sessionId: undefined })
  })

  it('keeps a notice past the plugin\'s end without a timer left behind', async () => {
    const w = world({ sessions: listOf([session('s-draft', '/d', { blank: true })], 's-draft') })
    w.answers.push(() => ({ message: 'here', sessionId: 's-draft' }))
    await w.flows.startNew()
    w.lifetime.abort()
    await sleep(NOTICE_MS + 20)
    expect(w.entry.getSnapshot().notice).toEqual({ kind: 'here', sessionId: 's-draft' })
  })
})

describe('startup never keeps an example selected', () => {
  const own = research('Sparse attention', '/research/sparse', 'w-sparse')
  const example = research('Example', '/demo/example', 'w-example', { example: true })
  const registered = workspacesOf([workspace('w-sparse', '/research/sparse', []), workspace('w-example', '/demo/example', [])])

  it('waits for both lists and the record, then lands away from a restored example', async () => {
    const w = world({
      sessions: listOf([session('s-example', '/demo/example'), session('s-sparse', '/research/sparse')], 's-example', 'pending'),
      workspaces: workspacesOf(registered.items, [], 'pending'), projects: null,
    })
    const stop = w.flows.leaveStartupExample()
    w.sessions.update((state) => { state.phase = 'ready' })
    w.workspaces.set(registered)
    await flush()
    expect(w.openSession).not.toHaveBeenCalled()
    w.setProjects([own, example])
    await flush()
    expect(w.openSession).toHaveBeenCalledWith('s-sparse')
    stop()
  })

  it('leaves the person\'s own selection, no selection, and an example the person opened after startup', async () => {
    const mine = world({ sessions: listOf([session('s-sparse', '/research/sparse')], 's-sparse'), workspaces: registered, projects: [own, example] })
    mine.flows.leaveStartupExample()()
    const none = world({ sessions: listOf([session('s-example', '/demo/example')]), workspaces: registered, projects: [own, example] })
    none.flows.leaveStartupExample()
    const later = world({ sessions: listOf([session('s-example', '/demo/example'), session('s-sparse', '/research/sparse')], 's-sparse'), workspaces: registered, projects: null })
    later.flows.leaveStartupExample()
    later.select('s-example')
    later.setProjects([own, example])
    await flush()
    for (const w of [mine, none, later]) expect(w.reread).not.toHaveBeenCalled()
  })

  it('stops waiting when its disposer runs', async () => {
    const w = world({ sessions: listOf([session('s-example', '/demo/example')], 's-example'), workspaces: registered, projects: null })
    w.flows.leaveStartupExample()()
    w.setProjects([own, example])
    await flush()
    expect(w.reread).not.toHaveBeenCalled()
  })

  it('shows why on the entry line when the landing it starts fails', async () => {
    const w = world({ sessions: listOf([session('s-example', '/demo/example')], 's-example'), workspaces: registered, projects: [example] })
    w.answers.push(() => { throw new Error('no research home') })
    w.flows.leaveStartupExample()
    await sleep(0)
    expect(w.entry.getSnapshot().notice).toMatchObject({ kind: 'failed', action: 'new', reason: 'no research home' })
  })
})

describe('moving the untouched draft', () => {
  const draftRoot = '/home/SciPaper/2026-09-26-1'
  const draft = research('新研究', draftRoot, 'w-draft', { draft: true, untitled: true })
  const moved = research('新研究', '/picked', 'w-moved', { draft: true, untitled: true })
  const start = () => world({
    sessions: listOf([session('s-draft', draftRoot, { blank: true })], 's-draft'),
    workspaces: workspacesOf([workspace('w-draft', draftRoot, ['s-draft'])]), projects: [draft],
  })

  it('carries the composer\'s draft into the new folder once it is listed, while a lost selection is left to the move', async () => {
    const w = start()
    const carry = vi.fn((workspaceId: WorkspaceId) => {
      expect(workspaceId).toBe('w-moved')
      w.select('s-moved')
    })
    w.answers.push((request) => {
      expect(request).toEqual({ action: 'relocate', projectId: draft.id, root: '/picked', confirmNonEmpty: true })
      return { message: 'Research moved', outcome: 'moved', project: moved, sessionId: 's-moved' }
    })
    const moving = w.flows.move({ projectId: draft.id, root: '/picked', confirmNonEmpty: true }, carry)
    await flush()
    // The host archived the draft's conversation, so the selection was cleared: landing now would open something else.
    w.select(undefined)
    const reads = w.reread.mock.calls.length
    await w.flows.land()
    expect(w.reread).toHaveBeenCalledTimes(reads)
    expect(carry).not.toHaveBeenCalled()
    w.listSessions([session('s-moved', '/picked', { blank: true })])
    w.listWorkspaces([workspace('w-moved', '/picked', ['s-moved'])])
    expect(await moving).toMatchObject({ outcome: 'moved' })
    expect(carry).toHaveBeenCalledOnce()
    expect(w.openSession).not.toHaveBeenCalled()
    expect(w.command).toHaveBeenCalledTimes(1)
  })

  it('lands where the person would when a move ends with nothing selected', async () => {
    const w = start()
    w.answers.push(() => { throw new Error('这项研究已经开始') })
    w.select(undefined)
    w.answers.push(() => ({ message: 'The untouched new research', sessionId: 's-draft' }))
    expect(await w.flows.move({ projectId: draft.id, root: '/picked' }, vi.fn())).toBeUndefined()
    expect(w.entry.getSnapshot().notice).toMatchObject({ kind: 'failed', action: 'move', reason: '这项研究已经开始' })
    await sleep(0)
    expect(w.command).toHaveBeenLastCalledWith({ action: 'start-new' })
    expect(w.openSession).toHaveBeenCalledWith('s-draft')
  })

  it('shows why when the landing after a move fails too', async () => {
    const w = start()
    w.select(undefined)
    w.answers.push(() => { throw new Error('这项研究已经开始') }, () => { throw new Error('研究存放位置不可写') })
    await w.flows.move({ projectId: draft.id, root: '/picked' }, vi.fn())
    await sleep(0)
    expect(w.entry.getSnapshot().notice).toMatchObject({ kind: 'failed', action: 'new', reason: '研究存放位置不可写' })
  })

  it('answers what the folder is without carrying anything, and says so when the new folder never appears', async () => {
    const w = start()
    const carry = vi.fn()
    w.answers.push(() => ({ message: 'The folder already is a research', outcome: 'existing', project: moved }))
    expect(await w.flows.move({ projectId: draft.id, root: '/picked' }, carry)).toMatchObject({ outcome: 'existing' })
    w.answers.push(() => ({ message: 'moved', outcome: 'moved' }))
    expect(await w.flows.move({ projectId: draft.id, root: '/picked' }, carry)).toMatchObject({ outcome: 'moved' })
    w.answers.push(() => ({ message: 'moved', outcome: 'moved', project: moved, sessionId: 's-moved' }))
    expect(await w.flows.move({ projectId: draft.id, root: '/picked' }, carry)).toBeUndefined()
    expect(carry).not.toHaveBeenCalled()
    expect(w.entry.getSnapshot().notice).toMatchObject({ kind: 'failed', action: 'move', reason: 't:entryNotListed' })
  })

  it('opens another research with the composer\'s draft, then discards the untouched one', async () => {
    const w = start()
    w.listWorkspaces([workspace('w-draft', draftRoot, ['s-draft']), workspace('w-other', '/research/other', ['s-other-blank'])])
    const carry = vi.fn(() => { w.select('s-other-blank') })
    w.answers.push((request) => {
      expect(request).toEqual({ action: 'discard-draft', projectId: draft.id })
      return { message: 'The untouched new research was removed' }
    })
    await w.flows.adopt(draft.id, 'w-other' as WorkspaceId, carry)
    expect(carry).toHaveBeenCalledWith('w-other')
    expect(w.command).toHaveBeenCalledOnce()
    expect(w.reread).toHaveBeenCalledOnce()
  })

  it('restores a research the person removed from the list before it carries the draft there', async () => {
    const w = start()
    const removed = research('Evidence study', '/research/other', 'w-other', { archived: true })
    w.setProjects([draft, removed])
    w.listWorkspaces([workspace('w-draft', draftRoot, ['s-draft']), workspace('w-other', '/research/other', ['s-other-blank'])])
    const carry = vi.fn(() => { w.select('s-other-blank') })
    w.answers.push((request) => {
      expect(request).toEqual({ action: 'unarchive-project', projectId: removed.id })
      // The draft is carried only once the research is back.
      expect(carry).not.toHaveBeenCalled()
      return { message: 'Restored' }
    }, () => ({ message: 'The untouched new research was removed' }))
    await w.flows.adopt(draft.id, 'w-other' as WorkspaceId, carry)
    expect(carry).toHaveBeenCalledWith('w-other')
    expect(w.command).toHaveBeenLastCalledWith({ action: 'discard-draft', projectId: draft.id })
    // Before the record arrives there is nothing to restore.
    const early = world({ projects: null })
    early.answers.push(() => ({ message: 'removed' }))
    await early.flows.adopt(draft.id, 'w-other' as WorkspaceId, () => { early.select('s-other-blank') })
    expect(early.command).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'unarchive-project' }))
  })

  it('discards nothing when the other research never opens, and says why a discard failed', async () => {
    const w = start()
    w.listWorkspaces([workspace('w-draft', draftRoot, ['s-draft']), workspace('w-other', '/research/other', ['s-other-blank'])])
    // The move lost the selection, and the other research's conversation never comes.
    w.select(undefined)
    w.answers.push(() => ({ message: 'The untouched new research', sessionId: 's-draft' }))
    await w.flows.adopt(draft.id, 'w-other' as WorkspaceId, vi.fn())
    await sleep(0)
    expect(w.command).toHaveBeenCalledWith({ action: 'start-new' })
    w.command.mockClear()
    w.select('s-draft')
    await w.flows.adopt(draft.id, 'w-other' as WorkspaceId, vi.fn())
    expect(w.command).not.toHaveBeenCalled()
    expect(w.entry.getSnapshot().notice).toMatchObject({ kind: 'failed', action: 'move', reason: 't:entryNotListed' })
    w.answers.push(() => { throw new Error('这项研究已经开始') })
    await w.flows.adopt(draft.id, 'w-other' as WorkspaceId, () => { w.select('s-other-blank') })
    expect(w.entry.getSnapshot().notice).toMatchObject({ kind: 'failed', action: 'move', reason: '这项研究已经开始', sessionId: 's-other-blank' })
  })

  it('reports any other failure on the screen that is on it now', () => {
    const w = start()
    w.flows.fail('reveal', 'no file manager')
    expect(w.entry.getSnapshot().notice).toEqual({ kind: 'failed', action: 'reveal', reason: 'no file manager', sessionId: 's-draft' })
  })
})
