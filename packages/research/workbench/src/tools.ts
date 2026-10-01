/**
 * The research agent's tools. The project is found from the session's working
 * directory; every action takes typed fields; results are compact. Reaching
 * outside the project goes through DSH's own approval card, except for the
 * files the person attached to the conversation.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ParameterSchemaSpec, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import type { ResearchWorkbench } from './index.ts'
import { canonicalPath } from './drafts.ts'
import { errorText, isAttachment, isExampleRoot, isInside, sameDirectory } from './files.ts'
import type { ModeRegistry, ResolvedMode } from './modes.ts'
import { runView } from './project.ts'
import { remoteResearchAt } from './session-project.ts'
import { autonomies, checkIds, commandSchema, MODE_DECISION_KEY } from './schema.ts'
import type { ProjectId, ResearchCommand, ResearchGoal, ResearchProject, ResearchResponse, ResearchStanding } from './types.ts'

const text = (description: string) => ({ type: 'string' as const, description })
const list = (description: string) => ({ type: 'array' as const, items: { type: 'string' as const }, description })
const json = (description: string) => ({ type: 'json' as const, description })
const projectId = text('Optional; defaults to the research linked to this conversation’s workspace.')
const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] }

/** Independently selectable tool families, sharing the same project ledger. */
export const RESEARCH_TOOL_MODULES = ['project', 'evidence', 'artifact', 'environment', 'experiment', 'board', 'media', 'knowledge', 'checks', 'tasks'] as const
/** One family selected by a research-tools plugin declaration. */
export type ResearchToolModule = typeof RESEARCH_TOOL_MODULES[number]

type ResearchToolService = Pick<ResearchWorkbench,
  'knowledgeEnabled' | 'projects' | 'getProject' | 'projectAt' | 'execute' | 'createProject'
  | 'tasks' | 'standing' | 'activeGoals' | 'modes'>

const MODULE_TOOLS: Record<ResearchToolModule, string> = {
  project: 'research_project', evidence: 'research_evidence', artifact: 'research_artifact',
  environment: 'research_environment', experiment: 'research_experiment', board: 'research_board',
  media: 'research_media', knowledge: 'research_knowledge', checks: 'research_check', tasks: 'research_task',
}

interface Family {
  name: string
  title: string
  actions: readonly string[]
  description: string
  fields: ParameterSchemaSpec
}

