/** Serializable research records shared by tools, storage and the desktop. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Stable identity of a research record, separate from its folder's Workspace identity. */
export type ProjectId = Branded<'ResearchProjectId'>
/** Identity of an imported source whose revisions can be cited by claims and artifacts. */
export type EvidenceId = Branded<'ResearchEvidenceId'>
/** Identity of a tracked project artifact across its file revisions. */
export type ArtifactId = Branded<'ResearchArtifactId'>
/** Identity of one submitted experiment run and its recorded observations. */
export type ExperimentId = Branded<'ResearchExperimentId'>
/** Identity of a configured local or SSH execution environment. */
export type EnvironmentId = Branded<'ResearchEnvironmentId'>
/** Whether the agent stops at key decisions to ask, or decides and records its rationale. */
export type Autonomy = 'checkpoints' | 'automatic'
/** Observed experiment state; `unknown` means observation failed, not that the process has stopped. */
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

/** Position within an evidence source; the source format determines which fields identify the passage. */
export interface SourceLocator {
  page?: number | undefined
  paragraph?: number | undefined
  line?: number | undefined
  key?: string | undefined
}
/** Extracted text paired with the location a citation can point back to. */
export interface EvidenceChunk {
  text: string
  locator: SourceLocator
}
/** Imported source with revisioned content and extraction coverage, including whether it is verified or stale. */
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
/** A quotation tied to a specific source revision and passage, so later source changes can invalidate it. */
export interface EvidenceLink {
  evidenceId: EvidenceId
  revision: number
  locator: SourceLocator
  quote: string
}
/** A research claim and its recorded support state, citing evidence passages and associated artifacts. */
export interface ClaimRecord {
  id: string
  text: string
  kind: 'hypothesis' | 'method' | 'literature' | 'empirical'
  state: 'proposed' | 'supported' | 'contradicted' | 'stale'
  evidence: EvidenceLink[]
  artifactIds: ArtifactId[]
}
/** A revisioned project file with the evidence, claims and input-artifact revisions it depends on. */
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
  /**
   * A short slug naming what the decision settles, such as
   * `experiments-deferred`; a phase that declares it as `deferrable` is
   * deferred while the phase is not done. Absent on most decisions.
   */
  key?: string | undefined
}
/** A configured Python environment, its execution target, and the result of preparing or inspecting it. */
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
/** Inputs and execution limits for one experiment, including the code and evidence copied into its run snapshot. */
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
/** A submitted run's frozen inputs and latest observation; `collected` separately records whether results became evidence. */
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
  /**
   * The conversation (agent session) that submitted the run; absent for runs
   * the desktop submitted and for runs recorded before runs kept it.
   */
  sessionId?: string | undefined
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
/** Outcome of compiling one manuscript revision, with the input digest, output paths and diagnostics. */
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
/** Page-rendering or visual-review outcome for a manuscript revision; rendering alone does not mean the pages were reviewed. */
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
/** One actionable result from a base check or mode gate, with a source location when available. */
export interface CheckFinding {
  /** A base {@link CheckId}, or the id of a gate the project's mode pack runs. */
  check: string
  severity: 'error' | 'warning'
  message: string
  file?: string | undefined
  line?: number | undefined
}
/** A mode phase's completion result and unmet requirements in one check report. */
export interface PhaseStatus {
  /** A phase id of the mode pack the check ran under. */
  id: string
  done: boolean
  /** What still stands between this phase and done, in the agent's terms. */
  missing: string[]
  /**
   * The same as keys, for the person's view: the key of each unmet
   * requirement in the order the pack lists them (`requirementKey`), then
   * `errors:<check>` for each deciding check that reported an error. Empty
   * when the phase is done; reports stored before keys existed read as empty.
   */
  unmet: string[]
}
/** A deterministic report on the paper's current files; it never refuses anything. */
export interface CheckReport {
  clean: boolean
  scope: string
  /** The mode and route whose phases the report lists. */
  mode?: string | undefined
  route?: string | undefined
  /**
   * The ids of the mode's gates this check ran, or tried to (a gate that could
   * not run reports an error under its id). Base checks always run. Reports
   * stored before this field existed read as none.
   */
  gatesRun: string[]
  phases: PhaseStatus[]
  findings: CheckFinding[]
  checkedAt: string
}
/** Where one phase stood after the last check that decided it. */
export interface PhaseProgress {
  done: boolean
  /** What held it back, as {@link PhaseStatus.unmet} keys. */
  unmet: string[]
  checkedAt: string
}
/** The findings of one check, from the last report that ran it. */
export interface CheckProgress {
  items: CheckFinding[]
  checkedAt: string
}
/** The last check of the whole paper (scope `all`). */
export interface FullCheckProgress {
  clean: boolean
  errors: number
  warnings: number
  checkedAt: string
}
/**
 * What research_check reports established for the project's mode and route,
 * merged report by report; research_check is its only writer. A phase moves
 * only when the report ran every gate that decides it, a check's findings are
 * replaced whenever a report ran that check, and `full` changes only with a
 * scope-`all` report. A report for another mode or route starts it afresh.
 */
export interface ResearchProgress {
  mode: string
  route?: string | undefined
  /** By phase id. */
  phases: Record<string, PhaseProgress>
  /** By check id: a base check or one of the mode's gates. */
  findings: Record<string, CheckProgress>
  full?: FullCheckProgress | undefined
}
/**
 * How a phase stands for the person: `done` by its last check, `current` for
 * the first phase that is neither done nor deferred, `pending` after it, and
 * `deferred` while a recorded decision defers a phase that is not done.
 */
export type PhaseState = 'done' | 'current' | 'pending' | 'deferred'
/** One phase of the project's mode as the person reads it. */
export interface StandingPhase {
  id: string
  label: LocalizedText
  state: PhaseState
  /** The phase asks the person before its work starts. */
  checkpoint: boolean
  /** One sentence per unmet key of its last check, from the mode pack; empty when done or never checked. */
  hints: LocalizedText[]
  /** When a check last decided this phase; absent before any did. */
  checkedAt?: string | undefined
}
/** What one check found at its last run, for the person. */
export interface StandingIssues {
  /** A base check or gate id. */
  check: string
  /** The check's name: a gate's label from its pack, or the built-in name of a base check. */
  label: LocalizedText
  errors: number
  warnings: number
  /** The first file its findings name that exists now, errors first; absent when none does. */
  file?: string | undefined
  line?: number | undefined
  /** The check's findings, errors first, in the words the check wrote for the agent. */
  findings: CheckFinding[]
}
/**
 * Where a project stands, derived from its stored progress, its mode and its
 * files for each snapshot and brief; never stored.
 */
