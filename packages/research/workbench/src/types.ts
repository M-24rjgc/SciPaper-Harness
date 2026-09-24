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
export type CheckId = 'cite' | 'numbers' | 'placeholders' | 'figures' | 'compile' | 'visual' | 'review' | 'stale' | 'claims' | 'structure' | 'prose'

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
  /** The last line the run appended to its progress file, as the supervisor last read it; absent until it writes one. */
  progress?: RunProgress | undefined
}
/** One progress line of a run: `$RESEARCH_PROGRESS_PATH` takes one JSON object per line. */
export interface RunProgress {
  /** The line's numeric fields, except `progress`. */
  values: Record<string, number>
  /** The line's `progress` field: the fraction of the run done, from 0 to 1. */
  fraction?: number | undefined
  /** The line's `note` field: what the run is doing, in its own words. */
  note?: string | undefined
  /** When the progress file last changed. */
  at: string
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
/** A figure of the built-in figure gallery: a published paper's Figure 1 or teaser. */
export interface GalleryFigure {
  /** The gallery's id, such as `neurips2024-19`. */
  id: string
  venue: string
  year: number
  title: string
  authors: string[]
  /** The gallery's visual pattern: architecture, pipeline, framework, conceptual, taxonomy, teaser … */
  pattern: string
  /** Oral or Spotlight, where the venue marked the paper. */
  tier?: 'oral' | 'spotlight' | undefined
  /** A best-paper award or honorable mention. */
  award?: 'best' | 'honorable' | undefined
  /** The paper's page. */
  paper: string
  /** The PDF the figure was cropped from, when it is not the paper's page. */
  pdf?: string | undefined
  width: number
  height: number
  /** The gallery's design-quality score. */
  score?: number | undefined
}
/** Where the figure gallery comes from; each figure keeps its paper's copyright. */
export interface GallerySource {
  name: string
  repository: string
  commit: string
  license: string
}
/** One page of a figure gallery search. */
export interface GalleryPage {
  /** Figures matching the search, across all pages. */
  total: number
  offset: number
  figures: GalleryFigure[]
  /** How the page was ranked: `browse` without a query, `keyword`, or `semantic` (keywords fused with embeddings). */
  basis: 'browse' | 'keyword' | 'semantic'
  /** Figures per venue, year, pattern and tier across the whole gallery. */
  facets: { venue: Record<string, number>; year: Record<string, number>; pattern: Record<string, number>; tier: Record<string, number> }
  source: GallerySource
}
/** How a board value is drawn: good news, something to watch, a failure, or recessive. */
export type BoardTone = 'good' | 'warning' | 'bad' | 'muted'
/**
 * A board value: fixed, or following the final metric of a run. `run` names a
 * run id, or a run name that covers every seed of that name unless `seed` picks one.
 */
export interface BoardValue {
  value?: string | number | undefined
  run?: string | undefined
  seed?: number | undefined
  /** The metric of the followed runs; their mean, with the spread over seeds, once more than one finished. */
  metric?: string | undefined
  /** Multiplies a number before it is shown, e.g. 100 for a percentage. */
  scale?: number | undefined
  digits?: number | undefined
  unit?: string | undefined
  /** A shown value at or past it is good, one short of it a warning. */
  target?: number | undefined
  better?: 'higher' | 'lower' | undefined
  sub?: string | undefined
  tone?: BoardTone | undefined
}
/** A table cell: text, a number, empty, or a value that may follow runs. */
export type BoardCell = string | number | null | BoardValue
/** One number in a stats block or the overview row. */
export interface BoardStat extends BoardValue {
  label: string
  /** Draws a bar under the value: the fraction done, from 0 to 1. */
  progress?: number | undefined
}
/** One line of a chart: a run's progress field over its progress lines, or points a collector computed. */
export interface BoardSeries {
  label?: string | undefined
  /** A run id, or the latest run of that name (and seed). */
  run?: string | undefined
  seed?: number | undefined
  /** The progress field plotted. */
  key?: string | undefined
  points?: [number, number][] | undefined
}
/** One line of a list block: a step, a job or a run. */
export interface BoardListItem {
  title: string
  /** Free text; `pending`, `running`, `done`, `failed` and `blocked` get their own mark. A followed run supplies its own. */
  status?: string | undefined
  progress?: number | undefined
  detail?: string | undefined
  run?: string | undefined
  seed?: number | undefined
  tone?: BoardTone | undefined
}
interface BoardBlockBase { title?: string | undefined; note?: string | undefined }
/** The building blocks a board section is made of. */
export type BoardBlock =
  | BoardBlockBase & { type: 'stats'; items: BoardStat[] }
  | BoardBlockBase & {
    type: 'table'
    columns: { key: string; label: string; align?: 'left' | 'center' | 'right' | undefined }[]
    rows: { cells: Record<string, BoardCell>; tone?: BoardTone | undefined }[]
  }
  | BoardBlockBase & {
    type: 'chart'
    /** The progress field on the horizontal axis; the first of epoch, step and iteration a line has, else the line number. */
    x?: string | undefined
    xLabel?: string | undefined
    yLabel?: string | undefined
    min?: number | undefined
    max?: number | undefined
    series: BoardSeries[]
  }
  | BoardBlockBase & { type: 'list'; items: BoardListItem[] }
  /** The runs whose names match `match` (`*` matches anything), with the named metrics. */
  | BoardBlockBase & { type: 'runs'; match: string; metrics?: string[] | undefined; scale?: number | undefined; digits?: number | undefined }
  | BoardBlockBase & { type: 'text'; text: string; tone?: BoardTone | undefined }
  | BoardBlockBase & { type: 'kv'; items: { label: string; value: string | number; tone?: BoardTone | undefined }[] }
  | BoardBlockBase & { type: 'log'; text: string }
/** One section of the board, built from blocks. */
export interface BoardSection {
  id: string
  title: string
  note?: string | undefined
  /** Shown folded, as for a superseded batch. */
  collapsed?: boolean | undefined
  blocks: BoardBlock[]
}
/**
 * A project script the board runs, read-only, to report what the platform
 * cannot see itself (a queue the user runs, a results folder on a server).
 * It prints one JSON object: `{stats?, sections?, alerts?}`.
 */
export interface BoardCollector {
  id: string
  /** Project-relative path of the Python script. */
  script: string
  /** The environment whose interpreter runs it, locally or over SSH; the project's default environment when absent. */
  environmentId?: string | undefined
  /** Seconds between runs while the board is open. */
  every?: number | undefined
  args?: string[] | undefined
}
/** The board layout the agent keeps: what to show and where each number comes from, never the numbers themselves. */
export interface BoardSpec {
  title?: string | undefined
  summary?: string | undefined
  tags?: string[] | undefined
  sections: BoardSection[]
  collectors: BoardCollector[]
  updatedAt?: string | undefined
}
/** Something on the board a person should see. */
export interface BoardAlert {
  level: 'info' | 'warning' | 'error'
  text: string
}
/** What one collector printed last, and when. */
export interface BoardCollected {
  at: string
  ms: number
  stats: BoardStat[]
  sections: BoardSection[]
  alerts: BoardAlert[]
  /** Why the last run produced nothing; the previous output is kept. */
  error?: string | undefined
}
/** One resource sample of a machine: utilisations and memory shares from 0 to 1. */
export interface BoardSample {
  t: number
  gpu?: number | undefined
  gpuMemory?: number | undefined
  cpu?: number | undefined
  memory?: number | undefined
}
/** A machine that runs the project's experiments, as its probe last saw it. */
export interface BoardMachine {
  /** `local`, or the SSH host alias. */
  key: string
  /** The environments that run on it. */
  environments: string[]
  at: string
  error?: string | undefined
  host?: string | undefined
  os?: string | undefined
  gpus: {
    name: string
    util?: number | undefined
    memoryUsed?: number | undefined
    memoryTotal?: number | undefined
    temperature?: number | undefined
    power?: number | undefined
    powerLimit?: number | undefined
  }[]
  /** Busy share of the processors from 0 to 1, and the processors visible. */
  cpu?: { util?: number | undefined; cores?: number | undefined } | undefined
  /** Bytes. */
  memory?: { used: number; total: number } | undefined
  /** The experiment directory's file system, in bytes. */
  disk?: { path: string; used: number; total: number; free: number } | undefined
  history: BoardSample[]
}
/** The experiment board as the desktop draws it: the agent's layout and what the scripts last read. */
export interface BoardSnapshot {
  spec: BoardSpec
  capturedAt?: string | undefined
  /** A read is under way; ask again shortly for its result. */
  refreshing: boolean
  machines: BoardMachine[]
  /** Progress lines (numeric fields) of running runs and of runs a chart follows, thinned to a few hundred. */
  series: Record<string, Record<string, number>[]>
  collected: Record<string, BoardCollected>
  alerts: BoardAlert[]
}
/** A change to the board layout. */
export interface BoardPatch {
  title?: string | undefined
  summary?: string | undefined
  tags?: string[] | undefined
  sections?: (BoardSection | { id: string; remove: true })[] | undefined
  collectors?: (BoardCollector | { id: string; remove: true })[] | undefined
}
export interface ResearchResponse {
  project?: ResearchProject | undefined
  jobId?: string | undefined
  message: string
  content?: string | undefined
  path?: string | undefined
  paths?: string[] | undefined
  literature?: LiteratureItem[] | undefined
  gallery?: GalleryPage | undefined
  board?: BoardSnapshot | undefined
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
  /** The board layout as stored. */
  | { action: 'board-get'; projectId: ProjectId }
  /**
   * Change the board layout: sections and collectors are replaced by id,
   * `{id, remove: true}` drops one; `replace` starts from an empty board.
   */
  | { action: 'board-update'; projectId: ProjectId; board: BoardPatch; replace?: boolean | undefined }
  /** Read machines, progress and collectors now, and report what each produced. */
  | { action: 'board-refresh'; projectId: ProjectId }
  /**
   * The board as last read, starting a new read in the background when
   * `refresh` asks and the last one is old; `runs` adds those runs' progress lines.
   */
  | { action: 'board-view'; projectId: ProjectId; refresh?: boolean | undefined; runs?: ExperimentId[] | undefined }
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
  /** Search the figure gallery; filters narrow it, a query ranks it. */
  | {
    action: 'find-reference-figures'
    projectId: ProjectId
    query?: string | undefined
    pattern?: string | undefined
    venue?: string | undefined
    year?: number | undefined
    /** `award` for best papers and honorable mentions. */
    tier?: 'award' | 'oral' | 'spotlight' | undefined
    limit?: number | undefined
    offset?: number | undefined
  }
  /** Save reference figures under figures/refs/: gallery figures by id, or overview figures of arXiv papers. */
  | { action: 'fetch-reference-figures'; projectId: ProjectId; arxivIds?: string[] | undefined; galleryIds?: string[] | undefined; label: string }
  /** Audit an SVG figure; `save` writes the report to figures/audit_logs/<name>.audit.json. */
  | { action: 'audit-svg'; projectId: ProjectId; path: string; save?: boolean | undefined; minFontPx?: number | undefined }
  /** Export an SVG figure to a vector PDF (beside it, or `output`) with PNG previews under figures/previews. */
  | { action: 'export-figure'; projectId: ProjectId; path: string; output?: string | undefined }
  /** Run one of the scripts the project's mode pack declares, with arguments after the manifest's own. */
  | { action: 'run-script'; projectId: ProjectId; script: string; args?: string[] | undefined }
  | { action: 'export'; projectId: ProjectId }
  /** The venues of the template library matching `query`. */
  | { action: 'list-venues'; projectId: ProjectId; query?: string | undefined }
  /** Apply a venue's template: `review` (anonymous where the venue is) or `final`. */
  | { action: 'apply-template'; projectId: ProjectId; venue: string; stage?: 'review' | 'final' | undefined }
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