const FAMILIES: Family[] = [
  {
    name: 'research_evidence',
    title: 'Research evidence',
    actions: ['import', 'refresh-evidence', 'search-evidence', 'claim', 'literature-search', 'literature-import'],
    description: 'Sources and citations. import {paths}: snapshot files (PDF, DOCX, CSV, JSON, text) as evidence with page/line locators; '
      + 'CSV/JSON become data evidence that result numbers can trace to. search-evidence {query}: ranked quotes with evidenceId, revision and locator. '
      + 'literature-search {provider: crossref|openalex|arxiv, query}; literature-import {item}: re-fetches the record by its identifier and returns '
      + 'verified BibTeX to put in the bibliography. claim {claim}: link a claim to exact quoted evidence. refresh-evidence {evidenceId}.',
    fields: {
      paths: list('import: files, relative to the project or absolute. Files the user attached to the conversation import directly; other paths outside the project ask the user first.'),
      evidenceId: text('refresh-evidence'),
      query: text('search-evidence / literature-search'),
      provider: { type: 'string', enum: ['crossref', 'openalex', 'arxiv'], description: 'literature-search' },
      item: json('literature-import: one item exactly as literature-search returned it'),
      claim: json('claim: {id, text, kind: hypothesis|method|literature|empirical, state: proposed|supported|contradicted|stale, evidence: [{evidenceId, revision, locator, quote}], artifactIds}'),
    },
  },
  {
    name: 'research_artifact',
    title: 'Research files',
    actions: ['save-artifact', 'register-artifact', 'read-artifact', 'list-venues', 'apply-template', 'import-template', 'compile', 'render-pages', 'run-script', 'export'],
    description: 'Paper files, LaTeX and export. Files you write with ordinary file tools count too; register-artifact {path, kind} records '
      + 'what the file was made from (evidence links, input artifacts such as the data and script behind a plot). save-artifact {path, content, kind} writes and records; '
      + 'expectedRevision is optional and only guards against overwriting a newer edit. Kinds: manuscript, diagram, figure, code, bibliography, supplement, image. '
      + 'compile {path?, engine}: builds the PDF (path defaults to the main .tex). render-pages {maxPages?}: PNGs of the latest PDF — look at each with read_image. '
      + 'list-venues {query?}: the template library, 139 CCF venues (words such as "neurips", "CCF-A", "security"). apply-template {venue, stage?: review|final}: '
      + 'the venue\'s official style files, example and guide into template/<venue>/ (a paper there, or anywhere in the project, finds them), and '
      + 'template.json, main.tex.tmpl and the style files into the project root for an assembled paper; review is anonymous where the venue is. '
      + 'import-template {paths}: copy template files you have into template/. run-script {script, args?}: run one of the scripts the project\'s mode declares '
      + '(its skills name them) in the project folder. export {}: zip of sources, PDF, data manifest and the check report.',
    fields: {
      path: text('save-artifact / register-artifact / compile: project-relative path'),
      content: text('save-artifact: full file text'),
      kind: { type: 'string', enum: ['manuscript', 'diagram', 'figure', 'code', 'bibliography', 'supplement', 'image'], description: 'save-artifact / register-artifact' },
      expectedRevision: { type: 'integer', description: 'save-artifact: optional optimistic revision' },
      evidence: json('save/register: [{evidenceId, revision, locator, quote}]'),
      claimIds: list('save/register: claims this file states'),
      inputArtifacts: json('save/register: [{id, revision}] the files this one was made from (e.g. data table and plotting script)'),
      artifactId: text('read-artifact / render-pages'),
      paths: list('import-template: template files or directories'),
      engine: { type: 'string', enum: ['pdflatex', 'xelatex', 'lualatex'], description: 'compile (xelatex for CJK text)' },
      maxPages: { type: 'integer', description: 'render-pages: page cap' },
      query: text('list-venues: words matched against venue id, name, family and CCF tier'),
      venue: text('apply-template: a venue id from list-venues'),
      stage: { type: 'string', enum: ['review', 'final'], description: 'apply-template: review (the default; anonymous where the venue is) or final' },
      script: text('run-script: a script id of the current mode'),
      args: list('run-script: arguments added after the script\'s own'),
    },
  },
  {
    name: 'research_environment',
    title: 'Research environment',
    actions: ['environment'],
    description: 'Create or bind the Python environment experiments run in. environment {environment: {name, kind: uv|existing|conda, target: local|ssh, '
      + 'python, sshHost?, remoteRoot?, requirements: [], isDefault}}. kind uv with a blank python creates a managed 3.12 environment inside the project. '
      + 'Existing and conda interpreters are inspected, never modified, and binding a local one asks the user first. SSH uses an OpenSSH alias and a dedicated absolute remoteRoot.',
    fields: { environment: json('the environment description') },
  },
  {
    name: 'research_experiment',
    title: 'Research experiment',
    actions: ['experiment', 'experiment-refresh', 'experiment-cancel', 'experiment-dismiss', 'experiment-logs', 'experiment-wait'],
    description: 'Independent experiment runs that survive the chat and the app. experiment {requestId: a new UUID, spec: {environmentId, name, '
      + 'argv: ["{python}", "code/train.py", ...], cwd: ".", seed, maxSeconds, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], codePaths?: ["code"], '
      + 'metricsPath: "metrics.json"}}. The code directory (codePaths, default code/) and the selected data are snapshotted. The script writes numeric '
      + 'metrics as JSON to $RESEARCH_METRICS_PATH and deliverables (tables, plot data) to $RESEARCH_OUTPUT_DIR (or ./outputs); both become data evidence. '
      + 'While it runs, it appends one JSON object per line to $RESEARCH_PROGRESS_PATH (numeric fields, plus progress 0–1 and a short note) for the board. '
      + 'Reuse the same requestId to reconcile a lost response — never resubmit with a new one. experiment-wait {runIds, timeoutSeconds ≤ 1800} blocks '
      + 'until a run finishes. experiment-logs / -refresh / -cancel / -dismiss {runId}; dismiss only drops a run whose state is unknown.',
    fields: {
      requestId: text('experiment: a new UUID'),
      spec: json('experiment: the run specification'),
      runId: text('refresh / cancel / dismiss / logs'),
      runIds: list('experiment-wait'),
      timeoutSeconds: { type: 'integer', description: 'experiment-wait' },
    },
  },
  {
    name: 'research_board',
    title: 'Experiment board',
    actions: ['board-get', 'board-update', 'board-refresh'],
    description: 'The experiment board the user watches beside the chat. It already shows every run (status, progress, metrics, logs) and each '
      + 'experiment machine (GPU, CPU, memory, disk). You lay out what this project\'s experiments mean, and scripts keep every number current: '
      + 'never copy a number into the board, and update it only when the plan or a conclusion changes, not after each run. '
      + 'board-update {board, replace?}: sections and collectors are replaced by id, {id, remove: true} drops one, replace starts empty. '
      + 'board: {title?, summary?, tags?, sections: [{id, title, note?, collapsed?, blocks}], collectors: [{id, script, environmentId?, every?, args?}]}. '
      + 'Blocks: stats {items: [{label, progress?, ...value}]}; table {columns: [{key, label, align?}], rows: [{cells: {<key>: value}}]}; '
      + 'chart {series: [{run, key, label?} or {label, points: [[x, y]]}], x?, yLabel?, min?, max?}; list {items: [{title, status?, progress?, detail?, run?}]}; '
      + 'runs {match: "ablation/*", metrics?, scale?, digits?}; text {text}; kv {items: [{label, value}]}; log {text}. '
      + 'A value is fixed {value} or follows runs {run: a run id or name, seed?, metric, scale? (100 for percent), digits?, unit?, target?, better?}: '
      + 'a name covers all its seeds and shows their mean ± sd. A chart line plots one field of a run\'s progress lines — the run script appends one '
      + 'JSON object per line (e.g. {"epoch": 3, "val_acc": 0.81, "progress": 0.05, "note": "fold 1"}) to $RESEARCH_PROGRESS_PATH. '
      + 'A collector is a read-only project Python script the board runs every `every` seconds (default 30) while it is open, with the environment\'s '
      + 'interpreter: over SSH with $RESEARCH_REMOTE_ROOT for a remote one, else in the project folder with $RESEARCH_PROJECT_ROOT. It prints one '
      + 'JSON object {stats?, sections?, alerts?: [{level, text}]}; a section with a board section\'s id fills it, others are appended. Use one for what '
      + 'only this project can read, such as a queue the user runs on a server. board-refresh: probe the machines and run every collector now, '
      + 'reporting each error. board-get: the layout as stored.',
    fields: {
      board: json('board-update: the layout, or the parts to change'),
      replace: { type: 'boolean', description: 'board-update: start from an empty board' },
    },
  },
  {
    name: 'research_media',
    title: 'Research media',
    actions: ['visual-review', 'complete-visual-review', 'generate-image', 'find-reference-figures', 'fetch-reference-figures', 'audit-svg', 'export-figure'],
    description: 'visual-review {artifactId}: send rendered pages to a separate vision model — only needed when your own model cannot read images. '
      + 'complete-visual-review {artifactId, artifactRevision, sessionId, findings}: only the assigned review session records findings. '
      + 'generate-image {prompt, path, size?, quality?, background?, references?}: a raster image from the configured image API (gpt-image-2 by default); '
      + 'references are project images sent as style or layout references; the prompt is saved beside the image. Use it for artwork and for the visual draft '
      + 'of a method diagram, then redraw the diagram as an editable draw.io or SVG figure; result plots come from scripts and real data. '
      + 'find-reference-figures {query?, pattern?, venue?, year?, tier?, limit?, offset?}: the built-in figure gallery, about 3,500 hand-reviewed Figure 1 '
      + 'and teaser figures of ICLR, ICML, NeurIPS, CVPR, ACL and AAAI papers (2023-2026); an English query ranks titles and authors (and embeddings, '
      + 'when an embedding endpoint is configured), without one the most prominent come first. Look here first for the reference of a method or '
      + 'overview figure. fetch-reference-figures {galleryIds or arxivIds, label}: saves gallery figures (each with a .source.json naming its paper) '
      + 'or the overview figures of arXiv papers (ar5iv) under figures/refs/ to study with read_image, never to copy into the paper. '
      + 'audit-svg {path, save?, minFontPx?}: checks a hand-drawn SVG figure for overflow, overlapping text, shapes over labels, oversized or clipped '
      + 'arrowheads, dangling connectors, small type, glyphs outside Times, and traced path soup; save writes figures/audit_logs/<name>.audit.json. '
      + 'export-figure {path, output?}: the SVG as a vector PDF with live text (beside it unless output names the PDF) and PNG previews at 1440 and '
      + '480 px under figures/previews for read_image.',
    fields: {
      artifactId: text('visual-review / complete-visual-review'),
      artifactRevision: { type: 'integer', description: 'complete-visual-review' },
      sessionId: text('complete-visual-review'),
      findings: text('complete-visual-review'),
      prompt: text('generate-image: what to draw, with exact labels and layout; keep private material out'),
      size: text('generate-image: e.g. 1536x1024 (landscape), 1024x1536, 1024x1024, or auto; the configured size when omitted'),
      quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: 'generate-image: low for a rough composition check, high for a final draft' },
      background: { type: 'string', enum: ['transparent', 'opaque', 'auto'], description: 'generate-image' },
      references: list('generate-image: up to 4 project image paths used as style or layout references'),
      query: text('find-reference-figures: what the figure shows or the paper is about, in English (e.g. "retrieval augmented agent memory")'),
      pattern: {
        type: 'string', enum: ['architecture', 'pipeline', 'framework', 'conceptual', 'taxonomy', 'teaser', 'comparison', 'results'],
        description: 'find-reference-figures: the kind of figure',
      },
      venue: { type: 'string', enum: ['iclr', 'icml', 'neurips', 'cvpr', 'acl', 'aaai'], description: 'find-reference-figures' },
      year: { type: 'integer', description: 'find-reference-figures: 2023 to 2026' },
      tier: { type: 'string', enum: ['award', 'oral', 'spotlight'], description: 'find-reference-figures: award is best papers and honorable mentions' },
      limit: { type: 'integer', description: 'find-reference-figures: figures per page (default 12, at most 60)' },
      offset: { type: 'integer', description: 'find-reference-figures: skip this many for the next page' },
      galleryIds: list('fetch-reference-figures: gallery figure ids from find-reference-figures, at most 6'),
      arxivIds: list('fetch-reference-figures: new-style arXiv ids, at most 6'),
      label: text('fetch-reference-figures: the figure these references are for, e.g. method-overview'),
      path: text('generate-image: new .png/.jpg/.webp path; audit-svg / export-figure: the .svg figure'),
      save: { type: 'boolean', description: 'audit-svg: keep the report under figures/audit_logs' },
      minFontPx: { type: 'number', description: 'audit-svg: smallest legible type in px at the SVG\'s own width (default 20)' },
      output: text('export-figure: the PDF path (default: beside the SVG)'),
    },
  },
  {
    name: 'research_knowledge',
    title: 'Research knowledge graph',
    actions: ['graph-status', 'graph-view', 'recall', 'novelty', 'build-graph', 'name-patterns', 'mark', 'unmark', 'marks'],
    description: 'Research-pattern knowledge graphs: reusable problem → solution → story patterns mined from papers. A built-in graph covers '
      + 'machine-learning papers from OpenReview; a project can build its own. graph-status: the graphs and whether ranking is semantic. '
      + 'recall {query, topK?, path?}: patterns and papers closest to an idea (write the query in English), with exemplars and why each was recalled; '
      + 'path saves the result. graph-view {query?, source?, domain?, pattern?}: inspect patterns, papers and their recorded relationships. '
      + 'novelty {claim, references?, path?}: compares a research claim with references [{title,text,url?}] and the closest graph papers in any mode. '
      + 'Alternatively novelty {story?, path?} reads story.json and retrieved_papers.json for a Spark to Paper project; it '
      + 'writes novelty_report.json. build-graph {papers, domain}: cluster a corpus you extracted (JSON lines with paper_id, title, story, '
      + 'base_problem, solution_pattern) into candidate patterns. name-patterns {names?}: read your cluster names (cluster_meta.json) and write the '
      + 'project graph. Ranking is lexical unless an embedding endpoint is configured in the research settings; each result says which. '
      + 'Marks: the person (and you) can mark a paper or pattern {target: {kind, graph, id}, verdict: pin|irrelevant, note?}; recall honours every '
      + 'mark: pins come first, irrelevant targets leave the results (annotations.skipped says why), nearby results move a few places, and each '
      + 'result carries `why`. Tell the person which marks shaped a recall (annotations.applied). marks lists them; unmark {id} removes one. '
      + 'Mark only on the person\'s request or with a stated reason; the person\'s marks win over yours.',
    fields: {
      query: text('recall / graph-view: the idea as a search-friendly English query'),
      topK: { type: 'integer', description: 'recall: how many patterns (default 8, at most 20)' },
      path: text('recall: project-relative JSON file to save the result to; novelty: report path (default novelty_report.json)'),
      story: text('novelty: the story file (default story.json)'),
      claim: text('novelty: the research claim to compare directly, without requiring a story file'),
      references: { type: 'array', description: 'novelty: verified reference texts to compare with the claim', items: {
        type: 'object', additionalProperties: false, properties: { title: text('Reference title'), text: text('Abstract or verified source text'), url: text('Primary source URL') },
      } },
      source: { type: 'string', enum: ['all', 'ai', 'project'], description: 'graph-view: graph source' },
      pattern: text('graph-view: a pattern node id from an earlier graph-view result'),
      limit: { type: 'integer', description: 'graph-view: patterns per page, 1–12 (default 8)' },
      offset: { type: 'integer', description: 'graph-view: number of patterns to skip' },
      papers: text('build-graph: the extracted corpus, JSON lines'),
      domain: text('build-graph: the corpus domain label, e.g. hci'),
      names: text('name-patterns: the cluster names file (default cluster_meta.json)'),
      target: { type: 'object', description: 'mark: what to mark, as graph-view and recall name it', additionalProperties: false, properties: {
        kind: { type: 'string', enum: ['paper', 'pattern'], description: 'A paper or a pattern' },
        graph: { type: 'string', enum: ['ai', 'project'], description: 'ai is the built-in graph; project is the research\'s own' },
        id: text('The paper\'s or pattern\'s id'),
      } },
      verdict: { type: 'string', enum: ['pin', 'irrelevant'], description: 'mark: pin keeps it in recall; irrelevant takes it out' },
      note: text('mark: why, in a few words (at most 280 characters)'),
      id: text('unmark: the mark id, <graph>:<kind>:<id>'),
    },
  },
]