export interface ResearchStanding {
  /** The phases of the project's mode on its route, in order; none in a mode without phases. */
  phases: StandingPhase[]
  /** The current phase's id; absent when every phase is done or deferred. */
  next?: string | undefined
  /** The current phase's first hint; absent when it has none or was never checked. */
  hint?: LocalizedText | undefined
  /** The whole-paper check is clean, every phase is done, and no file changed since that check. */
  finished: boolean
  /** When the last check ran; absent before any check under this mode and route. */
  checkedAt?: string | undefined
  /**
   * Whether a project file (outside `.research`, `exports`, `.git` and
   * `node_modules`) changed after the last check; `unknown` when the project
   * holds too many files to list.
   */
  changedSinceCheck: boolean | 'unknown'
  /** What the last checks found, one group per check that has findings: groups with errors first. */
  issues: StandingIssues[]
}
/** An unfinished goal of a live conversation in a research, as the goal service reports it. */
export interface ResearchGoal {
  /** The conversation (agent session) that holds the goal. */
  sessionId: string
  objective: string
  /** `active` while it drives rounds; `paused` or `blocked` while it waits for the person. */
  phase: 'active' | 'paused' | 'blocked'
  roundsStarted: number
  /** Epoch milliseconds of the goal's last change. */
  updatedAt: number
}
/** The durable research record together with optional derived fields that snapshots expose to clients. */
export interface ResearchProject {
  id: ProjectId
  workspaceId: WorkspaceId
  title: string
  /**
   * True while the title is a placeholder the product chose rather than a
   * name for the research; `rename` clears it. Absent once the research is named.
   */
  untitled?: boolean | undefined
  root: string
  /**
   * True when creating the research also created its root folder, so
   * discarding it as an untouched draft may remove that folder once it is
   * empty. Absent when the folder existed before, and on researches created
   * before drafts existed.
   */
  createdRoot?: boolean | undefined
  /**
   * True for a shipped example under `<data home>/research/examples` or
   * legacy `demo`, which is read-only. Derived for every snapshot and
   * brief, never stored; absent for the person's own researches.
   */
  example?: boolean | undefined
  /**
   * True for the untouched draft research that 新研究 (New research) opens:
   * it still carries the placeholder title (`untitled`), its record holds
   * nothing but its autonomy, every conversation of it is blank (no turn
   * started), and its folder holds only the empty folders it was created
   * with. Derived for every snapshot and for the results of `start-new` and
   * `relocate`, never stored; absent otherwise.
   */
  draft?: boolean | undefined
  /**
   * When the person removed the research from the list (移出列表,
   * `archive-project`); absent while it is listed. Its folder and its runs
   * are untouched, but its runs are not observed in the background while it is set.
   */
  archivedAt?: string | undefined
  /**
   * The conversations `archive-project` archived, which `unarchive-project`
   * unarchives again; absent when it archived none. A conversation the
   * person had archived before is not among them and stays archived.
   */
  archivedConversations?: string[] | undefined
  /**
   * True while the research is removed from the list (`archivedAt` is set).
   * Derived for every snapshot and command answer, never stored; absent otherwise.
   */
  archived?: boolean | undefined
  /** The mode pack the project runs in; `general` adds nothing to the research tools. */
  mode: string
  /** The route through the mode, for packs that have routes. */
  route?: string | undefined
  /** The venue whose template the project uses, once one is applied. */
  venue?: string | undefined
  /** Why the mode and route were chosen; kept until a later `set-mode` gives a new reason. */
  modeReason?: string | undefined
  /**
   * Who chose the mode: the caller that named one at creation (`user`), or
   * the `decidedBy` of the last `set-mode`. Absent while the mode is not
   * chosen yet, as for a research created without naming one.
   */
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
  /** The last check report, whatever its scope; kept for compatibility, progress is read from `progress`. */
  lastCheck?: CheckReport | undefined
  /** Absent until the first check this version stored; a stored scope-`all` `lastCheck` then stands in for it. */
  progress?: ResearchProgress | undefined
  /** Where the project stands: derived for each snapshot, never stored; absent elsewhere. */
  standing?: ResearchStanding | undefined
  /**
   * The unfinished goals of the project's live conversations (`activeGoals`),
   * those that drive rounds first: derived for each snapshot, never stored;
   * absent when there is none, and elsewhere.
   */
  goals?: ResearchGoal[] | undefined
  sessionId?: string | undefined
}
/** A provider/model selection resolved through the harness's model registry. */
export interface ModelBinding {
  provider: string
  model: string
}
/** Image-generation endpoint and request defaults; credentials are stored separately from these preferences. */
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
/** Saved model selections, tool paths and display preferences shared by the person's researches. */
export interface ResearchPreferences {
  main?: ModelBinding | undefined
  vision?: ModelBinding | undefined
  image?: ImageBinding | undefined
  embedding?: EmbeddingBinding | undefined
  python?: string | undefined
  uv?: string | undefined
  texBin?: string | undefined
  /**
   * The absolute folder new researches are created in, as
   * `<researchHome>/<yyyy-mm-dd>-<n>`; the person's choice in the settings.
   * When absent, the service's configured `researchHome` or
   * `<profile home>/SciPaper` applies.
   */
  researchHome?: string | undefined
  /**
   * Whether the sidebar lists the example researches (设置 › 科研 ›
   * 显示示例研究, Show example researches); absent reads as true.
   */
  showExamples?: boolean | undefined
  /**
   * Which kinds of memory a new research carries (the switches of the Memory
   * view); a kind that is absent reads as on.
   */
  memoryCarry?: Partial<Record<MemoryKind, boolean | undefined>> | undefined
}
/** Detected availability, executable path and version of one research runtime component. */
export interface ComponentStatus {
  id: 'python' | 'uv' | 'latex' | 'drawio'
  installed: boolean
  path: string
  version: string
  /** Where the selected tool is provided; omitted by older component snapshots. */
  source?: 'configured' | 'managed' | 'system' | 'bundled' | undefined
  /** Why a discovered or explicitly configured tool could not be used. */
  problem?: 'missing-executable' | 'invalid-executable' | undefined
  /** TeX engines whose version command succeeded in the selected binary directory. */
  engines?: CompileRecord['engine'][] | undefined
}
/** A project's mode or route as just recorded; the payload of the `research/mode` event. */
export interface ResearchModeEvent {
  projectId: ProjectId
  root: string
  mode: string
  route?: string | undefined
}
/** Client-facing view of the research records, configured tools, installed modes and effective research home. */
export interface ResearchSnapshot {
  projects: ResearchProject[]
  preferences: ResearchPreferences
  components: ComponentStatus[]
  /** The installed modes, in display order. */
  modes: ModeSummary[]
  /** Availability of the optional knowledge graph provider and of its sub-plugins in this profile. */
  knowledge?: { enabled: boolean; modules: KnowledgeModules } | undefined
  /**
   * The folder new researches are created in now: the `researchHome`
   * preference, else the configured one, else `<profile home>/SciPaper`.
   * Every snapshot the service returns carries it.
   */
  researchHome?: string | undefined
}
/** A provider's bibliographic search result; an abstract or citation does not establish full-text coverage. */
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
/** A primary reference supplied for comparing a research claim in any mode. */
export interface KnowledgeReference {
  title: string
  text: string
  url?: string | undefined
}

