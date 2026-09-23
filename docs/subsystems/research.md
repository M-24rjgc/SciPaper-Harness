# Research

English | [中文](research.zh.md)

The research subsystem is the ledger behind the research edition. [`@deepseek-ai/dsh-research-workbench`](../../packages/research/workbench/README.md) owns `ctx.research`: one durable record per research project, the model tools that read and write it, and the checks that tell the agent whether its work is done. The agent drives the work through ordinary conversation, goals and skills; the service records what exists, where it came from, what is out of date and what was decided. It never injects prompts into a session and never refuses an action because a check failed.

Source: [`packages/research/workbench/src/types.ts`](../../packages/research/workbench/src/types.ts)

## Project record

A `ResearchProject` binds one canonical Workspace directory. It carries the evidence (imported sources, literature, collected run outputs), claims and their evidence links, registered files with revisions and inputs, environments, experiment runs, compilations, page renders and visual reviews, decisions, and the last check report. Three settings shape how the agent works:

| Field | Values | Meaning |
|---|---|---|
| `mode` | an installed mode pack id; `general` by default | Which mode pack the project runs in (see below). |
| `route` | one of the pack's routes | The path through the pack, such as starting from an idea, a proposal or measured results. |
| `autonomy` | `checkpoints`, `automatic` | Whether the agent asks at key decisions (`ask_user_question`, which pauses a running goal) or decides and records its rationale. `automatic` pairs with the `research-auto` permission preset, which rejects sandbox escalations instead of waiting for approval. |

Records live in the `research_workbench` storage domain (single-document layout, version 1). Records of earlier shapes are migrated when read: stage-machine fields are dropped and confirmed stages become user decisions; the built-in `paper-first` and `from-results` modes become the spark-to-paper pack's `proposal` and `data` routes, and `free` or an unset mode becomes `general`. Mode, route, phase and check ids are stored as strings, so a record still opens when the pack it names is gone; the project then runs as `general`. Extracted evidence text is kept beside the snapshots in `.research/chunks/<evidence>/<revision>.json` rather than in the record, so a mutation rewrites the ledger and not the text of every source.

## Mode packs

A mode pack is a directory under `packages/research/workbench/runtime/modes/<id>/`: a `mode.yml` manifest, the skills the agent sees only while a project is in that mode, and the scripts its gates run. `ModeRegistry` (`src/modes.ts`) loads and validates the packs at start and skips a broken pack with a warning; the `general` pack must load.

| Manifest field | Meaning |
|---|---|
| `id`, `order`, `name`, `summary` | Identity and display, with names in English and Chinese |
| `source` | The upstream repository, version and licence the pack follows |
| `entry`, `preload` | The skill that runs the mode, and skills loaded before it |
| `routes`, `defaultRoute` | Alternative paths through the mode |
| `phases` | Each phase's label, routes, skills, whether it is a checkpoint, the checks that decide it, and the facts it requires |
| `gates`, `scripts` | Python scripts the pack's checks run, and scripts the agent may run |

The general mode is a pack with no phases and no skills: every research tool, no pipeline. A pack's skills reach the agent through a skill provider mounted with the research tools: it lists the skills of the mode of the project containing the session's working directory, so switching the mode swaps the catalog in the live session. `research/mode` tells the provider when a project's mode changed.

Phase requirements use a fixed set of facts: a file glob (`file`, with an optional `min`), `manuscript`, `bibEntries`, `sections`, `figures`, `diagram`, `pagesInspected`, `reviewCurrent`, `runsCollected`, `noActiveRuns`, `dataEvidence` and `resultsOrData`. A requirement given as a list holds when any one of them holds.

A gate is a Python script in the pack. It runs with the platform Python (`python -I -X utf8`, no shell, an argument vector) in the project root, and its last line of output is `{"findings": [{severity, message, file?, line?}]}`; anything else it prints becomes one error finding. A check never installs Python: without it, each gate reports that it could not run. `research_artifact` run-script runs a script the pack declares for the project's route the same way and returns what it printed. The spark-to-paper pack runs its upstream linters unchanged through such an adapter; its `NOTICE.md` lists what was taken, patched and replaced.

## Venue templates

