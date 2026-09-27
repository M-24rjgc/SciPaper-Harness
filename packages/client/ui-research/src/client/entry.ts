/**
 * Where the person lands and what 新研究 (New research) opens. This is the
 * research's entry policy for ui-workspace (`land`, `startNew`), the startup
 * rule that never keeps an example selected, and the moves of the untouched
 * draft research to a folder or a research the person chose.
 *
 * Every navigation here is late: it waits for the host and for the session
 * list. Each one therefore opens only a listed session, and only while no
 * newer navigation (`beginNavigation`) or selection superseded it.
 */
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ProjectId, ResearchCommand, ResearchProject, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import {
  sessionProject, type CarryDraft, type EntryNotice, type EntryView, type MoveRequest, type ResearchView, type SessionDirectories,
} from './contract.ts'
import type { Translate } from './format.ts'

/** What the entry flows read and act through; the plugin's apply supplies each. */
export interface EntrySources {
  sessions: Pick<ISessions, 'list'>
  current: ObservableSnapshot<SessionId | undefined>
  workspaces: Pick<IWorkspaces, 'list'>
  research: ObservableSnapshot<ResearchView>
  entry: SnapshotStore<EntryView>
  /** Read the record again, after any read already in flight. */
  reread(): Promise<void>
  /** Send one research command and answer with the host's response. */
  command(request: ResearchCommand): Promise<ResearchResponse>
  /** Select a listed session (`uiWorkspace.openSession`). */
  openSession(sessionId: SessionId): void
  /** Open a Workspace's blank conversation (`uiWorkspace.openWorkspace`). */
  openWorkspace(workspaceId: WorkspaceId): Promise<void>
  /** Start a navigation; the signal aborts on the next one (`layout.beginNavigation`). */
  beginNavigation(): AbortSignal
  /** The plugin's lifetime. */
  lifetime: AbortSignal
  /** The research dictionary, for the reasons this module words itself. */
  t: Translate
  /** How long a session may take to appear in the lists, and how long the `here` notice stays. */
  timing: { listingMs: number; noticeMs: number }
}

/** The entry flows one plugin instance runs. */
export interface ResearchEntry {
  /** ui-workspace's `land()`; `replacing` names a selection landing may replace (an example restored at startup). */
  land(replacing?: SessionId): Promise<void>
  /** ui-workspace's `startNew()`: the untouched draft, created when there is none, opened. */
  startNew(): Promise<void>
  /**
   * At startup only: once the lists and the record are read, a selection
   * restored inside an example gives way to where the person would land.
   * @returns a disposer that stops waiting.
   */
  leaveStartupExample(): () => void
  /**
   * 更改位置 (Change location): ask the host to move the draft; a move carries the composer's draft with `carry`.
   * @returns the host's answer, or undefined when the move failed (the notice says why).
   */
  move(request: MoveRequest, carry: CarryDraft): Promise<ResearchResponse | undefined>
  /**
   * 打开它 (Open it): carry the composer's draft into another research's blank
   * conversation, then discard the untouched draft. A research removed from
   * the list is restored first.
   */
  adopt(draftId: ProjectId, workspaceId: WorkspaceId, carry: CarryDraft): Promise<void>
  /** Show a failure on the screen that is on it now. */
  fail(action: Extract<EntryNotice, { kind: 'failed' }>['action'], error: unknown): void
}

/** The message of a thrown value, whatever was thrown. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve true once `ready()` holds, checked again on every change of the
 * sources; false after `ms`, or once `signal` aborts.
 * @param ready - the condition.
 * @param sources - what the condition reads.
 * @param ms - how long to wait.
 * @param signal - the waiter's lifetime.
 * @returns whether the condition came to hold.
 */
export function until(
  ready: () => boolean, sources: readonly ObservableSnapshot<unknown>[], ms: number, signal: AbortSignal,
): Promise<boolean> {
  if (ready()) return Promise.resolve(true)
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const finish = (found: boolean): void => {
      clearTimeout(timer)
      for (const stop of stops) stop()
      signal.removeEventListener('abort', abandon)
      resolve(found)
    }
    const abandon = (): void => { finish(false) }
    const timer = setTimeout(abandon, ms)
    const stops = sources.map(source => source.subscribe(() => { if (ready()) finish(true) }))
    signal.addEventListener('abort', abandon)
  })
}