/** Graph explorer filters shared by the human interface and the Agent. */
export interface KnowledgeGraphQuery {
  source?: 'all' | 'ai' | 'project' | undefined
  query?: string | undefined
  domain?: string | undefined
  pattern?: string | undefined
  offset?: number | undefined
  limit?: number | undefined
}

/** One inspectable graph node with its source and original research content. */
export interface KnowledgeGraphNode {
  id: string
  kind: 'pattern' | 'paper' | 'domain'
  label: string
  source: 'ai' | 'project'
  summary: string
  domain: string
  url?: string | undefined
  size?: number | undefined
  problem?: string | undefined
  solution?: string | undefined
}

/** A bounded graph view; errors identify unavailable sources without hiding healthy ones. */
export interface KnowledgeGraphPage {
  nodes: KnowledgeGraphNode[]
  edges: { from: string; to: string; kind: 'uses-pattern' | 'in-domain' | 'similar' }[]
  graphs: { source: 'ai' | 'project'; name: string; patterns: number; papers: number }[]
  domains: string[]
  warnings: string[]
  total: number
  offset: number
  hasMore: boolean
}

/** Which optional knowledge sub-plugins are mounted in this profile; each one adds a view and its commands. */
export interface KnowledgeModules {
  /** The domain map (`research-knowledge-map`); it also needs the graph engine, so it is off whenever that is. */
  map: boolean
  /** The evidence graph (`research-knowledge-evidence`); it reads only the project's own record. */
  evidence: boolean
  /** The research memory (`research-knowledge-memory`); it reads only the records of the researches on this computer. */
  memory: boolean
  /** The relation graph (`research-knowledge-relations`); it reads only the project's own record and works without the engine. */
  relations: boolean
}

/**
 * How a claim stands against the sources it cites. `contradicted` is the
 * recorded state. A claim that cites nothing is `proposed` when it is a
 * hypothesis and `missing` otherwise. A claim that cites a source that changed
 * since, or is recorded `stale`, is `stale`. A claim recorded `proposed` stays
 * `proposed`; every other claim is `supported`.
 */
export type EvidenceClaimStatus = 'supported' | 'stale' | 'missing' | 'proposed' | 'contradicted'

/**
 * One node on the evidence side of the graph: a run, a literature item or a
 * file that a claim cites, or a placeholder where evidence is still to come.
 */
export interface EvidenceGraphSource {
  /** Stable for a record: `run:<id>`, `source:<id>`, `expected:<run id>` or `none:<claim id>`. */
  id: string
  /** `expected-run` is a run in progress or not yet collected; `none` marks a claim nothing is expected for. */
  kind: 'run' | 'literature' | 'file' | 'expected-run' | 'none'
  /** A run's name, or a source's title; empty for `none`. */
  label: string
  /** A run's seed. */
  seed?: number | undefined
  /** Where a run executes: `local`, or its SSH host alias. */
  host?: string | undefined
  /** A run's status. */
  status?: RunStatus | undefined
  /** A run's recorded metrics. */
  metrics?: Record<string, number> | undefined
  /** A literature item or file: whether the host verified it. */
  verified?: boolean | undefined
  /** A literature item or file: what was extracted from it. */
  coverage?: EvidenceRecord['coverage'] | undefined
  /** The source is recorded stale, or a claim cites an older revision of it. */
  changed: boolean
  /** Project-relative path of the source's record, for opening it. */
  path?: string | undefined
}

/** One citation of a source by a claim. */
export interface EvidenceGraphLink {
  /** The {@link EvidenceGraphSource.id} cited. */
  sourceId: string
  /** The revision the claim cited. */
  revision: number
  /** The source is recorded stale, is gone, or has a newer revision than the one cited. */
  outdated: boolean
  locator: SourceLocator
  /** The quoted passage; absent when the citation quotes none. */
  quote?: string | undefined
}

/** A file that carries a claim, as the claim and the file each record it. */
export interface EvidenceGraphFile {
  id: ArtifactId
  path: string
  revision: number
  stale: boolean
}

/** One conclusion of the research with the sources behind it. */
export interface EvidenceGraphClaim {
  id: string
  text: string
  kind: ClaimRecord['kind']
  status: EvidenceClaimStatus
  files: EvidenceGraphFile[]
  links: EvidenceGraphLink[]
  /** Placeholder sources (`expected-run`, or one `none`) for a claim that cites nothing. */
  expected: string[]
  /** Runs in progress or not yet collected that `expected` leaves out. */
  expectedMore: number
}

/** The research question, its conclusions and their evidence, derived from the project record alone. */
export interface EvidenceGraphPage {
  /** The brief, or the title while the brief is empty. */
  question: string
  claims: EvidenceGraphClaim[]
  sources: EvidenceGraphSource[]
  summary: { claims: number } & Record<EvidenceClaimStatus, number>
}

/** What a new research can carry from the earlier ones; each kind has a switch in the Memory view. */
export type MemoryKind = 'literature' | 'runs' | 'environments' | 'writing'

