/** Research project ledger service and typed desktop operations. The agent drives; this records. */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionRequestId, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { ComponentManager, runtimeAsset } from './components.ts'
import { AUTONOMY_PRESETS, autonomies, commandSchema, locatorSchema, MODE_DECISION_KEY, preferencesSchema, researchDomain } from './schema.ts'
import { invalidate, newProject, putClaim, runView, searchEvidence } from './project.ts'
import { ArtifactRevisionConflict, compilePaper, compileTarget, exportPaper, extractText, importEvidence, importTemplate, renderPages, writeArtifact } from './artifacts.ts'
import { runChecks, type GateRunner } from './checks.ts'
import { createGateRunner, runPackScript } from './gates.ts'
import { GENERAL_MODE, ModeRegistry } from './modes.ts'
import { FileTimes, mergeProgress, projectStanding, storedProgress } from './progress.ts'
import { createEnvironment } from './environments.ts'
import { adoptRunCode, collectRunOutputs, experimentLogs, launchExperiment, newExperiment, observationDue, observeExperiment } from './experiments.ts'
import { ExperimentBoards, missingScripts, unmatched } from './board.ts'
import { auditSvg, exportFigure } from './figures.ts'
import { fetchReferenceFigures, generateImage } from './images.ts'
import { FigureGallery } from './gallery.ts'
import { createEmbedder, KnowledgeBase, PROJECT_CLUSTERS, PROJECT_GRAPH, type Embedder } from './knowledge.ts'
import { applyVenue, listVenues, loadVenues, type VenueLibrary } from './venues.ts'
import { downloadPdf, openAccessPdf, searchLiterature, verifyLiterature } from './literature.ts'
import {
  assertUsableProjectRoot, atomicWrite, errorText, EXAMPLE_READ_ONLY, hashBytes, isBinaryFile, isExampleRoot, isInside,
  projectPath, readText, sameDirectory, truncateBytes, writeNew,
} from './files.ts'
import { registerResearchRoutes } from './routes.ts'
import {
  blankRecord, canonicalPath, DRAFT_TITLE, holdsFiles, nextDraftRoot, onlyScaffold, removeEmptyScaffold, resolveResearchHome, SCAFFOLD,
} from './drafts.ts'
import type {
  ArtifactId, CreateProjectRequest, EvidenceId, EvidenceRecord, ExperimentRecord, LiteratureItem, ProjectId, ResearchCommand, ResearchGoal,
  ResearchModeEvent, ResearchPreferences, ResearchProject, ResearchResponse, ResearchSnapshot, ResearchStanding, ResearchTask, VisualReview,
} from './types.ts'
export type * from './types.ts'

/** Research workbench configuration. */
export interface Config {
  /** Directory for managed tools (Python, uv, TeX, draw.io); defaults to the product home's research/components. */
  componentRoot?: string
  /** Byte ceiling for any single source, artifact or tool response the service reads or returns. */
  maxSourceBytes: number
  /** How often running experiments are observed, in milliseconds. */
  pollIntervalMs: number
  /** Most PDF pages rendered for one inspection. */
  maxReviewPages: number
  /**
   * Absolute folder new researches are created in while the person has not
   * chosen one in the settings (the `researchHome` preference); `<profile home>/SciPaper` when unset.
   */
  researchHome?: string
}

/** The only credential the image provider may use; it cannot name any other stored secret. */
export const IMAGE_CREDENTIAL = 'RESEARCH_IMAGE_API_KEY'
/** The only credential the embedding endpoint may use. */
export const EMBEDDING_CREDENTIAL = 'RESEARCH_EMBEDDING_API_KEY'
/** Runs in these states are still in progress from the agent's point of view. */
const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'unknown'])
/** Actions the desktop follows as background jobs instead of waiting on. */
const LONG_ACTIONS = new Set<ResearchCommand['action']>([
  'import', 'import-template', 'refresh-evidence', 'literature-search', 'literature-import',
  'environment', 'experiment', 'experiment-refresh', 'experiment-cancel',
  'compile', 'render-pages', 'visual-review', 'generate-image', 'fetch-reference-figures', 'run-script', 'export',
  'recall', 'novelty', 'build-graph', 'audit-svg', 'export-figure',
])

type ReadOnlyAction = 'search-evidence' | 'read-artifact' | 'experiment-logs' | 'check' | 'experiment-wait' | 'find-reference-figures'
  | 'board-get' | 'board-update' | 'board-refresh' | 'board-view'
/**
 * The person's commands: open, move or remove the untouched draft research,
 * and remove a research from the list or restore it; the agent never sends them.
 */
type PersonCommand = Extract<ResearchCommand, { action: 'start-new' | 'relocate' | 'discard-draft' | 'archive-project' | 'unarchive-project' }>
const PERSON_ACTIONS: ReadonlySet<ResearchCommand['action']> = new Set<PersonCommand['action']>([
  'start-new', 'relocate', 'discard-draft', 'archive-project', 'unarchive-project',
])
/** Commands on one existing project. */
type ProjectCommand = Exclude<ResearchCommand, PersonCommand>
/** Commands that record something in the project. */
type RecordingCommand = Exclude<ProjectCommand, { action: ReadOnlyAction }>
/** Commands whose whole effect is a record change. */
type ShortCommand = Extract<ResearchCommand, {
  action: 'set-mode' | 'set-autonomy' | 'rename' | 'record-decision' | 'claim' | 'save-artifact' | 'register-artifact' | 'experiment-dismiss' | 'complete-visual-review'
}>
/** The question of the decision `set-mode` records. */
const MODE_QUESTION = '模式与路线'
/** The order goals are reported in: one that drives rounds before one that waits. */
const GOAL_PHASE_ORDER: Record<ResearchGoal['phase'], number> = { active: 0, blocked: 1, paused: 2 }
/** A record change prepared outside the project's lock and applied inside it. */
type Commit = (project: ResearchProject) => ResearchResponse | Promise<ResearchResponse>
/** Why the agent is refused a person's command. */
const PERSON_ONLY = 'start-new, relocate, discard-draft, archive-project and unarchive-project are the person\'s commands '
  + '(新研究, 更改位置, 移出列表 and 恢复); the agent never sends them'
/** Why relocate or discard-draft is refused: the research is not the untouched draft (any more). */
const NOT_A_DRAFT = '这项研究已经开始，不能再更改位置或丢弃 / This research has started, so it can no longer be moved or discarded'
/** Why archive-project is refused on the untouched draft, which 新研究 reopens. */
const DRAFT_STAYS = '还没开始的新研究不能移出列表 / The untouched new research cannot be removed from the list'

/** Whether a command is one of the person's own, which the agent never sends. */
function isPersonCommand(request: ResearchCommand): request is PersonCommand {
  return PERSON_ACTIONS.has(request.action)
}

const evidenceTextSchema = z.array(z.object({ text: z.string(), locator: locatorSchema }))

/** Where one evidence revision's extracted text is kept, outside the stored record. */
function textFile(evidence: EvidenceRecord): string {
  return `.research/chunks/${evidence.id}/${evidence.revision}.json`
}

function textKey(projectId: ProjectId, evidence: EvidenceRecord): string {
  return `${projectId}/${evidence.id}/${evidence.revision}`
}

/** Unreadable text leaves that source unsearchable until it can be read again; it is never overwritten. */
async function readEvidenceText(root: string, evidence: EvidenceRecord): Promise<EvidenceRecord['chunks']> {
  try {
    return evidenceTextSchema.parse(JSON.parse(await readFile(await projectPath(root, textFile(evidence)), 'utf8')))
  } catch { return [] }
}

/** Index of a run known to exist: runs are never removed, and the id was read from this project. */
function runAt(project: ResearchProject, id: string): number {
  return project.experiments.findIndex(run => run.id === id)
}

/** The innermost project whose root contains a directory. */
function innermost(projects: readonly ResearchProject[], directory: string): ResearchProject | undefined {
  return projects.filter(project => isInside(project.root, directory)).sort((a, b) => b.root.length - a.root.length)[0]
}

/** A research's listed conversations: the one bound to it and each whose working directory's innermost research it is. */
function conversationsOf(
  project: ResearchProject,
  projects: readonly ResearchProject[],
  sessions: readonly SessionSummary[],
): SessionSummary[] {
  const inside = (cwd: string | undefined): boolean => cwd !== undefined && innermost(projects, cwd)?.id === project.id
  return sessions.filter(session => session.sessionId === project.sessionId || inside(session.cwd))
}

/** The research a live session belongs to: the one bound to it, else the innermost one containing its working directory. */
function researchOf(session: Session, projects: readonly ResearchProject[]): ResearchProject | undefined {
  const bound = projects.find(project => project.sessionId === session.id)
  if (bound !== undefined) return bound
  const { cwd } = session.header
  return cwd === undefined ? undefined : innermost(projects, cwd)
}

declare module '@deepseek-ai/cordis' {
  interface Context { research: ResearchWorkbench }

  interface Events {
    /**
     * A project was created or its mode changed, after the change was stored.
     * The mode's skills follow it into the project's sessions.
     * @param event - the project, its root and the mode now recorded.
     * @mode emit
     */
    'research/mode'(event: ResearchModeEvent): void
  }
}

