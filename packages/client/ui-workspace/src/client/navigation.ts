/** Workspace archive and directory UI capability. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ClientRemote, DirectoryListing, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ISessions,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/**
 * What decides the startup selection, a selection that is lost, and the
 * unscoped New Session action: `recent` connects the most recently active
 * Workspace, `policy` asks the registered {@link UiWorkspaceEntryPolicy}.
 */
export type UiWorkspaceEntry = 'recent' | 'policy'

/**
 * A deployment's entry rule under `entry: 'policy'`, registered through
 * {@link UiWorkspace.setEntryPolicy}. ui-workspace calls it only once both the
 * Session and the Workspace lists are ready, and logs a throw or rejection.
 * A call opens only Sessions the lists already carry: `openSession` refuses
 * an unlisted id.
 */
export interface UiWorkspaceEntryPolicy {
  /**
   * Select something while nothing is selected: at startup, after the current
   * Session is archived or leaves the list, and when this policy registers.
   * Not called while a policy call is still running, nor again after one
   * settled without a selection.
   */
  land(): void | Promise<void>
  /** Run the unscoped New Session action (`startSession()` without a Workspace). */
  startNew(): void | Promise<void>
}

/** How long startup waits for an entry policy, once both lists are ready, before it uses `recent`. */
const ENTRY_POLICY_WAIT_MS = 5000

/** Workspace archive and directory operations consumed by Client UI domains. */
export interface UiWorkspace {
  /**
   * Select a Session and show its Conversation as one UI navigation action.
   * @param sessionId - listed or retained Session to display.
   */
  openSession(sessionId: SessionId): void
  /**
   * Connect a Workspace and open its Session unless a later navigation supersedes it.
   * @param workspaceId - target Workspace.
   * @param beforeOpen - optional synchronous preparation for the selected Session, skipped after supersession.
   * @param canReuse - optional check before preparation; false keeps the candidate intact and creates a new Session instead.
   * @returns completion; a superseded request may create a Session but does not open it.
   */
  openWorkspace(
    workspaceId: WorkspaceId,
    beforeOpen?: (sessionId: SessionId) => void,
    canReuse?: (sessionId: SessionId) => boolean,
  ): Promise<void>
  /**
   * Fork a Session and open the child unless a later navigation supersedes it.
   * @param sessionId - source Session.
   * @returns completion; a superseded request leaves its child available without selecting it.
   */
  forkSession(sessionId: SessionId): Promise<void>
  /**
   * Resolve the reusable or newly created blank Session for a Workspace.
   * @param workspaceId - target Workspace.
   * @returns a Session already addressable through the Session Controller.
   */
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
  /**
   * Start a New Session flow and navigate to its Session. Under `entry:
   * 'policy'` with a registered policy, the unscoped action runs its `startNew()`.
   * @param workspaceId - explicit target; absent inherits the current or most recent Workspace.
   */
  startSession(workspaceId?: WorkspaceId): void
  /**
   * Register the entry policy that `entry: 'policy'` consults; under `entry:
   * 'recent'` it is kept and never called. Throws while another is registered.
   * @param policy - the startup, lost-selection and unscoped New Session rule.
   * @returns disposer that unregisters it; later navigation uses `recent` until another registers.
   */
  setEntryPolicy(policy: UiWorkspaceEntryPolicy): () => void
  /**
   * Archive a Session and clear it when it is the current selection.
   * @param sessionId - Session to archive.
   */
  archiveSession(sessionId: SessionId): Promise<void>
  /**
   * Unarchive a Session, restoring it to its recorded Workspace position.
   * @param sessionId - Session to unarchive.
   */
  unarchiveSession(sessionId: SessionId): Promise<void>
  /**
   * Open the Host-native directory picker.
   * @returns the selected directory, or null when cancelled.
   */
  pickDirectory(): Promise<string | null>
  /**
   * List one Host directory level.
   * @param path - directory path; absent selects the Host home.
   * @param signal - cancellation for a superseded scan.
   * @returns directory entries and breadcrumb ancestry.
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * Create a child directory.
   * @param path - existing parent directory.
   * @param name - child directory name.
   * @returns created absolute path.
   */
  createDirectory(path: string, name: string): Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-Controller Workspace navigation and directory UI capability. */
    uiWorkspace: UiWorkspace
  }
}

/** Structured directory failure exposed to directory UI consumers. */
export class DirectoryBrowseError extends Error {
  override readonly name = 'DirectoryBrowseError'