/** A research that left memory: not an example, not removed from the list, and not the untouched draft. */
export interface MemoryResearch {
  id: ProjectId
  title: string
  /** The whole-paper check is clean and nothing changed since (`ResearchStanding.finished`). */
  finished: boolean
  /** Distinct literature items it imported. */
  literature: number
  /** Distinct experiments it finished, by name. */
  runs: number
  /** The venue whose template it uses: the library's name for it, else its id. */
  venue?: string | undefined
}

/** A literature item that one or several researches imported, merged by title. */
export interface MemoryLiterature {
  title: string
  doi?: string | undefined
  /** The host verified at least one of the records. */
  verified: boolean
  /** The researches that imported it, oldest first. */
  researches: ProjectId[]
}

/** The finished runs of one experiment name in one research; one per seed. */
export interface MemoryRun {
  name: string
  /** How many runs of that name finished. */
  runs: number
  /** The metrics of the run that finished last. */
  metrics: Record<string, number>
  /** The command of that run, as recorded. */
  command: string
  /** When that run was last observed. */
  at: string
  /** The research that ran it; always one. */
  researches: ProjectId[]
}

/** A ready environment of one or several researches. Local `uv` environments are merged, SSH ones by host and interpreter. */
export interface MemoryEnvironment {
  name: string
  kind: EnvironmentRecord['kind']
  target: EnvironmentRecord['target']
  /** The SSH alias; absent for a local environment. */
  host?: string | undefined
  /** The interpreter; empty for a local `uv` environment, which each research creates inside its own folder. */
  python: string
  requirements: string[]
  researches: ProjectId[]
}

/** A venue whose template one or several researches use. */
export interface MemoryWriting {
  /** The venue's id in the template library. */
  venue: string
  /** The library's name for it, when it has one. */
  name?: string | undefined
  researches: ProjectId[]
}

/** A fact a research recorded about what went wrong or what it decided; nothing here is inferred. */
export type MemoryLesson = { research: ProjectId; at: string } & (
  | {
    kind: 'failed-run'
    /** The experiment's name. */
    name: string
    /** The reason the run recorded; empty when it recorded only an exit code. */
    reason: string
    exitCode?: number | undefined
  }
  | { kind: 'decision'; question: string; answer: string; rationale: string; by: 'user' | 'agent' }
)

/** The items of one kind, newest or most shared first, and how many there are in all. */
export interface MemoryList<T> {
  total: number
  /** At most 100 of them. */
  items: T[]
}

/**
 * What the researches on this computer leave for the next one, derived from their records alone: the researches
 * that left memory, oldest first, and their literature, finished experiments, environments, venue templates and recorded lessons.
 */
export interface ResearchMemoryPage {
  researches: MemoryResearch[]
  literature: MemoryList<MemoryLiterature>
  runs: MemoryList<MemoryRun>
  environments: MemoryList<MemoryEnvironment>
  writing: MemoryList<MemoryWriting>
  lessons: MemoryList<MemoryLesson>
  /** Which kinds a new research carries: the person's switches, on unless switched off. */
  carry: Record<MemoryKind, boolean>
}

/** A labelled region of the domain map. */
export interface MapRegionView {
  index: number
  /** One to three keywords joined by " / ", shown at (x, y). */
  label: string
  keywords: string[]
  papers: number
  /** The region's most common domain. */
  domain: string
  x: number
  y: number
}

/**
 * An area that holds few papers in this map although the regions around it hold many. It is a fact about
 * the 2D drawing of this corpus, recurring across layout runs, and never evidence that a topic is unexplored.
 */
export interface MapGapView {
  index: number
  x: number
  y: number
  /** Share of the map's area. */
  area: number
  /** Labels of the regions around it, largest share first. */
  borders: string[]
  /** Layout runs, out of `runs - 1` others, in which it recurs. */
  recurs: number
  runs: number
  /** One sentence worded as a fact about the map. */
  description: string
}

/**
 * The domain map of the research field: one point per paper of the built-in graph, nearby points being
 * similar papers. Coordinates are in [0, 1], x rightward and y downward; only nearby distances mean much.
 */
export type MapViewPage = { built: false } | {
  built: true
  graph: { name: string; papers: number; patterns: number }
  /** Paper positions in graph order as base64 of little-endian uint16 pairs (x, y), each value / 65535. */
  points: string
  /** Region per paper in graph order as base64 of uint8, 255 where no region reaches. */
  regionOf: string
  regions: MapRegionView[]
  gaps: MapGapView[]
}

/** Where a text lands on the map and how much the evidence agrees. */
export interface MapPlacementView {
  x: number
  y: number
  /** Share of the evidence within reach of the point: near 1 when it agrees, low when it splits. */
  confidence: number
  /** The region at the point. */
  region?: string | undefined
  /** Other concentrations of the evidence, largest share first. */
  alternatives: { x: number; y: number; share: number }[]
  /** The papers that put it there, heaviest first (at most five); `weight` is relative to the heaviest, which weighs 1. */
  nearest: { index: number; title: string; weight: number }[]
  /** Share of the corpus's papers whose surroundings are at most this crowded (0 sparse, 1 crowded). */
  crowding: number
  /** The text matched a paper of the map by title and sits exactly on it. */
  exact?: boolean | undefined
}

/** One mark of the knowledge graph as the map and the panels show it. */
export interface KnowledgeMarkView {
  id: string
  target: { kind: 'pattern' | 'paper'; graph: 'ai' | 'project'; id: string }
  verdict: 'pin' | 'irrelevant'
  note?: string | undefined
  by: 'user' | 'agent'
  at: string
  /** The marked paper's or pattern's name, when it is still in its graph. */
  title?: string | undefined
  /** The marked paper's index in the built-in graph, for drawing it on the map. */
  index?: number | undefined
}

/** What a research places over the domain map. */
export type MapOverlayPage = { built: false } | {
  built: true
  /** The research's idea: the agent's latest recall query, else the brief; absent when there is neither. */
  idea?: { text: string; source: 'recall' | 'brief'; placement?: MapPlacementView | undefined; note?: string | undefined } | undefined
  /** The research's imported literature, each placed when the map can place it. */
  library: { evidenceId: string; title: string; placement?: MapPlacementView | undefined }[]
  /** Papers of the built-in graph the agent's recent recalls returned, most recent first. */
  recalled: { index: number; title: string; query: string }[]
  /** The research's marks on built-in papers and patterns. */
  marks: KnowledgeMarkView[]
  /** Whether recall applies the marks; the person can pause them. */
  honour: boolean
}