/** One durable owner for each project's evidence, files, decisions and execution records. */
export class ResearchWorkbench extends TypertRemoteService {
  static inject = ['storageDomain', 'workspaceRegistry', 'sessionController', 'credentials', 'tools', 'llm', 'agents', 'goals', 'sessions', 'permissionPresets']
  static Config: s<Config> = s.object({
    componentRoot: s.string(),
    maxSourceBytes: s.number().min(1024).required(),
    pollIntervalMs: s.number().min(500).required(),
    maxReviewPages: s.number().step(1).min(1).required(),
    researchHome: s.string(),
  })
  private domain!: Domain<typeof researchDomain>
  private readonly tails = new Map<ProjectId, Promise<unknown>>()
  private readonly operations = new Set<Promise<unknown>>()
  /** Runs whose launch is under way outside their project's lock. */
  private readonly launching = new Set<string>()
  /** The latest project creation, draft opening, move or removal; each one waits for the one before it. */
  private creations: Promise<unknown> = Promise.resolve()
  /**
   * Projects known to hold a conversation whose turn has started. A
   * conversation never becomes blank again, so such a project is never
   * the untouched draft again and its sessions need not be listed.
   */
  private readonly started = new Set<ProjectId>()
  /**
   * Extracted evidence text by `project/evidence/revision`. Records are stored
   * without it, so a mutation rewrites kilobytes of ledger rather than the text
   * of every source; the text is written to the project once per revision.
   */
  private readonly evidenceText = new Map<string, EvidenceRecord['chunks']>()
  private readonly lifetime = new AbortController()
  /** Product-owned document, drawing and TeX runtimes, separate from experiment environments. */
  readonly components: ComponentManager
  /** The research-pattern graphs: the built-in one and each project's own. */
  readonly knowledge: KnowledgeBase = new KnowledgeBase(runtimeAsset('kg/ai-kg.json.gz'))
  /** Published papers' Figure 1s to study before drawing, fetched on demand into the product home's cache. */
  readonly gallery: FigureGallery
  /** Each project's experiment board: the agent's layout, filled by scripts on a timer. */
  readonly boards: ExperimentBoards
  /** The installed mode packs, loaded once at start. */
  modes!: ModeRegistry
  /** Each project's newest file time, for whether anything changed since its last check. */
  private readonly fileTimes = new FileTimes()
  private venueLibrary: Promise<VenueLibrary> | undefined
  private refreshResourceRoutes!: () => Promise<void>

