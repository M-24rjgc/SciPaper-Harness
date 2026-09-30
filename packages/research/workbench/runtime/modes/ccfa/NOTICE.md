# CCFA pack: upstream notice

This mode pack is adapted from [CCFA-Skills](https://github.com/mikubaka88/CCFA-Skills) at commit `5969e6b` (version 0.10.0-r2), released under the MIT licence; the licence text is in `LICENSE` beside this file.

## Taken from upstream

- **Skill texts.** Sixteen upstream skills, each `SKILL.md` kept verbatim as `skills/<name>/references/upstream.md` with a one-line header naming its source, and every file of their `references/` folders verbatim beside it — including the paper writer's 29 exemplar cards, its exemplar index and default format, and the reviewer's writing-review references.
- **Assets:** the rebuttal writer's four TeX response templates (`skills/ccf-rebuttal-writer/assets/templates/`).
- **Scripts**, under `upstream/` with their upstream paths: `ccf-common/scripts/check_path_privacy.py`, `ccf-paper-reviewer/scripts/validate_version_comparison.py`, `ccf-paper-to-exemplar/scripts/convert.py`, `ccf-paper-writer/scripts/check_prose_quality.py`, `ccf-visual-composer/resources/python/ccfa_plot_recipes.py`, and the state template `ccf-project-scaffolder/assets/ccfa.yaml`.

Two scripts carry a patch, each marked `[research-workbench]` in the source:

- `validate_version_comparison.py` finds the reviewer's references under `skills/ccf-paper-reviewer/references/`, where this pack keeps them, when they are not beside the script.
- `convert.py` reads PDFs with pypdfium2, which the platform Python ships, when pymupdf is not installed.

One word is replaced throughout the copies: the repository does not allow an ambiguous origin label, so the texts, the source registry and `validate_version_comparison.py` say "origin" where upstream used that label — among them the version-comparison issue field and its values.

## Written for this pack

- `mode.yml` — the routes (upstream's suggested routes plus `open`), phases, gates and scripts.
- `gates/run_gate.py` — the gates `research_check` runs: `ccfa.yaml` against the v0.4.0 contract, the review reports through the upstream `validate_version_comparison.py --report` plus their open findings, the revision ledger, the submission readiness record, and machine paths with the upstream `check_path_privacy.py` patterns.
- `scripts/plot_recipe.py` — a command line over the upstream plot recipes: one recipe, its arguments from a JSON file, an SVG out.
- `skills/<name>/SKILL.md` — each upstream skill restated against the research tools: which tool does which upstream host step, where each deliverable lives, and what "done" means in `research_check` terms.

## Replaced by platform capabilities

| Upstream | Replaced by |
|---|---|
| `metadata.ccf_skill_controls.handoff_question_mode` | the project's autonomy: `checkpoints` is PARTIAL, `automatic` is OFF |
| web search and scholarly APIs | `web_search`, `web_fetch`, and `research_evidence` literature-search and literature-import (verified records and BibTeX) |
| GPT Image 2 through the host's image tool | `research_media` generate-image with the image endpoint from the research settings (gpt-image-2 by default) |
| render QA and SVG export | `research_media` audit-svg and export-figure |
| `ccf-paper-writer/references/venue-guides/` (109 guides) and `ccf-latex-templates/` (139 venues) | the platform venue library, built from the same guides and templates (`research_artifact` list-venues and apply-template) |
| latexmk / pdflatex | `research_artifact` compile and render-pages |
| registering exemplar cards in the writer's library | a project library under `ccfa-workfiles/exemplars/` (the built-in library is read-only) |
| `convert_pdf_to_card.py` | the `pdf-to-card` script, which runs `convert.py` directly |

## Not included

`ccf-skill-forger` and the family-maintenance scripts (`check_v04.py`, `check_sources.py`, `check_markdown_links.py`), which maintain the skill family itself; the Codex and Claude Code packaging (`agents/openai.yaml`, plugin manifests); the venue guides and LaTeX templates as copies (the venue library carries them); the four unreferenced images of the visual composer's references.
