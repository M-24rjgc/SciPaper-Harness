/**
 * The research agent's tools. The project is found from the session's working
 * directory; every action takes typed fields; results are compact. Reaching
 * outside the project goes through DSH's own approval card.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ParameterSchemaSpec, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import type { ResearchWorkbench } from './index.ts'
import { isInside } from './files.ts'
import type { ModeRegistry, ResolvedMode } from './modes.ts'
import { runView } from './project.ts'
import { autonomies, checkIds, commandSchema } from './schema.ts'
import type { ProjectId, ResearchCommand, ResearchProject, ResearchResponse } from './types.ts'

const text = (description: string) => ({ type: 'string' as const, description })
const list = (description: string) => ({ type: 'array' as const, items: { type: 'string' as const }, description })
const json = (description: string) => ({ type: 'json' as const, description })
const projectId = text('Optional; defaults to the research project containing your working directory.')
const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] }

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
      paths: list('import: files, relative to the project or absolute. Paths outside the project ask the user first.'),
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
    actions: ['save-artifact', 'register-artifact', 'read-artifact', 'import-template', 'compile', 'render-pages', 'run-script', 'export'],
    description: 'Paper files, LaTeX and export. Files you write with ordinary file tools count too; register-artifact {path, kind} records '
      + 'what the file was made from (evidence links, input artifacts such as the data and script behind a plot). save-artifact {path, content, kind} writes and records; '
      + 'expectedRevision is optional and only guards against overwriting a newer edit. Kinds: manuscript, diagram, figure, code, bibliography, supplement, image. '
      + 'compile {path?, engine}: builds the PDF (path defaults to the main .tex). render-pages {maxPages?}: PNGs of the latest PDF — look at each with read_image. '
      + 'import-template {paths}: copy a venue template into template/. run-script {script, args?}: run one of the scripts the project\'s mode declares '
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
    name: 'research_media',
    title: 'Research media',
    actions: ['visual-review', 'complete-visual-review', 'generate-image', 'fetch-reference-figures'],
    description: 'visual-review {artifactId}: send rendered pages to a separate vision model — only needed when your own model cannot read images. '
      + 'complete-visual-review {artifactId, artifactRevision, sessionId, findings}: only the assigned review session records findings. '
      + 'generate-image {prompt, path, size?, quality?, background?, references?}: a raster image from the configured image API (gpt-image-2 by default); '
      + 'references are project images sent as style or layout references; the prompt is saved beside the image. Use it for artwork and for the visual draft '
      + 'of a method diagram, then redraw the diagram as an editable draw.io or SVG figure; result plots come from scripts and real data. '
      + 'fetch-reference-figures {arxivIds, label}: overview figures of published papers (ar5iv) saved under figures/refs/ to study, never to copy into the paper.',
    fields: {
      artifactId: text('visual-review / complete-visual-review'),
      artifactRevision: { type: 'integer', description: 'complete-visual-review' },
      sessionId: text('complete-visual-review'),
      findings: text('complete-visual-review'),
      prompt: text('generate-image: what to draw, with exact labels and layout; keep private material out'),
      path: text('generate-image: new .png/.jpg/.webp path'),
      size: text('generate-image: e.g. 1536x1024 (landscape), 1024x1536, 1024x1024, or auto; the configured size when omitted'),
      quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: 'generate-image: low for a rough composition check, high for a final draft' },
      background: { type: 'string', enum: ['transparent', 'opaque', 'auto'], description: 'generate-image' },
      references: list('generate-image: up to 4 project image paths used as style or layout references'),
      arxivIds: list('fetch-reference-figures: new-style arXiv ids, at most 6'),
      label: text('fetch-reference-figures: the figure these references are for, e.g. method-overview'),
    },
  },
  {
    name: 'research_knowledge',
    title: 'Research knowledge graph',
    actions: ['graph-status', 'recall', 'novelty', 'build-graph', 'name-patterns'],
    description: 'Research-pattern knowledge graphs: reusable problem → solution → story patterns mined from papers. A built-in graph covers '
      + 'machine-learning papers from OpenReview; a project can build its own. graph-status: the graphs and whether ranking is semantic. '
      + 'recall {query, topK?, path?}: patterns and papers closest to an idea (write the query in English), with exemplars and why each was recalled; '
      + 'path saves the result. novelty {story?, path?}: compares story.json with retrieved_papers.json abstracts and the closest graph papers, '
      + 'writes novelty_report.json. build-graph {papers, domain}: cluster a corpus you extracted (JSON lines with paper_id, title, story, '
      + 'base_problem, solution_pattern) into candidate patterns. name-patterns {names?}: read your cluster names (cluster_meta.json) and write the '
      + 'project graph. Ranking is lexical unless an embedding endpoint is configured in the research settings; each result says which.',
    fields: {
      query: text('recall: the idea as a search-friendly English query'),
      topK: { type: 'integer', description: 'recall: how many patterns (default 8, at most 20)' },
      path: text('recall: project-relative JSON file to save the result to; novelty: report path (default novelty_report.json)'),
      story: text('novelty: the story file (default story.json)'),
      papers: text('build-graph: the extracted corpus, JSON lines'),
      domain: text('build-graph: the corpus domain label, e.g. hci'),
      names: text('name-patterns: the cluster names file (default cluster_meta.json)'),
    },
  },
]

/** What the mode asks of the agent, in a sentence or two. */
function modeGuide(project: ResearchProject, mode: ResolvedMode): string[] {
  const { pack, route, phases } = mode
  const lines: string[] = []
  if (mode.missing !== undefined) lines.push(`The mode pack "${mode.missing}" is not installed; the project runs in general mode until you set another mode.`)
  if (phases.length === 0) {
    lines.push(pack.id === 'general'
      ? 'Mode general: no pipeline. Every research tool is available; run the relevant check (research_check with scope cite, compile, figures …) before you say a task is done. '
        + 'When the user wants a whole paper carried through a method, suggest a mode (research_project modes) and switch with set-mode.'
      : `Mode ${pack.name.en}: no pipeline on this route; work as the mode's skills direct and run the relevant checks.`)
  } else {
    const current = project.lastCheck?.mode === pack.id && project.lastCheck.route === route ? project.lastCheck : undefined
    const next = current?.phases.find(phase => !phase.done)
    const checkpoints = phases.filter(phase => phase.checkpoint).map(phase => phase.id)
    lines.push(`Mode ${pack.name.en}${route === undefined ? '' : ` (route ${route})`}: ${phases.map(phase => phase.id).join(' → ')}.`
      + `${next ? ` Next unfinished phase: ${next.id}.` : ''}${checkpoints.length ? ` Checkpoint before: ${checkpoints.join(', ')}.` : ''}`)
    lines.push('A phase is done when research_check for it is clean; the paper is done when research_check (scope all) is clean.')
  }
  const skills = [...pack.preload, ...pack.entry === undefined ? [] : [pack.entry]]
  if (skills.length) lines.push(`Load the ${skills.join(', then ')} skill${skills.length > 1 ? 's' : ''} before working in this mode.`)
  return lines
}