/** Where a search text lands on the domain map, ranked the way recall ranks the built-in graph. */
export interface MapSearchView {
  query: string
  /** How the patterns were ranked; papers are always matched by their words. */
  basis: 'lexical' | 'semantic+lexical'
  /** Absent when nothing in the built-in graph matched. */
  placement?: MapPlacementView | undefined
  /** The papers whose words matched, best first (at most ten). */
  papers: { index: number; title: string }[]
  /** The closest patterns with the centre of their papers on the map, best first (at most five). */
  patterns: { index: number; name: string; x: number; y: number }[]
}

/** A paper of the domain map, for its hover card and detail. */
export interface MapPaperView {
  index: number
  id: string
  title: string
  idea: string
  story: string
  url?: string | undefined
  pattern?: string | undefined
  region?: string | undefined
  score: number | null
}

// ── Relation graph (research-knowledge-relations) ──
// Hand-written for the client; knowledge-relations-plugin.ts returns the backend's values under these annotations, so the
// compiler rejects a backend change these interfaces do not follow.

/** The kinds of node of the relation graph; a paper is always one of the research's literature records. */
export type RelationEntityKind = 'method' | 'task' | 'dataset' | 'metric' | 'paper'
/** The kinds of directed relation, each read as `from <kind> to`. */
export type RelationKindId = 'cites' | 'introduces' | 'is-a' | 'extends' | 'improves-on' | 'compares-with' | 'applied-to' | 'evaluated-on' | 'measured-by'
/** Who put an entry in the relation graph or decided about it. */
export type RelationAuthor = 'user' | 'agent'
/** Where a ground comes from: the pages of a full-text record, a provider abstract, a project file, a run or a citation record. */
export type RelationGroundSource = 'full-text' | 'abstract' | 'file' | 'run' | 'citation'

/** A rejection of a relation or of one ground. */
export interface RelationRejection {
  by: RelationAuthor
  at: string
  reason?: string | undefined
}

/** What a relation rests on, for display: a quotation of a source, a run, or a citation record. */
export interface RelationGroundView {
  id: string
  type: 'quote' | 'run' | 'citation'
  source: RelationGroundSource
  /** `outdated`: its source changed since the ground was checked, so the relation weighs less until it is checked again. */
  status: 'current' | 'outdated' | 'rejected'
  /** The evidence record's title, the run's name and seed, or the citing paper. */
  title: string
  evidenceId?: string | undefined
  locator?: SourceLocator | undefined
  /** The source's own words, cut to 200 characters. */
  quote?: string | undefined
  runId?: string | undefined
  setting?: string | undefined
  /** Who recorded a quotation or run ground; absent for a citation. */
  by?: RelationAuthor | undefined
  /** Present when `status` is `rejected`. */
  rejection?: RelationRejection | undefined
}

/** A node of the relation graph in a list. */
export interface RelationNodeSummary {
  id: string
  kind: RelationEntityKind
  name: string
  aliases: string[]
  /** `orphaned`: a paper none of whose records the research still holds. */
  status: 'active' | 'orphaned'
  /** Relations it has that are not rejected. */
  degree: number
}

/** A node of a neighbourhood with its layout hint, so that a view draws the same picture for the same graph. */
export interface RelationNodeView extends RelationNodeSummary {
  /** 0 for the centre, 1 for its neighbours, 2 for theirs. */
  ring: 0 | 1 | 2
  /** The centre and the densest group around it; a view draws them nearest the centre. */
  core: boolean
  /** For ring 2: the ring-1 node it hangs from. */
  parent?: string | undefined
  /** Place around its ring. */
  slot: number
  /** A paper's literature records. */
  evidenceIds?: string[] | undefined
}

/** A relation of a neighbourhood: `from <kind> to`, read in that direction. */
export interface RelationEdgeView {
  id: string
  kind: RelationKindId
  from: string
  to: string
  /** `stale`: every ground rests on a source that changed. */
  status: 'active' | 'stale'
  confidence: number
  /** Grounds that are not rejected, by where they come from. */
  sources: Record<RelationGroundSource, number>
  /** Its weightiest ground. */
  best: RelationGroundView
  /** Every ground, the heaviest first and the rejected ones last. */
  grounds: RelationGroundView[]
  /** Who first recorded the relation. */
  by: RelationAuthor
}

/** The nodes and relations around one node. */
export interface RelationNeighbourhoodView {
  center: string
  nodes: RelationNodeView[]
  edges: RelationEdgeView[]
  /** What the size limits left out. */
  omitted: { nodes: number; edges: number }
}

/** A relation that is rejected, listed so that the person can restore it. */
export interface RelationRejectedView {
  id: string
  kind: RelationKindId
  from: string
  to: string
  fromName: string
  toName: string
  /** Absent when the relation stands but every one of its grounds was rejected. */
  rejection?: RelationRejection | undefined
}

/** The relation graph around one node, with what the view needs to start from; the answer of `relations-graph`. */
export interface RelationsPage {
  /** Problems of the stored file, each naming what it keeps from being honored. */
  problems: string[]
  counts: { entities: number; relations: number; stale: number; rejected: number; citationLists: number }
  /**
   * `found`: the request's entity resolved and `neighbourhood` is its neighbourhood; `none`: no entity was asked for,
   * so `neighbourhood` is the most connected entity's, when the graph has one; `unknown`: nothing matched the request;
   * `ambiguous`: several entities matched and `candidates` lists them.
   */
  match: 'none' | 'found' | 'unknown' | 'ambiguous'
  /** The most connected entities, most connected first (at most 12). */
  hubs: RelationNodeSummary[]
  candidates: RelationNodeSummary[]
  neighbourhood?: RelationNeighbourhoodView | undefined
  /** Rejected relations (at most 50), the latest first. */
  rejected: RelationRejectedView[]
}

/** One hop of a path, read in the direction the path walks it. */
export interface RelationHopView {
  relation: string
  kind: RelationKindId
  /** The relation's own ends; `direction` says whether the path walks it from `from` to `to`. */
  from: string
  to: string
  direction: 'forward' | 'backward'
  status: 'active' | 'stale'
  confidence: number
  /** Its two weightiest grounds. */
  grounds: RelationGroundView[]
  /** Other relations between the same two nodes. */
  parallel: { relation: string; kind: RelationKindId }[]
}

