# Research

English | [中文](research.zh.md)

The research subsystem is the ledger behind the research edition. [`@deepseek-ai/dsh-research-workbench`](../../packages/research/workbench/README.md) owns `ctx.research`: one durable record per research project, the model tools that read and write it, and the checks that tell the agent whether its work is done. The agent drives the work through ordinary conversation, goals and skills; the service records what exists, where it came from, what is out of date and what was decided. It never injects prompts into a session and never refuses an action because a check failed.

Source: [`packages/research/workbench/src/types.ts`](../../packages/research/workbench/src/types.ts)

## Project record

A `ResearchProject` binds one canonical Workspace directory. It carries the evidence (imported sources, literature, collected run outputs), claims and their evidence links, registered files with revisions and inputs, environments, experiment runs, compilations, page renders and visual reviews, decisions (each with an optional `key`, a short slug such as `experiments-deferred` naming what it settles), and the progress its checks established ([below](#progress-and-standing)). Three settings shape how the agent works:

| Field | Values | Meaning |
|---|---|---|
| `mode` | an installed mode pack id; `general` by default | Which mode pack the project runs in (see below). |
| `route` | one of the pack's routes | The path through the pack, such as starting from an idea, a proposal or measured results. |
| `autonomy` | `checkpoints`, `automatic` | Whether the agent asks at key decisions (`ask_user_question`, which pauses a running goal) or decides and records its rationale. It also selects every conversation's permission preset ([below](#autonomy-and-permission)). |

<a id="autonomy-and-permission"></a>

Autonomy is applied as a permission preset (`AUTONOMY_PRESETS`, `src/schema.ts`): `checkpoints` selects `workspace-write`, under which an escalation asks the person, and `automatic` selects `research-auto`, under which it is declined. The service sets the preset with `ctx.permissionPresets.set` on every live session of the project: the session bound to it, and each top-level session whose working directory lies in it and in no research nested inside it. It does so on every `set-autonomy`, even one that keeps the value, when a project is created, when the service starts, and for each session as it becomes live, in its own `session/created` listener, which runs after the permission service has pinned the session's default. A delegated child keeps the permission its delegation fixed, and a session of an example is never touched. A preset typed with `/permission` holds in its conversation until the autonomy is set again or the conversation is loaded again. The service does not load unless the permission row configures both presets.

Who chose the mode is `modeSetBy`. A project created with a named mode records `user`; one created without a mode is in `general` with `modeSetBy` unset, which means the mode is not chosen yet. `set-mode` sets `modeSetBy` from its `decidedBy` (the caller when absent) and appends a decision with key `mode`: the question 模式与路线, the answer `<mode>` or `<mode> · <route>` in ids, and the reason as its rationale. It replaces `modeReason` only when it is given a reason, and a changed mode or route starts `progress` afresh. `rename` sets the title, clears `untitled` (a placeholder title the product chose), and gives the folder's Workspace the same title unless another Workspace already has it. Each experiment run records the conversation that submitted it as `sessionId`; runs from the desktop, and runs recorded before this field existed, have none.

`activeGoals(project)` reads the unfinished goals (`ResearchGoal`: the session, objective, phase, rounds and last change) of the project's live top-level conversations through the goal service, those that drive rounds first. A conversation that is not loaded is not seen. The agent's brief reports the reader's own goal, or else the first one, as `activeGoal`.

A project whose root lies in `<data home>/demo` is an example research, shipped for the tutorial (`isExampleRoot`, `src/files.ts`). Snapshots and the agent's brief mark it `example: true`; the flag is derived, never stored. An example is read-only for the person and the agent alike. Reads and checks work, but a check's report is not stored, and every command that would record something is refused with `这是示例研究，只能查看 / This is an example research and is read-only`. The board shows its last read, its runs are not observed, and no research or folder is made among the examples.

A research created as a draft (below) records `createdRoot` when creating it also created its folder, so discarding it may remove that folder once it is empty.

Records live in the `research_workbench` storage domain (single-document layout, version 1). Records of earlier shapes are migrated when read: stage-machine fields are dropped and confirmed stages become user decisions; the built-in `paper-first` and `from-results` modes become the spark-to-paper pack's `proposal` and `data` routes, and `free` or an unset mode becomes `general`. Mode, route, phase and check ids are stored as strings, so a record still opens when the pack it names is gone; the project then runs as `general`. Extracted evidence text is kept beside the snapshots in `.research/chunks/<evidence>/<revision>.json` rather than in the record, so a mutation rewrites the ledger and not the text of every source.

<a id="new-research-draft"></a>
## The new-research draft

新研究 (New research) opens one untouched draft research through the desktop's `start-new` command. New researches go to the research home: the `researchHome` preference, which the person sets in 设置 › 科研 › 研究存放位置, else the service's configured `researchHome`, else `<profile home>/SciPaper` (`%USERPROFILE%\SciPaper` on Windows: outside Documents, which OneDrive often syncs, and an ASCII path for TeX). `snapshot().researchHome` reports the one in effect; `configure` refuses a relative path or one among the examples.

A research is the untouched draft, marked `draft: true` in snapshots and in these commands' answers (derived, never stored), while all of these hold:

- its record holds nothing but its placeholder title (`untitled`, titled 新研究) and its autonomy: the general mode with no mode chosen, an empty brief, and no sources, claims, files, decisions, environments, runs, compiles, reviews or checks (`blankRecord`, `src/drafts.ts`), so choosing an autonomy on the entry screen keeps it the draft;
- every conversation of it is blank in the session list (no turn started): the one bound to it and each working in its folder, found through `ctx.sessionController.list`;
- its folder holds only the empty folders a research is created with (`paper`, `figures`, `code`, `data`, `.research`, `exports`), or nothing at all;
- it is not an example, and it is not removed from the list ([below](#remove-from-list)).

The three commands are the desktop's alone: `execute` refuses them to the agent, and the model's `research_project` has no such action.

| Command | Effect |
|---|---|
| `start-new {}` | Answers `{project, sessionId}`: the draft (the newest, should there be more than one), or a new research at `<research home>/<yyyy-mm-dd>-<n>` with the smallest free `n` for the local date, made of its record, its folder's Workspace (named after the folder) and one blank conversation. A draft folder removed by hand is made again; a draft whose conversation was archived gets a new blank one. It is refused when the research home lies among the examples, inside another research, or in a system folder. |
| `relocate {projectId, root, confirmNonEmpty?}` | Only on the draft; `outcome` says what the folder is. `example`: among the examples. `existing`: it already is the research in `project` (with its bound `sessionId`). `nested`: it lies inside the research in `project`, which may be the draft itself. Either may name a research removed from the list, which then carries `archived: true`. `needs-confirm`: it holds files and `confirmNonEmpty` is not set. Otherwise `moved`: the research is created there, with the draft's autonomy and a blank conversation, and the draft is discarded; `project` and `sessionId` are the new research's. The draft's own folder answers `moved` with the draft unchanged. |
| `discard-draft {projectId}` | Only on the draft: archives its conversations, deletes its folder's Workspace registration and its record, then removes each scaffold folder that is still empty, and the root when the draft created it (`createdRoot`). A folder that holds anything stays; one that cannot be removed is logged. |

A research that has started is neither moved nor discarded: `这项研究已经开始，不能再更改位置或丢弃 / This research has started, so it can no longer be moved or discarded`. A conversation never becomes blank again, so a research found to hold a started conversation is not listed again. When the session list cannot be read, snapshots mark no draft and `start-new` fails rather than make a second one.

<a id="remove-from-list"></a>
## Removing a research from the list

移出列表 (Remove from list) and 恢复 (Restore) are the desktop's `archive-project` and `unarchive-project` commands. Like the draft commands, `execute` refuses them to the agent.

| Command | Effect |
|---|---|
| `archive-project {projectId}` | Archives each top-level conversation of the research that is not archived yet: the one bound to it, and each working in its folder and in no research nested there. It archives them through the Workspace registry, the same archive as the shell's own archive action and its archived-conversations settings page. Before the first one is archived, the record stores `archivedAt` and the ids it archives (`archivedConversations`). Delegated children are left alone, and nothing on disk changes. Repeating it keeps `archivedAt` and archives any conversation added since. It is refused for an example, and for the untouched draft with `还没开始的新研究不能移出列表 / The untouched new research cannot be removed from the list`. |
| `unarchive-project {projectId}` | Unarchives the conversations in `archivedConversations`, then clears both fields. A conversation the person had archived before the removal stays archived. A research in the list is answered unchanged; an example is refused. |

Snapshots and command answers mark a removed research `archived: true`, derived from `archivedAt` and never stored. Its runs keep running, but background observation skips them until the research is restored; `experiment-wait` and `experiment-refresh` still observe a run when asked. A removed research is never the draft.

The `showExamples` preference (设置 › 科研 › 显示示例研究, Show example researches) says whether the sidebar lists the examples. When it is absent, it reads as true.

## Mode packs

A mode pack is a directory under `packages/research/workbench/runtime/modes/<id>/`: a `mode.yml` manifest, the skills the agent sees only while a project is in that mode, and the scripts its gates run. `ModeRegistry` (`src/modes.ts`) loads and validates the packs at start and skips a broken pack with a warning; the `general` pack must load.

| Manifest field | Meaning |
|---|---|
| `id`, `order`, `name`, `summary` | Identity and display, with names in English and Chinese |
| `source` | The upstream repository, version and licence the pack follows |
| `entry`, `preload` | The skill that runs the mode, and skills loaded before it |
| `paperRoot` | The project folder the mode's paper sources live in: `paper`, or `.` for the project root |
| `reviewAgainst` | Optional project-relative glob: only a matching file changed after the newest review makes the review out of date |
| `routes`, `defaultRoute` | Alternative paths through the mode |
| `phases` | Each phase's label, routes, skills, whether it is a checkpoint, the checks that decide it, the facts it requires (each with a `hint`, one sentence in English and Chinese saying what is missing), and an optional `deferrable` decision key |
| `gates`, `scripts` | Python scripts the pack's checks run, each gate with a `label` in English and Chinese, and scripts the agent may run |

The general mode is a pack with no phases and no skills: every research tool, no pipeline. A pack's skills reach the agent through a skill provider mounted with the research tools: it lists the skills of the mode of the project containing the session's working directory, so switching the mode swaps the catalog in the live session. `research/mode` tells the provider when a project's mode changed.

Phase requirements use a fixed set of facts: a file glob (`file`, with an optional `min`), `manuscript`, `bibEntries`, `sections`, `figures`, `diagram`, `pagesInspected`, `reviewCurrent`, `runsCollected`, `noActiveRuns`, `dataEvidence` and `resultsOrData`. A requirement given as a list holds when any one of them holds. A requirement is named within its phase by its conditions (`requirementKey`: `file:story.json`, `sections>=4`, alternatives joined by ` | `), which must be unique in the phase; checks report unmet requirements under these keys. A `hint`, a gate `label` and `paperRoot` are required, so a pack without them is skipped with a warning.

A gate is a Python script in the pack. It runs with the platform Python (`python -I -X utf8`, no shell, an argument vector) in the project root, and its last line of output is `{"findings": [{severity, message, file?, line?}]}`; anything else it prints becomes one error finding. A check never installs Python: without it, each gate reports that it could not run. `research_artifact` run-script runs a script the pack declares for the project's route the same way and returns what it printed. The spark-to-paper pack runs its upstream linters unchanged through such an adapter; its `NOTICE.md` lists what was taken, patched and replaced.

The CCFA pack follows CCFA-Skills: sixteen specialist skills, each run after two preflight skills (`ccf-humanization`, then `ccf-common`), with `ccfa.yaml` as the project state. Its routes are the upstream orchestrator's suggested routes (`full-paper`, `manuscript-improvement`, `post-review-response`) plus `open`, which has no phases, for any single task. Its gates check the files those skills write: `ccfa.yaml` against its v0.4.0 fields, each review report through the upstream `validate_version_comparison.py --report` together with its open critical and major findings, the revision ledger, the submission readiness record, and local home paths in the sources and release folders. The upstream handoff mode follows the project's autonomy: `checkpoints` asks at the upstream partial-handoff triggers, `automatic` asks nothing.

## Venue templates

`research_artifact` list-venues and apply-template draw on a library of 139 CCF venues over 16 official style kits (`runtime/venues`, built by `scripts/build_venues.py` from CCFA-Skills). Applying a venue puts the kit, the venue's own example and its guide in `template/<venue>/`; every top-level folder of the project is on the TeX search path, so a hand-written paper anywhere in the project finds the class. It also writes `template.json`, `main.tex.tmpl` and the style files into the project root, which spark-to-paper's assembly builds against. The review stage is anonymous where the venue is, through the class option or an anonymous author block; `final` gives the camera-ready options. A compile installs what a venue class needs into the managed TeX Live: missing style, class and bibliography-style files by the package that ships them, and fonts and graphics only when the distribution names their package.

## SVG figures

`research_media` audit-svg runs spark-to-paper's own SVG audit (`runtime/figures/audit_svg.py`, unchanged) with the platform Python: overflow, overlapping text, shapes over labels, stroke-scaled or clipped arrowheads, dangling connectors, type below a pixel floor, glyphs outside Times and traced path soup. With `save` it keeps the report where spark-to-paper's figure gate reads it. export-figure writes a vector PDF with live text through svglib and reportlab, expanding `<marker>` references into shapes because svglib draws none and embedding Times New Roman when the system has it, and renders previews at 1440 and 480 pixels.

## Figure gallery

`research_media` find-reference-figures searches a gallery of about 3,500 hand-reviewed Figure 1 and teaser figures of ICLR, ICML, NeurIPS, CVPR, ACL and AAAI papers from 2023 to 2026, from Top-Conf Figure Gallery. Only its index ships (`runtime/figure-gallery/index.json.gz`, built by `scripts/build_figure_gallery.py`): each figure's paper, authors, venue, year, visual pattern, Oral, Spotlight and award marks, size and design score. Filters narrow the gallery by venue, year, pattern and tier (`award` covers best papers and honorable mentions); a query ranks what is left with BM25 over titles, authors, venues and patterns; without a query the most recognised figures come first. With an embedding endpoint configured, the first query embeds every title in the background into the product home's cache, and later queries fuse title embeddings with the keyword ranking. Each page names its basis: `browse`, `keyword` or `semantic`.

The images stay with the gallery. fetch-reference-figures `{galleryIds, label}` fetches each chosen figure from the gallery's repository, a CDN mirror or its site, keeps it in the product home's cache (`research/cache/figure-gallery`), and saves it as `figures/refs/<label>.gallery_<id>.<ext>` with a `.source.json` naming the paper and its copyright; a figure the gallery has taken down reports that it is gone. The same action with `arxivIds` takes the overview figures of other papers from ar5iv. The workbench's figure gallery tab browses the same index, loading images through the host route `/api/research/gallery/image?id=`. The figures are layout references for the drawing skills of every mode, never material for the paper.

## Experiment board

The workbench's experiment tab is a board the page reads every fifteen seconds while it is open; watching it costs no model call. Its fixed part is the same for every project: the runs by status, each run in flight with its progress and curves, each experiment machine, and every run with its command, metrics and curves. The rest is the agent's layout, stored by `research_board` board-update in `.research/board/board.json`: sections built from eight kinds of block (`stats`, `table`, `chart`, `list`, `runs`, `text`, `kv`, `log`). A value in a block is fixed, or follows runs by id or by name and seed. The page resolves it against the live record, so a finished run fills its cells at once, and a name with several finished seeds shows their mean and sample standard deviation.

A read runs three kinds of script: `board-view` with `refresh` starts one at most every ten seconds, and `board-refresh` runs one at once. The machine probe (`runtime/board_probe.py`, standard library only) runs once per host of the active runs, the collectors and the default environment, locally or over SSH. It reports GPUs through `nvidia-smi`, processor and memory use (a cgroup's quota and limit when there is one) and the experiment directory's disk, and each read adds a sample to six hours of history. Runs append progress lines to `$RESEARCH_PROGRESS_PATH`: the supervisor's status carries the last line into the run record as `progress`, the probe reads the lines of remote runs in flight, and a finished remote run's lines come home with its logs. Collectors are the agent's own read-only scripts, run on standard input with an environment's interpreter every `every` seconds (30 by default). Each prints `{stats?, sections?, alerts?}`; parts that do not parse are dropped and named, and the rest is kept. What a read produced is saved in `.research/board/snapshot.json`, so a reopened board shows it at once.

## Knowledge graphs

`research_knowledge` reads research-pattern graphs: reusable problem → solution → story patterns mined from papers, after spark-to-paper's graph builder. A built-in graph distilled from the upstream AI corpus ships as `runtime/kg/ai-kg.json.gz` — patterns, papers with their story fields and five nearest neighbours, no vectors. `scripts/build_kg.py` converts the upstream archive offline and reads its networkx pickle with an unpickler that runs no code from the file. A project builds its own graph from a corpus the agent extracted (`build-graph`, then `name-patterns`) into `.research/kg/`.

Ranking is BM25 over pattern and paper text plus the graph's paper neighbours. With an embedding endpoint configured (`preferences.embedding`, key `RESEARCH_EMBEDDING_API_KEY`), cosine similarity over pattern texts joins in by reciprocal-rank fusion, novelty compares the story with the closest works in embedding space against the upstream 0.88 / 0.82 bands, and a project graph clusters by average linkage instead of k-means. Every result names its basis. Graphs load on first use and are released after ten idle minutes.

## Checks

`research_check` runs deterministic checks over the files on disk and the ledger, and reports; it is the definition of done, not a permission. The base checks below run in every mode; a pack adds its phases and gates. A phase is done when its requirements hold and its checks carry no errors. The whole paper (scope `all`) is clean only when no check reports an error and every phase of its mode on its route is done.

A scope names a phase before a base check or gate of the same id, and a phase scope runs the gates that decide the phase. Each report records `gatesRun`, the gates it ran, and gives each phase its `unmet` keys (the unmet requirements, then `errors:<check>` for each deciding check with errors) beside the English `missing` lines the agent reads. A finding whose file does not exist on disk loses its file and line. With a pack's `reviewAgainst`, `review` compares the newest review with the files matching that glob only: spark-to-paper reviews `sections/*.tex`, so assembling `main.tex` in its latex phase leaves the review current.

| Check | Reports |
|---|---|
| `cite` | citation keys without a bibliography entry, incomplete entries, entries with no venue or not verified by a provider |
| `numbers` | decimals and percentages in results, the abstract, the conclusion and tables that trace to no data evidence, run metric or code value |
| `placeholders` | `\tbd{}`, `--` result cells, TODO and similar markers left in the paper |
| `figures` | missing included files, result plots without data and script or in raster form, diagrams not included |
| `compile` | no compile, a failed one, or one older than the current sources; undefined references and overfull boxes |
| `visual` | pages not rendered and inspected since the last compile |
| `review` | no review (Markdown in `reviews/` or a `*-review-reports/` folder, or named `review*.md`; a revision ledger is not one), a review older than the manuscript, open blocker or major issues |
| `stale` / `claims` | out-of-date files and sources, contradicted claims, evidence links that no longer resolve |
| `structure` | missing inputs; in a mode with phases, missing expected sections and a generic document class |
| `prose` | warnings only: machine-written tell phrases, defensive framing, stacked hedges, formulaic contrasts, em-dash overuse and promotional words, in English and Chinese (spark-to-paper's AI-tell list with CCFA's prose guardrails) |

<a id="progress-and-standing"></a>
## Progress and standing

`research_check` is the only writer of `project.progress` (`ResearchProgress`): the mode and route it describes, each phase's `done`, `unmet` keys and `checkedAt`, each check's findings and `checkedAt`, and `full`, the summary of the last scope-`all` check. Each report is folded in by one rule:

- a phase changes only when the report ran every gate that decides it, so a phase check never marks another phase done on partial evidence;
- the findings of every check the report ran are replaced;
- `full` changes only with scope `all`;
- a report for another mode or route starts the progress afresh.

`lastCheck` is still written, for readers of earlier versions. `export` runs its own check for the package's report and records nothing. A record stored before progress existed reads its last scope-`all` `lastCheck` as its progress, matching that report's English lines to the pack's requirements, so the shipped examples show their phases unchanged.

`standing(project)` derives where a project stands (`ResearchStanding`) for each snapshot and for the agent's brief, and never stores it. Progress stored for another mode or route counts as none. It holds:

- the phases of the mode on its route: `done`, `current` (the first that is neither done nor deferred), `pending` or `deferred`, each with its checkpoint flag and the pack's hints for what its last check found unmet;
- the next phase and its first hint;
- `checkedAt`, the time of the last check;
- `changedSinceCheck`: whether a project file outside `.research`, `exports`, `.git` and `node_modules` is newer than that check, listed at most every 30 seconds per project and `unknown` past 5,000 files;
- `finished`: the full check is clean, every phase is done, and nothing changed since the full check;
- the open issues: one group per check with findings, groups with errors first, named by the gate's `label` or the base check's built-in name, each with the first of its files that exists.

A phase that declares `deferrable: <key>` is deferred while it is not done and the project has a decision with that key (`record-decision` with `key`). spark-to-paper's experiments phase declares `experiments-deferred`. A deferred phase is never done, so a project with one is never finished; once the phase's own check passes it is done.

## What is refused

The service refuses only what would be unsafe or untrue, never work in progress:

- paths outside the project, and writes into `.research` however the path is spelled (checked on the normalized, case-folded path);
- imports from credential and key directories, the product home among them, except the attachment store's `<data home>/attachments/v1/files`, which holds the files the person attached to a conversation (a link inside it that leads out of it is refused);
- the agent's imports from anywhere else outside the project wait for the user's approval, which `automatic` declines;
- a second launch for an experiment identity already recorded, and guessed run states (an unconfirmed run is `unknown`);
- evidence links whose quote does not appear at its locator;
- provider credentials other than the two research credentials (the image and the embedding key);
- a project root that is a drive root, the home directory or a system directory.

## Concurrency

Each project's record changes one at a time. Project creation, the draft commands, `archive-project` and `unarchive-project` also run one at a time, so two creations of one folder record one project and two 新研究 clicks open one draft. Slow work (compiling, rendering pages, importing and extracting sources, building environments, launching and observing experiments) runs on a detached copy of the record outside that queue, and only its result is applied inside it, so a compile never holds up a save and an unreachable SSH host never holds up the project. A run being launched is left alone by observers until its launch is recorded, and an observation never overrides a run that settled in the meantime.

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
 * @returns every project without source bodies, with where it stands and whether it is the untouched draft
 * or removed from the list, the preferences, the research home in effect and the component status.
 */
@Remote async snapshot(): Promise<ResearchSnapshot>

/**
 * Where new researches are created now: the person's `researchHome`
 * preference, else the configured `researchHome`, else `<profile home>/SciPaper`.
 * @returns the absolute research home.
 */
researchHome(): string

/**
 * Where a project stands, derived from its stored progress, its mode and its
 * files; never stored. File times are listed at most every thirty seconds.
 * @param project - the project record.
 * @returns its phases, the next one and what it lacks, the open issues, and whether files changed since the last check.
 */
standing(project: ResearchProject): Promise<ResearchStanding>

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
 * Save model roles, explicitly bound tool locations, the research home and
 * whether examples are listed, never model secrets. A research home among
 * the examples is refused.
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
 * The unfinished goals of a project's live conversations, read through the
 * goal service: every live top-level session whose working directory lies in
 * the project (and in no project nested inside it) and whose goal is not
 * complete. A conversation that is not loaded is not seen.
 * @param project - the project record.
 * @returns the goals, those that drive rounds first, then the most recently changed.
 */
activeGoals(project: ResearchProject): ResearchGoal[]

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
async execute(raw: ResearchCommand, signal: AbortSignal, actor: 'user' | 'agent', sessionId?: string): Promise<ResearchResponse>
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
