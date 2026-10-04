---
description: "Research project ledger and model tools: sources with page-level quotes, literature with open-access full text, LaTeX compile and page renders, Python environments, detached experiments, report-only paper checks and submission export."
kind: "package-reference"
---

# @deepseek-ai/dsh-research-workbench

English | [中文](README.zh.md)

## Summary

Gives the agent a research project ledger and the tools to work in it: import and search sources with page-level quotes, verify literature and fetch open-access full text, write and compile LaTeX, render pages to look at, build Python environments, run experiments that outlive the app and SSH, lay out an experiment board that scripts keep current, and export a submission archive. `research_check` reports and records whether each phase of the paper is done; nothing is refused for failing it. Choose it for the research edition; it needs a storage domain and the desktop or web host.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it with the `ui-research` client plugin and the research agent preset through the `research-app` bundle. The service registers no tools of its own. Preset rows mount `@deepseek-ai/dsh-research-workbench/tools` with `config.modules` selecting `project`, `evidence`, `artifact`, `environment`, `experiment`, `board`, `media`, `knowledge`, `checks` or `tasks`; omission enables every family, and an empty list enables none. Each row owns its selected tools and approval hooks, so disabling one leaves other families and the shared ledger available. Mount `@deepseek-ai/dsh-research-workbench/mode-skills` separately for project-mode skills, and point `skill-filesystem` at this package's `runtime/skills` for general research skills. New research and visual-review conversations explicitly select the stable `research` preset regardless of the general session default.