/** Whether the route was settled: the user chose the mode, or a recorded decision settled it. */
function routingSettled(project: ResearchProject): boolean {
  return project.modeSetBy === 'user' || project.decisions.some(decision => decision.key === MODE_DECISION_KEY)
}

/** What the mode asks of the agent, in a sentence or two. */
function modeGuide(project: ResearchProject, mode: ResolvedMode, standing: ResearchStanding): string[] {
  const { pack, route, phases } = mode
  const lines: string[] = []
  if (mode.missing !== undefined) lines.push(`The mode pack "${mode.missing}" is not installed; the project runs in general mode until you set another mode.`)
  if (project.modeSetBy === undefined) {
    lines.push('The mode is not chosen yet (modeChosen false). After the user\'s first message, choose it with the research-modes skill: '
      + 'with checkpoints ask once with ask_user_question, your recommendation first; with automatic, decide. Then call set-mode with a one-line reason.')
  }
  if (phases.length === 0) {
    lines.push(pack.id === 'general'
      ? 'Mode general: no pipeline. Every research tool is available; run the relevant check (research_check with scope cite, compile, figures …) before you say a task is done. '
        + 'When the user wants a whole paper carried through a method, suggest a mode (research_project modes) and switch with set-mode.'
      : `Mode ${pack.name.en}: no pipeline on this route; work as the mode's skills direct and run the relevant checks.`)
  } else {
    const { next, hint } = standing
    const deferred = standing.phases.filter(phase => phase.state === 'deferred').map(phase => phase.id)
    const checkpoints = phases.filter(phase => phase.checkpoint).map(phase => phase.id)
    lines.push(`Mode ${pack.name.en}${route === undefined ? '' : ` (route ${route})`}: ${phases.map(phase => phase.id).join(' → ')}.`
      + (next === undefined ? '' : ` Next phase: ${next}${hint === undefined ? '' : ` (${hint.en})`}.`)
      + (deferred.length ? ` Deferred by a recorded decision: ${deferred.join(', ')}.` : '')
      + (checkpoints.length ? ` Checkpoint before: ${checkpoints.join(', ')}.` : ''))
    lines.push('A phase is done when research_check for it is clean; the paper is done when research_check (scope all) is clean.')
  }
  const skills = [...pack.preload, ...pack.entry === undefined ? [] : [pack.entry]]
  if (skills.length) {
    lines.push(`Load the ${skills.join(', then ')} skill${skills.length > 1 ? 's' : ''} when you start work in this mode, not for a question or a status report.`
      + (pack.routes.length && routingSettled(project) ? ' Routing is settled (routingSettled): skip the routing step of the entry skill.' : ''))
  }
  return lines
}