/** A path between two nodes with the grounds of every hop. */
export interface RelationPathView {
  nodes: string[]
  hops: RelationHopView[]
  cost: number
  /** The chance that every hop holds. */
  confidence: number
  /** Some hop is stale. */
  stale: boolean
}

/** The answer of `relations-paths`. */
export interface RelationPathsPage {
  /** The ids the request's ends resolved to, or the text when they did not. */
  from: string
  to: string
  paths: RelationPathView[]
  /**
   * `unknown-node`: an end matched no entity; `ambiguous-node`: an end matched several (see `candidates`); `same-node`;
   * `no-path`: nothing joins them within the hop limit.
   */
  none?: 'unknown-node' | 'ambiguous-node' | 'same-node' | 'no-path' | undefined
  /** The nodes on the paths. */
  nodes: RelationNodeSummary[]
  /** Set when `none` is `ambiguous-node`. */
  candidates?: { from: RelationNodeSummary[]; to: RelationNodeSummary[] } | undefined
}

/**
 * What the project's own sources say about one method and one column. `reported`: a literature record's quotation
 * grounds it; `project-only`: only the project's runs or files do; `stale`: only grounds whose source changed;
 * `mentioned`: no ground, but some passage names both; `absent`: both are named in the sources, never in one
 * passage; `uncovered`: the sources never name one of them. Every state is about the project's literature, never the field.
 */
export type RelationGapState = 'reported' | 'project-only' | 'stale' | 'mentioned' | 'absent' | 'uncovered'

/** One cell of the gap matrix. */
export interface RelationGapCell {
  state: RelationGapState
  /** Literature records with a current quotation grounding the pair. */
  papers: number
  /** Of those, the ones that ground it only through a subtype of the row or the column. */
  viaSubtypes: number
  runs: number
  files: number
  stale: number
  /** Passages naming both, counted when no ground supports the pair. */
  passages: number
  /** Sources whose grounds were rejected and that support the pair no other way; they never count toward the state. */
  rejected: number
  /** The relations that ground it, at most eight. */
  relations: string[]
}

/** One row or column of the gap matrix. */
export interface RelationGapAxisEntry {
  /** An entity id, or a setting's grouping key. */
  id: string
  name: string
  /** Passages of the project's sources that name it. */
  passages: number
}

/**
 * The gap matrix of methods against tasks, datasets or settings, as the project's own sources cover them. The view's
 * heading reads 本项目文献中的空白 with the coverage (`basis`); the states read `reported` 本项目文献中有 N 篇报告,
 * `project-only` 仅见于本项目的实验或笔记, `stale` 依据已更新，需重新核对, `mentioned` 有 N 处同时提到，尚未核实,
 * `absent` 本项目文献中没有报告, `uncovered` 本项目文献未涉及，结论前请先检索. It never says nobody has tested a pair or that the field has a gap.
 */
export interface RelationGapPage {
  axis: 'task' | 'dataset' | 'setting'
  rows: RelationGapAxisEntry[]
  columns: RelationGapAxisEntry[]
  /** cells[row][column]. */
  cells: RelationGapCell[][]
  /** The coverage the matrix rests on: literature records by what was extracted, and project files. */
  basis: { literature: number; fullText: number; abstractOnly: number; metadataOnly: number; files: number }
  /** The client's locale keys for the heading and for each state. */
  wording: { heading: string; states: Record<RelationGapState, string> }
}

/** Why a proposal or a correction was refused, with the message the proposer reads. */
export interface RelationRefusalView {
  status: 'refused'
  /** What to change: `quote-not-found`, `missing-mention`, `rejected`, `not-yours` … */
  code: string
  message: string
}

/** The outcome of one proposal: a relation or a ground added, found already recorded, or moved to the current revision. */
export type RelationProposalOutcomeView =
  | {
    status: 'added' | 'unchanged' | 'regrounded'
    relation: string
    ground: string
    /** Entities this proposal created. */
    created: string[]
    /** The proposer's locator did not hold the quotation and was replaced. */
    locatorCorrected: boolean
    /** Rules a person's quotation did not meet, kept with the ground. */
    warnings: string[]
    /** The proposal lifted an earlier rejection. */
    restored: boolean
  }
  | RelationRefusalView

/** The outcome of rejecting or restoring a relation or one of its grounds. */
export type RelationDecisionOutcomeView = { status: 'changed' | 'unchanged'; relation: string } | RelationRefusalView

/** One outcome of `relations-propose` (one per proposal, in order), `relations-reject` or `relations-restore` (one). */
export type RelationOutcomeView = RelationProposalOutcomeView | RelationDecisionOutcomeView

/** A node created or found by `relations-entity`, or the survivor of a merge. */
export interface RelationEntityView {
  id: string
  kind: RelationEntityKind
  name: string
  aliases: string[]
  evidenceIds?: string[] | undefined
}

/** The outcome of `relations-entity`. */
export type RelationEntityOutcomeView = { status: 'created' | 'updated' | 'unchanged'; entity: RelationEntityView } | RelationRefusalView

/** The outcome of `relations-merge`; no operation undoes a merge. */
export type RelationMergeOutcomeView = { status: 'merged'; entity: RelationEntityView; dropped: string[] } | RelationRefusalView

/** Two entities that may be one, for the person to merge or keep apart. */
export interface RelationMergeSuggestionView {
  a: string
  b: string
  /** `acronym`: one's name is the initials of the other's; `spelling`: their names differ in one letter. */
  reason: 'acronym' | 'spelling'
  /** The two names that matched. */
  names: [string, string]
}

/** What `relations-reground` did. */
export interface RelationRegroundView {
  /** Quotations found again in their source's current revision and moved to it. */
  regrounded: number
  /** Quotations whose source changed and that no longer hold in the current revision. */
  lapsed: number
}

/** What `relations-citations` did: reference lists fetched and the citations among the research's papers they gave. */
export interface RelationCitationsView {
  /** Papers whose list was missing or older than the configured age. */
  asked: number
  /** Reference lists now cached. */
  works: number
  /** `cites` grounds added. */
  added: number
  /** Citations already recorded. */
  unchanged: number
  /** Citations not recorded because the relation or the ground is rejected. */
  rejected: number
  /** One message per request that failed. */
  failures: string[]
}

