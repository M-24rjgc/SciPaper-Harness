---
description: "Research project ledger and model tools: sources with page-level quotes, literature with open-access full text, LaTeX compile and page renders, Python environments, detached experiments, report-only paper checks and submission export."
kind: "package-reference"
---

# @deepseek-ai/dsh-research-workbench

English | [中文](README.zh.md)

## Summary

Gives the agent a research project ledger and the tools to work in it: import and search sources with page-level quotes, verify literature and fetch open-access full text, write and compile LaTeX, render pages to look at, build Python environments, run experiments that outlive the app and SSH, lay out an experiment board that scripts keep current, and export a submission archive. `research_check` reports whether each phase of the paper is done; nothing is refused for failing it. Choose it for the research edition; it needs a storage domain and the desktop or web host.

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

Mount it with the `ui-research` client plugin and the research agent preset; the web-app bundle already does. The service registers no tools of its own: the preset mounts `@deepseek-ai/dsh-research-workbench/tools`, so only agents composed from it see the research tools.

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

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-research-workbench) is the exhaustive source for every accepted field.

### Adding a mode

A mode is a directory, not code. To add one — a learning mode, say — create `runtime/modes/<id>/` with a `mode.yml` (identity, routes, phases with the facts each requires and the checks that decide it, gates and scripts), the skills under `skills/<name>/SKILL.md`, and any gate or script it runs with the platform Python; an adapted upstream method also carries its `LICENSE` and a `NOTICE.md`. The registry loads and validates it at start and skips it with a warning when it is broken, the skill provider shows its skills only in projects in that mode, and `research_check` runs its phases and gates. Add a line for it to the preset's `research-modes` skill and a spec like `tests/spark-pack.spec.ts`. Code changes only when a phase needs a kind of fact the requirement vocabulary does not have yet.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One service owns every project record in the `research_workbench` storage domain; each project's changes are applied one at a time. Slow work (compiles, page renders, imports, environment builds, experiment launches and observations) runs on a detached copy outside that queue and only its result is recorded, so a save never waits for a compile. Evidence text lives in per-revision files under `.research/chunks`, keeping each record write small. The files themselves stay in the project, with immutable snapshots under `.research`. The [research subsystem page](../../../docs/subsystems/research.md) covers the record, modes, checks and refusals.

| Source | What it holds |
|---|---|
| [`src/index.ts`](src/index.ts) | The service: project lifecycle, command dispatch, the per-project queue, run observation |
| [`src/checks.ts`](src/checks.ts) | `research_check`: every base check, a mode's gates through the runner the service supplies, and phase progress from the mode's requirements |
| [`src/modes.ts`](src/modes.ts) | Mode packs: manifest validation, the registry, routes and the mode a project resolves to |
| [`src/mode-skills.ts`](src/mode-skills.ts) | The skill provider that lists the skills of each project's mode |
| [`src/gates.ts`](src/gates.ts) | Pack gates and scripts: running them with the platform Python and reading their findings |
| [`runtime/modes/`](runtime/modes) | The shipped mode packs: `general`, `spark-to-paper` and `ccfa` (upstream skills, gates and scripts; see each pack's `NOTICE.md`) |
| [`src/figures.ts`](src/figures.ts) | SVG figures: the upstream audit and the export to a vector PDF with previews ([`runtime/figures/`](runtime/figures)) |
| [`src/prose.ts`](src/prose.ts) | The prose check: tell phrases, defensive framing, hedges, formulaic contrasts, em dashes and promotional words |
| [`src/venues.ts`](src/venues.ts) | The venue template library: listing venues and applying one to a project |
| [`runtime/venues/`](runtime/venues) | 139 venues over 16 official style kits, with guides and examples, built by [`scripts/build_venues.py`](scripts/build_venues.py) |
| [`src/knowledge.ts`](src/knowledge.ts) | `research_knowledge`: loading graphs, recall, novelty, building and naming a project graph |
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
| [`src/tools.ts`](src/tools.ts) | The model tools and the approval hook |
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

The generated [research tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-research-workbench): ten tools, `research_project` (current, create, list, modes, set-mode, set-autonomy, record-decision), `research_check` (scope), and one tool per family, each taking an `action` and typed fields: `research_evidence`, `research_artifact`, `research_environment`, `research_experiment`, `research_board`, `research_media`, `research_knowledge`, plus `research_task`. Descriptions name each action's fields in one line; `projectId` is optional because the project is resolved from the session's working directory.

#### Token effect

Fixed schema cost on every request where the tools are visible; the definitions are static for a given build.

#### KV Cache effect

Prefix-stable while the definitions and their visibility are unchanged.

### Tool-call history and result

#### What the model sees

Results are compact JSON: what the call produced (a message, paths, run views, a check report, literature items, source excerpts clipped to `maxSourceBytes`), never the whole project. `research_project current` returns the project brief: mode, route and the reason for them, autonomy, phase progress from the last check on that route, the skills each phase uses, the last 20 decisions, every registered file, the last 60 sources, environments, the last 20 runs and the last compile, with guidance naming the next unfinished phase, the mode's skills to load first and when to ask. Failures are thrown errors that name what to fix, such as `Revision conflict: the file is at revision 2, not 1. Read it again and merge your changes`.

#### Token effect

Grows with each call's result until compaction. Source searches and file reads are the largest and are clipped to `maxSourceBytes`; check reports list findings with file and line.

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

- **Windows-first provisioning** — automatic installation of Python, uv, TeX and draw.io targets Windows x64; other platforms bind existing tools in settings.
- **SSH without provisioning** — remote runs use explicitly configured OpenSSH authentication and a dedicated remote directory; accounts, cluster schedulers and a server's global Python are never touched.
- **No draw.io export from the agent** — diagrams are edited in the built-in editor, but a vector export needs the desktop app's main process, which this package does not extend; the agent draws TikZ by default.
- **NVIDIA-only GPU readings** — the board's machine probe reads GPUs through `nvidia-smi`, and reads no processor or memory use on macOS.
- **Single-user projects** — one person's projects on one machine; collaborative accounts are out of scope.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