/** What the brief says about a goal already running in this research. */
function goalGuide(goal: ResearchGoal | undefined, sessionId: string | undefined): string[] {
  if (goal === undefined) return []
  return [goal.sessionId === sessionId
    ? 'This conversation holds the research\'s goal (activeGoal): keep working toward it; never create a second.'
    : `A goal is already ${goal.phase === 'active' ? 'running' : goal.phase} in another conversation of this research (activeGoal): `
      + 'continue the work there or tell the user where it runs; never create a second goal.']
}

/** What the live conversations of a project add to its brief. */
export interface BriefContext {
  /** Availability of the profile's graph plugin. */
  knowledge?: boolean | undefined
  /** The unfinished goals of the project's live conversations, as the service orders them. */
  goals?: ResearchGoal[] | undefined
  /** The conversation reading the brief. */
  sessionId?: string | undefined
  /** The SSH execution directory, distinct from the local research ledger. */
  execution?: { readonly host: string; readonly path: string } | undefined
}

/**
 * Compact view of a project for the model: enough to act on, without source bodies.
 * @param project - the record.
 * @param mode - the mode the project resolves to.
 * @param standing - where it stands, as the service derives it for the person too.
 * @param live - the goals of the project's live conversations and the conversation reading the brief.
 * @returns the brief.
 */