/** Each listed session's working directory, as {@link sessionProject} reads it. */
function directoriesOf(list: SessionListState): SessionDirectories {
  const directories: Record<string, string> = {}
  for (const [id, summary] of Object.entries(list.byId)) if (summary.cwd !== undefined) directories[id] = summary.cwd
  return directories
}

/** Where a landing goes: a research's conversation, or its folder's blank one when it has none worth opening. */
export interface LandingTarget {
  workspaceId: WorkspaceId
  sessionId?: SessionId | undefined
}

/**
 * Where the person lands: the own research used most recently, on its newest
 * conversation that has started. Own means not an example, not the untouched
 * draft (新研究 reopens that one), not removed from the list, and with its
 * folder still in the Workspace list. A conversation counts when it is
 * listed, top-level, not archived, not blank and not a visual-review
 * reviewer; a research is used when one of its conversations or its record
 * last changed.
 * @param projects - every project the record carries.
 * @param list - the session list.
 * @param workspaces - the Workspace list.
 * @returns the target, or undefined when the person has no research of their own.
 */
export function landingTarget(
  projects: readonly ResearchProject[], list: SessionListState, workspaces: WorkspaceSnapshot,
): LandingTarget | undefined {
  const registered = new Set<string>(workspaces.items.map(item => item.workspaceId))
  const archived = new Set<string>(workspaces.archivedSessionIds)
  const own = projects.filter(project =>
    project.example !== true && project.draft !== true && project.archived !== true && registered.has(project.workspaceId))
  const reviewers = new Set(projects.flatMap(project => project.visualReviews.flatMap(review => review.sessionId ?? [])))
  const directories = directoriesOf(list)
  const newest = new Map<string, { sessionId: SessionId; at: number }>()
  for (const id of list.ids) {
    const summary = list.byId[id]
    if (summary === undefined || summary.blank || summary.parentId !== undefined || summary.origin === 'subagent') continue
    if (archived.has(id) || reviewers.has(id)) continue
    const project = sessionProject(own, id, directories)
    if (project === undefined) continue
    const seen = newest.get(project.id)
    if (seen === undefined || summary.updatedAt > seen.at) newest.set(project.id, { sessionId: id, at: summary.updatedAt })
  }
  let best: { project: ResearchProject; at: number } | undefined
  for (const project of own) {
    const at = Math.max(newest.get(project.id)?.at ?? Number.NEGATIVE_INFINITY, Date.parse(project.updatedAt))
    if (best === undefined || at > best.at) best = { project, at }
  }
  if (best === undefined) return undefined
  return { workspaceId: best.project.workspaceId, sessionId: newest.get(best.project.id)?.sessionId }
}

/**
 * Build the entry flows over the plugin's sources.
 * @param sources - the lists, the record, the host command and the navigation calls.
 * @returns the flows; they hold no timer beyond a notice's own.
 */