  /** Bind the research API and its private tooling directory. */
  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'research')
    if (config.researchHome !== undefined && !isAbsolute(config.researchHome)) {
      throw new Error(`research: researchHome must be an absolute path, not ${config.researchHome}`)
    }
    const root = config.componentRoot ?? join(resolveDshHome(), 'research', 'components')
    this.components = new ComponentManager(root, () => this.domain.global.get())
    this.gallery = new FigureGallery(runtimeAsset('figure-gallery/index.json.gz'), join(dirname(root), 'cache', 'figure-gallery'))
    this.boards = new ExperimentBoards({
      localPython: () => this.components.installedPython(),
      signal: this.lifetime.signal,
      track: (operation) => { this.track(operation) },
      warn: (message) => { this.ctx.logger.warn(message) },
    })
  }

  /**
   * Read every project's evidence text into memory. Records stored before the
   * text moved out of them still carry it inline; they are rewritten without it.
   */
  private async loadEvidenceText(): Promise<void> {
    for (const [id, stored] of this.domain.table('projects').entries()) {
      if (stored.evidence.some(evidence => evidence.chunks.length > 0)) {
        await this.domain.table('projects').put(id, await this.withoutText(structuredClone(stored)))
      } else {
        await Promise.all(stored.evidence.map(async (evidence) => {
          this.evidenceText.set(textKey(id, evidence), await readEvidenceText(stored.root, evidence))
        }))
      }
    }
  }

  /**
   * Keep new evidence text on disk, once per revision, and return the record
   * without it. Text of revisions the record no longer holds leaves memory.
   */
  private async withoutText(project: ResearchProject): Promise<ResearchProject> {
    const live = new Set<string>()
    for (const evidence of project.evidence) {
      const key = textKey(project.id, evidence)
      live.add(key)
      if (!this.evidenceText.has(key)) {
        await atomicWrite(await projectPath(project.root, textFile(evidence)), JSON.stringify(evidence.chunks))
        this.evidenceText.set(key, evidence.chunks)
      }
    }
    for (const key of this.evidenceText.keys()) if (key.startsWith(`${project.id}/`) && !live.has(key)) this.evidenceText.delete(key)
    return { ...project, evidence: project.evidence.map(evidence => ({ ...evidence, chunks: [] })) }
  }

  /** Track one background operation so shutdown can wait for it. */
  private track(operation: Promise<unknown>): void {
    this.operations.add(operation)
    const settle = (): void => { this.operations.delete(operation) }
    void operation.then(settle, settle)
  }

  protected async [Service.init](): Promise<void> {
    const missing = Object.values(AUTONOMY_PRESETS).filter(name => !this.ctx.permissionPresets.names.includes(name))
    if (missing.length) {
      throw new Error(`research: autonomy selects the permission presets ${missing.join(', ')}, which the permission row does not configure`)
    }
    this.modes = await ModeRegistry.load([runtimeAsset('modes')], this.ctx.logger)
    this.domain = await this.ctx.storageDomain.open(researchDomain)
    const cut = [...this.domain.table('tasks').entries()].filter(([, task]) => task.status === 'running')
    await Promise.all(cut.map(([id, task]) => this.domain.table('tasks').put(id, {
      ...task, status: 'interrupted', message: 'The application restarted; independent experiments can be reconnected from the experiment panel',
    })))
    await this.loadEvidenceText()
    // The permission service pins a new session's default in its own listener, registered when it was constructed,
    // before this service (which injects it) started; this listener therefore runs after that pin.
    this.ctx.on('session/created', (session) => { this.align(session, researchOf(session, this.projects())) })
    const projects = this.projects()
    for (const session of this.ctx.sessions.list()) this.align(session, researchOf(session, projects))
    // Tools are the research preset's to mount (./tools), so agents composed from other presets never see them.
    this.refreshResourceRoutes = registerResearchRoutes(this.ctx, this)
    let polling = false
    const timer = setInterval(() => {
      // The interval is cleared before the lifetime aborts, so a tick never runs after shutdown began.
      if (polling) return
      polling = true
      this.track(this.refreshRunning().finally(() => { polling = false }))
    }, this.config.pollIntervalMs)
    this.ctx.effect(() => async () => {
      clearInterval(timer)
      this.knowledge.dispose()
      this.gallery.dispose()
      this.lifetime.abort()
      await Promise.allSettled([...this.operations, ...this.tails.values()])
      await this.domain.close()
    }, 'research.close')
  }

  /**
   * Read detached project snapshots and non-secret component settings.
   * @returns every project without source bodies, with where it stands, the unfinished goals of its live
   * conversations, and whether it is the untouched draft or removed from the list; the preferences, the
   * research home in effect and the component status.
   */
  @Remote
  async snapshot(): Promise<ResearchSnapshot> {
    const projects = this.projects()
    const drafts = await this.draftsForView(projects, projects)
    const withStanding = async (project: ResearchProject): Promise<ResearchProject> => {
      const goals = this.activeGoals(project, projects)
      return {
        ...publicProject(project, drafts.has(project.id)),
        standing: await this.standing(project),
        ...(goals.length === 0 ? {} : { goals }),
      }
    }
    return {
      projects: await Promise.all(projects.map(withStanding)),
      preferences: structuredClone(this.domain.global.get()),
      components: await this.components.status(),
      modes: this.modes.summaries(),
      researchHome: this.researchHome(),
    }
  }

  /**
   * Where new researches are created now: the person's `researchHome`
   * preference, else the configured `researchHome`, else `<profile home>/SciPaper`.
   * @returns the absolute research home.
   */
  researchHome(): string {
    return resolveResearchHome(this.domain.global.get().researchHome, this.config.researchHome)
  }

  /**
   * Where a project stands, derived from its stored progress, its mode and its
   * files; never stored. File times are listed at most every thirty seconds.
   * @param project - the project record.
   * @returns its phases, the next one and what it lacks, the open issues, and whether files changed since the last check.
   */
  standing(project: ResearchProject): Promise<ResearchStanding> {
    return projectStanding(project, this.modes.resolve(project), {
      newest: () => this.fileTimes.newest(project.root),
      exists: path => existsSync(resolve(project.root, path)),
    })
  }

  /**
   * Read durable operation handles, including interrupted calls from prior launches.
   * @returns every recorded task, with project bodies stripped from results.
   */
  @Remote
  tasks(): ResearchTask[] {
    return [...this.domain.table('tasks').entries()].map(([, value]) => ({
      ...structuredClone(value),
      ...(value.result?.project ? { result: { ...value.result, project: publicProject(value.result.project) } } : {}),
    }))
  }

  /**
   * Create (or reopen) a research project around one canonical DSH Workspace. Nothing starts.
   * @param request - title, absolute root, brief, and optional mode and autonomy.
   * @returns the project record.
   */
  @Remote
  async create(request: CreateProjectRequest): Promise<ResearchProject> { return this.createProject(request) }

  /**
   * Create or reopen a project. A caller that already runs in a session (the
   * agent creating its own project) binds that session instead of a new one.
   * @param request - title, absolute root, brief, and optional mode and autonomy.
   * @param sessionId - the calling session to bind, when there is one.
   * @returns the project record.
   */
  async createProject(request: CreateProjectRequest, sessionId?: string): Promise<ResearchProject> {
    z.object({
      title: z.string().trim().min(1), root: z.string().min(1), brief: z.string(),
      mode: z.string().min(1).optional(), route: z.string().min(1).optional(), autonomy: z.enum(autonomies).optional(),
    }).parse(request)
    if (!isAbsolute(request.root)) throw new Error('Choose an absolute project directory')
    const chosen = this.modes.choose(request.mode ?? GENERAL_MODE, request.route)
    // Only a named mode is a choice: without one the project opens in general with the mode not chosen yet.
    const named = request.mode === undefined ? request : { ...request, ...chosen }
    // One creation at a time: two requests for the same folder would otherwise both find no project and record two.
    return this.serialize(() => this.createAt(named, sessionId))
  }

  /** Run one creation, draft opening, move or removal after the one before it has settled. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.creations.catch(() => {}).then(work)
    this.creations = turn
    return turn
  }

  /**
   * Create the project at a folder, or return the one recorded there. A draft
   * takes the placeholder title (`untitled`), its folder's name as its
   * Workspace title, and records whether its folder was created with it.
   */
  private async createAt(request: CreateProjectRequest, sessionId: string | undefined, draft = false): Promise<ResearchProject> {
    // An example opens as it is, bound to no session; no research, and no folder, is made among the examples.
    if (isExampleRoot(request.root)) {
      const found = existsSync(request.root) ? await realpath(request.root) : undefined
      const example = found === undefined ? undefined : this.projects().find(project => sameDirectory(project.root, found))
      if (example === undefined) throw new Error(EXAMPLE_READ_ONLY)
      return this.record(example.id)
    }
    const made = await mkdir(request.root, { recursive: true })
    const root = await realpath(request.root)
    assertUsableProjectRoot(root)
    const existing = this.projects().find(project => sameDirectory(project.root, root))
    if (existing) {
      if (!existing.sessionId) {
        await this.mutate(existing.id, async (project) => {
          project.sessionId = sessionId ?? (await this.ctx.sessionController.create({ workspaceId: project.workspaceId, agentPreset: 'research' })).sessionId
        })
      }
      return this.record(existing.id)
    }
    // create() reuses a workspace already registered for this directory, so a
    // retry after a failed launch never produces a duplicate sidebar entry.
    const workspace = await this.ctx.workspaceRegistry.create(root, draft ? undefined : request.title)
    const project = newProject({ ...request, root }, workspace.id)
    if (draft) {
      project.untitled = true
      if (made !== undefined) project.createdRoot = true
    }
    for (const directory of SCAFFOLD) {
      await mkdir(await projectPath(root, directory), { recursive: true })
    }
    project.sessionId = sessionId ?? (await this.ctx.sessionController.create({ workspaceId: project.workspaceId, agentPreset: 'research' })).sessionId
    await this.domain.table('projects').put(project.id, project)
    this.announceMode(project.id)
    // The bound session went live before the record existed, and so did any conversation already open in the folder.
    this.alignConversations(project.id)
    return structuredClone(project)
  }

  /** Runs a mode pack's gates with the installed platform Python; a check never installs it. */
  private gates(signal: AbortSignal): GateRunner {
    return createGateRunner(() => this.components.installedPython(), signal)
  }

  /** The venue template library, read on first use. */
  private venues(): Promise<VenueLibrary> {
    this.venueLibrary ??= loadVenues(runtimeAsset('venues'))
    return this.venueLibrary
  }

  /** The configured embedding endpoint with its key, or undefined when either is missing. */
  private async embedder(): Promise<Embedder | undefined> {
    const binding = this.domain.global.get().embedding
    if (!binding) return undefined
    const credential = await this.ctx.credentials.resolve(credentialRef(EMBEDDING_CREDENTIAL))
    return credential ? createEmbedder(binding, credential.value) : undefined
  }

  /** Tell listeners (the mode's skill catalog) which mode a project now records. */
  private announceMode(id: ProjectId): void {
    const { root, mode, route } = this.record(id)
    this.ctx.emit('research/mode', { projectId: id, root, mode, ...(route === undefined ? {} : { route }) })
  }

  /**
   * Save model roles, explicitly bound tool locations, the research home and
   * whether examples are listed, never model secrets. A research home among
   * the examples is refused.
   * @param preferences - the complete preference record.
   * @returns the preferences as stored.
   */
  @Remote
  async configure(preferences: ResearchPreferences): Promise<ResearchPreferences> {
    const parsed = preferencesSchema.parse(preferences)
    // Nothing is made among the examples, so new researches cannot go there either.
    if (parsed.researchHome !== undefined && isExampleRoot(parsed.researchHome)) throw new Error(EXAMPLE_READ_ONLY)
    await this.domain.global.set(parsed)
    return parsed
  }

  /**
   * Store a provider's API key under its fixed research credential name.
   * @param kind - the image provider or the embedding endpoint; it must be configured first.
   * @param value - the API key.
   */
  @Remote
  async setCredential(kind: 'image' | 'embedding', value: string): Promise<void> {
    if (!this.domain.global.get()[kind]) throw new Error(`Configure the ${kind} provider before setting its credential`)
    if (!value.trim()) throw new Error('The API key is empty')
    await this.ctx.credentials.set(credentialRef(kind === 'image' ? IMAGE_CREDENTIAL : EMBEDDING_CREDENTIAL), value.trim())
  }

  /**
   * Provision a tool component as a queryable background operation.
   * @param component - which managed tool to install.
   * @returns the job handle to follow through tasks().
   */
  @Remote
  installComponent(component: 'python' | 'uv' | 'latex' | 'drawio'): Promise<ResearchResponse> {
    return this.begin(`install-${component}`, undefined, async (signal) => {
      const path = await this.components[component](signal)
      if (component === 'drawio') await this.refreshResourceRoutes()
      return { message: `${component} ready`, path }
    })
  }

  /**
   * Admit a desktop action; long operations return a job the desktop follows.
   * @param request - one research command.
   * @param signal - cancellation of the call.
   * @returns the outcome, or a job handle for a long operation.
   */
  @Remote
  async command(request: ResearchCommand, signal: AbortSignal): Promise<ResearchResponse> { return this.execute(request, signal, 'user') }

  /**
   * Every project record, detached, without evidence text (see getProject).
   * @returns copies of all project records.
   */
  projects(): ResearchProject[] {
    return [...this.domain.table('projects').entries()].map(([, value]) => structuredClone(value))
  }

  /**
   * One project's record with its evidence text, for tools and checks that read sources.
   * @param id - the project.
   * @returns a detached copy of its record.
   */
  getProject(id: ProjectId): ResearchProject {
    const project = this.record(id)
    for (const evidence of project.evidence) evidence.chunks = structuredClone(this.evidenceText.get(textKey(id, evidence)) ?? [])
    return project
  }

  /** A detached project record without evidence text, for work that never reads it. */
  private record(id: ProjectId): ResearchProject {
    const project = this.domain.table('projects').get(id)
    if (!project) throw new Error(`Research project not found: ${id}`)
    return structuredClone(project)
  }

  /**
   * The project whose root contains a directory, preferring the innermost one.
   * @param directory - a session's working directory.
   * @returns that project, or undefined outside every project.
   */
  async projectAt(directory: string): Promise<ResearchProject | undefined> {
    let canonical: string
    try { canonical = await realpath(directory) } catch { return undefined }
    return innermost(this.projects(), canonical)
  }

  /**
   * The unfinished goals of a project's live conversations, read through the
   * goal service: every live top-level session whose working directory lies in
   * the project (and in no project nested inside it) and whose goal is not
   * complete. A conversation that is not loaded is not seen.
   * @param project - the project record.
   * @param projects - every project, which decides the research a working directory belongs to; read afresh when absent.
   * @returns the goals, those that drive rounds first, then the most recently changed.
   */
  activeGoals(project: ResearchProject, projects?: readonly ResearchProject[]): ResearchGoal[] {
    const all = projects ?? this.projects()
    const goals: ResearchGoal[] = []
    for (const agent of this.ctx.agents.list()) {
      const { cwd, origin } = agent.session.header
      if (cwd === undefined || origin === 'subagent' || innermost(all, cwd)?.id !== project.id) continue
      let goal: GoalView | undefined
      // A goal log that no longer replays, or an agent unloaded since the listing, holds no goal to continue.
      try { goal = this.ctx.goals.get(agent) } catch { continue }
      if (goal === undefined || goal.phase === 'complete') continue
      const { objective, phase, roundsStarted, updatedAt } = goal
      goals.push({ sessionId: agent.session.id, objective, phase, roundsStarted, updatedAt })
    }
    return goals.sort((a, b) => GOAL_PHASE_ORDER[a.phase] - GOAL_PHASE_ORDER[b.phase] || b.updatedAt - a.updatedAt)
  }

  /**
   * Give a live session the permission preset its research's autonomy selects.
   * A session outside every research, a session of an example and a delegated
   * child, whose permission its delegation fixed, are left as they are. A
   * failure is logged, not thrown: a throw while a session is published would
   * refuse the session.
   */
  private align(session: Session, project: ResearchProject | undefined): void {
    if (project === undefined || isExampleRoot(project.root) || session.header.origin === 'subagent') return
    try { this.ctx.permissionPresets.set(session, AUTONOMY_PRESETS[project.autonomy]) } catch (error) {
      this.ctx.logger.warn('research autonomy for session %s: %s', session.id, errorText(error))
    }
  }

  /** Give every live conversation of a project the permission preset of its autonomy. */
  private alignConversations(id: ProjectId): void {
    const projects = this.projects()
    for (const session of this.ctx.sessions.list()) {
      const project = researchOf(session, projects)
      if (project?.id === id) this.align(session, project)
    }
  }

  /** Run work in a project's one-at-a-time queue, after every change queued before it. */
  private queued<T>(id: ProjectId, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(() => {
      this.lifetime.signal.throwIfAborted()
      return work()
    })
    this.tails.set(id, result)
    void result.finally(() => { if (this.tails.get(id) === result) this.tails.delete(id) }).catch(() => {})
    return result
  }

  /** Serialize graph transitions; an editor conflict still commits adoption of the externally changed file. */
  private mutate<T>(id: ProjectId, work: (project: ResearchProject) => T | Promise<T>): Promise<T> {
    return this.queued(id, async () => {
      const project = this.getProject(id)
      // The last line of the example guard: whatever path reaches here, an example's record never changes.
      if (isExampleRoot(project.root)) throw new Error(EXAMPLE_READ_ONLY)
      const result = await Promise.resolve().then(() => work(project)).then(value => ({ value }), (error: unknown) => {
        if (error instanceof ArtifactRevisionConflict) return { error }
        throw error
      })
      project.revision++
      project.updatedAt = new Date().toISOString()
      await this.domain.table('projects').put(id, await this.withoutText(project))
      if ('error' in result) throw result.error
      return result.value
    })
  }

  private async begin(
    kind: string,
    projectId: ProjectId | undefined,
    work: (signal: AbortSignal) => Promise<ResearchResponse>,
  ): Promise<ResearchResponse> {
    const task: ResearchTask = {
      id: randomUUID(), kind, ...(projectId ? { projectId } : {}),
      status: 'running', message: kind, createdAt: new Date().toISOString(),
    }
    await this.domain.table('tasks').put(task.id, task)
    const operation = Promise.resolve().then(() => work(this.lifetime.signal)).then(
      async (result) => {
        await this.domain.table('tasks').put(task.id, { ...task, status: 'completed', message: result.message, result })
      },
      async (error: unknown) => {
        await this.domain.table('tasks').put(task.id, { ...task, status: this.lifetime.signal.aborted ? 'interrupted' : 'failed', message: errorText(error) })
      },
    ).finally(() => { this.operations.delete(operation) })
    this.operations.add(operation)
    return { jobId: task.id, message: `${kind} started` }
  }

  /** Apply the configured byte ceiling to the complete response body. */
  private clipped(value: ResearchResponse): ResearchResponse {
    return value.content === undefined ? value : { ...value, content: truncateBytes(value.content, this.config.maxSourceBytes) }
  }

  /**
   * Dispatch a validated tool or desktop command. The desktop receives a job
   * for long operations; the agent waits for the result inside its tool call.
   * `start-new`, `relocate`, `discard-draft`, `archive-project` and
   * `unarchive-project` are the desktop's alone.
   * @param raw - the command as received.
   * @param signal - cancellation of the call.
   * @param actor - who acts: the desktop user or the agent.
   * @param sessionId - the agent's conversation, recorded on the runs it submits; absent for the desktop.
   * @returns the outcome.
   */
  async execute(raw: ResearchCommand, signal: AbortSignal, actor: 'user' | 'agent', sessionId?: string): Promise<ResearchResponse> {
    const request = commandSchema.parse(raw) as ResearchCommand
    if (isPersonCommand(request)) {
      if (actor !== 'user') throw new Error(PERSON_ONLY)
      return this.personCommand(request)
    }
    const project = this.record(request.projectId)
    // An example can be read and checked; nothing is recorded into it, whoever asks.
    const example = isExampleRoot(project.root)
    switch (request.action) {
      case 'search-evidence': return this.clipped(searchEvidence(this.getProject(project.id), request.query, this.config.maxSourceBytes))
      case 'read-artifact': {
        const artifact = project.artifacts.find(a => a.id === request.artifactId)
        if (!artifact) throw new Error('Artifact not found')
        const target = await projectPath(project.root, artifact.path)
        // A binary file has no text to return, and save-artifact refuses to write text over it.
        if (await isBinaryFile(target)) return { message: `Revision ${artifact.revision}; a binary file, so no text`, content: '', path: artifact.path, binary: true }
        return { message: `Revision ${artifact.revision}`, content: await readText(target, this.config.maxSourceBytes), path: artifact.path }
      }
      case 'experiment-logs': {
        const run = project.experiments.find(r => r.id === request.runId)
        if (!run) throw new Error('Experiment not found')
        return this.clipped({ message: 'Experiment logs', content: await experimentLogs(project, run, signal) })
      }
      case 'check': {
        const snapshot = this.getProject(project.id)
        const mode = this.modes.resolve(snapshot)
        const check = await runChecks(snapshot, this.config.maxSourceBytes, request.scope, mode, this.gates(signal))
        // research_check is the one writer of progress; lastCheck stays for readers of earlier versions.
        if (!example) {
          await this.mutate(project.id, (current) => {
            current.progress = mergeProgress(storedProgress(current, mode), check, mode)
            current.lastCheck = check
          })
        }
        return { message: check.clean ? 'Clean' : 'Not done yet: fix the errors and check again', check }
      }
      case 'experiment-wait': return this.waitForRuns(project.id, request.runIds, request.timeoutSeconds, signal)
      case 'find-reference-figures': {
        const { query, pattern, venue, year, tier, limit, offset } = request
        const page = await this.gallery.search({ query, pattern, venue, year, tier, limit, offset }, await this.embedder(), signal)
        return {
          message: `${page.total} gallery figure(s) (${page.basis}); fetch-reference-figures {galleryIds, label} saves the ones to study`,
          gallery: page,
        }
      }
      // The board lives in its own files, never in the project record, so none of these changes the record.
      case 'board-get': {
        const { spec, problem } = await this.boards.layout(project.root)
        return { message: problem ?? `Board: ${spec.sections.length} section(s), ${spec.collectors.length} collector(s)`, content: JSON.stringify(spec) }
      }
      case 'board-update': {
        if (example) throw new Error(EXAMPLE_READ_ONLY)
        const spec = await this.boards.update(project.root, request.board, request.replace ?? false)
        const missing = await missingScripts(project.root, spec)
        const waiting = unmatched(project, spec)
        const notes = [
          ...missing.length ? [`collector script(s) not written yet: ${missing.join(', ')}`] : [],
          ...waiting.length ? [`waiting for runs not submitted yet: ${waiting.slice(0, 10).join(', ')}`] : [],
        ]
        return {
          message: `Board saved: ${spec.sections.length} section(s), ${spec.collectors.length} collector(s)${notes.map(note => `; ${note}`).join('')}. `
            + 'Its numbers refresh by themselves; board-refresh runs the collectors now.',
        }
      }
      case 'board-refresh': {
        if (example) throw new Error(EXAMPLE_READ_ONLY)
        const report = await this.boards.refresh(project, signal)
        const failed = report.collectors.filter(collector => !collector.ok).length + report.machines.filter(machine => machine.error).length
        return { message: failed ? `Board read with ${failed} problem(s); see each collector's and machine's error` : 'Board read', content: JSON.stringify(report) }
      }
      // An example's board is shown as it was last read: a new read would write its cache into the example.
      case 'board-view': return { message: 'Experiment board', board: await this.boards.view(project, !example && (request.refresh ?? false), request.runs ?? []) }
      default: {
        if (example) throw new Error(EXAMPLE_READ_ONLY)
        const work = async (workSignal: AbortSignal): Promise<ResearchResponse> => {
          const prepared = await this.prepare(project.id, request, workSignal, actor, sessionId)
          const value = typeof prepared === 'function' ? await this.mutate(project.id, prepared) : prepared
          if (request.action === 'set-mode') this.announceMode(project.id)
          if (request.action === 'set-autonomy') this.alignConversations(project.id)
          return this.clipped({ ...value, project: await this.presented(this.record(project.id)) })
        }
        return LONG_ACTIONS.has(request.action) && actor === 'user' ? this.begin(request.action, project.id, work) : work(signal)
      }
    }
  }

  /**
   * Open, move or remove the untouched draft, or remove a research from the
   * list or restore it; each waits for every creation before it, so two
   * never make two drafts and a research is never archived while it is the draft.
   */
  private personCommand(request: PersonCommand): Promise<ResearchResponse> {
    switch (request.action) {
      case 'start-new': return this.serialize(() => this.startNew())
      case 'relocate': return this.serialize(() => this.relocate(request))
      case 'discard-draft': return this.serialize(async () => {
        await this.discard(request.projectId)
        return { message: 'The untouched new research was removed' }
      })
      case 'archive-project': return this.serialize(() => this.archive(request.projectId))
      case 'unarchive-project': return this.serialize(() => this.unarchive(request.projectId))
    }
  }

  /**
   * archive-project: remove a research from the list. Every top-level
   * conversation of it (bound to it, or working in its folder and in no
   * research nested there) that is not archived yet is archived through the
   * Workspace registry, the archive the shell's own archive action and its
   * archived-conversations settings page use. The record stores when, and
   * which conversations it archives, before any is archived, so a removal
   * cut short can still be restored; repeating it archives any conversation
   * added since. Delegated children follow their parent and are left alone;
   * nothing on disk changes. Active conversations refuse the operation before
   * it writes. An archive failure reverses this operation's completed writes;
   * a failed reversal retains the restoration record.
   */
  private async archive(id: ProjectId): Promise<ResearchResponse> {
    const project = this.record(id)
    if (isExampleRoot(project.root)) throw new Error(EXAMPLE_READ_ONLY)
    const projects = this.projects()
    if ((await this.drafts([project], projects)).has(id)) throw new Error(DRAFT_STAYS)
    const { items } = await this.ctx.sessionController.list({}, this.lifetime.signal)
    const archived = new Set<string>(this.ctx.workspaceRegistry.archivedSessionIds)
    const conversations = conversationsOf(project, projects, items)
      .filter(conversation => conversation.origin !== 'subagent' && !archived.has(conversation.sessionId))
      .map(conversation => conversation.sessionId)
    for (const sessionId of conversations) {
      const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
      if (activity.length > 0) throw new WorkspaceActiveSessionError(sessionId, activity)
    }
    const previous = { archivedAt: project.archivedAt, conversations: project.archivedConversations?.slice() }
    await this.mutate(id, (current) => {
      current.archivedAt ??= new Date().toISOString()
      const recorded = [...new Set([...current.archivedConversations ?? [], ...conversations])]
      if (recorded.length > 0) current.archivedConversations = recorded
    })
    const completed: SessionId[] = []
    try {
      for (const sessionId of conversations) {
        await this.ctx.workspaceRegistry.archiveSession(sessionId)
        completed.push(sessionId)
      }
    } catch (error) {
      const failures: unknown[] = []
      for (const sessionId of completed.reverse()) {
        try { await this.ctx.workspaceRegistry.unarchiveSession(sessionId) }
        catch (failure) { failures.push(failure) }
      }
      if (failures.length === 0) {
        await this.mutate(id, (current) => {
          if (previous.archivedAt === undefined) delete current.archivedAt
          else current.archivedAt = previous.archivedAt
          if (previous.conversations === undefined) delete current.archivedConversations
          else current.archivedConversations = previous.conversations
        })
      } else {
        throw new AggregateError([error, ...failures], 'Research archive failed; restore the research to recover its conversations')
      }
      throw error
    }
    return {
      message: `Removed from the list: ${conversations.length} conversation(s) archived; its folder and runs are untouched`,
      project: await this.presented(this.record(id)),
    }
  }

  /**
   * unarchive-project: list a research again. The conversations
   * archive-project archived are unarchived before the record changes, so a
   * restore cut short can be repeated; a conversation the person had
   * archived before stays archived. A research in the list is answered as it is.
   */
  private async unarchive(id: ProjectId): Promise<ResearchResponse> {
    const project = this.record(id)
    if (isExampleRoot(project.root)) throw new Error(EXAMPLE_READ_ONLY)
    if (project.archivedAt === undefined) return { message: 'The research is in the list', project: await this.presented(project) }
    const conversations = project.archivedConversations ?? []
    for (const sessionId of conversations) await this.ctx.workspaceRegistry.unarchiveSession(sessionId as SessionId)
    await this.mutate(id, (current) => {
      delete current.archivedAt
      delete current.archivedConversations
    })
    return {
      message: `Restored to the list: ${conversations.length} conversation(s) unarchived`,
      project: await this.presented(this.record(id)),
    }
  }

  /**
   * The untouched researches among some projects, each with its listed
   * conversations. An untouched research's record holds nothing but its
   * autonomy (`blankRecord`), it is not an example, its folder holds only the
   * empty scaffold, and every conversation of it is blank: bound to it or
   * working in its folder, with no turn started. Sessions are listed only
   * when a project passes the other tests.
   * @param candidates - the projects to test.
   * @param all - every project, which decides the research a conversation's folder belongs to.
   * @returns the untouched researches, each with its conversations.
   */
  private async untouched(
    candidates: Iterable<ResearchProject>,
    all: readonly ResearchProject[],
  ): Promise<{ project: ResearchProject; conversations: SessionSummary[] }[]> {
    const unstarted: ResearchProject[] = []
    for (const project of candidates) {
      const recordBlank = blankRecord(project) && !isExampleRoot(project.root) && !this.started.has(project.id)
      if (recordBlank && await onlyScaffold(project.root)) unstarted.push(project)
    }
    const untouched: { project: ResearchProject; conversations: SessionSummary[] }[] = []
    if (unstarted.length === 0) return untouched
    const { items } = await this.ctx.sessionController.list({}, this.lifetime.signal)
    for (const project of unstarted) {
      const conversations = conversationsOf(project, all, items)
      if (conversations.every(conversation => conversation.blank)) untouched.push({ project, conversations })
      else this.started.add(project.id)
    }
    return untouched
  }

  /**
   * The draft among some projects: the newest untouched research of all
   * (`untouched`), so one whose files were removed again, or one restored to
   * the list, reads as a research of its own beside a newer draft.
   * @param candidates - the projects to test.
   * @param all - every project, among which the newest untouched one is the draft.
   * @returns the draft's id with its conversations, when it is among the candidates.
   */
  private async drafts(
    candidates: readonly ResearchProject[],
    all: readonly ResearchProject[] = candidates,
  ): Promise<Map<ProjectId, SessionSummary[]>> {
    const tested = new Map([...all.filter(blankRecord), ...candidates].map(project => [project.id, project]))
    const [newest] = (await this.untouched(tested.values(), all))
      .sort((a, b) => b.project.createdAt.localeCompare(a.project.createdAt))
    const drafts = new Map<ProjectId, SessionSummary[]>()
    const listed = newest !== undefined && candidates.some(project => project.id === newest.project.id)
    if (listed) drafts.set(newest.project.id, newest.conversations)
    return drafts
  }

  /**
   * The untouched drafts for a view of the projects. When sessions cannot be
   * listed, no project reads as a draft, rather than the snapshot failing, or
   * a command whose change is already stored.
   */
  private async draftsForView(
    candidates: readonly ResearchProject[],
    all: readonly ResearchProject[],
  ): Promise<ReadonlyMap<ProjectId, unknown>> {
    try { return await this.drafts(candidates, all) } catch (error) {
      this.ctx.logger.warn('research drafts: %s', errorText(error))
      return new Map()
    }
  }

  /** A project for the desktop, with its derived draft flag; only a blank record costs a look at the other projects. */
  private async presented(project: ResearchProject): Promise<ResearchProject> {
    const draft = blankRecord(project) && (await this.draftsForView([project], this.projects())).has(project.id)
    return publicProject(project, draft)
  }

  /** The draft's bound conversation, or a new blank one in its folder when the bound one was removed from the list. */
  private async blankConversation(project: ResearchProject): Promise<string> {
    const bound = project.sessionId
    if (bound !== undefined && !this.ctx.workspaceRegistry.archivedSessionIds.includes(bound as SessionId)) return bound
    return (await this.ctx.sessionController.create({ workspaceId: project.workspaceId, agentPreset: 'research' })).sessionId
  }

  /**
   * start-new: reopen the draft (the newest untouched research), or create `<research home>/<yyyy-mm-dd>-<n>` with the next free `n`, its
   * record (`untitled`, titled 新研究, general with no mode chosen), its
   * folder's Workspace and one blank conversation. Nothing is reused or made
   * among the examples, and no draft is made inside another research.
   */
  private async startNew(): Promise<ResearchResponse> {
    const projects = this.projects()
    const drafts = await this.drafts(projects)
    const reused = projects.find(project => drafts.has(project.id))
    if (reused !== undefined) {
      // A draft folder removed by hand comes back with its empty folders.
      for (const directory of SCAFFOLD) await mkdir(join(reused.root, directory), { recursive: true })
      return { message: 'The untouched new research', project: publicProject(reused, true), sessionId: await this.blankConversation(reused) }
    }
    const home = this.researchHome()
    if (isExampleRoot(home)) throw new Error(EXAMPLE_READ_ONLY)
    const root = nextDraftRoot(await canonicalPath(home), new Date(), path => projects.some(project => sameDirectory(project.root, path)))
    const around = innermost(projects, root)
    if (around !== undefined) {
      throw new Error(`研究存放位置在研究「${around.title}」里面，请在设置里换一个位置 / The research location lies inside the research "${around.title}"; choose another one in Settings`)
    }
    assertUsableProjectRoot(root)
    const created = await this.createAt({ title: DRAFT_TITLE, root, brief: '' }, undefined, true)
    return { message: 'New research created', project: publicProject(created, true), sessionId: created.sessionId }
  }

  /**
   * relocate: move the untouched draft to the folder the person chose. A
   * folder among the examples, one that already is a research, one inside a
   * research (the draft's own included) and one that holds files (until
   * confirmed) are reported instead. Otherwise the research is created
   * there, with the draft's autonomy, and the draft is discarded.
   */
  private async relocate(request: Extract<PersonCommand, { action: 'relocate' }>): Promise<ResearchResponse> {
    const draft = this.record(request.projectId)
    if (!(await this.drafts([draft], this.projects())).has(draft.id)) throw new Error(NOT_A_DRAFT)
    if (!isAbsolute(request.root)) throw new Error('Choose an absolute folder')
    const root = await canonicalPath(request.root)
    if (isExampleRoot(root)) return { message: 'The folder is among the examples, which are read-only', outcome: 'example' }
    if (sameDirectory(root, draft.root)) {
      return { message: 'The research is already in this folder', outcome: 'moved', project: publicProject(draft, true), sessionId: await this.blankConversation(draft) }
    }
    const projects = this.projects()
    const existing = projects.find(project => sameDirectory(project.root, root))
    if (existing !== undefined) {
      return { message: 'The folder already is a research', outcome: 'existing', project: await this.presented(existing), sessionId: existing.sessionId }
    }
    const around = innermost(projects, root)
    if (around !== undefined) return { message: 'The folder lies inside a research', outcome: 'nested', project: await this.presented(around) }
    assertUsableProjectRoot(root)
    if (request.confirmNonEmpty !== true && await holdsFiles(root)) {
      return { message: 'The folder holds files; repeat with confirmNonEmpty to create the research beside them', outcome: 'needs-confirm' }
    }
    const moved = await this.createAt({ title: DRAFT_TITLE, root, brief: '', autonomy: draft.autonomy }, undefined, true)
    await this.discard(draft.id)
    return { message: 'Research moved', outcome: 'moved', project: await this.presented(moved), sessionId: moved.sessionId }
  }

  /**
   * Remove an untouched draft inside its project's queue: archive its blank
   * conversations, delete its folder's Workspace registration and its
   * record, then remove the empty folders it made. A folder that holds
   * anything stays; failing to remove an empty one is logged, not thrown.
   */
  private discard(id: ProjectId): Promise<void> {
    return this.queued(id, async () => {
      const project = this.record(id)
      // Untouched is enough: a relocated draft has a newer one beside it by now.
      const [untouched] = await this.untouched([project], this.projects())
      if (untouched === undefined) throw new Error(NOT_A_DRAFT)
      for (const conversation of untouched.conversations) await this.ctx.workspaceRegistry.archiveSession(conversation.sessionId)
      await this.ctx.workspaceRegistry.delete(project.workspaceId)
      await this.domain.table('projects').delete(id)
      try { await removeEmptyScaffold(project.root, project.createdRoot === true) } catch (error) {
        this.ctx.logger.warn('research draft folder %s: %s', project.root, errorText(error))
      }
    })
  }

  /**
   * Do an action's slow part (processes, network, SSH) on a detached snapshot,
   * outside the project's lock, and return the change to record inside it. A
   * compile therefore never holds up a save, and a hung SSH host never holds up
   * the project. Short actions run entirely inside the lock.
   * @returns the response itself when nothing is left to record, or the change to apply.
   */
  private async prepare(
    id: ProjectId,
    request: RecordingCommand,
    signal: AbortSignal,
    actor: 'user' | 'agent',
    sessionId: string | undefined,
  ): Promise<ResearchResponse | Commit> {
    const limit = this.config.maxSourceBytes
    switch (request.action) {
      case 'import': {
        const snapshot = this.record(id)
        const sources: EvidenceRecord[] = []
        for (const path of request.paths) sources.push(await importEvidence(snapshot, path, this.components, signal, limit))
        return async (project) => {
          for (const source of sources) {
            // Content already imported, before or earlier in this batch: drop the copy instead of orphaning it.
            if (project.evidence.some(e => e.sha256 === source.sha256)) await rm(await projectPath(project.root, `.research/sources/${source.id}`), { recursive: true, force: true })
            else project.evidence.push(source)
          }
          return { message: 'Sources imported with immutable snapshots' }
        }
      }
      case 'import-template': {
        const copied = await importTemplate(this.record(id), request.paths, limit)
        return { message: `Template files copied: ${copied.length}`, content: copied.join('\n') }
      }
      case 'refresh-evidence': {
        const snapshot = this.record(id)
        const previous = snapshot.evidence.find(e => e.id === request.evidenceId)
        if (!previous?.originalPath) throw new Error('This source has no refreshable original file')
        const next = await importEvidence(snapshot, previous.originalPath, this.components, signal, limit, previous)
        const message = 'Source checked; dependent results are marked out of date when content changes'
        if (next.revision === previous.revision) return { message }
        return (project) => {
          // A refresh that finished first has already recorded this revision.
          if (project.evidence.some(e => e.id === previous.id && e.revision === previous.revision)) {
            invalidate(project, { evidenceId: previous.id })
            project.evidence = project.evidence.map(e => e.id === previous.id ? next : e)
          }
          return { message }
        }
      }
      case 'literature-search': return { message: 'Scholarly metadata retrieved', literature: await searchLiterature(request.provider, request.query, signal) }
      case 'literature-import': {
        const item = await verifyLiterature(request.item, signal)
        const evidenceId = randomUUID() as EvidenceId
        const fullText = await this.openAccessText(this.record(id).root, evidenceId, item, signal)
        return async (project) => {
          const content = JSON.stringify(item, null, 2)
          const path = `.research/sources/${evidenceId}/reference.json`
          await atomicWrite(await projectPath(project.root, path), content)
          const summary = { text: item.abstract || item.title, locator: { key: item.abstract ? 'abstract' : 'title' } }
          const bibtex = { text: item.bibtex, locator: { key: 'bibtex' } }
          project.evidence.push({
            id: evidenceId, kind: 'literature', title: item.title, path, sha256: hashBytes(content), revision: 1,
            importedAt: new Date().toISOString(),
            chunks: 'path' in fullText ? [summary, ...fullText.chunks, bibtex] : [summary, bibtex],
            sourceUrl: item.url, ...(item.doi ? { doi: item.doi } : {}), ...('path' in fullText ? { fullTextPath: fullText.path } : {}),
            coverage: 'path' in fullText ? 'full-text' : item.abstract ? 'abstract' : 'metadata', verified: true, stale: false,
          })
          const found = 'path' in fullText ? `with its open-access full text (${fullText.path})` : `without full text (${fullText.reason})`
          return { message: `Citation metadata verified and imported ${found}; add the BibTeX to the bibliography`, content: item.bibtex }
        }
      }
      case 'environment': {
        const environment = await createEnvironment(this.record(id), request.environment, this.components, signal)
        return (project) => {
          if (environment.isDefault) for (const existing of project.environments) existing.isDefault = false
          project.environments.push(environment)
          return { message: `Experiment environment ready: ${environment.id}`, path: environment.python }
        }
      }
      case 'experiment': return this.submitExperiment(id, request, signal, sessionId)
      case 'experiment-refresh':
      case 'experiment-cancel': {
        const snapshot = this.record(id)
        const run = snapshot.experiments.find(r => r.id === request.runId)
        if (!run) throw new Error('Experiment not found')
        if (this.launching.has(run.id)) throw new Error('This run is still being submitted; wait for the submission to finish')
        const updated = await this.observe(id, snapshot, run, request.action === 'experiment-cancel' ? 'cancel' : 'status', signal)
        return { message: updated.status, runs: [runView(updated)] }
      }
      case 'compile': {
        const artifact = await this.mutate(id, project => compileTarget(project, request, limit))
        const result = await compilePaper(this.record(id), artifact, request.engine, this.components, signal, limit)
        return (project) => {
          project.compilations.push(result)
          return {
            message: result.status === 'completed' ? `PDF built: ${result.pdfPath}. Look at it: render-pages, then read_image.` : `No PDF was produced; see the diagnostics and ${result.logPath}`,
            path: result.pdfPath, content: result.diagnostics.join('\n'),
          }
        }
      }
      case 'render-pages': {
        const pages = request.maxPages ?? this.config.maxReviewPages
        const { paths, review } = await renderPages(this.record(id), request.artifactId, pages, this.components, signal)
        return (project) => {
          project.visualReviews.push(review)
          return { message: `${paths.length} page image(s); inspect each with read_image`, paths }
        }
      }
      case 'visual-review': return this.visualReview(id, request.artifactId, signal)
      case 'run-script': {
        const snapshot = this.record(id)
        const mode = this.modes.resolve(snapshot)
        const { route } = mode
        const onRoute = (routes: string[] | undefined): boolean => routes === undefined || (route !== undefined && routes.includes(route))
        const script = mode.pack.scripts.find(item => item.id === request.script && onRoute(item.routes))
        if (!script) {
          const available = mode.pack.scripts.map(item => item.id)
          throw new Error(`Mode ${mode.pack.id} has no script ${request.script}${available.length ? `; its scripts: ${available.join(', ')}` : ''}`)
        }
        const python = await this.components.python(signal)
        const result = await runPackScript(python, script, mode, snapshot, request.args ?? [], signal)
        return {
          message: result.code === 0 ? `${script.id} finished` : `${script.id} exited with code ${result.code}; see its output`,
          content: `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ''}`,
        }
      }
      case 'audit-svg': {
        const { report, saved } = await auditSvg(await this.components.python(signal), this.record(id).root, request.path, request, signal)
        const counts = `${report.errors.length} error(s), ${report.warnings.length} warning(s)`
        return {
          message: `SVG audit ${report.ok ? 'passed' : 'failed'}: ${counts}${saved ? `; report saved to ${saved}` : ''}`,
          content: JSON.stringify({ ok: report.ok, errors: report.errors, warnings: report.warnings, stats: report.stats }),
          ...saved ? { path: saved } : {},
        }
      }
      case 'export-figure': {
        const figure = await exportFigure(await this.components.python(signal), this.record(id).root, request.path, request.output, signal)
        const fonts = figure.text ? `${figure.embedded ? 'embedded' : 'unembedded'} fonts ${figure.fonts.join(', ')}` : 'NO live text: the labels were lost or outlined'
        return {
          message: `Vector PDF written to ${figure.pdf} (${fonts}${figure.markers ? `; ${figure.markers} marker(s) drawn as shapes` : ''}); `
            + `previews ${figure.previews.join(', ')}: look at them with read_image`,
          path: figure.pdf, paths: [figure.pdf, ...figure.previews], content: JSON.stringify(figure),
        }
      }
      case 'generate-image': return this.generateImage(id, request, signal)
      case 'fetch-reference-figures': return this.referenceFigures(id, request, signal)
      case 'export': {
        // The package carries its own check report; progress is research_check's alone to record.
        const snapshot = this.getProject(id)
        const check = await runChecks(snapshot, limit, 'all', this.modes.resolve(snapshot), this.gates(signal))
        const result = await exportPaper(snapshot, limit, check)
        return { message: result.final ? 'Submission package exported' : 'Draft exported; the bundled check report lists what is still open', path: result.path, check }
      }
      case 'list-venues': {
        const venues = listVenues(await this.venues(), request.query)
        return { message: `${venues.length} venue(s)${request.query ? ` match "${request.query}"` : ''}`, content: JSON.stringify(venues) }
      }
      case 'apply-template': {
        const applied = await applyVenue(await this.venues(), this.record(id).root, request.venue, request.stage)
        const { venue, kit, stage } = applied
        const holds = `the kit${venue.example ? ', its example' : ''}${venue.guide ? ' and GUIDE.md' : ''}`
        const notes = venue.notes.length ? `. Notes: ${venue.notes.join('; ')}` : ''
        return (project) => {
          project.venue = venue.id
          return {
            message: `${venue.name} template applied for ${stage} (${kit.name}): template/${venue.id}/ holds ${holds}; `
              + `template.json, main.tex.tmpl and the style files are in the project root${notes}`,
            paths: applied.written,
            content: JSON.stringify({
              venue: venue.id, kit: kit.id, stage, anonymous: venue.anonymous, url: venue.url, notes: venue.notes,
            }),
          }
        }
      }
      case 'graph-status': {
        const status = await this.knowledge.status(this.record(id).root, this.domain.global.get().embedding?.model)
        return { message: 'Knowledge graphs available to this project', content: JSON.stringify(status) }
      }
      case 'recall': {
        const root = this.record(id).root
        const result = await this.knowledge.recall(root, request.query, request.topK ?? 8, await this.embedder(), signal)
        if (request.path) await atomicWrite(await projectPath(root, request.path), `${JSON.stringify({ query: request.query, ...result }, null, 1)}\n`)
        return {
          message: `${result.patterns.length} pattern(s) recalled (${result.basis})${request.path ? `; saved to ${request.path}` : ''}`,
          content: JSON.stringify(result), ...request.path ? { path: request.path } : {},
        }
      }
      case 'novelty': {
        const path = request.path ?? 'novelty_report.json'
        const report = await this.knowledge.novelty(this.record(id).root, request.story ?? 'story.json', path, await this.embedder(), signal, limit)
        return { message: `Novelty risk ${report.risk_level} (${report.basis}); report saved to ${path}`, path, content: JSON.stringify(report) }
      }
      case 'build-graph': {
        const result = await this.knowledge.build(this.record(id).root, request.papers, request.domain, await this.embedder(), signal)
        return { message: `${result.clusters.length} cluster(s) from ${result.papers} papers (${result.basis})`, path: PROJECT_CLUSTERS, content: JSON.stringify(result) }
      }
      case 'name-patterns': {
        const result = await this.knowledge.namePatterns(this.record(id).root, request.names ?? 'cluster_meta.json', limit)
        return {
          message: result.issues.length ? `Project graph written with ${result.issues.length} problem(s) to fix` : 'Project graph written and valid',
          path: PROJECT_GRAPH, content: JSON.stringify(result),
        }
      }
      default: {
        const short = request
        return project => this.perform(project, short, actor)
      }
    }
  }

  /**
   * Download and extract an open-access PDF for a verified reference. A
   * reference without one keeps its abstract, and the reason is reported.
   */
  private async openAccessText(
    root: string,
    evidenceId: EvidenceId,
    item: LiteratureItem,
    signal: AbortSignal,
  ): Promise<{ path: string; chunks: EvidenceRecord['chunks'] } | { reason: string }> {
    try {
      const url = await openAccessPdf(item, signal)
      if (url === undefined) return { reason: 'no open-access copy is known' }
      const path = `.research/sources/${evidenceId}/fulltext.pdf`
      const target = await projectPath(root, path)
      await atomicWrite(target, await downloadPdf(url, signal, this.config.maxSourceBytes))
      return { path, chunks: await extractText(target, this.components, signal, this.config.maxSourceBytes) }
    } catch (error) {
      signal.throwIfAborted()
      return { reason: errorText(error) }
    }
  }

  /** Actions that only change the record: they run entirely inside the project's lock. */
  private async perform(project: ResearchProject, request: ShortCommand, actor: 'user' | 'agent'): Promise<ResearchResponse> {
    switch (request.action) {
      case 'set-mode': {
        const { mode, route } = this.modes.choose(request.mode, request.route)
        const changed = mode !== project.mode || route !== project.route
        project.mode = mode
        if (route === undefined) delete project.route
        else project.route = route
        const by = request.decidedBy ?? actor
        project.modeSetBy = by
        const reason = request.reason?.trim() ?? ''
        if (reason) project.modeReason = reason
        // Phases belong to a mode and route: another one starts with nothing checked.
        if (changed) project.progress = { mode, ...(route === undefined ? {} : { route }), phases: {}, findings: {} }
        project.decisions.push({
          id: randomUUID(), question: MODE_QUESTION, answer: route === undefined ? mode : `${mode} · ${route}`, by, rationale: reason,
          at: new Date().toISOString(), key: MODE_DECISION_KEY,
        })
        const resolved = this.modes.resolve(project)
        const phases = resolved.phases.map(phase => phase.id)
        const name = `${resolved.pack.name.en}${route === undefined ? '' : ` (${route})`}`
        return { message: phases.length ? `Mode ${name}: ${phases.join(' → ')}` : `Mode ${name}: no pipeline; run checks when useful` }
      }
      case 'set-autonomy': project.autonomy = request.autonomy; return { message: `Autonomy: ${request.autonomy}` }
      case 'rename': {
        const title = request.title.trim()
        project.title = title
        delete project.untitled
        const workspace = this.ctx.workspaceRegistry.get(project.workspaceId)
        // Workspace titles are unique; a taken one leaves the folder's Workspace under its earlier name.
        const taken = this.ctx.workspaceRegistry.list().some(candidate => candidate.id !== project.workspaceId && candidate.title === title)
        if (workspace !== undefined && !taken && workspace.title !== title) await workspace.setTitle(title)
        return {
          message: taken
            ? `Research renamed to "${title}"; its folder keeps its earlier name in the conversation list, because another folder there is already called "${title}"`
            : `Research renamed to "${title}"`,
        }
      }
      case 'record-decision': {
        project.decisions.push({
          id: randomUUID(), question: request.question, answer: request.answer, by: request.decidedBy ?? actor,
          rationale: request.rationale?.trim() ?? '', at: new Date().toISOString(), ...(request.key === undefined ? {} : { key: request.key }),
        })
        return { message: 'Decision recorded' }
      }
      case 'claim': putClaim(project, request.claim); return { message: 'Claim and evidence links updated' }
      case 'save-artifact':
      case 'register-artifact': {
        const artifact = await writeArtifact(project, request, actor, this.config.maxSourceBytes)
        return { message: `${artifact.path} is at revision ${artifact.revision} (artifact ${artifact.id})`, path: artifact.path }
      }
      case 'experiment-dismiss': {
        const run = project.experiments.find(r => r.id === request.runId)
        if (!run) throw new Error('Experiment not found')
        if (this.launching.has(run.id)) throw new Error('This run is still being submitted; wait for the submission to finish')
        if (!['unknown', 'queued'].includes(run.status)) throw new Error(`Only runs whose state is unknown can be dismissed; this one is ${run.status}`)
        Object.assign(run, { status: 'interrupted', message: `Dismissed by the ${actor}; no longer observed`, updatedAt: new Date().toISOString(), nextObserveAt: undefined })
        return { message: 'Run dismissed', runs: [runView(run)] }
      }
      case 'complete-visual-review': {
        const review = project.visualReviews.find(r => r.artifactId === request.artifactId
          && r.artifactRevision === request.artifactRevision
          && r.sessionId === request.sessionId
          && r.status === 'pending')
        if (!review) throw new Error('This visual review is not pending for that session and revision')
        review.status = 'reviewed'; review.findings = request.findings
        return { message: 'Visual findings recorded for the inspected revision' }
      }
    }
  }

  /**
   * Admit a run durably, launch it outside the project's lock, then record
   * what the launch reported. The run's identity is stored before anything
   * crosses a transport boundary, so a lost response never starts a second
   * experiment; a launch without a clear answer leaves the run unknown. The
   * submitting conversation is recorded on the run, so its cards show there.
   */
  private async submitExperiment(
    id: ProjectId,
    request: Extract<ResearchCommand, { action: 'experiment' }>,
    signal: AbortSignal,
    sessionId: string | undefined,
  ): Promise<ResearchResponse | Commit> {
    const admitted = await this.mutate(id, async (project): Promise<{ run: ExperimentRecord; fresh: boolean }> => {
      const existing = project.experiments.find(r => r.id === request.requestId)
      if (existing) {
        if (JSON.stringify(existing.spec) !== JSON.stringify(request.spec)) throw new Error('The submission ID belongs to a different experiment')
        return { run: structuredClone(existing), fresh: false }
      }
      const run: ExperimentRecord = {
        ...newExperiment(project, request.spec, request.requestId),
        ...(sessionId === undefined ? {} : { sessionId }),
      }
      await adoptRunCode(project, run)
      project.experiments.push(run)
      // Observers leave the run alone until its launch is recorded.
      this.launching.add(run.id)
      return { run: structuredClone(run), fresh: true }
    })
    const { run } = admitted
    if (!admitted.fresh) return { message: `Existing experiment: ${run.id} (${run.status})`, runs: [runView(run)] }
    let launched: ExperimentRecord
    try {
      launched = await launchExperiment(this.record(id), run, signal)
    } catch (error) {
      launched = { ...run, status: 'unknown', message: `Submission outcome requires inspection: ${String(error)}` }
    }
    return async (project) => {
      this.launching.delete(run.id)
      const index = runAt(project, run.id)
      project.experiments[index] = launched
      await this.collect(project, index)
      return { message: `Experiment ${run.id}: ${launched.status}. Use experiment-wait to wait for it.`, runs: [runView(launched)] }
    }
  }

  /** Whether a background observer or a wait should look at this run now. */
  private observable(run: ExperimentRecord): boolean {
    return (ACTIVE_RUN_STATES.has(run.status) || (run.status === 'completed' && !run.collected))
      && observationDue(run, Date.now()) && !this.launching.has(run.id)
  }

  /**
   * Observe (or cancel) one run without holding its project, then record what
   * was seen. A run that settled meanwhile, because another observer got there
   * first or someone dismissed it, keeps its recorded state, so results are
   * never collected twice.
   * @returns the run as recorded afterwards.
   */
  private async observe(
    id: ProjectId,
    snapshot: ResearchProject,
    run: ExperimentRecord,
    action: 'status' | 'cancel',
    signal: AbortSignal,
  ): Promise<ExperimentRecord> {
    const observed = ACTIVE_RUN_STATES.has(run.status) ? await observeExperiment(snapshot, run, action, signal) : run
    return this.mutate(id, async (project) => {
      const index = runAt(project, run.id)
      const current = project.experiments[index] as ExperimentRecord
      if (!ACTIVE_RUN_STATES.has(current.status)) {
        await this.collect(project, index)
        return current
      }
      project.experiments[index] = observed
      // Collecting marks the observed record itself.
      await this.collect(project, index)
      return observed
    })
  }

  /**
   * Wait until any of the runs leaves an in-progress state, or the timeout
   * passes, observing them in between. The agent spends time here rather than
   * spending goal rounds on polling.
   */
  private async waitForRuns(
    projectId: ProjectId,
    runIds: string[],
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<ResearchResponse> {
    const deadline = Date.now() + timeoutSeconds * 1000
    const interval = Math.min(this.config.pollIntervalMs, 5000)
    const selected = (): ExperimentRecord[] => this.record(projectId).experiments.filter(run => runIds.includes(run.id))
    if (selected().length !== new Set(runIds).size) throw new Error('Unknown run ID')
    while (true) {
      const snapshot = this.record(projectId)
      const due = snapshot.experiments.filter(run => runIds.includes(run.id) && this.observable(run))
      for (const run of due) await this.observe(projectId, snapshot, run, 'status', signal)
      const runs = selected()
      const settled = runs.some(run => !ACTIVE_RUN_STATES.has(run.status))
      if (settled || Date.now() >= deadline) {
        return { message: settled ? 'A run finished' : 'Still running after the timeout; wait again or do other work', runs: runs.map(runView) }
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now())))
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Operation cancelled')) }, { once: true })
      })
    }
  }

  private async collect(project: ResearchProject, index: number): Promise<void> {
    const run = project.experiments[index]
    if (!run || run.collected || run.status !== 'completed') return
    if (Object.keys(run.metrics).length > 0) {
      const text = JSON.stringify(run.metrics, null, 2)
      const id = randomUUID() as EvidenceId
      const path = `.research/runs/${run.id}/metrics.json`
      await atomicWrite(await projectPath(project.root, path), text)
      project.evidence.push({
        // Seeds of one configuration share a name; the seed keeps each run's evidence distinguishable where claims cite it.
        id, title: `${run.spec.name} · seed ${run.spec.seed}`, kind: 'experiment', path, sha256: hashBytes(text), revision: 1,
        importedAt: new Date().toISOString(),
        chunks: Object.entries(run.metrics).map(([key, value]) => ({ text: String(value), locator: { key } })),
        coverage: 'data', verified: true, stale: run.inputRevision !== project.researchRevision,
      })
    }
    try {
      project.evidence.push(...await collectRunOutputs(project, run, this.config.maxSourceBytes, this.lifetime.signal))
    } catch (error) {
      run.message = `${run.message ? `${run.message}; ` : ''}outputs could not be collected: ${String(error)}`
    }
    run.collected = true
  }

  private async refreshRunning(): Promise<void> {
    for (const [id, stored] of this.domain.table('projects').entries()) {
      // An example's runs are part of its story and are never observed again; a
      // research removed from the list keeps its runs, observed again once it is restored.
      if (isExampleRoot(stored.root) || stored.archivedAt !== undefined) continue
      const snapshot = structuredClone(stored)
      try {
        for (const run of snapshot.experiments.filter(r => this.observable(r))) await this.observe(id, snapshot, run, 'status', this.lifetime.signal)
      } catch (error) {
        // One project's failure must not stop the others from being observed.
        this.ctx.logger.warn('research experiment observation for %s: %s', id, String(error))
      }
    }
  }

  /**
   * Send rendered pages to a configured vision model when the main model cannot
   * see images. A main model that can see uses render-pages and read_image instead.
   */
  private async visualReview(id: ProjectId, artifactId: ArtifactId, signal: AbortSignal): Promise<ResearchResponse | Commit> {
    const project = this.record(id)
    const artifact = project.artifacts.find(a => a.id === artifactId)
    if (!artifact) throw new Error('Artifact not found')
    const binding = this.domain.global.get().vision
    if (!binding) {
      return (current) => {
        current.visualReviews.push({
          artifactId, artifactRevision: artifact.revision, status: 'not-configured',
          findings: 'No separate vision model is configured; if your own model reads images, use render-pages and read_image',
          createdAt: new Date().toISOString(),
        })
        return { message: 'No separate vision model configured; use render-pages and read_image if your model reads images' }
      }
    }
    const compiled = [...project.compilations].reverse().find(c => c.artifactId === artifactId && c.status === 'completed')
    const reviews: VisualReview[] = []
    let paths: string[]
    if (compiled) {
      const rendered = await renderPages(project, artifactId, this.config.maxReviewPages, this.components, signal)
      paths = rendered.paths
      reviews.push(rendered.review)
    } else if (/\.(png|jpe?g|webp)$/i.test(artifact.path)) {
      paths = [await projectPath(project.root, artifact.path)]
    } else {
      throw new Error('Compile the manuscript or export the figure to PNG before requesting a visual review')
    }
    const session = await this.ctx.sessionController.create({ workspaceId: project.workspaceId, agentPreset: 'research' })
    await this.ctx.sessionController.selectModel({ sessionId: session.sessionId, ...binding })
    const instructions = `Review the attached pages of ${artifact.path} for legibility, clipped content, overlaps, typography and figure/text consistency. `
      + 'Explain visible findings precisely. This is visual inspection, not validation of numerical claims. '
      + `Afterwards call research_media with action complete-visual-review, projectId ${project.id}, artifactId ${artifactId}, `
      + `artifactRevision ${artifact.revision}, sessionId ${session.sessionId}, and findings containing your actual observations.`
    const content: import('@deepseek-ai/dsh-api-session-controller/types').PromptContentPart[] = [{ type: 'text', text: instructions }]
    for (const page of paths) {
      content.push({
        type: 'image',
        mediaType: /\.jpe?g$/i.test(page) ? 'image/jpeg' : /\.webp$/i.test(page) ? 'image/webp' : 'image/png',
        data: (await readFile(page)).toString('base64'),
        name: basename(page),
      })
    }
    reviews.push({
      artifactId, artifactRevision: artifact.revision, status: 'pending', sessionId: session.sessionId,
      ...(compiled ? { inputDigest: compiled.inputDigest } : {}),
      findings: 'Visual inspection is pending', createdAt: new Date().toISOString(),
    })
    // The pending review is stored before the reviewer starts, so its completion always finds it.
    await this.mutate(id, (current) => {
      // A reviewer that never reported back is superseded rather than left pending forever.
      for (const stale of current.visualReviews.filter(r => r.artifactId === artifactId && r.status === 'pending')) {
        Object.assign(stale, { status: 'failed', findings: 'Superseded by a newer visual review before it reported' })
      }
      current.visualReviews.push(...reviews)
    })
    await this.ctx.sessionController.prompt({ sessionId: session.sessionId, requestId: randomUUID() as SessionRequestId, mode: 'queue', content }, signal)
    return { message: 'Visual review session started; its findings arrive through complete-visual-review', content: session.sessionId }
  }

  private async generateImage(id: ProjectId, request: Extract<ResearchCommand, { action: 'generate-image' }>, signal: AbortSignal): Promise<Commit> {
    const binding = this.domain.global.get().image
    if (!binding) throw new Error('Configure an image-generation provider first')
    const credential = await this.ctx.credentials.resolve(credentialRef(IMAGE_CREDENTIAL))
    if (!credential) throw new Error('The image provider credential has not been configured')
    if (!IMAGE_FILE.test(request.path)) throw new Error('Save generated images as .png, .jpg or .webp')
    const root = this.record(id).root
    const target = await projectPath(root, request.path)
    const limit = this.config.maxSourceBytes
    const references = []
    for (const path of request.references ?? []) {
      if (!IMAGE_FILE.test(path)) throw new Error(`A reference image must be .png, .jpg or .webp: ${path}`)
      const bytes = await readFile(await projectPath(root, path))
      if (bytes.byteLength > limit) throw new Error(`Reference image exceeds the configured size limit: ${path}`)
      references.push({ name: basename(path), type: MEDIA_TYPES[extname(path).slice(1).toLowerCase()] as string, bytes })
    }
    const image = await generateImage(binding, credential.value, {
      prompt: request.prompt, size: request.size, quality: request.quality, background: request.background, references,
    }, signal, limit)
    await mkdir(dirname(target), { recursive: true })
    // Exclusive creation: an existing image is never overwritten, even by a concurrent write.
    if (!await writeNew(target, image.bytes)) throw new Error('Choose a new image path to preserve existing artwork')
    // The prompt beside the image, so the drawing can be regenerated, audited and explained.
    const prompt = `${request.path.replace(/\.[^.]+$/, '')}.prompt.txt`
    await atomicWrite(await projectPath(root, prompt), [
      `model: ${binding.model}`, `endpoint: ${image.via}`, `size: ${request.size ?? binding.size}`,
      ...(request.references?.length ? [`references: ${request.references.join(', ')}`] : []), '', request.prompt, '',
    ].join('\n'))
    return async (project) => {
      await writeArtifact(project, { action: 'register-artifact', projectId: project.id, path: request.path, kind: 'image', evidence: [], claimIds: [], inputArtifacts: [] }, 'agent', limit)
      return {
        message: `Image generated through ${image.via} and saved (${extname(request.path).slice(1)}); its prompt is in ${prompt}${image.note ? `. Note: ${image.note}` : ''}`,
        path: request.path, paths: [request.path, prompt],
      }
    }
  }

  /**
   * Save reference figures into the project: gallery figures, each with a
   * record of its paper beside it, and the overview figures of arXiv papers.
   */
  private async referenceFigures(id: ProjectId, request: Extract<ResearchCommand, { action: 'fetch-reference-figures' }>, signal: AbortSignal): Promise<ResearchResponse> {
    if (!request.arxivIds && !request.galleryIds) throw new Error('Name galleryIds (from find-reference-figures) or arxivIds')
    const root = this.record(id).root
    const limit = this.config.maxSourceBytes
    const saved: { path: string; source?: string; galleryId?: string; arxivId?: string; title?: string; caption?: string }[] = []
    const skipped: string[] = []
    for (const galleryId of request.galleryIds ?? []) {
      try {
        const { figure, file, extension, source } = await this.gallery.image(galleryId, signal, limit)
        const path = `figures/refs/${request.label}.gallery_${figure.id}.${extension}`
        await atomicWrite(await projectPath(root, path), await readFile(file))
        const record = `figures/refs/${request.label}.gallery_${figure.id}.source.json`
        await atomicWrite(await projectPath(root, record), `${JSON.stringify({
          ...figure, gallery: `${source.repository}@${source.commit}`,
          copyright: 'The figure belongs to its paper\'s authors and publisher: a layout reference to study, never material for the paper',
        }, null, 1)}\n`)
        saved.push({ path, source: record, galleryId: figure.id, title: figure.title })
      } catch (error) {
        signal.throwIfAborted()
        skipped.push(`${galleryId}: ${errorText(error)}`)
      }
    }
    const fetched = request.arxivIds ? await fetchReferenceFigures(request.arxivIds, signal, limit) : { figures: [], skipped: [] }
    skipped.push(...fetched.skipped)
    const counts = new Map<string, number>()
    for (const figure of fetched.figures) {
      const index = (counts.get(figure.arxivId) ?? 0) + 1
      counts.set(figure.arxivId, index)
      const path = `figures/refs/${request.label}.ref_${figure.arxivId.replace(/v\d+$/, '')}_${index}.${figure.extension}`
      await atomicWrite(await projectPath(root, path), figure.bytes)
      saved.push({ path, arxivId: figure.arxivId, caption: figure.caption })
    }
    return {
      message: saved.length
        ? `${saved.length} reference figure(s) saved under figures/refs; study their layout with read_image, never copy them into the paper`
        : 'No reference figure saved; search the gallery or other papers for an overview figure',
      paths: saved.map(item => item.path),
      content: JSON.stringify({ figures: saved, skipped }),
    }
  }
}

/** Image files the generator writes and reads as references. */
const IMAGE_FILE = /\.(png|jpe?g|webp)$/i
const MEDIA_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

/**
 * A project as the desktop reads it: without large source bodies, and with
 * the derived `example`, `draft` and `archived` flags.
 * @param project - the stored record.
 * @param draft - whether the service found it to be the untouched draft.
 * @returns a detached copy.
 */
export function publicProject(project: ResearchProject, draft = false): ResearchProject {
  const result = structuredClone(project)
  for (const evidence of result.evidence) evidence.chunks = []
  for (const environment of result.environments) environment.details = truncateBytes(environment.details, 3000)
  if (isExampleRoot(result.root)) result.example = true
  if (draft) result.draft = true
  if (result.archivedAt !== undefined) result.archived = true
  return result
}

export default ResearchWorkbench