/** Compact view of a project for the model: enough to act on, without source bodies. */
export function projectBrief(project: ResearchProject, mode: ResolvedMode): JsonValue {
  const lastCompile = project.compilations.at(-1)
  const guide = [
    ...modeGuide(project, mode),
    project.autonomy === 'checkpoints'
      ? 'Autonomy checkpoints: at key decisions (the mode or route when you chose it, the research question, before running experiments, before the final export, a material method change, results that contradict the hypothesis) ask with ask_user_question, then record-decision with the answer and decidedBy user.'
      : 'Autonomy automatic: make those decisions yourself, record-decision with your rationale, and keep going; ask only when genuinely blocked.',
  ]
  const current = project.lastCheck?.mode === mode.pack.id && project.lastCheck.route === mode.route ? project.lastCheck : undefined
  return JSON.parse(JSON.stringify({
    id: project.id, title: project.title, root: project.root, brief: project.brief,
    mode: mode.pack.id, route: mode.route ?? null, modeReason: project.modeReason ?? null, venue: project.venue ?? null,
    autonomy: project.autonomy, guide,
    phases: current?.phases ?? mode.phases.map(phase => ({ id: phase.id, done: false, missing: ['Not checked yet'] })),
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

/** The project a call acts on: its explicit id (which must contain the session's directory) or the directory's own project. */
async function projectFor(service: ResearchWorkbench, id: unknown, exec: ToolExecution): Promise<ResearchProject> {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) throw new Error('This tool needs a session working directory inside a research project')
  const here = await service.projectAt(cwd)
  if (typeof id === 'string' && id) {
    const project = service.getProject(id as ProjectId)
    if (here?.id !== project.id) throw new Error('The tool session does not belong to this research project')
    return project
  }
  if (!here) throw new Error('No research project contains this working directory; create one with research_project action create')
  return here
}

/** Why a call needs the user's approval before it runs, or undefined when it does not. */
async function approvalReason(service: ResearchWorkbench, exec: ToolExecution): Promise<string | undefined> {
  if (!['research_evidence', 'research_artifact', 'research_environment'].includes(exec.name)) return undefined
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  let project: ResearchProject
  try { project = await projectFor(service, args.projectId, exec) } catch { return undefined }
  if (args.action === 'import' || args.action === 'import-template') {
    const paths = Array.isArray(args.paths) ? args.paths.filter((path): path is string => typeof path === 'string') : []
    const outside = paths.filter(path => !isInside(project.root, isAbsolute(path) ? path : resolve(project.root, path)))
    if (outside.length) return `Copy files from outside the research project into it: ${outside.join(', ')}`
  }
  const environment = args.environment as { kind?: unknown; target?: unknown; python?: unknown } | undefined
  if (exec.name === 'research_environment' && environment?.target === 'local' && environment.kind !== 'uv' && typeof environment.python === 'string') {
    return `Run the Python interpreter ${environment.python} to inspect it and use it for experiments`
  }
  return undefined
}

/** Register the research tools and the approval hook for calls that reach outside the project. */
export function registerResearchTools(ctx: Context, service: ResearchWorkbench): void {
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const reason = await approvalReason(service, exec)
    return reason === undefined ? next() : { kind: 'ask', reason }
  })

  ctx.tools.register(defineTool({
    name: 'research_project',
    description: 'The research project around your working directory. current: mode, route, autonomy, phases, decisions, files, runs — call it when you start work. '
      + 'create {title, brief?, root?, mode?, route?, autonomy?}: make the working directory (or root) a research project. list: all projects. '
      + 'modes: the installed modes, their routes and phases — general has every tool and no pipeline; a mode adds its own skills, phases and checks. '
      + 'set-mode {mode, route?, reason}: switch the project\'s mode; its skills follow. set-autonomy {autonomy: checkpoints|automatic}. '
      + 'record-decision {question, answer, rationale?, decidedBy?}: log a settled decision — decidedBy user for the user\'s answer at a checkpoint, '
      + 'agent (the default) for your own call in automatic mode.',
    parameters: {
      action: { type: 'string', enum: ['current', 'create', 'list', 'modes', 'set-mode', 'set-autonomy', 'record-decision'], required: true },
      projectId,
      title: text('create'),
      brief: text('create: the idea or the material in a few sentences'),
      root: text('create: absolute directory; defaults to the working directory'),
      mode: text('create / set-mode: a mode id from action modes (general when omitted on create)'),
      route: text('create / set-mode: one of the mode\'s routes; its default route when omitted'),
      autonomy: { type: 'string', enum: [...autonomies], description: 'create / set-autonomy' },
      reason: text('set-mode: why this mode and route'),
      question: text('record-decision'),
      answer: text('record-decision'),
      rationale: text('record-decision'),
      decidedBy: { type: 'string', enum: ['user', 'agent'], description: 'record-decision: who made the decision' },
    },
    output,
    async execute(args, exec) {
      if (args.action === 'list') {
        return service.projects().map(({ id, title, root, mode, route }) => ({ id, title, root, mode, route: route ?? null }))
      }
      if (args.action === 'modes') return modeCatalog(service.modes)
      if (args.action === 'create') {
        const cwd = exec.agent?.session.header.cwd
        const root = args.root ?? cwd
        if (!root || !args.title) throw new Error('create needs a title, and a root when the session has no working directory')
        const created = await service.createProject({
          title: args.title, root, brief: args.brief ?? '',
          ...(args.mode ? { mode: args.mode } : {}), ...(args.route ? { route: args.route } : {}),
          ...(args.autonomy ? { autonomy: args.autonomy } : {}),
        }, root === cwd ? exec.agent?.session.id : undefined)
        return projectBrief(created, service.modes.resolve(created))
      }
      const project = await projectFor(service, args.projectId, exec)
      if (args.action === 'current') return projectBrief(project, service.modes.resolve(project))
      const request = args.action === 'set-mode'
        ? { action: 'set-mode', projectId: project.id, mode: args.mode, route: args.route, reason: args.reason }
        : args.action === 'set-autonomy'
          ? { action: 'set-autonomy', projectId: project.id, autonomy: args.autonomy }
          : {
            action: 'record-decision', projectId: project.id, question: args.question, answer: args.answer,
            rationale: args.rationale, decidedBy: args.decidedBy,
          }
      return compact(await service.execute(commandSchema.parse(request) as ResearchCommand, exec.signal, 'agent'))
    },
    presentCall: () => ({ card: 'generic', title: 'Research project', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'research_check',
    description: 'Check the paper as it is on disk: citations resolve and are complete, every number in results and tables traces to collected '
      + 'metrics or data, placeholders (\\tbd{}, "--" cells), included figures exist, the latest compile is current, pages were looked at, the review '
      + `is current, stale files — plus the gates of the project's mode. scope: all (default), a phase of the current mode, one base check (${checkIds.join(', ')}) `
      + 'or one of the mode\'s gates. It reports and never blocks. Not clean means not done: fix the errors and check again.',
    parameters: { projectId, scope: text('all, a phase id, a check id or a gate id') },
    output,
    async execute(args, exec) {
      const project = await projectFor(service, args.projectId, exec)
      return compact(await service.execute({ action: 'check', projectId: project.id, scope: args.scope }, exec.signal, 'agent'))
    },
    presentCall: () => ({ card: 'generic', title: 'Research check', kind: 'read' }),
  }))

  for (const family of FAMILIES) ctx.tools.register(defineTool({
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
      const request = commandSchema.parse({ ...fields, action, projectId: project.id }) as ResearchCommand
      if (request.action === 'complete-visual-review' && exec.agent?.session.id !== request.sessionId) {
        throw new Error('Only the assigned visual-review session can record these findings')
      }
      return compact(await service.execute(request, exec.signal, 'agent'))
    },
    presentCall: () => ({ card: 'generic', title: family.title, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
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
