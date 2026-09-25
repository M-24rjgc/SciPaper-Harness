/** Browser presentation inputs; the owning plugin supplies all remote callbacks. */
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  BoardSnapshot, CreateProjectRequest, GalleryPage, ModeSummary, ProjectId, ResearchCommand, ResearchPreferences, ResearchProject,
  ResearchResponse, ResearchSnapshot, ResearchTask,
} from '@deepseek-ai/dsh-research-workbench/types'

/** A figure gallery search, as the panel sends it. */
export type GallerySearchRequest = Extract<ResearchCommand, { action: 'find-reference-figures' }>
/** A read of the experiment board, as the board page sends it. */
export type BoardViewRequest = Extract<ResearchCommand, { action: 'board-view' }>

/**
 * Everything the research surfaces read: the record, the host's background
 * jobs, and the last settled command result. No action's progress or failure
 * lives here; each control keeps its own (`Action.tsx`).
 */
export interface ResearchView {
  snapshot: ResearchSnapshot | null
  tasks: ResearchTask[]
  /** The last result a `run` or `install` settled with, as the file panel shows it. */
  response: ResearchResponse | null
}

/** One claim and the project that holds it. */
export interface ClaimFocus {
  projectId: string
  claimId: string
}

/**
 * What one rail row asked the frame-wide overlay to open. The rail and the
 * overlay sit in different slot scopes and cannot pass props to each other, so
 * the selection travels through the plugin's own store instead.
 */
export interface ResearchFocus {
  /** The claim whose sources are on screen, or `null` while nothing is open. */
  claim: ClaimFocus | null
  projectId?: string | undefined
  artifactId?: string | undefined
  panel?: 'workflow' | 'sources' | 'claims' | 'artifacts' | 'gallery' | 'experiments' | 'settings' | undefined
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
  /** Carry the composer's draft into another research's blank conversation, then discard the untouched draft. */
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
  }
  /** Create or adopt the project rooted at `request.root`; the record comes back so a caller can act on it. */
  create(request: CreateProjectRequest): Promise<ResearchProject>
  /**
   * Send one command. A long command starts a host job; the promise follows it
   * and settles with the job's result or rejects with its failure message, so
   * the caller's own pending state lasts as long as the work. The record is
   * read again before the promise settles, and the result becomes `response`.
   */
  run(request: ResearchCommand): Promise<ResearchResponse>
  /** One page of the figure gallery; unlike `run`, it neither refreshes the record nor sets `response`. */
  searchFigures(request: GallerySearchRequest): Promise<GalleryPage>
  /** The experiment board as last read, starting a new read when it asks; like searchFigures, it leaves the record alone. */
  board(request: BoardViewRequest): Promise<BoardSnapshot>
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
   * Open a project file in the conversation's right sidebar, where PDFs,
   * images and text render natively. Throws when no conversation's sidebar is
   * mounted to show it.
   */
  openFile(root: string, path: string): void
  /** Show the research folder's file tab in the right sidebar. */
  openFiles(): void
  /** Raise the claim sheet over the whole frame, or close it with `null`. */
  focusClaim(claim: ClaimFocus | null): void
  /** Ask the host's folder chooser for a folder. */
  pickDirectory(): Promise<FolderPick>
  /** Open the research tab beside the conversation; only the person's click calls it. */
  showProgress(): void
  expand(projectId?: string, panel?: ResearchFocus['panel'], artifactId?: string): void
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

/** A path in one comparable spelling: forward slashes, no trailing slash, case-folded for drive paths. */
function comparable(path: string): string {
  const slashed = path.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed
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
  const here = comparable(cwd)
  return projects
    ?.filter((project) => { const root = comparable(project.root); return here === root || here.startsWith(`${root}/`) })
    .sort((a, b) => b.root.length - a.root.length)[0]
}

/** This seat's project, read through the injected stores. */
export function useSessionProject(props: WorkbenchProps & SessionSeatProps): ResearchProject | undefined {
  return sessionProject(props.useResearch(s => s).snapshot?.projects, props.sessionId, props.useDirectories(s => s))
}

/** The installed modes, read through the injected store; none before the first snapshot arrives. */
export function useModes(props: WorkbenchProps): readonly ModeSummary[] {
  return props.useResearch(s => s).snapshot?.modes ?? []
}