export function projectBrief(project: ResearchProject, mode: ResolvedMode, standing: ResearchStanding, live: BriefContext = {}): JsonValue {
  const lastCompile = project.compilations.at(-1)
  const example = isExampleRoot(project.root)
  const goals = live.goals ?? []
  // The reader's own goal first; otherwise the one the service ranks first.
  const goal = goals.find(item => item.sessionId === live.sessionId) ?? goals[0]
  const guide = [
    ...example
      ? ['This is an example research shipped with the app, and it is read-only: explain how it was made and change nothing. '
        + 'For the person\'s own work, suggest 新研究 (New research).']
      : [],
    ...modeGuide(project, mode, standing),
    ...(live.knowledge === undefined ? [] : [live.knowledge
      ? 'Knowledge graph is enabled for every research mode. Use the research-knowledge skill for retrieval, claim comparison and building a project graph when relevant.'
      : 'Knowledge graph is disabled. Skip graph steps in mode skills; continue with research_evidence and web search, stating the evidence basis.']),
    ...goalGuide(goal, live.sessionId),
    ...live.execution === undefined ? [] : [
      'This conversation executes in the SSH workspace. The research ledger and research tool file actions use the local research root; '
      + 'ordinary workspace file and terminal tools use the SSH directory. A remote path is not a local research artifact.',
    ],
    project.autonomy === 'checkpoints'
      ? 'Autonomy checkpoints: at key decisions (the mode or route when you chose it, the research question, before running experiments, before the final export, a material method change, results that contradict the hypothesis) ask with ask_user_question, then record-decision with the answer and decidedBy user.'
      : 'Autonomy automatic: make those decisions yourself, record-decision with your rationale, and keep going; ask only when genuinely blocked.',
    ...project.untitled === true ? ['The research has no title of its own yet: once the topic is clear, give it a short one with rename.'] : [],
  ]
  return JSON.parse(JSON.stringify({
    id: project.id, title: project.title, ...project.untitled === true ? { untitled: true } : {}, root: project.root, brief: project.brief,
    ...live.execution === undefined ? {} : { coordinates: {
      ledger: { kind: 'local', path: project.root },
      execution: { kind: 'ssh', host: live.execution.host, path: live.execution.path },
    } },
    ...example ? { example: true } : {},
    mode: mode.pack.id, route: mode.route ?? null, modeReason: project.modeReason ?? null, venue: project.venue ?? null,
    modeChosen: project.modeSetBy !== undefined, modeSetBy: project.modeSetBy ?? null, routingSettled: routingSettled(project),
    paperRoot: mode.pack.paperRoot,
    ...(live.knowledge === undefined ? {} : { capabilities: { knowledgeGraph: live.knowledge } }),
    autonomy: project.autonomy,
    activeGoal: goal === undefined ? null : {
      conversation: goal.sessionId, thisConversation: goal.sessionId === live.sessionId,
      objective: goal.objective, phase: goal.phase, roundsStarted: goal.roundsStarted,
      ...goals.length > 1 ? { otherConversationsWithGoals: goals.length - 1 } : {},
    },
    guide,
    // What the person's record shows: each phase's state, and why an unfinished one that was checked is not done.
    phases: standing.phases.map(phase => ({
      id: phase.id, state: phase.state, done: phase.state === 'done', checkpoint: phase.checkpoint,
      missing: phase.state === 'done' ? [] : phase.checkedAt === undefined ? ['Not checked yet'] : phase.hints.map(hint => hint.en),
    })),
    checkedAt: standing.checkedAt ?? null, changedSinceCheck: standing.changedSinceCheck, finished: standing.finished,
    phaseSkills: Object.fromEntries(mode.phases.map(phase => [phase.id, phase.skills])),
    decisions: project.decisions.slice(-20).map(({ question, answer, by, rationale }) => ({ question, answer, by, rationale })),
    artifacts: project.artifacts.map(({ id, path, kind, revision, stale }) => ({ id, path, kind, revision, stale })),
    evidence: project.evidence.slice(-60)
      .map(({ id, title, kind, coverage, revision, stale, doi }) => ({ id, title, kind, coverage, revision, stale, doi })),
    environments: project.environments
      .map(({ id, name, kind, target, status, isDefault, python }) => ({ id, name, kind, target, status, isDefault, python })),
    experiments: project.experiments.slice(-20).map(run => ({ ...runView(run), name: run.spec.name })),
    lastCompile: lastCompile ? { status: lastCompile.status, pdfPath: lastCompile.pdfPath } : null,
  })) as JsonValue
}