export function createResearchEntry(sources: EntrySources): ResearchEntry {
  const { sessions, workspaces, research, entry, lifetime, t, timing } = sources
  /** Moves under way; while any runs, a lost selection is the move's own and `land()` leaves it alone. */
  let moving = 0
  let landing: Promise<void> | undefined
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  lifetime.addEventListener('abort', () => { clearTimeout(noticeTimer) })
  const current = (): SessionId | undefined => sources.current.getSnapshot()

  const notify = (notice: EntryNotice | null, ttl?: number): void => {
    clearTimeout(noticeTimer)
    entry.set({ notice })
    if (ttl !== undefined) noticeTimer = setTimeout(() => { entry.set({ notice: null }) }, ttl)
  }
  const fail: ResearchEntry['fail'] = (action, error) => {
    notify({ kind: 'failed', action, reason: reasonOf(error), sessionId: current() })
  }
  const listed = (sessionId: SessionId): boolean => sessions.list.getSnapshot().byId[sessionId] !== undefined
  const workspaceOf = (sessionId: SessionId | undefined): WorkspaceId | undefined => sessionId === undefined
    ? undefined
    : workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId))?.workspaceId
  const lists = [sessions.list, workspaces.list, sources.current] as const

  /** Open the draft `start-new` answers with, while `free()` says nothing superseded this navigation. */
  const openDraft = async (free: () => boolean): Promise<void> => {
    const from = current()
    let answer: ResearchResponse
    try {
      answer = await sources.command({ action: 'start-new' })
    } catch (error) {
      fail('new', error)
      throw error
    }
    void sources.reread()
    const sessionId = answer.sessionId as SessionId
    if (sessionId === from) {
      notify({ kind: 'here', sessionId: from }, timing.noticeMs)
      return
    }
    if (!(await until(() => listed(sessionId), lists, timing.listingMs, lifetime))) {
      const error = new Error(t('entryNotListed'))
      fail('new', error)
      throw error
    }
    if (free()) sources.openSession(sessionId)
  }

  const landNow = async (replacing: SessionId | undefined): Promise<void> => {
    const navigation = sources.beginNavigation()
    const free = (): boolean => {
      const selected = current()
      return !navigation.aborted && !lifetime.aborted && moving === 0 && (selected === undefined || selected === replacing)
    }
    await sources.reread()
    if (!free()) return
    const snapshot = research.getSnapshot().snapshot
    if (snapshot === null) {
      fail('land', t('entryRecordUnavailable'))
      return
    }
    const target = landingTarget(snapshot.projects, sessions.list.getSnapshot(), workspaces.list.getSnapshot())
    if (target === undefined) return openDraft(free)
    if (target.sessionId !== undefined) {
      sources.openSession(target.sessionId)
      return
    }
    try {
      await sources.openWorkspace(target.workspaceId)
    } catch (error) {
      fail('land', error)
      throw error
    }
  }

  const land: ResearchEntry['land'] = (replacing) => {
    if (moving > 0) return Promise.resolve()
    landing ??= landNow(replacing).finally(() => { landing = undefined })
    return landing
  }

  /** A move ended: a selection it lost and did not replace goes where the person would land. */
  const settleMove = (): void => {
    moving -= 1
    if (moving === 0 && current() === undefined) {
      land().catch((_error: unknown) => {
        // The landing reported itself on the entry screen; nothing waits on it here.
      })
    }
  }

  return {
    land,
    startNew: () => {
      const navigation = sources.beginNavigation()
      const from = current()
      return openDraft(() => !navigation.aborted && !lifetime.aborted && current() === from)
    },
    leaveStartupExample: () => {
      let restored: { sessionId: SessionId | undefined } | undefined
      const check = (): boolean => {
        const list = sessions.list.getSnapshot()
        if (list.phase !== 'ready' || workspaces.list.getSnapshot().phase !== 'ready') return false
        restored ??= { sessionId: current() }
        const snapshot = research.getSnapshot().snapshot
        if (snapshot === null) return false
        const selected = current()
        const inExample = selected !== undefined && sessionProject(snapshot.projects, selected, directoriesOf(list))?.example === true
        if (inExample && selected === restored.sessionId) {
          land(selected).catch((_error: unknown) => {
            // The landing reported itself on the entry screen; startup waits on nothing.
          })
        }
        return true
      }
      if (check()) return () => {}
      const stops = [sessions.list, workspaces.list, sources.current, research]
        .map(source => source.subscribe(() => { if (check()) stop() }))
      const stop = (): void => { for (const dispose of stops) dispose() }
      return stop
    },
    move: async (request, carry) => {
      moving += 1
      try {
        const answer = await sources.command({ action: 'relocate', projectId: request.projectId, root: request.root, ...(request.confirmNonEmpty === true ? { confirmNonEmpty: true } : {}) })
        await sources.reread()
        const target = answer.project
        const sessionId = answer.sessionId as SessionId | undefined
        if (answer.outcome === 'moved' && target !== undefined && sessionId !== undefined) {
          const ready = (): boolean => listed(sessionId) && workspaceOf(sessionId) === target.workspaceId
          if (!(await until(ready, lists, timing.listingMs, lifetime))) throw new Error(t('entryNotListed'))
          carry(target.workspaceId)
          await until(() => current() === sessionId, lists, timing.listingMs, lifetime)
        }
        return answer
      } catch (error) {
        fail('move', error)
        return undefined
      } finally {
        settleMove()
      }
    },
    adopt: async (draftId, workspaceId, carry) => {
      moving += 1
      try {
        // A research the person removed from the list comes back when they open it with their draft.
        const target = research.getSnapshot().snapshot?.projects.find(project => project.workspaceId === workspaceId)
        if (target?.archived === true) await sources.command({ action: 'unarchive-project', projectId: target.id })
        carry(workspaceId)
        if (!(await until(() => workspaceOf(current()) === workspaceId, lists, timing.listingMs, lifetime))) throw new Error(t('entryNotListed'))
        await sources.command({ action: 'discard-draft', projectId: draftId })
        await sources.reread()
      } catch (error) {
        fail('move', error)
      } finally {
        settleMove()
      }
    },
    fail,
  }
}