`research_artifact` list-venues and apply-template draw on a library of 139 CCF venues over 16 official style kits (`runtime/venues`, built by `scripts/build_venues.py` from CCFA-Skills). Applying a venue puts the kit, the venue's own example and its guide in `template/<venue>/`; every top-level folder of the project is on the TeX search path, so a hand-written paper anywhere in the project finds the class. It also writes `template.json`, `main.tex.tmpl` and the style files into the project root, which spark-to-paper's assembly builds against. The review stage is anonymous where the venue is, through the class option or an anonymous author block; `final` gives the camera-ready options. A compile installs what a venue class needs into the managed TeX Live: missing style, class and bibliography-style files by the package that ships them, and fonts and graphics only when the distribution names their package.

## SVG figures

`research_media` audit-svg runs spark-to-paper's own SVG audit (`runtime/figures/audit_svg.py`, unchanged) with the platform Python: overflow, overlapping text, shapes over labels, stroke-scaled or clipped arrowheads, dangling connectors, type below a pixel floor, glyphs outside Times and traced path soup. With `save` it keeps the report where spark-to-paper's figure gate reads it. export-figure writes a vector PDF with live text through svglib and reportlab, expanding `<marker>` references into shapes because svglib draws none and embedding Times New Roman when the system has it, and renders previews at 1440 and 480 pixels.

## Knowledge graphs

`research_knowledge` reads research-pattern graphs: reusable problem → solution → story patterns mined from papers, after spark-to-paper's graph builder. A built-in graph distilled from the upstream AI corpus ships as `runtime/kg/ai-kg.json.gz` — patterns, papers with their story fields and five nearest neighbours, no vectors. `scripts/build_kg.py` converts the upstream archive offline and reads its networkx pickle with an unpickler that runs no code from the file. A project builds its own graph from a corpus the agent extracted (`build-graph`, then `name-patterns`) into `.research/kg/`.

Ranking is BM25 over pattern and paper text plus the graph's paper neighbours. With an embedding endpoint configured (`preferences.embedding`, key `RESEARCH_EMBEDDING_API_KEY`), cosine similarity over pattern texts joins in by reciprocal-rank fusion, novelty compares the story with the closest works in embedding space against the upstream 0.88 / 0.82 bands, and a project graph clusters by average linkage instead of k-means. Every result names its basis. Graphs load on first use and are released after ten idle minutes.

## Checks

`research_check` runs deterministic checks over the files on disk and the ledger, and reports; it is the definition of done, not a permission. The base checks below run in every mode; a pack adds its phases and gates. A phase is done when its requirements hold and its checks carry no errors. The whole paper (scope `all`) is clean only when no check reports an error and every phase of its mode on its route is done.

| Check | Reports |
|---|---|
| `cite` | citation keys without a bibliography entry, incomplete entries, entries with no venue or not verified by a provider |
| `numbers` | decimals and percentages in results, the abstract, the conclusion and tables that trace to no data evidence, run metric or code value |
| `placeholders` | `\tbd{}`, `--` result cells, TODO and similar markers left in the paper |
| `figures` | missing included files, result plots without data and script or in raster form, diagrams not included |
| `compile` | no compile, a failed one, or one older than the current sources; undefined references and overfull boxes |
| `visual` | pages not rendered and inspected since the last compile |
| `review` | no review, a review older than the manuscript, open blocker or major issues |
| `stale` / `claims` | out-of-date files and sources, contradicted claims, evidence links that no longer resolve |
| `structure` | missing inputs; in a mode with phases, missing expected sections and a generic document class |
| `prose` | warnings only: machine-written tell phrases, defensive framing, stacked hedges, formulaic contrasts, em-dash overuse and promotional words, in English and Chinese (spark-to-paper's AI-tell list with CCFA's prose guardrails) |

## What is refused

The service refuses only what would be unsafe or untrue, never work in progress:

- paths outside the project, and writes into `.research` however the path is spelled (checked on the normalized, case-folded path);
- imports from credential and key directories; the agent's imports from outside the project wait for the user's approval;
- a second launch for an experiment identity already recorded, and guessed run states (an unconfirmed run is `unknown`);
- evidence links whose quote does not appear at its locator;
- provider credentials other than the two research credentials (the image and the embedding key);
- a project root that is a drive root, the home directory or a system directory.

## Concurrency

