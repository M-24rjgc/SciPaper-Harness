# Research

English | [中文](research.zh.md)

The research subsystem is the ledger behind the research edition. [`@deepseek-ai/dsh-research-workbench`](../../packages/research/workbench/README.md) owns `ctx.research`: one durable record per research project, the model tools that read and write it, and the checks that tell the agent whether its work is done. The agent drives the work through ordinary conversation, goals and skills; the service records what exists, where it came from, what is out of date and what was decided. It never injects prompts into a session and never refuses an action because a check failed.

Source: [`packages/research/workbench/src/types.ts`](../../packages/research/workbench/src/types.ts)

## Project record

A `ResearchProject` binds one canonical Workspace directory. It carries the evidence (imported sources, literature, collected run outputs), claims and their evidence links, registered files with revisions and inputs, environments, experiment runs, compilations, page renders and visual reviews, decisions, and the last check report. Two settings shape how the agent works:

| Field | Values | Meaning |
|---|---|---|
| `mode` | `paper-first`, `from-results`, `free`, or unset | The route. `paper-first` writes the complete method paper with experiment placeholders before running experiments; `from-results` writes from data that already exists; `free` follows no pipeline. Unset means the agent routes the project and records why. |
| `autonomy` | `checkpoints`, `automatic` | Whether the agent asks at key decisions (`ask_user_question`, which pauses a running goal) or decides and records its rationale. `automatic` pairs with the `research-auto` permission preset, which rejects sandbox escalations instead of waiting for approval. |

Records live in the `research_workbench` storage domain (single-document layout, version 1). Records written by the earlier stage-based workbench are migrated when read: stages, the budget and the pause flag are dropped, and confirmed stages become user decisions. Extracted evidence text is kept beside the snapshots in `.research/chunks/<evidence>/<revision>.json` rather than in the record, so a mutation rewrites the ledger and not the text of every source.

## Modes and checks

`research_check` runs deterministic checks over the files on disk and the ledger, and reports; it is the definition of done, not a permission. Each mode lists phases, and a phase is done when its checks are clean. The whole paper (scope `all`) is clean only when no check reports an error and every phase of its mode is done:

| Mode | Phases |
|---|---|
| `paper-first` | idea → literature → plan → draft → experiments → results → polish → submission |
| `from-results` | ingest → plan → literature → write → figures → polish → submission |
| `free` | none; named checks on demand |

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
| `structure` | missing inputs, missing sections for the mode, a generic document class |

## What is refused

The service refuses only what would be unsafe or untrue, never work in progress:

- paths outside the project, and writes into `.research` however the path is spelled (checked on the normalized, case-folded path);
- imports from credential and key directories; the agent's imports from outside the project wait for the user's approval;
- a second launch for an experiment identity already recorded, and guessed run states (an unconfirmed run is `unknown`);
- evidence links whose quote does not appear at its locator;
- image-provider credentials other than the research credential;
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
 * Store the image-provider API key under its fixed research credential name.
 * @param value - the API key.
 */
@Remote async setImageCredential(value: string): Promise<void>

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
<!-- END GENERATED cordis-surface -->
