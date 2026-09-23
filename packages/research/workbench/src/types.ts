/** Serializable research records shared by tools, storage and the desktop. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

export type ProjectId = Branded<'ResearchProjectId'>
export type EvidenceId = Branded<'ResearchEvidenceId'>
export type ArtifactId = Branded<'ResearchArtifactId'>
export type ExperimentId = Branded<'ResearchExperimentId'>
export type EnvironmentId = Branded<'ResearchEnvironmentId'>
/** Whether the agent stops at key decisions to ask, or decides and records its rationale. */
export type Autonomy = 'checkpoints' | 'automatic'
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'
/** The checks every mode has; a mode pack may add gates of its own, reported under their own ids. */
export type CheckId = 'cite' | 'numbers' | 'placeholders' | 'figures' | 'compile' | 'visual' | 'review' | 'stale' | 'claims' | 'structure'

/** Text a mode pack supplies in each interface language. */
export interface LocalizedText {
  en: string
  zh: string
}
/**
 * One installed mode as the desktop and the agent see it. The general mode has
 * no phases; a pack mode (spark-to-paper, CCFA, …) adds its own skills, phases
 * and gates on top of the same research tools.
 */
export interface ModeSummary {
  id: string
  order: number
  name: LocalizedText
  summary: LocalizedText
  /** The skill that runs the mode, loaded first. */
  entry?: string | undefined
  /** Skills loaded before the entry skill on every task in this mode. */
  preload: string[]
  /** Alternative paths through the mode, such as starting from an idea or from measured data. */
  routes: { id: string; name: LocalizedText; summary: LocalizedText }[]
  defaultRoute?: string | undefined
  /** Every phase of the pack; `routes` limits a phase to some routes. */
  phases: { id: string; label: LocalizedText; routes?: string[] | undefined; checkpoint: boolean; skills: string[] }[]
}