A project's autonomy is every one of its conversations' permission preset: the service injects `ctx.permissionPresets` and sets `workspace-write` for `checkpoints` and `research-auto` for `automatic` on each live session of the project, whenever the autonomy is set and as each session becomes live; examples and delegated children are left alone ([details](../../../docs/subsystems/research.md#autonomy-and-permission)). The permission row must configure both presets, as the research-app bundle does, or the service does not load.

The optional knowledge bundle mounts five plugins from this package, each as a row with its own switch. `knowledge-plugin` provides the graph engine (`ctx.researchKnowledge`), `knowledge-map-plugin` the domain map (`ctx.researchKnowledgeMap`), `knowledge-evidence-plugin` the evidence graph (`ctx.researchKnowledgeEvidence`) `knowledge-memory-plugin` the research memory (`ctx.researchKnowledgeMemory`) and `knowledge-relations-plugin` the relation graph (`ctx.researchKnowledgeRelations`). The map injects the engine, so it is off whenever the engine is; the evidence graph, the memory and the relation graph read only project records and need no engine. The desktop commands `evidence-graph`, `memory`, `memory-carry`, `map-view`, `map-overlay`, `map-papers` and the `relations-*` commands fail with an error naming their plugin while it is off, `graph-status` reports which sub-plugins are on, and the snapshot carries the same flags in `knowledge.modules`. Switching a plugin off never touches project files. Each row's name and description come from `locale/<plugin>/en.json` and `zh.json`, exported as `<plugin>/locale/*.json`.

The memory is a pure projection of every research the host holds that is not an example, not removed from the list and not the untouched draft. It merges literature across researches by normalized title (`src/title-key.ts`, the normalization the domain map uses), lists each research's finished experiments by name with their command and metrics (the record marks no baseline, so none is called one), merges the ready environments (local `uv` environments into one, SSH ones by host and interpreter), lists the venues whose templates were applied, and lists the lessons the records hold: failed runs that recorded a reason or an exit code, and decisions other than the choice of mode. `memory` answers the desktop with that page. `memory-carry {kind, on}` is the person's command and the agent is refused it: it stores the switch as `memoryCarry` in the research preferences, where a kind that is absent reads as on. The agent's `research_project memory` receives, in `content`, only the kinds switched on, from the researches other than its own, at most 40 items of each kind and no lessons.

The relation graph keeps typed relations between a research's methods, tasks, datasets, metrics and papers in `.research/kg/relations.json`, and each rests on a ground: a quotation of one revision of an evidence record, completed runs, or an OpenAlex or Crossref citation record. The agent reads it with `relations-neighbourhood`, `relations-paths`, `relations-gaps` and `relations-suggestions`, and proposes and rejects relations with `relations-propose` and `relations-reject`; the tool description states the rule its quotations face. Entities, merges, re-checking quotations after a source changed and fetching reference lists (`relations-citations`, a job) are the person's commands, and the author of a proposal is set by the caller, never by its input. The plugin takes `citationMaxAgeDays` (30) and `pauseMs` (120) in its row's `config`. An example research answers the reads and refuses the rest.

The first research snapshot installs two offline examples under `<data home>/research/examples/v1`, with synthetic data, English and Chinese manuscripts, PDF notes, editable SVG figures and durable conversations created through the Session Controller. Installation preserves existing files and records, restores missing material and resumes interrupted registration with stable identities. `showExamples` controls visibility; it does not create or delete examples. Shipped conversations use the `read-only` permission preset, and every research mutation rejects example roots, including aliases of the data home. Legacy `<data home>/demo` and the default home's demo remain read-only and are not rewritten.

The service also rejects example conversation forks, renames, prompts, queue mutations and new conversations through the Session Controller's command-admission waterfall, before Agent activation or writes. Existing registered example conversations can be adopted idempotently; creation and missing-conversation recovery are reserved for the initializer's exact in-process request. Protection uses the actual directory and registered project identity, including aliased homes, rather than Session name prefixes. Ordinary research conversations keep their normal branching and editing behavior.

新研究 (New research) is the desktop's `start-new` command: it opens the one untouched draft research, or creates one at `<research home>/<yyyy-mm-dd>-<n>` with its folder's Workspace and a blank conversation. `relocate` moves the draft to a folder the person chose, and `discard-draft` removes it with the empty folders it made. The research home is the person's `researchHome` preference, else the configured `researchHome`, else `<profile home>/SciPaper`. The agent cannot send these commands ([details](../../../docs/subsystems/research.md#new-research-draft)).

移出列表 (Remove from list) is the desktop's `archive-project`: it archives the research's conversations and marks the record `archivedAt`, changing nothing on disk, and its runs go unobserved until `unarchive-project` restores it with exactly the conversations it archived. Active conversations refuse archival before any writes. A later archive failure reverses this operation's completed archives; if reversal fails, the record retains the conversations needed for restoration. Archiving never stops independent experiment processes. The agent cannot send these either ([details](../../../docs/subsystems/research.md#remove-from-list)).

### When to choose it

Choose it when the agent should carry a paper from an idea or from existing results to a submission, recording where every source, file and number came from. It records and checks; the agent, its goals and the research skills drive the work, so a general coding session gains nothing from it.

### Minimal configuration

```yaml
- id: research-workbench
  name: '@deepseek-ai/dsh-research-workbench'
  config:
    maxSourceBytes: 67108864
    pollIntervalMs: 5000
    maxReviewPages: 12
```

| Field | Default | Meaning |
|---|---|---|
| `maxSourceBytes` | required | Byte ceiling for any single source, artifact or tool response |
| `pollIntervalMs` | required | How often running experiments are observed |
| `maxReviewPages` | required | Most PDF pages rendered for one inspection |
| `componentRoot` | the product home's `research/components` | Directory for managed Python, uv, TeX and draw.io |
| `researchHome` | `<profile home>/SciPaper` | Absolute folder new researches are created in until the person chooses one in the settings; test compositions point it at a temporary folder |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-research-workbench) is the exhaustive source for every accepted field.

The platform Python uses an explicitly configured interpreter first, then the bundled interpreter, then the environment under `componentRoot`. Windows absolute executable commands use extended-length paths. Bundled interpreters and newly created local Windows environments normalize their native import paths at startup while preserving existing `sitecustomize` files. When a new environment's base executable exceeds the Windows redirector's path limit, it uses a copy of that base interpreter and its adjacent DLLs; its package isolation remains unchanged. Adopted environments are inspected without modifying their files. Stored preferences, environment records and component status retain ordinary paths; relative commands retain their normal lookup behavior.

TeX uses an explicit `texBin` binding first, then a completed managed distribution, then usable engines on `PATH`. Component status reports the selected source, actual version and available engines; compilation uses that same selection. An invalid binding fails without falling back, and a missing requested engine fails without downloading a second distribution. Without a binding or usable installation, Windows can install private TinyTeX on demand. Missing packages are installed automatically only in the managed distribution; external MiKTeX compiler and BibTeX commands disable its implicit package installer.

`compile` defaults to XeLaTeX when its engine is omitted. Managed TeX keeps format files, font configuration and font caches under the product's user-data `research/cache/latex/<distribution-id>/<engine>` directory, even when `componentRoot` is read-only. It adopts the distribution's prebuilt format or initializes a missing one with its own launcher. Windows TeX commands use ordinary executable paths because TeX Live locates its resources through the executable path; Python retains extended paths. Initialization failures are recorded as failed compilations with diagnostics.

Check reports expose each check as `passed`, `warnings`, `failed` or `skipped`. Phase results distinguish satisfied material requirements (`materialsPresent`) from completed check coverage (`checksComplete`), list skipped checks and count warnings. Missing manuscripts and gates that could not execute establish no coverage. Warnings remain nonblocking and remain visible; an unexecuted deciding check cannot complete a phase. These fields are optional when reading older stored records.

Research tools describe structured inputs as typed objects and arrays derived from their execution schemas. Execution still validates numeric, length and cross-field constraints that the tool schema format cannot express. SSH environment and experiment operations reuse saved host credentials, require known host keys, disable forwarding and preserve classified authentication and handshake failures; credentials are never tool arguments.

Explicit session stop-all requests cancellation of independent experiments admitted by the current runtime Agent or its verified runtime descendants. It observes the supervisor's actual terminal state within the shared stop deadline. Unknown or interrupted supervisors and older active runs without a verified producer remain unconfirmed. Ordinary turn cancellation, plugin disposal and application restart do not terminate detached experiments. A zero observation budget still requests cancellation, without reporting it as confirmed.

### Adding a mode

A mode is a directory, not code. To add one — a learning mode, say — create `runtime/modes/<id>/` with a `mode.yml` (identity, routes, phases with the facts each requires and the checks that decide it, gates and scripts), the skills under `skills/<name>/SKILL.md`, and any gate or script it runs with the platform Python; an adapted upstream method also carries its `LICENSE` and a `NOTICE.md`. The manifest also says what the person reads:

- `paperRoot`: the folder its paper sources live in (`paper`, or `.` for the project root);
- a `hint` on every requirement: one short sentence in English and Chinese saying what is missing, which the research record shows under the current phase;
- a `label` on every gate: the name its findings are grouped under;
- optionally, `deferrable: <decision key>` on a phase a recorded decision may defer, and `reviewAgainst: <glob>` when a review covers only part of the paper.

The registry loads and validates it at start and skips it with a warning when it is broken, the skill provider shows its skills only in projects in that mode, and `research_check` runs its phases and gates. Add a line for it to the preset's `research-modes` skill and a spec like `tests/spark-pack.spec.ts`. Code changes only when a phase needs a kind of fact the requirement vocabulary does not have yet.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One service owns every project record in the `research_workbench` storage domain; each project's changes are applied one at a time. Slow work (compiles, page renders, imports, environment builds, experiment launches and observations) runs on a detached copy outside that queue and only its result is recorded, so a save never waits for a compile. Evidence text lives in per-revision files under `.research/chunks`, keeping each record write small. The files themselves stay in the project, with immutable snapshots under `.research`. The [research subsystem page](../../../docs/subsystems/research.md) covers the record, modes, checks and refusals.

A stale editor save commits the revision adopted from disk before reporting the conflict; rereading returns that revision, and interrupted history files stay intact. Completed experiments collect evidence even when submission already returns a final result; waits and background observation also recover completed runs whose evidence was not collected.

| Source | What it holds |
|---|---|
| [`src/index.ts`](src/index.ts) | The service: project lifecycle, the new-research draft, removal from the list, command dispatch, the per-project queue, run observation, and each conversation's permission preset |
| [`src/drafts.ts`](src/drafts.ts) | New researches: the research home, the draft folder's name, what an untouched draft holds, and removing its empty folders |
| [`src/checks.ts`](src/checks.ts) | `research_check`: every base check, a mode's gates through the runner the service supplies, and phase progress from the mode's requirements |
| [`src/progress.ts`](src/progress.ts) | The project's progress, merged report by report from `research_check`, and `standing`: where the project stands for the person, the brief and the header |
| [`src/modes.ts`](src/modes.ts) | Mode packs: manifest validation, the registry, routes and the mode a project resolves to |
| [`src/mode-skills.ts`](src/mode-skills.ts) | The skill provider that lists the skills of each project's mode |
| [`src/gates.ts`](src/gates.ts) | Pack gates and scripts: running them with the platform Python and reading their findings |
| [`runtime/modes/`](runtime/modes) | The shipped mode packs: `general`, `spark-to-paper` and `ccfa` (upstream skills, gates and scripts; see each pack's `NOTICE.md`) |
| [`src/figures.ts`](src/figures.ts) | SVG figures: the upstream audit and the export to a vector PDF with previews ([`runtime/figures/`](runtime/figures)) |
| [`src/prose.ts`](src/prose.ts) | The prose check: tell phrases, defensive framing, hedges, formulaic contrasts, em dashes and promotional words |
| [`src/venues.ts`](src/venues.ts) | The venue template library: listing venues and applying one to a project |
| [`runtime/venues/`](runtime/venues) | 139 venues over 16 official style kits, with guides and examples, built by [`scripts/build_venues.py`](scripts/build_venues.py) |
| [`src/examples.ts`](src/examples.ts), [`runtime/examples/v1/`](runtime/examples/v1) | Non-overwriting installation, stable registration and authored conversations for two synthetic research examples |
| [`src/knowledge.ts`](src/knowledge.ts) | `research_knowledge`: loading graphs, recall, novelty, building and naming a project graph |
| [`src/knowledge-plugin.ts`](src/knowledge-plugin.ts), [`src/knowledge-map-plugin.ts`](src/knowledge-map-plugin.ts), [`src/knowledge-evidence-plugin.ts`](src/knowledge-evidence-plugin.ts), [`src/knowledge-memory-plugin.ts`](src/knowledge-memory-plugin.ts), [`src/knowledge-relations-plugin.ts`](src/knowledge-relations-plugin.ts) | The five optional knowledge services; the engine, the map and the relation graph run their work under [`src/operation-scope.ts`](src/operation-scope.ts), which aborts it when the plugin is disabled, and the relation graph fetches reference lists through the request helper of [`src/literature.ts`](src/literature.ts) |
| [`src/knowledge-evidence.ts`](src/knowledge-evidence.ts) | The evidence graph: the question, the conclusions and their runs and literature, projected from the record by a pure function |
| [`src/knowledge-relations.ts`](src/knowledge-relations.ts), [`src/knowledge-relations-grounding.ts`](src/knowledge-relations-grounding.ts), [`src/knowledge-relations-queries.ts`](src/knowledge-relations-queries.ts) | The relation graph: its store and edits, the rule that grounds a relation in a quotation or a run, and the neighbourhood, path and gap-matrix queries |
| [`src/knowledge-memory.ts`](src/knowledge-memory.ts), [`src/title-key.ts`](src/title-key.ts) | The research memory: what earlier researches leave, projected from the records by pure functions, and the title normalization it shares with the domain map |
| [`src/knowledge-map.ts`](src/knowledge-map.ts), [`src/knowledge-map-view.ts`](src/knowledge-map-view.ts) | The domain map: reading the shipped layout ([`runtime/kg/MAP-FORMAT.md`](runtime/kg/MAP-FORMAT.md)), placing a recall on it, and the pages the map commands return |
| [`src/knowledge-recall-log.ts`](src/knowledge-recall-log.ts) | The research's last 20 recalls by built-in paper and pattern index, which the map shows and places the idea from |
| [`src/knowledge-annotations.ts`](src/knowledge-annotations.ts) | Marks on papers and patterns, kept in `.research/kg/annotations.json`, and how recall honours them |
| [`src/knowledge-trace.ts`](src/knowledge-trace.ts) | What one `research_knowledge` call touched (the recalled and skipped items, the marks read, the relations around an entity, the hops of the paths found), built from the value the call computed and stored as the tool result's presentation metadata, never in the model's text |
| [`src/clustering.ts`](src/clustering.ts) | Tokens, BM25, term vectors, cosine, rank fusion, average-linkage and k-means clustering |
| [`runtime/kg/`](runtime/kg) | The built-in research-pattern graph, distilled by [`scripts/build_kg.py`](scripts/build_kg.py) |
| [`src/latex.ts`](src/latex.ts) | Manuscript discovery, input flattening, bibliography and graphic resolution |
| [`src/artifacts.ts`](src/artifacts.ts) | Imports, file revisions, compile, page renders, export |
| [`src/experiments.ts`](src/experiments.ts) | Run admission, input snapshots, launch, observation, output collection |
| [`src/literature.ts`](src/literature.ts) | Crossref, OpenAlex and arXiv metadata; open-access PDF lookup |
| [`src/images.ts`](src/images.ts) | Image generation (OpenAI Images API, gpt-image-2 by default, reference images through edits; chat-style providers) and reference figures from ar5iv |
| [`src/board.ts`](src/board.ts) | The experiment board: the stored layout, machine probes, progress lines and collector scripts, read in the background |
| [`runtime/board_probe.py`](runtime/board_probe.py) | The standard-library probe that reports one machine's GPUs, processors, memory, disk and runs' progress lines |
| [`src/gallery.ts`](src/gallery.ts) | The figure gallery: search with filters, keywords and optional title embeddings; figures fetched on demand into a cache |
| [`runtime/figure-gallery/`](runtime/figure-gallery) | The index of about 3,500 top-venue Figure 1s from Top-Conf Figure Gallery, built by [`scripts/build_figure_gallery.py`](scripts/build_figure_gallery.py); no images |
| [`src/tools.ts`](src/tools.ts) | The model tools and the approval hook, which asks for imports from outside the project except the files the person attached |
| [`runtime/experiment_runner.py`](runtime/experiment_runner.py) | The standard-library supervisor every run executes under |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Research subsystem](../../../docs/subsystems/research.md) — the record, modes, checks, refusals and the Cordis API.
- [Goals](../../../docs/subsystems/goal.md) — how a pipeline runs round after round until its check is clean.
- [Permission presets](../../../docs/subsystems/permission-presets.md) — the presets behind checkpoints and automatic autonomy.
- [Storage](../../../docs/subsystems/storage.md) — the domain the project records live in.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The generated [research tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-research-workbench): ten tools, `research_project` (current, create, rename, list, modes, set-mode, set-autonomy, record-decision, memory), `research_check` (scope), and one tool per family, each taking an `action` and typed fields: `research_evidence`, `research_artifact`, `research_environment`, `research_experiment`, `research_board`, `research_media`, `research_knowledge`, plus `research_task`. Descriptions name each action's fields in one line; `projectId` is optional because the project is resolved from the session's working directory. The `research_knowledge` description and the `research-knowledge` skill tell the model to name an item of the graph in its reply as a Markdown link `[name](kg:<id>)`, with only an id a call returned in this conversation and never an invented one; the person's client draws such a link as a chip when a call of the conversation touched that id, and as plain text otherwise.

#### Token effect

Fixed schema cost on every request where the tools are visible; the definitions are static for a given build.

#### KV Cache effect

Prefix-stable while the definitions and their visibility are unchanged.

### Tool-call history and result

#### What the model sees

Results are compact JSON: what the call produced (a message, paths, run views, a check report, literature items, source excerpts clipped to `maxSourceBytes`), never the whole project. `research_project current` returns the project brief: mode, route and the reason for them, whether the mode was chosen and by whom (`modeChosen`, `modeSetBy`) and whether the route is settled (`routingSettled`), the mode's `paperRoot`, autonomy, the goal a live conversation of the research holds (`activeGoal`, the reader's own first), each phase's state (done, current, pending or deferred) with what its last check found missing, when the project was last checked and whether files changed since, the skills each phase uses, the last 20 decisions, every registered file, the last 60 sources, environments, the last 20 runs and the last compile, with guidance naming the next phase and its hint, deferred phases, the mode's skills to load when a phase's work starts, a running goal not to duplicate, and when to ask. The phases are the same `standing` the research record shows the person. `research_knowledge recall` gives each result a `why`, and `annotations` (applied and skipped marks) when the research has marks, and each pattern and paper a `link` (`kg:ai:paper:42`), the destination that names it in a reply; a `marks` listing already carries each mark's `id`, and `relations-neighbourhood` and `relations-paths` list each relation's id in brackets, one hop per line in a path; a recall in a research that is not an example is also appended to `.research/kg/recalls.json` for the domain map, which no tool result returns. `research_project memory` returns the kinds of memory the person lets new researches carry, from the other researches and at most 40 items of each kind, or fails naming the plugin while it is off. Outside a research, current returns `{project: null, hint}` instead of failing; `create` makes only the conversation's own folder a research and refuses any other root with a message telling the agent to ask the user to use 新研究 (New research) and 更改位置 (Change location). Failures are thrown errors that name what to fix, such as `Revision conflict: the file is at revision 2, not 1. Read it again and merge your changes`. An import of a file the user attached to the conversation runs without an approval request; an import from anywhere else outside the project asks the user first, and under `automatic` autonomy the request is declined, because its preset turns approval prompts off in every conversation of the research (the approval policy's runtime-context sentence tells the model which applies).

#### Token effect

Grows with each call's result until compaction. Source searches and file reads are the largest and are clipped to `maxSourceBytes`; check reports list findings with file and line. The `link` of a recall result adds about ten tokens per pattern or paper (16 items in a default recall, at most 28), and a relation id per path hop adds about ten.

#### KV Cache effect

Append-only; results follow the reusable request prefix and invalidate nothing.

### Skill catalog

#### What the model sees

The skills of the project's mode pack, listed in the session's skill catalog beside the preset's general skills; a project in the general mode lists none of them. When the mode changes, the next step publishes a replacement catalog.

#### Token effect

One catalog line per pack skill (spark-to-paper adds thirteen, ccfa sixteen). A skill's body costs tokens only when the model loads it, and its `references/` only when it reads them.

#### KV Cache effect

A mode change appends a replacement catalog message; the earlier prefix stays reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current constraints of the package, not a task backlog.

No runtime invariant companion is published because every relationship the ledger keeps (revisions, evidence links, run identities) is enforced where it is written, inside each project's one-at-a-time change queue.

- **Windows-first provisioning** — automatic installation of Python, uv, TeX and draw.io targets Windows x64. Existing TeX on `PATH` is detected on every platform; other tools need bindings in settings outside Windows.
- **SSH without provisioning** — remote runs use explicitly configured OpenSSH authentication, or the password saved for the environment's `user@host[:port]` when its SSH workspace was added with one, and a dedicated remote directory; the password reaches `ssh` only through `SSH_ASKPASS` and never appears in a command line, a run record or a tool result. Accounts, cluster schedulers and a server's global Python are never touched.
- **No draw.io export from the agent** — diagrams are edited in the built-in editor, but a vector export needs the desktop app's main process, which this package does not extend; the agent draws TikZ by default.
- **NVIDIA-only GPU readings** — the board's machine probe reads GPUs through `nvidia-smi`, and reads no processor or memory use on macOS.
- **Single-user projects** — one person's projects on one machine; collaborative accounts are out of scope.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
