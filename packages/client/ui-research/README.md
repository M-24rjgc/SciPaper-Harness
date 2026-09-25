---
description: "Research edition browser surfaces: blank-session project entry, header status, the read-only right-sidebar research tab with autonomy, phases, check findings, decisions and tools, the research tool cards in the conversation, the claim evidence sheet, experiment runs and the experiment board, the project file panel and research settings."
kind: "package-plugin"
---

# @deepseek-ai/dsh-client-ui-research

English | [中文](README.zh.md)

## Summary

Shows a research project beside the conversation, and reports rather than steers. The person reads the phases, findings and decisions, opens a claim's sources, follows experiment runs on the experiment board, and stops a run after confirming. The one setting changed here is autonomy, which also selects the `research-auto` permission preset. The assistant sets the mode and runs checks; nothing here starts work or opens a panel by itself. Its research tool calls read in the reader's language. Every control shows its own progress and failure. Mount it with `@deepseek-ai/dsh-research-workbench`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row in a client roster alongside the host-side service:

```yaml
- id: research-workbench
  name: '@deepseek-ai/dsh-research-workbench'
  config:
    maxSourceBytes: 67108864
    pollIntervalMs: 5000
    maxReviewPages: 12
- id: ui-research
  name: '@deepseek-ai/dsh-client-ui-research'
  config:
    hideDeveloperCells: true
```

`hideDeveloperCells` (default `false`) shadows the shell cells that are developer surfaces in this product: the composer's turn, step, token-rate and cache-hit pills, General settings' default permission, and the open-configuration-file action. The Host half validates it and puts it into every served page as the `__DSH_RESEARCH__` global, which the browser half reads when it applies; a client row's `config` reaches no browser plugin otherwise.

The plugin injects `remote`, `remote.research`, `remote.directoryPicker`, `slots`, `locale`, `layout`, `sessions`, `sidebarRight` and `uiWorkspace`. Without the host row the Remote is absent and nothing registers.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Every surface reads one polled snapshot of projects, preferences and components, and finds the project of a session by its binding, else by the innermost project root containing the session's working directory, so every conversation in a project folder shows it. Commands go to the host Remote; a command that starts a host job settles when the job does. The autonomy control sends its `/permission` line through the session's own command path, as the native picker does. Every control that asks the host for something keeps its own pending state and failure line (`Action.tsx`); there is no plugin-wide busy flag or error banner.

| Module | What it draws |
| --- | --- |
| `Hero.tsx` | The flask mark on the blank-session entry and the research tab |
| `Header.tsx` | The project's status chip in the conversation header; clicking it opens the research tab |
| `Rail.tsx` | The research tab: autonomy, the phases and open issues of the host's `standing` with when it was checked, decisions, counts, and the tools row (board, gallery, research files) |
| `NewProject.tsx`, `ProjectEntry.tsx` | Project creation with mode and autonomy, and the sidebar project list |
| `ClaimSheet.tsx` | One claim and every source under it, over the whole frame, looked up in its own project |
| `RunPanel.tsx`, `MetricsGrid.tsx`, `StopRun.tsx` | Submitted experiments above the composer, with their metrics, and stopping one after a confirmation |
| `Workbench.tsx` | The project's files: sources, manuscript and diagram editors, runs, export; saving never writes over a binary file |
| `examples.ts` | Keeps the composer of every conversation in an example research inert; the header chip, the research tab and the project list mark examples |
| `ResearchToolView.tsx`, `toolCallValues.ts` | The keyed `tool.call.toolview` cards of the `research_*` tools, derived from each logged call and result: a row naming the tool and what the call did (`研究资料 · 导入 3 个文件`), with the raw call behind it and a failure in place; for `research_check`, a card with the scope, 通过 or 未通过 with counts, the first three groups of findings, each file a link when the report shows it on disk, and the check's words behind 详细信息. The record only names things (phases, check labels, routes) and gives the folder |
| `Action.tsx`, `EmptyCell.tsx` | One control's own progress and failure line; the empty cell that shadows the composer statistics, the default-permission setting and the open-config-file action |
| `Board.tsx`, `BoardBlocks.tsx`, `LineChart.tsx`, `boardValues.ts` | The experiment board tab: runs in flight, machines, the agent's sections resolved against the live record, every run, and the line charts |
| `Gallery.tsx` | The figure gallery tab: filters, a grid of top-venue Figure 1s, and saving one as a reference under `figures/refs/` |
| `ResearchSettings.tsx`, `EnvironmentForm.tsx` | Model roles, managed components, bound environments |
| `Onboarding.tsx` | Skips the harness's first-run internal-testing notice |
| `contract.ts`, `format.ts`, `locales.ts` | The injected face, session-to-project resolution, formatting, and every string in `en` and `zh` |

All copy is locale-owned per the [locale-owned client UI copy](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md) decision.

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the commands and records its controls write: the autonomy control submits `/permission research-auto` or `/permission workspace-write` through the session's command path, and autonomy lands in the host ledger that the agent reads with `research_project current`. Suggested sentences (a plot request from a finished run) are appended to the composer draft and reach the model only when the person sends them.

#### KV Cache effect

No direct invalidation; the permission and research-tool consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current constraints of the package, not a task backlog.

No runtime invariant companion is published because this package holds no independently observable relationship: it renders a snapshot the host owns, and every registration is an effect the slot registry already disposes.

- **No source text in the browser** — the host strips evidence text from every snapshot; the claim sheet shows the quote the host validated at write time.
- **Metrics arrive at exit** — a running experiment shows its progress line (or elapsed time when it writes none); its metrics appear once the run finishes.
- **No settings deep link** — the settings panel has no plugin-facing open API, so the research tab names where environments are managed.
- **No diagram export** — the draw.io editor saves `.drawio` files; exporting a diagram to PDF is not offered.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Scoped checks from the repository root:

```sh
pnpm exec tsc -p packages/client/ui-research/tsconfig.json --noEmit --composite false --incremental false
pnpm exec tsx scripts/run-oxlint.ts packages/client/ui-research
pnpm exec vitest run --config vitest.config.ts packages/client/ui-research
```

</details>
