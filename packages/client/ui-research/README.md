---
description: "Research edition browser surfaces: blank-session project entry, header status, the right-sidebar research tab with mode, autonomy, phases, check findings and decisions, the claim evidence sheet, experiment runs and the experiment board, the project file panel and research settings."
kind: "package-plugin"
---

# @deepseek-ai/dsh-client-ui-research

English | [中文](README.zh.md)

## Summary

Shows a research project beside the conversation and lets the person steer it: pick the mode and autonomy, run the check, start the pipeline, read the phases, findings and decisions, open a claim's sources, follow experiment runs on the experiment board, and edit, compile and export project files. Choosing automatic autonomy also selects the `research-auto` permission preset, and Run pipeline submits a `/goal` through the composer. It never drives the agent; it renders the host ledger and sends ordinary commands. Mount it with `@deepseek-ai/dsh-research-workbench`.

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
```

The plugin injects `remote`, `remote.research`, `remote.directoryPicker`, `slots`, `locale`, `layout`, `sessions` and `sidebarRight`. Without the host row the Remote is absent and nothing registers.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Every surface reads one polled snapshot of projects, preferences and components, and finds the project of a session by its binding, else by the innermost project root containing the session's working directory, so every conversation in a project folder shows it. Commands go to the host Remote; `/goal` and `/permission` lines go through the session's own command path, as the native pickers do.

| Module | What it draws |
| --- | --- |
| `Hero.tsx` | Blank-session entry: the mark, a resume line for the latest project, openings, standing promises |
| `Header.tsx` | The project's status chip and file actions in the conversation header |
| `Rail.tsx` | The research tab: mode and autonomy controls, Run check, Run pipeline, phases, findings, decisions |
| `NewProject.tsx`, `ProjectEntry.tsx` | Project creation with mode and autonomy, and the sidebar project list |
| `ClaimSheet.tsx` | One claim and every source under it, over the whole frame |
| `RunPanel.tsx`, `MetricsGrid.tsx` | Submitted experiments above the composer, with their metrics |
| `Workbench.tsx`, `ContextCards.tsx` | The project's files: sources, manuscript and diagram editors, runs, export |
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

Indirectly, through the commands and records its controls write: Run pipeline submits `/goal <objective>` and the autonomy control submits `/permission research-auto` or `/permission workspace-write` through the session's command path, while mode, autonomy and decisions land in the host ledger that the agent reads with `research_project current`.

#### KV Cache effect

No direct invalidation; the goal, permission and research-tool consumers own any request-prefix changes.

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