Each project's record changes one at a time. Slow work (compiling, rendering pages, importing and extracting sources, building environments, launching and observing experiments) runs on a detached copy of the record outside that queue, and only its result is applied inside it, so a compile never holds up a save and an unreachable SSH host never holds up the project. A run being launched is left alone by observers until its launch is recorded, and an observation never overrides a run that settled in the meantime.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxresearch--researchworkbench"></a>

### `ctx.research` — `ResearchWorkbench`

One durable owner for each project's evidence, files, decisions and execution records.

```ts cordis-catalog
/**
 * Read detached project snapshots and non-secret component settings.
 * @returns every project without source bodies, the preferences and the component status.
 */
@Remote async snapshot(): Promise<ResearchSnapshot>

/**
 * Read durable operation handles, including interrupted calls from prior launches.
 * @returns every recorded task, with project bodies stripped from results.
 */
@Remote tasks(): ResearchTask[]

/**
 * Create (or reopen) a research project around one canonical DSH Workspace. Nothing starts.
 * @param request - title, absolute root, brief, and optional mode and autonomy.
 * @returns the project record.
 */
@Remote async create(request: CreateProjectRequest): Promise<ResearchProject>

/**
 * Create or reopen a project. A caller that already runs in a session (the
 * agent creating its own project) binds that session instead of a new one.
 * @param request - title, absolute root, brief, and optional mode and autonomy.
 * @param sessionId - the calling session to bind, when there is one.
 * @returns the project record.
 */
async createProject(request: CreateProjectRequest, sessionId?: string): Promise<ResearchProject>

/**
 * Save model roles and explicitly bound tool locations, never model secrets.
 * @param preferences - the complete preference record.
 * @returns the preferences as stored.
 */
@Remote async configure(preferences: ResearchPreferences): Promise<ResearchPreferences>

/**
 * Store a provider's API key under its fixed research credential name.
 * @param kind - the image provider or the embedding endpoint; it must be configured first.
 * @param value - the API key.
 */
@Remote async setCredential(kind: 'image' | 'embedding', value: string): Promise<void>

/**
 * Provision a tool component as a queryable background operation.
 * @param component - which managed tool to install.
 * @returns the job handle to follow through tasks().
 */
@Remote installComponent(component: 'python' | 'uv' | 'latex' | 'drawio'): Promise<ResearchResponse>

/**
 * Admit a desktop action; long operations return a job the desktop follows.
 * @param request - one research command.
 * @param signal - cancellation of the call.
 * @returns the outcome, or a job handle for a long operation.
 */
@Remote async command(request: ResearchCommand, signal: AbortSignal): Promise<ResearchResponse>

/**
 * Every project record, detached, without evidence text (see getProject).
 * @returns copies of all project records.
 */
projects(): ResearchProject[]

/**
 * One project's record with its evidence text, for tools and checks that read sources.
 * @param id - the project.
 * @returns a detached copy of its record.
 */
getProject(id: ProjectId): ResearchProject

/**
 * The project whose root contains a directory, preferring the innermost one.
 * @param directory - a session's working directory.
 * @returns that project, or undefined outside every project.
 */
async projectAt(directory: string): Promise<ResearchProject | undefined>

/**
 * Dispatch a validated tool or desktop command. The desktop receives a job
 * for long operations; the agent waits for the result inside its tool call.
 * @param raw - the command as received.
 * @param signal - cancellation of the call.
 * @param actor - who acts: the desktop user or the agent.
 * @returns the outcome.
 */
async execute(raw: ResearchCommand, signal: AbortSignal, actor: 'user' | 'agent'): Promise<ResearchResponse>
```

Source: [`packages/research/workbench/src/index.ts`](../../packages/research/workbench/src/index.ts)

<a id="research-events"></a>

### `research/*` events

<a id="researchmode--emit"></a>

#### `research/mode` — emit

A project was created or its mode changed, after the change was stored. The mode's skills follow it into the project's sessions.

```ts cordis-catalog
/**
 * A project was created or its mode changed, after the change was stored.
 * The mode's skills follow it into the project's sessions.
 * @param event - the project, its root and the mode now recorded.
 * @mode emit
 */
'research/mode'(event: ResearchModeEvent): void
```

Source: [`packages/research/workbench/src/index.ts`](../../packages/research/workbench/src/index.ts)
<!-- END GENERATED cordis-surface -->
