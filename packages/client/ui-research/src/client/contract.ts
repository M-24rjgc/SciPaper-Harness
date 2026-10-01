/** Browser presentation inputs; the owning plugin supplies all remote callbacks. */
import type { ConversationDrafts } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionSearchResultItem } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  BoardSnapshot, CreateProjectRequest, EvidenceRecord, GalleryPage, KnowledgeMarkView, ModeSummary, ProjectId, ResearchCommand,
  ResearchPreferences, ResearchProject, ResearchResponse, ResearchSnapshot, ResearchTask,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { PresetDefaults } from './presets.ts'

/** A figure gallery search, as the panel sends it. */
export type GallerySearchRequest = Extract<ResearchCommand, { action: 'find-reference-figures' }>
/** A read of the experiment board, as the board page sends it. */
export type BoardViewRequest = Extract<ResearchCommand, { action: 'board-view' }>

/** Where the 资料 (Sources) tab scrolls when it is opened: to its claims, below the sources. */
export interface ResearchSourcesParams {
  section?: 'claims' | undefined
}

/** A graph opened from a research tool result. */
export interface ResearchKnowledgeParams {
  query?: string | undefined
  pattern?: string | undefined
  /** The knowledge call whose turn the 对话 view shows; without it the view follows the latest turn that has one. */
  call?: string | undefined
  /** The node of that turn's graph to bring into focus. */
  node?: string | undefined
}

/** The marks of one research as last read, and whether the agent follows them. */
export interface KnowledgeMarksRead {
  marks: readonly KnowledgeMarkView[]
  honour: boolean
}

/** The marks read so far, by research id; the cards and the 对话 view read them, so a mark changed anywhere shows everywhere. */
export type KnowledgeMarksState = Readonly<Record<string, KnowledgeMarksRead>>

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The 资料 (Sources) tab, opened on its sources or scrolled to its claims. */
    'research-sources': ResearchSourcesParams
    'research-knowledge': ResearchKnowledgeParams
  }
}

/**
 * Everything the research surfaces read: the record and the host's background
 * jobs. No action's progress or failure lives here; each control keeps its own
 * (`Action.tsx`).
 */
export interface ResearchView {
  snapshot: ResearchSnapshot | null
  tasks: ResearchTask[]
}

/**
 * Who wrote a literature source and when, from the reference record the host
 * keeps beside it (`reference.json`) since the reference was verified and
 * imported.
 */
export interface SourceReference {
  authors: readonly string[]
  year?: number | undefined
}

/** One claim and the project that holds it. */
export interface ClaimFocus {
  projectId: string
  claimId: string
}

/**
 * The claim a right-sidebar tab asked the frame-wide overlay to open. The tab
 * and the overlay sit in different slot scopes and cannot pass props to each
 * other, so the selection travels through the plugin's own store instead.
 */
export interface ResearchFocus {
  /** The claim whose sources are on screen, or `null` while nothing is open. */
  claim: ClaimFocus | null
}

/** An SSH session's execution coordinate, kept separate from local research roots. */
export interface SshSessionDirectory {
  readonly kind: 'ssh'
  readonly host: string
  readonly cwd?: string | undefined
}

/** Local working directories and SSH coordinates of listed sessions. */
export type SessionDirectories = Readonly<Record<string, string | SshSessionDirectory>>

/** The session fields needed to build research coordinates from the session list. */
interface ListedSessionCoordinate {
  readonly cwd?: string | undefined
  readonly execution?: { readonly kind: 'local' } | { readonly kind: 'ssh'; readonly host: string } | undefined
}

/**
 * Preserve SSH host identity even when its cwd is absent, so a remote session
 * cannot fall back to a local project's bound session or local path.
 * @param byId - session summaries keyed by their ids.
 * @returns local paths and SSH coordinates for research matching.
 */