/** The installed modes as the agent chooses between them. */
function modeCatalog(modes: ModeRegistry): JsonValue {
  return JSON.parse(JSON.stringify(modes.list().map(pack => ({
    id: pack.id, name: pack.name.en, summary: pack.summary.en,
    routes: pack.routes.map(route => ({ id: route.id, name: route.name.en, summary: route.summary.en })),
    defaultRoute: pack.defaultRoute ?? null,
    phases: (pack.routes.length ? pack.routes.map(route => route.id) : [undefined]).map(route => ({
      route: route ?? null,
      phases: modes.resolve({ mode: pack.id, route }).phases.map(phase => phase.id),
    })),
  })))) as JsonValue
}

/** Tool results carry what the call produced, never the whole project. */
function compact(response: ResearchResponse): JsonValue {
  const { project: _project, ...rest } = response
  return JSON.parse(JSON.stringify(rest)) as JsonValue
}

/** Where a research in another folder comes from: the person, never the agent. */
const START_ELSEWHERE = 'to work in another folder, ask the user to start a research with 新研究 (New research) and choose its folder with 更改位置 (Change location)'
const NO_FOLDER = `This conversation has no working folder, so it belongs to no research; ${START_ELSEWHERE}`

/** Remote workspace paths must never be silently read as local research files. */
async function rejectRemoteFilePaths(action: string, fields: Readonly<Record<string, unknown>>, exec: ToolExecution): Promise<void> {
  if (exec.agent?.session.header.execution?.kind !== 'ssh') return
  const localPaths = ['path', 'story', 'papers', 'names', 'output', 'references'].flatMap((key) => {
    const value = fields[key]
    return Array.isArray(value) ? value as unknown[] : [value]
  })
  const imports = Array.isArray(fields.paths) ? fields.paths : []
  for (const value of imports) {
    if (typeof value !== 'string' || !value.startsWith('/')) continue
    if ((action === 'import' || action === 'import-template') && await isAttachment(value)) continue
    localPaths.push(value)
  }
  if (localPaths.some(path => typeof path === 'string' && path.startsWith('/'))) {
    throw new Error('Research file paths in an SSH conversation refer to the local research ledger; use project-relative paths, not absolute remote paths')
  }
}

/** The project a call acts on: its explicit id (which must contain the session's directory) or the directory's own project. */
async function projectFor(service: ResearchToolService, id: unknown, exec: ToolExecution): Promise<ResearchProject> {
  const session = exec.agent?.session
  const cwd = session?.header.cwd
  if (session === undefined || cwd === undefined) throw new Error(NO_FOLDER)
  let here: ResearchProject | undefined
  if (session.header.execution?.kind === 'ssh') {
    const match = remoteResearchAt(service.projects(), session.header)
    if (match.kind === 'ambiguous') throw new Error('Multiple research projects bind this SSH directory; choose a unique SSH environment remoteRoot')
    if (match.kind === 'none') throw new Error('No local research is linked to this SSH directory. Configure a ready SSH research environment with this host and remoteRoot in the local research project')
    here = match.project
  } else {
    here = await service.projectAt(cwd)
  }
  if (typeof id === 'string' && id) {
    const project = service.getProject(id as ProjectId)
    if (here?.id !== project.id) throw new Error('The tool session does not belong to this research project')
    return project
  }
  if (!here) {
    throw new Error('No research contains this conversation\'s folder. If the user wants research work in this folder, make it a research with '
      + `research_project action create; ${START_ELSEWHERE}`)
  }
  return here
}