  /** @param rpcError - Host directory business failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Implements Workspace archive and directory UI operations. */
class UiWorkspaceService extends Service implements UiWorkspace {
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>()
  private readonly lifetime = new AbortController()
  /** The registered entry policy; consulted only under `entry: 'policy'`. */
  private policy: UiWorkspaceEntryPolicy | undefined
  /** Entry-policy calls not yet settled; `land()` never starts while one runs. */
  private policyCalls = 0
  /** Navigation checks rerun when a policy registers; `watchNavigation` holds one for its lifetime. */
  private readonly policyListeners = new Set<() => void>()

  /**
   * @param ctx - Client root Context.
   * @param directoryPicker - the directory-picking Remote namespace.
   * @param workspaces - pure Workspace Controller.
   * @param sessions - pure Session Controller.
   * @param entry - the page's entry rule (the Host row's `entry` config); `recent` when the page names none.
   */
  constructor(
    ctx: Context,
    private readonly directoryPicker: ClientRemote['directoryPicker'],
    private readonly workspaces: IWorkspaces,
    private readonly sessions: ISessions,
    private readonly entry: UiWorkspaceEntry = 'recent',
  ) {
    super(ctx, 'uiWorkspace')
    ctx.effect(() => this.watchNavigation(), 'ui-workspace: Workspace navigation policy')
  }

  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    const workspace = this.workspaces.list.getSnapshot().items
      .find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) {
      throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`)
    }
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined) return inflight

    const archived = this.workspaces.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary !== undefined && summary.blank && summary.cwd === workspace.path
        && workspace.sessionIds.includes(summary.id)
        && !archived.includes(summary.id)) return summary.id
    }

    const attempt = this.sessions.create({ workspaceId })
      .finally(() => { this.connecting.delete(workspaceId) })
    this.connecting.set(workspaceId, attempt)
    return attempt
  }

  openSession(sessionId: SessionId): void {
    this.sessions.open(sessionId)
    this.ctx.layout.selectPanel(null)
  }

  async openWorkspace(
    workspaceId: WorkspaceId,
    beforeOpen?: (sessionId: SessionId) => void,
    canReuse?: (sessionId: SessionId) => boolean,
  ): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    const isCurrent = (): boolean => !navigation.aborted
    let sessionId = await this.connectWorkspace(workspaceId)
    if (!isCurrent()) return
    if (canReuse?.(sessionId) === false) {
      sessionId = await this.sessions.create({ workspaceId })
      if (!isCurrent()) return
    }
    beforeOpen?.(sessionId)
    if (isCurrent()) this.openSession(sessionId)
  }

  async forkSession(sessionId: SessionId): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    const childId = await this.sessions.fork({ sessionId, increaseTitle: true })
    if (!navigation.aborted) this.openSession(childId)
  }

  startSession(workspaceId?: WorkspaceId): void {
    // Under `entry: 'policy'` the unscoped action is the policy's; a
    // Workspace-scoped one still reuses or creates that Workspace's blank Session.
    if (this.entry === 'policy' && workspaceId === undefined && this.policy !== undefined) {
      this.callPolicy(this.policy, 'startNew')
      return
    }
    const workspace = this.workspaces.list.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    const current = sessions.current
    const currentWorkspaceId = current === undefined
      ? undefined
      : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId
    const recent = workspace.phase === 'ready' && sessions.phase === 'ready'
      ? recentWorkspace(workspace.items, sessions.byId)
      : undefined
    const target = workspaceId ?? currentWorkspaceId ?? recent
    if (target === undefined) {
      this.sessions.clear()
      this.ctx.layout.selectPanel(null)
      return
    }
    void this.openWorkspace(target).catch(
      (reason: unknown) => { console.warn('new session failed:', reason) },
    )
  }

  setEntryPolicy(policy: UiWorkspaceEntryPolicy): () => void {
    if (this.policy !== undefined) {
      throw new Error('uiWorkspace.setEntryPolicy: an entry policy is already registered')
    }
    this.policy = policy
    if (this.entry === 'policy') for (const listener of this.policyListeners) listener()
    return () => {
      if (this.policy === policy) this.policy = undefined
    }
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.archiveSession(sessionId)
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unarchiveSession(sessionId)
  }

  async pickDirectory(): Promise<string | null> {
    const result = await this.directoryPicker.pick()
    if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`)
    return result.value
  }

  async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const result = await this.directoryPicker.list(path, signal)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  async createDirectory(path: string, name: string): Promise<string> {
    const result = await this.directoryPicker.createDirectory(path, name)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  private watchNavigation(): () => void {
    let initial: 'waiting' | 'connecting' | 'done' = 'waiting'
    // Under `entry: 'policy'` the startup is `undecided` until a selection, a
    // policy's `land()`, or the fallback (which hands it to the `recent` rule
    // below) decides it; `seen` and `consulted` are the selection and policy
    // the previous check saw.
    let startup: 'undecided' | 'decided' | 'recent' = this.entry === 'policy' ? 'undecided' : 'recent'
    let seen: SessionId | undefined
    let consulted: UiWorkspaceEntryPolicy | undefined
    let fallback: ReturnType<typeof setTimeout> | undefined
    const decide = (): void => {
      startup = 'decided'
      clearTimeout(fallback)
    }
    // `land()` while nothing is selected: at startup, after a lost selection,
    // and when a policy registers. Without a policy the undecided startup
    // starts its fallback timer.
    const reconcilePolicy = (): void => {
      const workspace = this.workspaces.list.getSnapshot()
      const sessions = this.sessions.list.getSnapshot()
      if (workspace.phase !== 'ready' || sessions.phase !== 'ready') return
      const lost = sessions.current === undefined && seen !== undefined
      const registered = this.policy !== consulted
      seen = sessions.current
      consulted = this.policy
      if (sessions.current !== undefined) {
        if (startup === 'undecided') decide()
        return
      }
      if (this.policy === undefined) {
        if (startup === 'undecided' && fallback === undefined) {
          fallback = setTimeout(() => {
            startup = 'recent'
            reconcile()
          }, ENTRY_POLICY_WAIT_MS)
        }
        return
      }
      if ((startup === 'undecided' || lost || registered) && this.policyCalls === 0 && initial !== 'connecting') {
        decide()
        this.callPolicy(this.policy, 'land')
      }
    }
    const reconcile = (): void => {
      if (this.lifetime.signal.aborted) return
      if (this.clearArchivedCurrent()) return
      if (this.entry === 'policy') reconcilePolicy()
      if (startup !== 'recent' || initial !== 'waiting') return
      const workspace = this.workspaces.list.getSnapshot()
      const sessions = this.sessions.list.getSnapshot()
      if (workspace.phase !== 'ready' || sessions.phase !== 'ready') return
      if (sessions.current !== undefined) {
        initial = 'done'
        return
      }
      const target = recentWorkspace(workspace.items, sessions.byId)
      if (target === undefined) {
        initial = 'done'
        return
      }
      initial = 'connecting'
      void this.connectWorkspace(target).then(
        (sessionId) => {
          if (this.lifetime.signal.aborted) return
          if (this.sessions.list.getSnapshot().current === undefined) {
            this.sessions.open(sessionId)
          }
          initial = 'done'
        },
        (reason: unknown) => {
          if (this.lifetime.signal.aborted) return
          initial = 'waiting'
          console.warn('initial workspace selection failed:', reason)
        },
      )
    }
    const disposeWorkspaces = this.workspaces.list.subscribe(reconcile)
    const disposeSessions = this.sessions.list.subscribe(reconcile)
    this.policyListeners.add(reconcile)
    reconcile()
    return () => {
      this.lifetime.abort()
      clearTimeout(fallback)
      this.policyListeners.delete(reconcile)
      disposeSessions()
      disposeWorkspaces()
    }
  }

  /**
   * Run one entry-policy call. A throw or a rejection is logged under the
   * call's name and never reaches the navigation that asked for it.
   * @param policy - the registered policy.
   * @param call - which of its rules to run.
   */
  private callPolicy(policy: UiWorkspaceEntryPolicy, call: 'land' | 'startNew'): void {
    this.policyCalls += 1
    void new Promise<void>((resolve) => { resolve(policy[call]()) })
      .catch((reason: unknown) => { console.warn(`entry policy ${call} failed:`, reason) })
      .finally(() => { this.policyCalls -= 1 })
  }

  /** @returns true when an archived current selection was cleared. */
  private clearArchivedCurrent(): boolean {
    const current = this.sessions.list.getSnapshot().current
    if (current === undefined
      || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)) return false
    this.sessions.clear()
    return true
  }

}

/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

export { UiWorkspaceService }
