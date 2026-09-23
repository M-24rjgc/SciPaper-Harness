/** Research project ledger service and typed desktop operations. The agent drives; this records. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import { ComponentManager, runtimeAsset } from './components.ts'
import { autonomies, commandSchema, locatorSchema, preferencesSchema, researchDomain } from './schema.ts'
import { invalidate, newProject, putClaim, runView, searchEvidence } from './project.ts'
import { compilePaper, compileTarget, exportPaper, extractText, importEvidence, importTemplate, renderPages, writeArtifact } from './artifacts.ts'
import { runChecks } from './checks.ts'
import { GENERAL_MODE, ModeRegistry } from './modes.ts'
import { createEnvironment } from './environments.ts'
import { adoptRunCode, collectRunOutputs, experimentLogs, launchExperiment, newExperiment, observationDue, observeExperiment } from './experiments.ts'
import { fetchReferenceFigures, generateImage } from './images.ts'
import { downloadPdf, openAccessPdf, searchLiterature, verifyLiterature } from './literature.ts'
import { assertUsableProjectRoot, atomicWrite, errorText, hashBytes, isInside, projectPath, readText, sameDirectory, truncateBytes, writeNew } from './files.ts'
import { registerResearchRoutes } from './routes.ts'
import type {
  ArtifactId, CreateProjectRequest, EvidenceId, EvidenceRecord, ExperimentRecord, LiteratureItem, ProjectId, ResearchCommand,
  ResearchModeEvent, ResearchPreferences, ResearchProject, ResearchResponse, ResearchSnapshot, ResearchTask, VisualReview,
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
}

/** The only credential the image provider may use; it cannot name any other stored secret. */
export const IMAGE_CREDENTIAL = 'RESEARCH_IMAGE_API_KEY'
/** Runs in these states are still in progress from the agent's point of view. */
const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'unknown'])
/** Actions the desktop follows as background jobs instead of waiting on. */
const LONG_ACTIONS = new Set<ResearchCommand['action']>([
  'import', 'import-template', 'refresh-evidence', 'literature-search', 'literature-import',
  'environment', 'experiment', 'experiment-refresh', 'experiment-cancel',
  'compile', 'render-pages', 'visual-review', 'generate-image', 'fetch-reference-figures', 'export',
])