export function sessionDirectoriesOf(byId: Readonly<Record<string, ListedSessionCoordinate>>): SessionDirectories {
  const directories: Record<string, string | SshSessionDirectory> = {}
  for (const [id, summary] of Object.entries(byId)) {
    if (summary.execution?.kind === 'ssh') directories[id] = { kind: 'ssh', host: summary.execution.host, cwd: summary.cwd }
    else if (summary.cwd !== undefined) directories[id] = summary.cwd
  }
  return directories
}

/**
 * What the host's folder picker answered: a folder, a dismissed chooser, or
 * no chooser at all on this host (a browse composition or a remote browser),
 * in which case the caller asks for a typed path.
 */
export type FolderPick =
  | { kind: 'picked'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' }

/**
 * One short line on the entry screen, shown only while the session it was
 * raised on (or no session, `undefined`) is on screen.
 */
export type EntryNotice =
  /** 新研究 was clicked while its draft was already on screen. */
  | { kind: 'here'; sessionId: string | undefined }
  /** A landing, 新研究, a move or a reveal failed; `reason` is in the reader's language or the host's own words. */
  | { kind: 'failed'; action: 'land' | 'new' | 'move' | 'reveal'; reason: string; sessionId: string | undefined }

/** The entry screen's shared state: the notice, if any. */
export interface EntryView {
  notice: EntryNotice | null
}

/** A folder to move the untouched draft research to. */
export interface MoveRequest {
  projectId: ProjectId
  root: string
  /** Create the research beside the files the folder already holds. */
  confirmNonEmpty?: boolean | undefined
}

/**
 * Carry the composer's draft and attachments into a research folder's blank
 * conversation: the hero folder seat's own `onPick`, captured while the
 * draft's conversation was on screen.
 */
export type CarryDraft = (workspaceId: WorkspaceId) => void

/**
 * What the entry screen's research seats act through: the folder menu, the
 * entry line and the 试试 (Try) sentences.
 */
export interface ResearchEntryInjected {
  hooks: {
    /** Main-view selection, independent of the Session catalog. */
    currentSession: ObservableSnapshot<SessionId | undefined>
    research: ObservableSnapshot<ResearchView>
    directories: ObservableSnapshot<SessionDirectories>
    entry: ObservableSnapshot<EntryView>
    /** Whether the host can show a folder in the desktop's file manager. */
    canReveal: ObservableSnapshot<boolean>
  }
  /** Ask the host's folder chooser for a folder; a failure shows on the entry line and answers `cancelled`. */
  chooseFolder(): Promise<FolderPick>
  /**
   * 更改位置 (Change location): move the untouched draft; a move carries the composer's draft with `carry`.
   * @returns the host's answer, or undefined when the move failed (the entry line says why).
   */
  move(request: MoveRequest, carry: CarryDraft): Promise<ResearchResponse | undefined>
  /**
   * Carry the composer's draft into another research's blank conversation,
   * restoring one removed from the list, then discard the untouched draft.
   */
  adopt(draftId: ProjectId, workspaceId: WorkspaceId, carry: CarryDraft): Promise<void>
  /** Show a folder in the desktop's file manager; a failure shows on the entry line. */
  reveal(path: string): void
  /** Open the research tab beside the conversation; only the person's click calls it. */
  showProgress(): void
}

/** Composed props of every entry-screen research seat: the dictionary plus the injected face. */
export type EntryProps = PropsLocale<'research'> & InjectFace<ResearchEntryInjected>

/** Remote operations and cross-scope selection the plugin injects into every research seat. */
export interface ResearchInjected {
  hooks: {
    /** Main-view selection, independent of the Session catalog. */
    currentSession: ObservableSnapshot<SessionId | undefined>
    research: ObservableSnapshot<ResearchView>
    focus: ObservableSnapshot<ResearchFocus>
    directories: ObservableSnapshot<SessionDirectories>
    /** Whether the host can show a folder in the desktop's file manager. */
    canReveal: ObservableSnapshot<boolean>
    /** The research assistant's agent preset and a saved default replacing it, or null while the settings are not read. */
    presets: ObservableSnapshot<PresetDefaults | null>
    /** The marks last read for each research; every command that changes a mark updates them. */
    marks: ObservableSnapshot<KnowledgeMarksState>
  }
  /** Read a research's marks again into {@link ResearchInjected.hooks}`.marks`; a failed read (the graph plugin is off) changes nothing. */
  readMarks(projectId: ProjectId): void
  /** Create or adopt the project rooted at `request.root`; the record comes back so a caller can act on it. */
  create(request: CreateProjectRequest): Promise<ResearchProject>
  /**
   * Send one command. A long command starts a host job; the promise follows it
   * and settles with the job's result or rejects with its failure message, so
   * the caller's own pending state lasts as long as the work. The record is
   * read again before the promise settles.
   */
  run(request: ResearchCommand): Promise<ResearchResponse>
  /** One page of the figure gallery; unlike `run`, it does not read the record again. */
  searchFigures(request: GallerySearchRequest): Promise<GalleryPage>
  /** The experiment board as last read, starting a new read when it asks; like searchFigures, it leaves the record alone. */
  board(request: BoardViewRequest): Promise<BoardSnapshot>
  /**
   * The authors and year of a literature source, read once per source revision
   * from its reference record.
   * @param projectId - the project that holds the source.
   * @param source - a literature source, whose `path` names its reference record.
   * @returns the reference, or undefined when it cannot be read; it never rejects.
   */
  reference(projectId: ProjectId, source: EvidenceRecord): Promise<SourceReference | undefined>
  /** Read the record and the job list again; a failed read keeps the previous ones and never rejects. */
  refresh(): Promise<void>
  /** Save the preferences, then store each provider key that was typed; an empty key leaves the stored one alone. */
  configure(preferences: ResearchPreferences, keys: { image: string; embedding: string }): Promise<void>
  /** Install a managed component, following its job until it settles like `run` does. */
  install(component: 'python' | 'uv' | 'latex' | 'drawio'): Promise<void>
  /**
   * Show one conversation. It waits until the session list carries the
   * session, then selects it; a session that stays unlisted (not yet
   * published, or unknown to this window) opens the Workspace's blank
   * conversation instead.
   * @param sessionId - the conversation to show.
   * @param workspaceId - the Workspace of its research folder, opened when the session never appears.
   */
  openConversation(sessionId: string, workspaceId: string): Promise<void>
  /**
   * Open a project file in the conversation's right sidebar, read through the
   * conversation on screen, where PDFs, images and text render natively and a
   * `.drawio` file opens in the draw.io editor. Throws when no conversation's
   * sidebar is mounted to show it.
   */
  openFile(root: string, path: string): void
  /** Show the research folder's file tab (项目文件) in the right sidebar. */
  openFiles(): void
  /** Raise the claim sheet over the whole frame, or close it with `null`. */
  focusClaim(claim: ClaimFocus | null): void
  /** Ask the host's folder chooser for a folder. */
  pickDirectory(): Promise<FolderPick>
  /** Open the research tab beside the conversation; only the person's click calls it. */
  showProgress(): void
  /** The header chip's click: collapse the panel while it shows the research tab, else open the research tab. */
  toggleProgress(): void
  /** Show a folder in the desktop's file manager; rejects with the host's reason. */
  reveal(path: string): Promise<void>
  /**
   * Remove the default agent preset saved in the settings, so new
   * conversations compose from the research assistant's preset again;
   * rejects when the settings kept it.
   */
  resetDefaultPreset(): Promise<void>
  /** Open the experiment board (实验看板) tab beside the conversation, 560 px wide when the panel has no width yet. */
  openBoard(): void
  /**
   * Open the 资料 (Sources) tab beside the conversation.
   * @param section - `claims` scrolls the tab to its claims.
   */
  openSources(section?: ResearchSourcesParams['section']): void
  /** Open the figure gallery (配图灵感) tab beside the conversation. */
  openGallery(): void
  /** Inspect the current research's graph beside the conversation. */
  openKnowledge(params?: ResearchKnowledgeParams): void
  /**
   * 新研究 (New research): the entry the sidebar's button takes, which opens the untouched draft or creates one
   * (`uiWorkspace.startSession` without a Workspace).
   */
  startNew(): void
}

/**
 * What a research tool card reads besides its own call: the record, for the
 * mode's names and the project's folder, and a way to open a file the call
 * names. The owner's own `openFile` opens a path the call's arguments name;
 * this one opens a path relative to the project root.
 */
export interface ResearchToolInjected {
  hooks: {
    /** Main-view selection, independent of the Session catalog. */
    currentSession: ObservableSnapshot<SessionId | undefined>
    research: ObservableSnapshot<ResearchView>
    /** The marks last read for each research. */
    marks: ObservableSnapshot<KnowledgeMarksState>
  }
  /** Read a research's marks again; the chips of a call show a node struck through while it is marked not relevant. */
  readMarks(projectId: ProjectId): void
  /** Open a project file in the conversation's right sidebar; throws when no sidebar is mounted to show it. */
  openProjectFile(root: string, path: string): void
  /** Open the graph related to this tool call. */
  openKnowledge(params?: ResearchKnowledgeParams): void
}

/** Composed props of every research slot entry: the dictionary plus the injected face. */
export type WorkbenchProps = PropsLocale<'research'> & InjectFace<ResearchInjected>

/** The session a seat is mounted in, as every session-scoped slot supplies it. */
export interface SessionSeatProps {
  sessionId: string
}

/** How a person chose to log in to the SSH host of a new workspace. */
export type SshAuthChoice =
  | { readonly kind: 'key' }
  | { readonly kind: 'password'; readonly password: string }

/** Why an SSH host could not be used, as the host classifies it. */
export type SshWorkspaceFailure = 'auth' | 'unreachable' | 'host-key' | 'host-key-changed' | 'unsupported'

const SSH_WORKSPACE_FAILURES: readonly SshWorkspaceFailure[] = ['auth', 'unreachable', 'host-key', 'host-key-changed', 'unsupported']

/** The key of an unknown SSH host, as a person compares it with the one the server's administrator knows. */
export interface SshHostKey {
  /** Key type, such as `ED25519`. */
  readonly type: string
  /** `SHA256:` fingerprint of the key. */
  readonly fingerprint: string
}

/** The host's refusal to register an SSH workspace, carrying its cause so the dialog can word it in the reader's language. */
export class SshWorkspaceError extends Error {
  override readonly name = 'SshWorkspaceError'

  /**
   * @param reason - the host's classification.
   * @param message - the host's own English text, free of any password.
   * @param hostKey - for `host-key`, the key the unknown host presents, when the host could read it safely.
   */
  constructor(readonly reason: SshWorkspaceFailure, message: string, readonly hostKey?: SshHostKey) { super(message) }
}

/**
 * Recognize a Workspace create failure that names an SSH cause.
 * @param error - whatever the workspace service threw.
 * @returns the classified error, or undefined for any other failure.
 */
export function sshWorkspaceErrorOf(error: unknown): SshWorkspaceError | undefined {
  const failure = (error as {
    rpcError?: { code?: unknown; message?: unknown; details?: { reason?: unknown; hostKey?: Partial<SshHostKey> } }
  } | null)?.rpcError
  if (failure?.code !== 'workspace/ssh-failed') return undefined
  const reason = SSH_WORKSPACE_FAILURES.find(candidate => candidate === failure.details?.reason)
  if (reason === undefined) return undefined
  const key = failure.details?.hostKey
  const hostKey = typeof key?.type === 'string' && typeof key.fingerprint === 'string'
    ? { type: key.type, fingerprint: key.fingerprint }
    : undefined
  return new SshWorkspaceError(reason, String(failure.message), hostKey)
}

/**
 * What the sidebar's research tree acts through: the record, the host's
 * file-manager answer, the shell's navigation and session actions, and the
 * research commands its row menus send.
 */
export interface ResearchTreeInjected {
  hooks: {
    /** Main-view selection, independent of the Session catalog. */
    currentSession: ObservableSnapshot<SessionId | undefined>
    drafts: ObservableSnapshot<ConversationDrafts>
    research: ObservableSnapshot<ResearchView>
    directories: ObservableSnapshot<SessionDirectories>
    /** Whether the host can show a folder in the desktop's file manager. */
    canReveal: ObservableSnapshot<boolean>
  }
  /** Select a listed conversation (`uiWorkspace.openSession`). */
  openSession(sessionId: SessionId): void
  /** Open a research folder's blank conversation, reusing it or creating it (`uiWorkspace.openWorkspace`). */
  openWorkspace(workspaceId: WorkspaceId): Promise<void>
  /** ＋ 新对话 (New conversation): the folder's blank conversation, reused or created, opened (`uiWorkspace.startSession`). */
  startSession(workspaceId: WorkspaceId): void
  /**
   * Register a remote directory as a workspace and return its identity.
   * @param host - SSH alias or `user@host`, with `:port` when a port is chosen.
   * @param path - absolute remote directory.
   * @param auth - key and ssh configuration, or a password the host verifies and saves.
   * @param trustedHostKey - the fingerprint of an unknown host's key that the person confirmed; the Host records
   * that key only while it still matches.
   * @throws {SshWorkspaceError} when the host refuses the connection for a cause the dialog words itself.
   */
  createSshWorkspace(host: string, path: string, auth: SshAuthChoice, trustedHostKey?: string): Promise<WorkspaceId>
  /** Send one research command, as {@link ResearchInjected.run} does. */
  run(request: ResearchCommand): Promise<ResearchResponse>
  /** Create or adopt the research rooted at `request.root`, as {@link ResearchInjected.create} does. */
  create(request: CreateProjectRequest): Promise<ResearchProject>
  /** Give a conversation a title the person chose; rejects with the host's reason. */
  renameConversation(sessionId: SessionId, title: string): Promise<void>
  /** Archive one conversation: it leaves every list, its log stays (`uiWorkspace.archiveSession`). */
  archiveConversation(sessionId: SessionId): Promise<void>
  /**
   * Take a folder that holds no research out of the list: archive each of its
   * conversations, then delete its Workspace registration. No file changes.
   */
  removeFolder(workspaceId: WorkspaceId): Promise<void>
  /** Show a folder in the desktop's file manager; rejects with the host's reason. */
  reveal(path: string): Promise<void>
  /** The shell's content search over conversation text (`sessions.search`). */
  searchConversations(query: string, signal: AbortSignal): Promise<{ items: readonly SessionSearchResultItem[]; hasMore: boolean }>
  /** How many merged rows one search shows, as the host bounds it. */
  searchResultLimit: number
}

/** A path in one comparable spelling: forward slashes, no trailing slash, case-folded for drive paths. */
function comparable(path: string): string {
  const slashed = path.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed
}

/**
 * A path inside a project folder, relative to that folder.
 * @param root - the project's absolute folder, either separator.
 * @param path - an absolute path, either separator.
 * @returns the `/`-separated path below `root`, or undefined when `path` is the folder itself or lies outside it.
 */
export function pathInProject(root: string, path: string): string | undefined {
  const folder = comparable(root)
  const slashed = path.replaceAll('\\', '/')
  if (!comparable(slashed).startsWith(`${folder}/`)) return undefined
  return slashed.slice(folder.length + 1)
}

/**
 * The innermost project whose folder is `path` or contains it.
 * @param projects - every project the snapshot carries.
 * @param path - an absolute folder, either separator.
 * @returns that project, or undefined when the path lies outside every project.
 */
export function projectAtPath<T extends { root: string }>(projects: readonly T[] | undefined, path: string): T | undefined {
  const here = comparable(path)
  return projects
    ?.filter((project) => { const root = comparable(project.root); return here === root || here.startsWith(`${root}/`) })
    .sort((a, b) => b.root.length - a.root.length)[0]
}

/** Browser-safe POSIX normalization for SSH paths; never interprets them as host paths. */
function remotePath(path: string | undefined): string | undefined {
  if (path === undefined || !path.startsWith('/')) return undefined
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** The remote binding fields needed from a research environment. */
interface RemoteResearchEnvironment {
  target: string
  status: string
  sshHost?: string | undefined
  remoteRoot?: string | undefined
}

/** The configured ready SSH environment must identify exactly one local ledger. */
function remoteSessionProject<T extends { environments?: readonly RemoteResearchEnvironment[] | undefined }>(
  projects: readonly T[] | undefined, coordinate: SshSessionDirectory,
): T | undefined {
  if (coordinate.host === '') return undefined
  const cwd = remotePath(coordinate.cwd)
  if (cwd === undefined) return undefined
  const matching = projects?.filter(project => project.environments?.some((environment) => {
    if (environment.target !== 'ssh' || environment.status !== 'ready' || environment.sshHost !== coordinate.host) return false
    const root = remotePath(environment.remoteRoot)
    return root !== undefined && root !== '/' && (cwd === root || cwd.startsWith(`${root}/`))
  })) ?? []
  return matching.length === 1 ? matching[0] : undefined
}

/**
 * The project a session works in: the one bound to it, else the innermost
 * project whose folder contains the session's working directory — so every
 * conversation opened in a project folder shows that project.
 * @param projects - every project the snapshot carries, across all workspaces.
 * @param sessionId - the session the seat is mounted in.
 * @param directories - each listed session's working directory.
 * @returns that session's project, or undefined when it works outside every project.
 */
export function sessionProject<T extends {
  sessionId?: string | undefined
  root: string
  environments?: readonly RemoteResearchEnvironment[] | undefined
}>(
  projects: readonly T[] | undefined, sessionId: string, directories: SessionDirectories = {},
): T | undefined {
  const cwd = directories[sessionId]
  if (cwd !== undefined && typeof cwd !== 'string') return remoteSessionProject(projects, cwd)
  const bound = projects?.find(project => project.sessionId === sessionId)
  if (bound) return bound
  if (cwd === undefined) return undefined
  return projectAtPath(projects, cwd)
}

/**
 * Find an exact-root local session that can read a local research ledger from
 * an SSH research panel, preferring the project's own bound session.
 * @param project - the local ledger being shown.
 * @param directories - listed local paths and SSH coordinates.
 * @returns a local Session id, or undefined when no local file authority is listed.
 */
export function localResearchFileSession(
  project: { root: string; sessionId?: string | undefined }, directories: SessionDirectories,
): string | undefined {
  const atRoot = (id: string): boolean => {
    const cwd = directories[id]
    return typeof cwd === 'string' && comparable(cwd) === comparable(project.root)
  }
  if (project.sessionId !== undefined && atRoot(project.sessionId)) return project.sessionId
  return Object.keys(directories).find(atRoot)
}

/**
 * This seat's project, read through the injected stores.
 * @param props - the seat's research face and the session it is mounted in.
 * @returns the session's project, or undefined when it works outside every project.
 */
export function useSessionProject(props: WorkbenchProps & SessionSeatProps): ResearchProject | undefined {
  return sessionProject(props.useResearch(s => s).snapshot?.projects, props.sessionId, props.useDirectories(s => s))
}

/**
 * The installed modes, read through the injected store; none before the first snapshot arrives.
 * @param props - the seat's research face.
 * @returns the modes in display order.
 */
export function useModes(props: WorkbenchProps): readonly ModeSummary[] {
  return props.useResearch(s => s).snapshot?.modes ?? []
}