/** Why a call needs the user's approval before it runs, or undefined when it does not. */
async function approvalReason(service: ResearchToolService, exec: ToolExecution): Promise<string | undefined> {
  if (!['research_evidence', 'research_artifact', 'research_environment'].includes(exec.name)) return undefined
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  let project: ResearchProject
  try { project = await projectFor(service, args.projectId, exec) } catch { return undefined }
  if (args.action === 'import' || args.action === 'import-template') {
    const paths = Array.isArray(args.paths) ? args.paths.filter((path): path is string => typeof path === 'string') : []
    const outside: string[] = []
    const root = await canonicalPath(project.root)
    for (const path of paths) {
      const source = isAbsolute(path) ? path : resolve(project.root, path)
      // Attaching a file to the conversation already was the person's consent.
      if (!isInside(root, await canonicalPath(source)) && !await isAttachment(source)) outside.push(path)
    }
    if (outside.length) return `Copy files from outside the research project into it: ${outside.join(', ')}`
  }
  const environment = args.environment as { kind?: unknown; target?: unknown; python?: unknown } | undefined
  if (exec.name === 'research_environment' && environment?.target === 'local' && environment.kind !== 'uv' && typeof environment.python === 'string') {
    return `Run the Python interpreter ${environment.python} to inspect it and use it for experiments`
  }
  return undefined
}

/**
 * Register the research tools and the approval hook for calls that reach outside the project.
 * @param ctx - plugin context owning tool contributions and approval-hook disposal.
 * @param service - workbench executing commands in the initiating session's research project.
 * @param modules - tool families contributed by this plugin instance.
 */