type ReadOnlyAction = 'search-evidence' | 'read-artifact' | 'experiment-logs' | 'check' | 'experiment-wait'
/** Commands that record something in the project. */
type RecordingCommand = Exclude<ResearchCommand, { action: ReadOnlyAction }>
/** Commands whose whole effect is a record change. */
type ShortCommand = Extract<ResearchCommand, {
  action: 'set-mode' | 'set-autonomy' | 'record-decision' | 'claim' | 'save-artifact' | 'register-artifact' | 'experiment-dismiss' | 'complete-visual-review'
}>
/** A record change prepared outside the project's lock and applied inside it. */
type Commit = (project: ResearchProject) => ResearchResponse | Promise<ResearchResponse>

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
  static inject = ['storageDomain', 'workspaceRegistry', 'sessionController', 'credentials', 'tools', 'llm']
  static Config: s<Config> = s.object({
    componentRoot: s.string(),
    maxSourceBytes: s.number().min(1024).required(),
    pollIntervalMs: s.number().min(500).required(),
    maxReviewPages: s.number().step(1).min(1).required(),
  })
  private domain!: Domain<typeof researchDomain>
  private readonly tails = new Map<ProjectId, Promise<unknown>>()
  private readonly operations = new Set<Promise<unknown>>()
  /** Runs whose launch is under way outside their project's lock. */
  private readonly launching = new Set<string>()
  /** The latest project creation; each one waits for the one before it. */
  private creations: Promise<unknown> = Promise.resolve()
  /**
   * Extracted evidence text by `project/evidence/revision`. Records are stored
   * without it, so a mutation rewrites kilobytes of ledger rather than the text
   * of every source; the text is written to the project once per revision.
   */
  private readonly evidenceText = new Map<string, EvidenceRecord['chunks']>()
  private readonly lifetime = new AbortController()
  readonly components: ComponentManager
  /** The installed mode packs, loaded once at start. */
  modes!: ModeRegistry
  private refreshResourceRoutes!: () => Promise<void>

  /** Bind the research API and its private tooling directory. */
  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'research')
    const root = config.componentRoot ?? join(resolveDshHome(), 'research', 'components')
    this.components = new ComponentManager(root, () => this.domain.global.get())
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
    this.modes = await ModeRegistry.load([runtimeAsset('modes')], this.ctx.logger)
    this.domain = await this.ctx.storageDomain.open(researchDomain)
    const cut = [...this.domain.table('tasks').entries()].filter(([, task]) => task.status === 'running')
    await Promise.all(cut.map(([id, task]) => this.domain.table('tasks').put(id, {
      ...task, status: 'interrupted', message: 'The application restarted; independent experiments can be reconnected from the experiment panel',
    })))
    await this.loadEvidenceText()
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
      this.lifetime.abort()
      await Promise.allSettled([...this.operations, ...this.tails.values()])
      await this.domain.close()
    }, 'research.close')
  }

  /**
   * Read detached project snapshots and non-secret component settings.
   * @returns every project without source bodies, the preferences and the component status.
   */
  @Remote
  async snapshot(): Promise<ResearchSnapshot> {
    return {
      projects: this.projects().map(publicProject),
      preferences: structuredClone(this.domain.global.get()),
      components: await this.components.status(),
      modes: this.modes.summaries(),
    }
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
    // One creation at a time: two requests for the same folder would otherwise both find no project and record two.
    const creation = this.creations.catch(() => {}).then(() => this.createAt({ ...request, ...chosen }, sessionId))
    this.creations = creation
    return creation
  }

  private async createAt(request: CreateProjectRequest, sessionId: string | undefined): Promise<ResearchProject> {
    await mkdir(request.root, { recursive: true })
    const root = await realpath(request.root)
    assertUsableProjectRoot(root)
    const existing = this.projects().find(project => sameDirectory(project.root, root))
    if (existing) {
      if (!existing.sessionId) {
        await this.mutate(existing.id, async (project) => {
          project.sessionId = sessionId ?? (await this.ctx.sessionController.create({ workspaceId: project.workspaceId })).sessionId
        })
      }
      return this.record(existing.id)
    }
    // create() reuses a workspace already registered for this directory, so a
    // retry after a failed launch never produces a duplicate sidebar entry.
    const workspace = await this.ctx.workspaceRegistry.create(root, request.title)
    const project = newProject({ ...request, root }, workspace.id)
    for (const directory of ['paper', 'figures', 'code', 'data', '.research', 'exports']) {
      await mkdir(await projectPath(root, directory), { recursive: true })
    }
    project.sessionId = sessionId ?? (await this.ctx.sessionController.create({ workspaceId: project.workspaceId })).sessionId
    await this.domain.table('projects').put(project.id, project)
    this.announceMode(project.id)
    return structuredClone(project)
  }

  /** Tell listeners (the mode's skill catalog) which mode a project now records. */
  private announceMode(id: ProjectId): void {
    const { root, mode, route } = this.record(id)
    this.ctx.emit('research/mode', { projectId: id, root, mode, ...(route === undefined ? {} : { route }) })
  }

  /**
   * Save model roles and explicitly bound tool locations, never model secrets.
   * @param preferences - the complete preference record.
   * @returns the preferences as stored.
   */
  @Remote
  async configure(preferences: ResearchPreferences): Promise<ResearchPreferences> {
    const parsed = preferencesSchema.parse(preferences)
    await this.domain.global.set(parsed)
    return parsed
  }

  /**
   * Store the image-provider API key under its fixed research credential name.
   * @param value - the API key.
   */
  @Remote
  async setImageCredential(value: string): Promise<void> {
    if (!this.domain.global.get().image) throw new Error('Configure the image provider before setting its credential')
    if (!value.trim()) throw new Error('The API key is empty')
    await this.ctx.credentials.set(credentialRef(IMAGE_CREDENTIAL), value.trim())
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
    return this.projects()
      .filter(project => isInside(project.root, canonical))
      .sort((a, b) => b.root.length - a.root.length)[0]
  }

  /** Serialize one complete graph transition and publish it only after durable storage. */
  private mutate<T>(id: ProjectId, work: (project: ResearchProject) => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(async () => {
      this.lifetime.signal.throwIfAborted()
      const project = this.getProject(id)
      const value = await work(project)
      project.revision++
      project.updatedAt = new Date().toISOString()
      await this.domain.table('projects').put(id, await this.withoutText(project))
      return value
    })
    this.tails.set(id, result)
    void result.finally(() => { if (this.tails.get(id) === result) this.tails.delete(id) }).catch(() => {})
    return result
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
   * @param raw - the command as received.
   * @param signal - cancellation of the call.
   * @param actor - who acts: the desktop user or the agent.
   * @returns the outcome.
   */
  async execute(raw: ResearchCommand, signal: AbortSignal, actor: 'user' | 'agent'): Promise<ResearchResponse> {
    const request = commandSchema.parse(raw) as ResearchCommand
    const project = this.record(request.projectId)
    switch (request.action) {
      case 'search-evidence': return this.clipped(searchEvidence(this.getProject(project.id), request.query, this.config.maxSourceBytes))
      case 'read-artifact': {
        const artifact = project.artifacts.find(a => a.id === request.artifactId)
        if (!artifact) throw new Error('Artifact not found')
        const content = /\.(png|jpe?g|webp|pdf|zip)$/i.test(artifact.path)
          ? ''
          : await readText(await projectPath(project.root, artifact.path), this.config.maxSourceBytes)
        return { message: `Revision ${artifact.revision}`, content, path: artifact.path }
      }
      case 'experiment-logs': {
        const run = project.experiments.find(r => r.id === request.runId)
        if (!run) throw new Error('Experiment not found')
        return this.clipped({ message: 'Experiment logs', content: await experimentLogs(project, run, signal) })
      }
      case 'check': {
        const check = await runChecks(this.getProject(project.id), this.config.maxSourceBytes, request.scope, this.modes.resolve(project))
        await this.mutate(project.id, (current) => { current.lastCheck = check })
        return { message: check.clean ? 'Clean' : 'Not done yet: fix the errors and check again', check }
      }
      case 'experiment-wait': return this.waitForRuns(project.id, request.runIds, request.timeoutSeconds, signal)
      default: {
        const work = async (workSignal: AbortSignal): Promise<ResearchResponse> => {
          const prepared = await this.prepare(project.id, request, workSignal, actor)
          const value = typeof prepared === 'function' ? await this.mutate(project.id, prepared) : prepared
          if (request.action === 'set-mode') this.announceMode(project.id)
          return this.clipped({ ...value, project: publicProject(this.record(project.id)) })
        }
        return LONG_ACTIONS.has(request.action) && actor === 'user' ? this.begin(request.action, project.id, work) : work(signal)
      }
    }
  }

  /**
   * Do an action's slow part (processes, network, SSH) on a detached snapshot,
   * outside the project's lock, and return the change to record inside it. A
   * compile therefore never holds up a save, and a hung SSH host never holds up
   * the project. Short actions run entirely inside the lock.
   * @returns the response itself when nothing is left to record, or the change to apply.
   */
  private async prepare(id: ProjectId, request: RecordingCommand, signal: AbortSignal, actor: 'user' | 'agent'): Promise<ResearchResponse | Commit> {
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
      case 'experiment': return this.submitExperiment(id, request, signal)
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
      case 'generate-image': return this.generateImage(id, request, signal)
      case 'fetch-reference-figures': return this.referenceFigures(id, request, signal)
      case 'export': {
        const snapshot = this.getProject(id)
        const check = await runChecks(snapshot, limit, 'all', this.modes.resolve(snapshot))
        const result = await exportPaper(snapshot, limit, check)
        return (project) => {
          project.lastCheck = check
          return { message: result.final ? 'Submission package exported' : 'Draft exported; the bundled check report lists what is still open', path: result.path, check }
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
        project.mode = mode
        if (route === undefined) delete project.route
        else project.route = route
        project.modeSetBy = actor
        if (request.reason?.trim()) project.modeReason = request.reason.trim()
        else delete project.modeReason
        const resolved = this.modes.resolve(project)
        const phases = resolved.phases.map(phase => phase.id)
        const name = `${resolved.pack.name.en}${route === undefined ? '' : ` (${route})`}`
        return { message: phases.length ? `Mode ${name}: ${phases.join(' → ')}` : `Mode ${name}: no pipeline; run checks when useful` }
      }
      case 'set-autonomy': project.autonomy = request.autonomy; return { message: `Autonomy: ${request.autonomy}` }
      case 'record-decision': {
        project.decisions.push({
          id: randomUUID(), question: request.question, answer: request.answer, by: request.decidedBy ?? actor,
          rationale: request.rationale?.trim() ?? '', at: new Date().toISOString(),
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
   * experiment; a launch without a clear answer leaves the run unknown.
   */
  private async submitExperiment(id: ProjectId, request: Extract<ResearchCommand, { action: 'experiment' }>, signal: AbortSignal): Promise<ResearchResponse | Commit> {
    const admitted = await this.mutate(id, async (project): Promise<{ run: ExperimentRecord; fresh: boolean }> => {
      const existing = project.experiments.find(r => r.id === request.requestId)
      if (existing) {
        if (JSON.stringify(existing.spec) !== JSON.stringify(request.spec)) throw new Error('The submission ID belongs to a different experiment')
        return { run: structuredClone(existing), fresh: false }
      }
      const run = newExperiment(project, request.spec, request.requestId)
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
    return (project) => {
      this.launching.delete(run.id)
      project.experiments[runAt(project, run.id)] = launched
      return { message: `Experiment ${run.id}: ${launched.status}. Use experiment-wait to wait for it.`, runs: [runView(launched)] }
    }
  }

  /** Whether a background observer or a wait should look at this run now. */
  private observable(run: ExperimentRecord): boolean {
    return ACTIVE_RUN_STATES.has(run.status) && observationDue(run, Date.now()) && !this.launching.has(run.id)
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
    const observed = await observeExperiment(snapshot, run, action, signal)
    return this.mutate(id, async (project) => {
      const index = runAt(project, run.id)
      const current = project.experiments[index] as ExperimentRecord
      if (!ACTIVE_RUN_STATES.has(current.status)) return current
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
    const session = await this.ctx.sessionController.create({ workspaceId: project.workspaceId })
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

  private async referenceFigures(id: ProjectId, request: Extract<ResearchCommand, { action: 'fetch-reference-figures' }>, signal: AbortSignal): Promise<ResearchResponse> {
    const root = this.record(id).root
    const { figures, skipped } = await fetchReferenceFigures(request.arxivIds, signal, this.config.maxSourceBytes)
    const saved: { path: string; arxivId: string; caption: string }[] = []
    const counts = new Map<string, number>()
    for (const figure of figures) {
      const index = (counts.get(figure.arxivId) ?? 0) + 1
      counts.set(figure.arxivId, index)
      const path = `figures/refs/${request.label}.ref_${figure.arxivId.replace(/v\d+$/, '')}_${index}.${figure.extension}`
      await atomicWrite(await projectPath(root, path), figure.bytes)
      saved.push({ path, arxivId: figure.arxivId, caption: figure.caption })
    }
    return {
      message: saved.length
        ? `${saved.length} reference figure(s) saved under figures/refs; study their layout with read_image, never copy them into the paper`
        : 'No reference figure found; search for other papers with an overview figure',
      paths: saved.map(item => item.path),
      content: JSON.stringify({ figures: saved, skipped }),
    }
  }
}

/** Image files the generator writes and reads as references. */
const IMAGE_FILE = /\.(png|jpe?g|webp)$/i
const MEDIA_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

/** Keep large source bodies out of routine desktop snapshots. */
export function publicProject(project: ResearchProject): ResearchProject {
  const result = structuredClone(project)
  for (const evidence of result.evidence) evidence.chunks = []
  for (const environment of result.environments) environment.details = truncateBytes(environment.details, 3000)
  return result
}

export default ResearchWorkbench