export interface SourceLocator {
  page?: number | undefined
  paragraph?: number | undefined
  line?: number | undefined
  key?: string | undefined
}
export interface EvidenceChunk {
  text: string
  locator: SourceLocator
}
export interface EvidenceRecord {
  id: EvidenceId
  title: string
  kind: 'file' | 'literature' | 'experiment'
  path: string
  originalPath?: string | undefined
  sha256: string
  revision: number
  importedAt: string
  chunks: EvidenceChunk[]
  sourceUrl?: string | undefined
  doi?: string | undefined
  /** Project-relative open-access PDF of a literature reference, when one was found. */
  fullTextPath?: string | undefined
  coverage: 'full-text' | 'abstract' | 'metadata' | 'data'
  verified: boolean
  stale: boolean
}
export interface EvidenceLink {
  evidenceId: EvidenceId
  revision: number
  locator: SourceLocator
  quote: string
}
export interface ClaimRecord {
  id: string
  text: string
  kind: 'hypothesis' | 'method' | 'literature' | 'empirical'
  state: 'proposed' | 'supported' | 'contradicted' | 'stale'
  evidence: EvidenceLink[]
  artifactIds: ArtifactId[]
}
export interface ArtifactRecord {
  id: ArtifactId
  path: string
  kind: 'manuscript' | 'diagram' | 'figure' | 'code' | 'bibliography' | 'supplement' | 'image'
  revision: number
  sha256: string
  evidence: EvidenceLink[]
  claimIds: string[]
  inputArtifacts: { id: ArtifactId; revision: number }[]
  stale: boolean
  updatedAt: string
  author: 'user' | 'agent' | 'experiment'
}
/** One settled question: asked of the user at a checkpoint, or decided by the agent in automatic mode. */
export interface DecisionRecord {
  id: string
  question: string
  answer: string
  by: 'user' | 'agent'
  rationale: string
  at: string
}
export interface EnvironmentRecord {
  id: EnvironmentId
  name: string
  kind: 'uv' | 'existing' | 'conda'
  target: 'local' | 'ssh'
  python: string
  sshHost?: string | undefined
  remoteRoot?: string | undefined
  requirements: string[]
  fingerprint: string
  status: 'pending' | 'ready' | 'failed'
  details: string
  isDefault: boolean
}
export interface ExperimentSpec {
  environmentId: EnvironmentId
  name: string
  argv: string[]
  cwd: string
  seed: number
  maxSeconds: number
  gpuIds: string[]
  dataEvidenceIds: EvidenceId[]
  codeArtifactIds: ArtifactId[]
  /** Project-relative files or directories copied into the run; defaults to `code`. */
  codePaths?: string[] | undefined
  metricsPath: string
}
export interface ExperimentRecord {
  id: ExperimentId
  spec: ExperimentSpec
  status: RunStatus
  createdAt: string
  updatedAt: string
  directory: string
  inputRevision: number
  environmentFingerprint: string
  metrics: Record<string, number>
  exitCode?: number | undefined
  message: string
  snapshotPath: string
  collected: boolean
  /** When the supervisor began executing the child, as it reported; absent while queued. */
  startedAt?: string | undefined
  /** When the supervisor observed the child exit, as it reported; absent until terminal. */
  finishedAt?: string | undefined
  /** Consecutive failed observation attempts; reset to zero by any successful read. */
  observeFailures?: number | undefined
  /** Epoch milliseconds before which an 'unknown' run is not re-observed; absent without a pending backoff. */
  nextObserveAt?: number | undefined
}
export interface CompileRecord {
  artifactId: ArtifactId
  artifactRevision: number
  inputDigest: string
  engine: 'pdflatex' | 'xelatex' | 'lualatex'
  status: 'completed' | 'failed'
  pdfPath: string
  logPath: string
  diagnostics: string[]
  createdAt: string
}
export interface VisualReview {
  artifactId: ArtifactId
  artifactRevision: number
  /** `rendered`: pages were rendered for the main model to inspect with its own image reader. */
  status: 'not-configured' | 'pending' | 'reviewed' | 'failed' | 'rendered'
  /** Compiled source digest the pages came from; absent on records from earlier versions. */
  inputDigest?: string | undefined
  sessionId?: string | undefined
  findings: string
  createdAt: string
}
export interface CheckFinding {
  /** A base {@link CheckId}, or the id of a gate the project's mode pack runs. */
  check: string
  severity: 'error' | 'warning'
  message: string
  file?: string | undefined
  line?: number | undefined
}
export interface PhaseStatus {
  /** A phase id of the mode pack the check ran under. */
  id: string
  done: boolean
  /** What still stands between this phase and done, in the agent's terms. */
  missing: string[]
}
/** A deterministic report on the paper's current files; it never refuses anything. */
export interface CheckReport {
  clean: boolean
  scope: string
  /** The mode and route whose phases the report lists. */
  mode?: string | undefined
  route?: string | undefined
  phases: PhaseStatus[]
  findings: CheckFinding[]
  checkedAt: string
}
export interface ResearchProject {
  id: ProjectId
  workspaceId: WorkspaceId
  title: string
  root: string
  /** The mode pack the project runs in; `general` adds nothing to the research tools. */
  mode: string
  /** The route through the mode, for packs that have routes. */
  route?: string | undefined
  /** The venue whose template the project uses, once one is applied. */
  venue?: string | undefined
  modeReason?: string | undefined
  modeSetBy?: 'user' | 'agent' | undefined
  autonomy: Autonomy
  brief: string
  revision: number
  researchRevision: number
  createdAt: string
  updatedAt: string
  evidence: EvidenceRecord[]
  claims: ClaimRecord[]
  artifacts: ArtifactRecord[]
  decisions: DecisionRecord[]
  environments: EnvironmentRecord[]
  experiments: ExperimentRecord[]
  compilations: CompileRecord[]
  visualReviews: VisualReview[]
  lastCheck?: CheckReport | undefined
  sessionId?: string | undefined
}
export interface ModelBinding {
  provider: string
  model: string
}
export interface ImageBinding {
  baseUrl: string
  model: string
  size: string
  /** Default quality for gpt-image models; a call may override it. */
  quality?: 'low' | 'medium' | 'high' | 'auto' | undefined
  /** `images` for the OpenAI Images API (the default); `chat` for providers that return images from chat completions. */
  apiStyle?: 'images' | 'chat' | undefined
}
/** An OpenAI-compatible `/embeddings` endpoint for semantic recall, novelty and clustering. */
export interface EmbeddingBinding {
  baseUrl: string
  model: string
}
export interface ResearchPreferences {
  main?: ModelBinding | undefined
  vision?: ModelBinding | undefined
  image?: ImageBinding | undefined
  embedding?: EmbeddingBinding | undefined
  python?: string | undefined
  uv?: string | undefined
  texBin?: string | undefined
}
export interface ComponentStatus {
  id: 'python' | 'uv' | 'latex' | 'drawio'
  installed: boolean
  path: string
  version: string
}
/** A project's mode or route as just recorded; the payload of the `research/mode` event. */
export interface ResearchModeEvent {
  projectId: ProjectId
  root: string
  mode: string
  route?: string | undefined
}
export interface ResearchSnapshot {
  projects: ResearchProject[]
  preferences: ResearchPreferences
  components: ComponentStatus[]
  /** The installed modes, in display order. */
  modes: ModeSummary[]
}
export interface LiteratureItem {
  id: string
  provider: 'crossref' | 'openalex' | 'arxiv'
  title: string
  authors: string[]
  year?: number | undefined
  doi?: string | undefined
  url: string
  abstract: string
  bibtex: string
}
export interface ResearchResponse {
  project?: ResearchProject | undefined
  jobId?: string | undefined
  message: string
  content?: string | undefined
  path?: string | undefined
  paths?: string[] | undefined
  literature?: LiteratureItem[] | undefined
  check?: CheckReport | undefined
  runs?: { id: ExperimentId; status: RunStatus; message: string; metrics: Record<string, number> }[] | undefined
}
export interface CreateProjectRequest {
  title: string
  root: string
  /** A mode pack id; the general mode when absent. */
  mode?: string | undefined
  route?: string | undefined
  autonomy?: Autonomy | undefined
  brief: string
}
type ArtifactFields = {
  path: string
  kind: ArtifactRecord['kind']
  evidence: EvidenceLink[]
  claimIds: string[]
  inputArtifacts: ArtifactRecord['inputArtifacts']
}
export type ResearchCommand =
  | { action: 'set-mode'; projectId: ProjectId; mode: string; route?: string | undefined; reason?: string | undefined }
  | { action: 'set-autonomy'; projectId: ProjectId; autonomy: Autonomy }
  | {
    action: 'record-decision'
    projectId: ProjectId
    question: string
    answer: string
    rationale?: string | undefined
    /** Who decided; the caller when absent. The agent names the user when it records the user's checkpoint answer. */
    decidedBy?: 'user' | 'agent' | undefined
  }
  | { action: 'check'; projectId: ProjectId; scope?: string | undefined }
  | { action: 'import'; projectId: ProjectId; paths: string[] }
  | { action: 'import-template'; projectId: ProjectId; paths: string[] }
  | { action: 'refresh-evidence'; projectId: ProjectId; evidenceId: EvidenceId }
  | { action: 'search-evidence'; projectId: ProjectId; query: string }
  | { action: 'literature-search'; projectId: ProjectId; query: string; provider: LiteratureItem['provider'] }
  | { action: 'literature-import'; projectId: ProjectId; item: LiteratureItem }
  | { action: 'claim'; projectId: ProjectId; claim: ClaimRecord }
  | ({ action: 'save-artifact'; projectId: ProjectId; content: string; expectedRevision?: number | undefined } & ArtifactFields)
  | ({ action: 'register-artifact'; projectId: ProjectId } & ArtifactFields)
  | { action: 'read-artifact'; projectId: ProjectId; artifactId: ArtifactId }
  | { action: 'environment'; projectId: ProjectId; environment: Omit<EnvironmentRecord, 'id' | 'fingerprint' | 'status' | 'details'> }
  | { action: 'experiment'; projectId: ProjectId; spec: ExperimentSpec; requestId: string }
  | { action: 'experiment-refresh'; projectId: ProjectId; runId: ExperimentId }
  | { action: 'experiment-cancel'; projectId: ProjectId; runId: ExperimentId }
  | { action: 'experiment-dismiss'; projectId: ProjectId; runId: ExperimentId }
  | { action: 'experiment-logs'; projectId: ProjectId; runId: ExperimentId }
  | { action: 'experiment-wait'; projectId: ProjectId; runIds: ExperimentId[]; timeoutSeconds: number }
  | { action: 'compile'; projectId: ProjectId; artifactId?: ArtifactId | undefined; path?: string | undefined; engine: CompileRecord['engine'] }
  | { action: 'render-pages'; projectId: ProjectId; artifactId?: ArtifactId | undefined; maxPages?: number | undefined }  | { action: 'visual-review'; projectId: ProjectId; artifactId: ArtifactId }
  | { action: 'complete-visual-review'; projectId: ProjectId; artifactId: ArtifactId; artifactRevision: number; sessionId: string; findings: string }
  | {
    action: 'generate-image'
    projectId: ProjectId
    prompt: string
    path: string
    size?: string | undefined
    quality?: 'low' | 'medium' | 'high' | 'auto' | undefined
    background?: 'transparent' | 'opaque' | 'auto' | undefined
    /** Project images sent as style or layout references. */
    references?: string[] | undefined
  }
  | { action: 'fetch-reference-figures'; projectId: ProjectId; arxivIds: string[]; label: string }
  /** Run one of the scripts the project's mode pack declares, with arguments after the manifest's own. */
  | { action: 'run-script'; projectId: ProjectId; script: string; args?: string[] | undefined }
  | { action: 'export'; projectId: ProjectId }
  /** The knowledge graphs available to the project, and whether ranking can be semantic. */
  | { action: 'graph-status'; projectId: ProjectId }
  /** Rank research patterns for an idea; `path` saves the result as JSON in the project. */
  | { action: 'recall'; projectId: ProjectId; query: string; topK?: number | undefined; path?: string | undefined }
  /** Compare story.json (or `story`) with the closest works and write novelty_report.json (or `path`). */
  | { action: 'novelty'; projectId: ProjectId; story?: string | undefined; path?: string | undefined }
  /** Cluster an extracted corpus (JSON lines) into candidate patterns. */
  | { action: 'build-graph'; projectId: ProjectId; papers: string; domain: string }
  /** Name the clusters (cluster_meta.json or `names`) and assemble the project graph. */
  | { action: 'name-patterns'; projectId: ProjectId; names?: string | undefined }

export interface ResearchTask {
  id: string
  kind: string
  projectId?: ProjectId | undefined
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  message: string
  createdAt: string
  result?: ResearchResponse | undefined
}
