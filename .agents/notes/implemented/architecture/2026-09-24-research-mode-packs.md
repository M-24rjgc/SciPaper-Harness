# Agent Note: Research modes as installable packs over a general mode

Status: implemented

English | [中文](2026-09-24-research-mode-packs.zh.md)

## Problem

The research workbench had three modes written into its code — `paper-first`, `from-results` and `free` — in its types, its record schema, the phase and check tables of `checks.ts` and the desktop UI. The two paper modes were a re-implementation of spark-to-paper-skills' pipeline, and every research skill was listed in every session whatever the project's mode.

The product needs a general mode that is simply the research agent: every tool, no pipeline. Methods such as spark-to-paper and CCFA-Skills come on top of it with their own skills, scripts and gates, fused with the built-in tools and invisible while inactive. More methods will follow (a learning mode, for one), so adding a mode cannot mean editing types, schema, checks, UI and locales again. Capabilities several methods need — venue templates, image generation, a research-pattern knowledge graph, SVG audit and export, a prose check — belong to the platform, not to one method.

## Decision

A mode is a directory under `packages/research/workbench/runtime/modes/<id>/`: a `mode.yml` manifest (identity and names in English and Chinese, the upstream source and licence, the entry skill and preloads, routes, phases, gates, scripts), `skills/<name>/SKILL.md`, the Python its gates and scripts run, and for an adapted method its `LICENSE` and `NOTICE.md`. `ModeRegistry` (`src/modes.ts`) loads and validates the packs at start and skips a broken one with a warning; the `general` pack, which has no phases and no skills, must load. Three packs ship: `general`, `spark-to-paper` and `ccfa`.

- **Record.** `mode` and `route` are strings the registry checks on `set-mode` and `create`. Earlier records migrate when read: `free` or no mode becomes `general`, `paper-first` and `from-results` become spark-to-paper's `proposal` and `data` routes. A record naming a pack that is no longer installed opens and runs as general, and the brief says so.
- **Phases.** A phase names its routes, skills, whether it is a checkpoint, the checks that decide it and the facts it requires, from a fixed set (a file glob, `manuscript`, `bibEntries`, `sections`, `figures`, `diagram`, `pagesInspected`, `reviewCurrent`, `runsCollected`, `noActiveRuns`, `dataEvidence`, `resultsOrData`). A phase is done when its requirements hold and its checks carry no errors. Checks report; nothing is ever refused for failing one.
- **Gates and scripts.** A gate is a pack script run with the platform Python (`python -I -X utf8`, an argument vector, no shell, the project root as working directory) that prints `{"findings": [...]}` last; anything else becomes one error finding, and a check never installs Python. `research_artifact` run-script runs only scripts the pack declares for the project's route.
- **Skills follow the mode.** A skill provider mounted with the research tools lists the skills of the mode of the project containing the session's working directory, so the general mode lists none and a mode change swaps the catalog in the live session; `research/mode` invalidates it. Tool schemas stay static; the mode, route, phases, entry skill and scripts reach the model through `research_project` current and modes.
- **Upstream fidelity.** Each upstream `SKILL.md` is kept verbatim as `references/upstream.md` with the upstream references beside it; the adapted `SKILL.md` says which research tool does each upstream host step, where each deliverable lives and what done means in `research_check` terms. Upstream linters and validators run unchanged through a per-pack `gates/run_gate.py`; the few patches are marked `[research-workbench]` and listed in the pack's `NOTICE.md` with what was replaced and what was left out.
- **Upstream control and autonomy.** spark-to-paper's stop before experiments is a checkpoint phase. CCFA's handoff mode is the project's autonomy: `checkpoints` is PARTIAL, `automatic` is OFF.
- **Shared capabilities are native and present in every mode.** The venue library (139 CCF venues over 16 official style kits, built from CCFA-Skills by `scripts/build_venues.py`, with missing class dependencies installed into the managed TeX Live at compile time); `research_media` generate-image (gpt-image-2 by default) and fetch-reference-figures; `research_knowledge` over a built-in graph distilled from spark-to-paper's AI corpus by `scripts/build_kg.py`; `research_media` audit-svg (the upstream audit, unchanged) and export-figure; the `prose` base check.
- **Platform Python.** One package list, `PLATFORM_PYTHON_PACKAGES` in `src/components.ts`, serves the runtime install and the desktop build; the ready marker holds the list, so an install from an older list is brought up to date.

## Alternatives considered

**Add CCFA as a third mode in code.** Every further mode would repeat the edit across types, schema, checks, UI and locales, and a mode's skills could not be hidden from other modes. A directory per mode keeps new modes out of the code unless a phase needs a new kind of fact.

**Port the upstream scripts to TypeScript.** A port drifts from upstream and loses its self-checks, and the platform already manages a Python for documents. Upstream scripts run as they are; TypeScript was written only where a native tool was the point: knowledge-graph recall, venue application and the prose check.

**Per-mode tool schemas.** Changing the tool list with the mode would rewrite the cached request prefix and the tool catalog on every switch. Static schemas with the mode in the project brief keep both stable.

**List every pack skill and tell the model which to use.** The model would still load skills of the wrong method, and the user asked for inactive modes to be invisible.

**Ship the upstream knowledge graph as it is.** The archive is 763 MB, its vectors belong to one embedding model, and its graph is a pickle that runs code when loaded. The built-in graph keeps patterns and papers without vectors, read through an unpickler that resolves only five known classes; semantic ranking joins in when the user configures an embedding endpoint.

**Give CCFA a fixed pipeline.** Upstream defines gates per task and no stage sequence. The pack ships the upstream orchestrator's suggested routes as phases and an `open` route with none.

**Copy the CCFA LaTeX templates per venue.** 139 folders of largely duplicated class files, several mapped to the wrong kit; they are deduplicated into 16 kits with the wrong mappings corrected, and each kit compiles in review and final form through the workbench's own compile.

## Consequences

A new mode is a directory and a spec like `tests/ccfa-pack.spec.ts`; the preset's `research-modes` skill names it. Code changes only when a phase needs a fact the requirement set lacks.

Pack scripts run on the user's files as product content pinned to upstream commits, never as code the model writes: an argument vector, isolated mode, no shell, and the environment stripped of secrets by `runProcess`.

The platform Python is larger (svglib, reportlab, PyYAML), and an existing install reinstalls its packages once when the list changes.

Upstream texts still carry host-specific instructions (Codex paths, the host's image tool), which the model reads next to the adapted page; each adapted `SKILL.md` therefore names what replaces what.

ACL-family venues need `acl_natbib.bst`, which neither upstream nor TeX Live provides; their PDFs compile with unresolved citations, and the venue notes say so.

The stage spine described by the [conversation-first surface note](../feature/2026-09-21-research-workbench-conversation-first-surface.md) no longer exists: a project's progress is its mode's phases as the last check reported them.
