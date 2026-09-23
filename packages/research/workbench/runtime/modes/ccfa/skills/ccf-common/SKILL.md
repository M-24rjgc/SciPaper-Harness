---
name: ccf-common
description: Required shared preflight for every CCFA skill, after ccf-humanization — routing, scope, prerequisites, evidence and privacy rules, handoffs, artifact contracts and the ccfa.yaml schema — and how each upstream host step maps to the research tools here. Research deliverables stay with their specialist owners.
---

# CCF Common

Adapted from CCFA-Skills `ccf-common` (MIT). The upstream skill is in `references/upstream.md`, with its shared controls beside it in `references/`: routing (`routing.md`, `skill-trigger-registry.yaml`), depth (`task-modes.md`), handoffs (`handoff-modes.md`), evidence and privacy (`privacy-and-evidence.md`, `source-registry.yaml`), review standards (`review-output-standards.md`), venue families (`ccf-a-venue-map.md`), files (`artifact-contracts.md`) and project state (`ccfa-yaml-contract.md`). Apply it once per task after ccf-humanization, then continue the specialist work; it creates no report or state file of its own.

Paths in every CCFA `references/upstream.md` are relative to that skill's folder: `../ccf-common/references/routing.md` is this skill's `references/routing.md`, and `../ccf-humanization/SKILL.md` is the sibling skill (load it with the skill tool).

## Handoff mode is the project's autonomy

Upstream's `handoff_question_mode` is set by the project, not by the skill metadata:

| Project autonomy | Upstream mode | What it means here |
|---|---|---|
| `checkpoints` | PARTIAL | Finish the authorized scope. Ask with `ask_user_question` (your recommendation first) only for a new deliverable, a changed claim or protocol, disclosing private material, a deletion or appendix-policy change — and the key decisions the project brief names (the idea to develop, before running experiments, before the final export). Record each answer with `research_project` record-decision, decidedBy user. |
| `automatic` | OFF | No handoff questions. Decide, record-decision with a one-line rationale, and continue; ask only when genuinely blocked. |

FULL (ask before every optional sibling task) applies only when the user asks for it in so many words. A handoff carries the four blocks of `handoff-modes.md` (task and boundary, evidence, artifact ownership, work remaining) in your own context; no handoff file is written.

## Upstream steps and the tools that do them

| Upstream says | Here |
|---|---|
| web search; DBLP, Semantic Scholar, OpenReview, arXiv, OpenAlex, Crossref lookups | `web_search` and `web_fetch` to discover and read primary pages; `research_evidence` literature-search (crossref, openalex, arxiv) and literature-import for the verified record and its BibTeX. Cite only imported records. |
| read a supplied PDF, review or draft | `research_evidence` import (page and line locators), then search-evidence for exact quotes |
| closest-work and novelty grounding | also `research_knowledge` recall and novelty over the built-in research-pattern graph (lexical, or semantic with the embedding endpoint) — a lead to verify, never a citation |
| GPT Image 2 through the host's image tool | `research_media` generate-image (gpt-image-2 by default; the key lives in the research settings — ask the user to add it there, never in chat) |
| SVG render QA, SVG to PDF | `research_media` audit-svg and export-figure |
| `venue-guides/index.md`, `ccf-latex-templates/<VENUE>/` | `research_artifact` list-venues and apply-template; the venue guide lands at `template/<venue>/GUIDE.md` |
| latexmk / pdflatex, inspect pages | `research_artifact` compile, then render-pages and read_image each page |
| a script under `../<skill>/scripts/` or `resources/` | `research_artifact` run-script with the mode's script id: prose-quality, validate-comparison, pdf-to-card, plot-recipe |
| running experiments | `research_experiment` in a project environment (`research_environment`), then experiment-wait |
| subagents, "independent reviewer calls if the host permits" | the `subagent` tool — isolated contexts for reviewer panels |
| `$CODEX_HOME`, `agents/openai.yaml`, `ccf-skill-forger`, `check_v04.py`, `check_sources.py`, `check_markdown_links.py` | not part of this mode: they maintain the skill family itself |

## Project state and files

- `ccfa.yaml` at the project root is the CCFA state (`ccfa-yaml-contract.md`). ccf-project-scaffolder creates it and ccf-pipeline-orchestrator updates `stage`; other skills read it and propose changes. The research record (`research_project` current) is the platform's own ledger beside it — both stay true.
- Working files go under `ccfa-workfiles/<purpose>/<artifact>/` as `artifact-contracts.md` says; canonical outputs keep their contract paths (`ccfa-review-reports/`, `reviews/revision-ledger.md`, `submission/checks.md`, `experiments/results.*`).
- The manuscript lives in the project's `paper/` folder (`paper/main.tex`, started from the venue's `main.tex.tmpl`) unless one already exists elsewhere, and `ccfa.yaml` records its path; the compiler finds the venue's class files wherever it sits.
- Record where each result came from in the research ledger too: `research_artifact` register-artifact for plots (data and script as inputs), `research_evidence` claim for claims tied to quotes.

## Checks

`research_check` runs the base checks and this mode's gates: `ccfa-yaml`, `review-report`, `revision-ledger`, `submission-checks`, `path-privacy`. A phase is done when its check is clean. Checks report and never refuse; "a blocked lookup is not a passed check" — say what was not verified.

## Maintenance

The maintenance workflow in `references/upstream.md` (editing the skill family, its registries and validators) does not apply here: the pack is read-only product content.
