/** Browser presentation inputs; the owning plugin supplies all remote callbacks. */
import type { ConversationDrafts } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionSearchResultItem } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  BoardSnapshot, CreateProjectRequest, EvidenceRecord, GalleryPage, ModeSummary, ProjectId, ResearchCommand, ResearchPreferences,
  ResearchProject, ResearchResponse, ResearchSnapshot, ResearchTask,
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

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The 资料 (Sources) tab, opened on its sources or scrolled to its claims. */
    'research-sources': ResearchSourcesParams
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

/** Working directory of every listed session, as the sessions service reports it. */
export type SessionDirectories = Readonly<Record<string, string>>

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
    research: ObservableSnapshot<ResearchView>
    focus: ObservableSnapshot<ResearchFocus>
    directories: ObservableSnapshot<SessionDirectories>
    /** Whether the host can show a folder in the desktop's file manager. */
    canReveal: ObservableSnapshot<boolean>
    /** The research assistant's agent preset and a saved default replacing it, or null while the settings are not read. */
    presets: ObservableSnapshot<PresetDefaults | null>
  }
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
}

/**
 * What a research tool card reads besides its own call: the record, for the
 * mode's names and the project's folder, and a way to open a file the call
 * names. The owner's own `openFile` opens a path the call's arguments name;
 * this one opens a path relative to the project root.
 */
export interface ResearchToolInjected {
  hooks: {
    research: ObservableSnapshot<ResearchView>
  }
  /** Open a project file in the conversation's right sidebar; throws when no sidebar is mounted to show it. */
  openProjectFile(root: string, path: string): void
}

/** Composed props of every research slot entry: the dictionary plus the injected face. */
export type WorkbenchProps = PropsLocale<'research'> & InjectFace<ResearchInjected>

/** The session a seat is mounted in, as every session-scoped slot supplies it. */
export interface SessionSeatProps {
  sessionId: string
}

/**
 * What the sidebar's research tree acts through: the record, the host's
 * file-manager answer, the shell's navigation and session actions, and the
 * research commands its row menus send.
 */
export interface ResearchTreeInjected {
  hooks: {
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

/**
 * The project a session works in: the one bound to it, else the innermost
 * project whose folder contains the session's working directory — so every
 * conversation opened in a project folder shows that project.
 * @param projects - every project the snapshot carries, across all workspaces.
 * @param sessionId - the session the seat is mounted in.
 * @param directories - each listed session's working directory.
 * @returns that session's project, or undefined when it works outside every project.
 */
export function sessionProject<T extends { sessionId?: string | undefined; root: string }>(
  projects: readonly T[] | undefined, sessionId: string, directories: SessionDirectories = {},
): T | undefined {
  const bound = projects?.find(project => project.sessionId === sessionId)
  if (bound) return bound
  const cwd = directories[sessionId]
  if (cwd === undefined) return undefined
  return projectAtPath(projects, cwd)
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