export function registerResearchTools(
  ctx: Context,
  service: ResearchToolService,
  modules: readonly ResearchToolModule[] = RESEARCH_TOOL_MODULES,
): void {
  const selected = new Set(modules.filter(module => module !== 'knowledge' || service.knowledgeEnabled).map(module => MODULE_TOOLS[module]))
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (!selected.has(exec.name)) return next()
    const reason = await approvalReason(service, exec)
    return reason === undefined ? next() : { kind: 'ask', reason }
  })

  if (selected.has('research_project')) ctx.tools.register(defineTool({
    name: 'research_project',
    description: 'The research around your working directory. current: the brief — the mode and whether it was chosen (modeChosen, modeSetBy, routingSettled), '
      + 'autonomy, where each phase stands, any goal already running in a conversation of this research (activeGoal), decisions, files, sources and runs; '
      + 'outside a research it returns project null with a hint. Call it when a conversation starts and after the mode changes. '
      + 'create {title, brief?, mode?, route?, autonomy?}: make this conversation\'s folder a research; it never makes one elsewhere. rename {title}: '
      + 'give the research a short title once the topic is clear. list: all researches. '
      + 'modes: the installed modes, their routes and phases — general has every tool and no pipeline; a mode adds its own skills, phases and checks. '
      + 'set-mode {mode, route?, reason, decidedBy?}: switch the mode and record the choice as a decision — decidedBy user when the user chose it, '
      + 'agent (the default) when you did; its skills follow, and the phases start unchecked when the mode or route changes. '
      + 'set-autonomy {autonomy: checkpoints|automatic}: only when the user asks you to in words; autonomy is the user\'s. '
      + 'record-decision {question, answer, rationale?, decidedBy?, key?}: log a settled decision — decidedBy user for the user\'s answer at a checkpoint, '
      + 'agent (the default) for your own call in automatic mode. key is a short slug naming what the decision settles: experiments-deferred '
      + 'defers a phase that allows it (spark-to-paper\'s experiments), which then shows as deferred and never as done.',
    parameters: {
      action: { type: 'string', enum: ['current', 'create', 'rename', 'list', 'modes', 'set-mode', 'set-autonomy', 'record-decision'], required: true },
      projectId,
      title: text('create / rename: a short title for the research'),
      brief: text('create: the idea or the material in a few sentences'),
      root: text('create: omit it; only this conversation\'s folder can become a research, and any other folder is refused'),
      mode: text('create / set-mode: a mode id from action modes (general, with the mode not chosen yet, when omitted on create)'),
      route: text('create / set-mode: one of the mode\'s routes; its default route when omitted'),
      autonomy: { type: 'string', enum: [...autonomies], description: 'create / set-autonomy' },
      reason: text('set-mode: why this mode and route, in one line'),
      question: text('record-decision'),
      answer: text('record-decision'),
      rationale: text('record-decision'),
      decidedBy: { type: 'string', enum: ['user', 'agent'], description: 'set-mode / record-decision: who made the decision' },
      key: text('record-decision: optional slug naming what the decision settles, such as experiments-deferred'),
    },
    output,
    async execute(args, exec) {
      if (args.action === 'list') {
        return service.projects().map(({ id, title, root, mode, route }) => ({ id, title, root, mode, route: route ?? null }))
      }
      if (args.action === 'modes') return modeCatalog(service.modes)
      const sessionId = exec.agent?.session.id
      const brief = async (project: ResearchProject): Promise<JsonValue> => projectBrief(
        project, service.modes.resolve(project), await service.standing(project), {
          goals: service.activeGoals(project), sessionId, knowledge: service.knowledgeEnabled,
          ...(exec.agent?.session.header.execution?.kind === 'ssh' && exec.agent.session.header.cwd !== undefined
            ? { execution: { host: exec.agent.session.header.execution.host, path: exec.agent.session.header.cwd } }
            : {}),
        },
      )
      if (args.action === 'create') {
        const session = exec.agent?.session
        const cwd = session?.header.cwd
        if (session === undefined || cwd === undefined) throw new Error(NO_FOLDER)
        if (session.header.execution?.kind === 'ssh') {
          throw new Error('Create the research in a local workspace; an SSH directory cannot become a local research ledger')
        }
        if (args.root !== undefined && !sameDirectory(args.root, cwd)) {
          throw new Error(`create makes only this conversation's folder (${cwd}) a research, never ${args.root}; ${START_ELSEWHERE}`)
        }
        // A folder inside a research already belongs to it; a research is never made inside another one.
        const here = await service.projectAt(cwd)
        if (here) return brief(here)
        if (!args.title) throw new Error('create needs a title')
        const created = await service.createProject({
          title: args.title, root: cwd, brief: args.brief ?? '',
          ...(args.mode ? { mode: args.mode } : {}), ...(args.route ? { route: args.route } : {}),
          ...(args.autonomy ? { autonomy: args.autonomy } : {}),
        }, sessionId)
        return brief(created)
      }
      if (args.action === 'current') {
        let project: ResearchProject
        try {
          project = await projectFor(service, args.projectId, exec)
        } catch (error) {
          // current never fails: outside a research the brief is empty and says what to do.
          return { project: null, hint: errorText(error) }
        }
        return brief(project)
      }
      const project = await projectFor(service, args.projectId, exec)
      const request = args.action === 'set-mode'
        ? { action: 'set-mode', projectId: project.id, mode: args.mode, route: args.route, reason: args.reason, decidedBy: args.decidedBy }
        : args.action === 'set-autonomy'
          ? { action: 'set-autonomy', projectId: project.id, autonomy: args.autonomy }
          : args.action === 'rename'
            ? { action: 'rename', projectId: project.id, title: args.title }
            : {
              action: 'record-decision', projectId: project.id, question: args.question, answer: args.answer,
              rationale: args.rationale, decidedBy: args.decidedBy, key: args.key,
            }
      return compact(await service.execute(commandSchema.parse(request) as ResearchCommand, exec.signal, 'agent', sessionId))
    },
    presentCall: () => ({ card: 'generic', title: 'Research project', kind: 'read' }),
  }))

  if (selected.has('research_check')) ctx.tools.register(defineTool({
    name: 'research_check',
    description: 'Check the paper as it is on disk: citations resolve and are complete, every number in results and tables traces to collected '
      + 'metrics or data, placeholders (\\tbd{}, "--" cells), included figures exist, the latest compile is current, pages were looked at, the review '
      + `is current, stale files — plus the gates of the project's mode. scope: all (default), a phase of the current mode (with its gates), one base check (${checkIds.join(', ')}) `
      + 'or one of the mode\'s gates; a phase and a base check of the same name mean the phase. It reports and never blocks, and it records '
      + 'where each phase stands for the user. Not clean means not done: fix the errors and check again.',
    parameters: { projectId, scope: text('all, a phase id, a check id or a gate id') },
    output,
    async execute(args, exec) {
      const project = await projectFor(service, args.projectId, exec)
      return compact(await service.execute({ action: 'check', projectId: project.id, scope: args.scope }, exec.signal, 'agent'))
    },
    presentCall: () => ({ card: 'generic', title: 'Research check', kind: 'read' }),
  }))

  for (const family of FAMILIES.filter(family => selected.has(family.name))) ctx.tools.register(defineTool({
    name: family.name,
    description: family.description,
    parameters: {
      action: { type: 'string', enum: [...family.actions], required: true },
      projectId,
      ...family.fields,
    },
    output,
    async execute(args, exec) {
      const { action, projectId: requested, ...fields } = args as Record<string, unknown> & { action: string }
      const project = await projectFor(service, requested, exec)
      await rejectRemoteFilePaths(action, fields, exec)
      const request = commandSchema.parse({ ...fields, action, projectId: project.id }) as ResearchCommand
      if (request.action === 'complete-visual-review' && exec.agent?.session.id !== request.sessionId) {
        throw new Error('Only the assigned visual-review session can record these findings')
      }
      return compact(await service.execute(request, exec.signal, 'agent', exec.agent?.session.id))
    },
    presentCall: () => ({ card: 'generic', title: family.title, kind: 'other' }),
  }))

  if (selected.has('research_task')) ctx.tools.register(defineTool({
    name: 'research_task',
    description: 'Read a desktop-started research operation by jobId. A failed or interrupted task did not complete. Experiment runs are separate and reconciled by runId.',
    parameters: { jobId: { type: 'string', required: true } },
    output,
    async execute(args, exec) {
      const task = service.tasks().find(item => item.id === args.jobId)
      if (!task?.projectId) throw new Error('Research task not found')
      await projectFor(service, task.projectId, exec)
      return JSON.parse(JSON.stringify({ ...task, ...(task.result ? { result: compact(task.result) } : {}) })) as JsonValue
    },
    presentCall: () => ({ card: 'generic', title: 'Research operation', kind: 'read' }),
  }))
}
