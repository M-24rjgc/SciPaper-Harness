/** Browser presentation inputs; the owning plugin supplies all remote callbacks. */
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  CreateProjectRequest, ModeSummary, ResearchCommand, ResearchPreferences, ResearchProject, ResearchResponse, ResearchSnapshot,
  ResearchTask,
} from '@deepseek-ai/dsh-research-workbench/types'

/** Everything the research surfaces read: the record, in-flight work, and the last outcome. */
export interface ResearchView {
  snapshot: ResearchSnapshot | null
  tasks: ResearchTask[]
  busy: boolean
  error: string
  response: ResearchResponse | null
}

/**
 * What one rail row asked the frame-wide overlay to open. The rail and the
 * overlay sit in different slot scopes and cannot pass props to each other, so
 * the selection travels through the plugin's own store instead.
 */
export interface ResearchFocus {
  /** Claim whose sources are on screen, or `null` while nothing is open. */
  claimId: string | null
  projectId?: string | undefined
  artifactId?: string | undefined
  panel?: 'workflow' | 'sources' | 'claims' | 'artifacts' | 'experiments' | 'settings' | undefined
}

/** Working directory of every listed session, as the sessions service reports it. */
export type SessionDirectories = Readonly<Record<string, string>>

/** Remote operations and cross-scope selection the plugin injects into every research seat. */
export interface ResearchInjected {
  hooks: {
    research: ObservableSnapshot<ResearchView>
    focus: ObservableSnapshot<ResearchFocus>
    directories: ObservableSnapshot<SessionDirectories>
  }
  /** Create or adopt the project rooted at `request.root`; the record comes back so a caller can act on it. */
  create(request: CreateProjectRequest): Promise<ResearchProject>
  run(request: ResearchCommand): Promise<ResearchResponse>
  refresh(): Promise<void>
  /** Save the preferences, then store each provider key that was typed; an empty key leaves the stored one alone. */
  configure(preferences: ResearchPreferences, keys: { image: string; embedding: string }): Promise<void>
  install(component: 'python' | 'uv' | 'latex' | 'drawio'): Promise<void>
  openConversation(sessionId: string): Promise<void>
  /**
   * Run a slash command in one session without posting a message — the same
   * path the composer's own pickers use for `/permission` and `/goal`.
   */
  command(sessionId: string, line: string): Promise<void>
  /** Open a project file in the conversation's right sidebar, where PDFs, images and text render natively. */
  openFile(root: string, path: string): void
  /** Raise the claim sheet over the whole frame, or close it with `null`. */
  focusClaim(claimId: string | null): void
  /** Ask the host for a project directory; `null` when the person dismissed the picker. */
  pickDirectory(): Promise<string | null>
  showProgress?(): void
  expand(projectId?: string, panel?: ResearchFocus['panel'], artifactId?: string): void
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