/** A node a relation proposal names: by id, by a paper's literature record, or by kind and name. */
export type RelationEndRef =
  | { id: string }
  | { kind: 'paper'; evidenceId: string }
  | { kind: 'method' | 'task' | 'dataset' | 'metric'; name: string; aliases?: string[] | undefined }

/** What a proposed relation rests on: a quotation of one revision of an evidence record, or completed project runs. */
export type RelationGroundInput =
  | { type: 'quote'; evidenceId: string; revision: number; quote: string; locator?: SourceLocator | undefined; setting?: string | undefined }
  | { type: 'run'; runId: string; from: string; to: string; baselineRunId?: string | undefined; setting?: string | undefined }

/** A relation to propose; who proposes it is set by the caller, never by this input. */
export interface RelationProposalInput {
  kind: RelationKindId
  from: RelationEndRef
  to: RelationEndRef
  ground: RelationGroundInput
}

/** Command result or acknowledgement; `jobId` identifies asynchronous work whose result appears in a ResearchTask. */
export interface ResearchResponse {
  project?: ResearchProject | undefined
  jobId?: string | undefined
  message: string
  content?: string | undefined
  /** read-artifact: true when the file is binary, so `content` is empty and save-artifact refuses it; absent for a text file. */
  binary?: boolean | undefined
  path?: string | undefined
  paths?: string[] | undefined
  literature?: LiteratureItem[] | undefined
  gallery?: GalleryPage | undefined
  knowledgeGraph?: KnowledgeGraphPage | undefined
  evidenceGraph?: EvidenceGraphPage | undefined
  /** memory and memory-carry, for the desktop; the agent receives the carried kinds in `content`. */
  memory?: ResearchMemoryPage | undefined
  mapView?: MapViewPage | undefined
  mapOverlay?: MapOverlayPage | undefined
  mapPapers?: MapPaperView[] | undefined
  mapSearch?: MapSearchView | undefined
  /** relations-graph. */
  relations?: RelationsPage | undefined
  relationPaths?: RelationPathsPage | undefined
  relationGaps?: RelationGapPage | undefined
  /** relations-propose (one per proposal), relations-reject and relations-restore (one). */
  relationOutcomes?: RelationOutcomeView[] | undefined
  relationEntity?: RelationEntityOutcomeView | undefined
  relationMerge?: RelationMergeOutcomeView | undefined
  relationSuggestions?: RelationMergeSuggestionView[] | undefined
  relationReground?: RelationRegroundView | undefined
  relationCitations?: RelationCitationsView | undefined
  marks?: KnowledgeMarkView[] | undefined
  /** marks, honour-marks: whether the agent follows the marks. */
  honour?: boolean | undefined
  board?: BoardSnapshot | undefined
  check?: CheckReport | undefined
  runs?: { id: ExperimentId; status: RunStatus; message: string; metrics: Record<string, number> }[] | undefined
  /**
   * start-new, and relocate when it answers `moved` or `existing`: the
   * conversation to open. For `moved` and start-new it is the research's
   * blank conversation; for `existing` it is the research's bound
   * conversation, absent when it has none.
   */
  sessionId?: string | undefined
  /**
   * relocate: what the chosen folder turned out to be. `moved`: the research
   * was created there and the untouched draft discarded; `existing`: the
   * folder already is the research in `project`; `needs-confirm`: the folder
   * holds files, so nothing happened until the command is repeated with
   * `confirmNonEmpty`; `nested`: the folder lies inside the research in
   * `project`, which may be the draft itself; `example`: the folder lies
   * among the examples.
   */
  outcome?: 'moved' | 'existing' | 'needs-confirm' | 'nested' | 'example' | undefined
}
/** Settings for creating or reopening research at an absolute folder path; an omitted mode selects general research. */
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
/** Research operations accepted by the service; individual variants identify actions restricted to the desktop. */
export type ResearchCommand =
  /**
   * Switch the mode and route, and record the choice as a decision (key
   * `mode`). `reason` replaces the stored one only when given; progress
   * starts afresh when the mode or route changes.
   */
  | {
    action: 'set-mode'
    projectId: ProjectId
    mode: string
    route?: string | undefined
    reason?: string | undefined
    /** Who chose the mode; the caller when absent. The agent names the user when it records the user's answer. */
    decidedBy?: 'user' | 'agent' | undefined
  }
  | { action: 'set-autonomy'; projectId: ProjectId; autonomy: Autonomy }
  /** Give the research a title; the folder's Workspace takes it too unless another Workspace already has it. */
  | { action: 'rename'; projectId: ProjectId; title: string }
  | {
    action: 'record-decision'
    projectId: ProjectId
    question: string
    answer: string
    rationale?: string | undefined
    /** Who decided; the caller when absent. The agent names the user when it records the user's checkpoint answer. */
    decidedBy?: 'user' | 'agent' | undefined
    /** A short slug naming what the decision settles, such as `experiments-deferred`. */
    key?: string | undefined
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
  | { action: 'novelty'; projectId: ProjectId; story?: string | undefined; path?: string | undefined; claim?: string | undefined; references?: KnowledgeReference[] | undefined }
  /** Browse a bounded portion of a graph, or the papers related to one pattern. */
  | ({ action: 'graph-view'; projectId: ProjectId } & KnowledgeGraphQuery)
  /** Cluster an extracted corpus (JSON lines) into candidate patterns. */
  | { action: 'build-graph'; projectId: ProjectId; papers: string; domain: string }
  /** Name the clusters (cluster_meta.json or `names`) and assemble the project graph. */
  | { action: 'name-patterns'; projectId: ProjectId; names?: string | undefined }
  /** The question, conclusions and evidence of the research record as a graph; needs the evidence graph plugin. */
  | { action: 'evidence-graph'; projectId: ProjectId }
  /**
   * What the researches on this computer leave for the next one; needs the memory plugin. The desktop receives the
   * whole page with the person's switches; the agent receives, in `content`, the kinds switched on, from the researches
   * other than the one it works in.
   */
  | { action: 'memory'; projectId: ProjectId }
  /** Switch one kind of memory on or off for new researches; needs the memory plugin. The person's command only; answers with the page. */
  | { action: 'memory-carry'; projectId: ProjectId; kind: MemoryKind; on: boolean }
  /** The domain map of the research field; needs the domain map plugin. */
  | { action: 'map-view'; projectId: ProjectId }
  /** The research's idea, library and recall placed over the domain map; needs the domain map plugin. */
  | { action: 'map-overlay'; projectId: ProjectId }
  /** Details of up to 64 papers of the domain map, by their index in the built-in graph; needs the domain map plugin. */
  | { action: 'map-papers'; projectId: ProjectId; indices: number[] }
  /** Where a search text lands on the domain map and what it matched; needs the domain map plugin. */
  | { action: 'map-search'; projectId: ProjectId; query: string }
  /**
   * The relation graph around an entity, named by id or by name or alias (`kind` narrows a name); without one, around
   * the most connected entity, with the most connected entities listed. Needs the relation graph plugin.
   */
  | {
    action: 'relations-graph'
    projectId: ProjectId
    entity?: string | undefined
    kind?: RelationEntityKind | undefined
    /** 2 when absent. */
    hops?: 1 | 2 | undefined
    /** At most 80; 40 when absent. */
    maxNodes?: number | undefined
    /** Stale relations are shown, marked, unless this is false. */
    includeStale?: boolean | undefined
    kinds?: RelationKindId[] | undefined
  }
  /** The best explained paths between two entities, each hop with its grounds; the ends are ids or names. Needs the relation plugin. */
  | {
    action: 'relations-paths'
    projectId: ProjectId
    from: string
    to: string
    /** Narrows both names to one kind of entity. */
    kind?: RelationEntityKind | undefined
    /** At most 5; 3 when absent. */
    k?: number | undefined
    /** At most 6; 4 when absent. */
    maxHops?: number | undefined
    includeStale?: boolean | undefined
    kinds?: RelationKindId[] | undefined
  }
  /**
   * Methods against tasks, datasets or settings, as the project's own sources cover them. Subtypes are not counted
   * unless `rollUp` is true. Rows and columns are ids or names; settings are labels. Needs the relation graph plugin.
   */
  | {
    action: 'relations-gaps'
    projectId: ProjectId
    axis: 'task' | 'dataset' | 'setting'
    rows?: string[] | undefined
    columns?: string[] | undefined
    rollUp?: boolean | undefined
    /** Rows and columns chosen when none are given, at most 30; 12 when absent. */
    limit?: number | undefined
  }
  /**
   * Propose up to 50 relations, each with its ground; each is checked on its own. The desktop's proposals are the
   * person's (`by: user`, a lighter rule), the agent's are the agent's (the strict rule); the caller sets `by`, never the input.
   */
  | { action: 'relations-propose'; projectId: ProjectId; proposals: RelationProposalInput[] }
  /** Reject a relation, or one ground of it, with a reason; the person's rejection stands against the agent until restored. */
  | { action: 'relations-reject'; projectId: ProjectId; relation: string; ground?: string | undefined; reason?: string | undefined }
  /** Lift a rejection; the agent may lift only its own. */
  | { action: 'relations-restore'; projectId: ProjectId; relation: string; ground?: string | undefined }
  /** Create a method, task, dataset or metric, or add aliases to the one a name already names. The person's command only. */
  | { action: 'relations-entity'; projectId: ProjectId; kind: 'method' | 'task' | 'dataset' | 'metric'; name: string; aliases?: string[] | undefined }
  /** Check the quotations whose source moved to a new revision against it and move those that still hold. The person's command only. */
  | { action: 'relations-reground'; projectId: ProjectId }
  /** Fetch the papers' reference lists from OpenAlex and Crossref and record the citations among them; a job. The person's command only. */
  | { action: 'relations-citations'; projectId: ProjectId }
  /** Merge one entity into another of its kind; no operation undoes it. The person's command only. */
  | { action: 'relations-merge'; projectId: ProjectId; from: string; into: string }
  /** Pairs of entities that may be one; nothing is merged. */
  | { action: 'relations-suggestions'; projectId: ProjectId }
  /** Mark a paper or pattern of a knowledge graph: `pin` keeps it in recall, `irrelevant` takes it out; replaces an earlier mark on it. */
  | { action: 'mark'; projectId: ProjectId; target: { kind: 'pattern' | 'paper'; graph: 'ai' | 'project'; id: string }; verdict: 'pin' | 'irrelevant'; note?: string | undefined }
  /** Remove a mark by its id (`<graph>:<kind>:<id>`); removing one that is gone is not an error. */
  | { action: 'unmark'; projectId: ProjectId; id: string }
  /** The research's marks with the names of what they mark. */
  | { action: 'marks'; projectId: ProjectId }
  /** The person's switch: whether the agent follows the marks. Pausing keeps every mark; only the person turns it. */
  | { action: 'honour-marks'; projectId: ProjectId; honour: boolean }
  /**
   * The person's 新研究 (New research): the one untouched draft research, or a
   * new one at `<research home>/<yyyy-mm-dd>-<n>` (the next free `n`) with a
   * blank conversation. Answers with the research and the conversation to
   * open. The desktop's command only; the agent is refused.
   */
  | { action: 'start-new' }
  /**
   * Move an untouched draft to the folder the person chose (更改位置, Change
   * location); the answer's `outcome` says what happened. The desktop's command only.
   */
  | { action: 'relocate'; projectId: ProjectId; root: string; confirmNonEmpty?: boolean | undefined }
  /**
   * Remove an untouched draft: its record, its folder's Workspace
   * registration, its blank conversations (archived) and the empty folders
   * it made. The desktop's command only.
   */
  | { action: 'discard-draft'; projectId: ProjectId }
  /**
   * 移出列表 (Remove from list): archive every top-level conversation of the
   * research that is not archived yet, and mark the record `archivedAt`;
   * nothing on disk changes. Refused for an example and for the untouched
   * draft. The desktop's command only.
   */
  | { action: 'archive-project'; projectId: ProjectId }
  /**
   * 恢复 (Restore): unarchive the conversations `archive-project` archived and
   * list the research again. The desktop's command only.
   */
  | { action: 'unarchive-project'; projectId: ProjectId }

/** Progress and eventual result of an asynchronous research command, addressed by the response's jobId. */
export interface ResearchTask {
  id: string
  kind: string
  projectId?: ProjectId | undefined
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  message: string
  createdAt: string
  result?: ResearchResponse | undefined
}
