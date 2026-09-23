# spark-to-paper pack: upstream notice

This mode pack is adapted from [spark-to-paper-skills](https://github.com/Spark-To-Paper-Skills/spark-to-paper-skills) at commit `c17149d` (version 1.2.0), released under the MIT licence; the licence text is in `LICENSE` beside this file.

## Taken from upstream

- **Skill texts.** Each upstream `skills/<name>/SKILL.md` is kept verbatim as `skills/<name>/references/upstream.md`, with a one-line header naming its source. Also verbatim: `ts-figure-svg/references/svg-craft.md`, `ts-paper-data/references/plot-style.md`, `ts-paper-review/references/review_panel.workflow.js.md` (the upstream workflow script, as Markdown) and the 21 resource files of `ts-paper-experiment` (`resources/*.md` upstream).
- **Scripts**, under `upstream/` with their upstream paths: `run_gates.py`, `template_lint.py`, `blueprint_lint.py`, `citations_lint.py`, `doi2bib.py`, `draft_lint.py`, `reflow_tex.py`, `assemble_paper.py`, `story_lint.py`, `check_vector_pdf.py`, `plot_results.py`, `plot_style.py`, `consistency_check.py`, `check_result_recomputation.py`, `check_code_paper_consistency.py`.
- **Template**: `upstream/ts-paper/templates/ts_iieta/` — upstream marks it `"official": false`, a demo style, not a venue's kit.

Line endings were normalized to LF. Two scripts carry a patch, each marked `[research-workbench]` in the source:

- `citations_lint.py` matches every natbib and biblatex cite form, optional arguments included (`\citep[see][]{k}`, `\citealp{k}`); upstream missed cites with optional arguments.
- `check_result_recomputation.py` also scans `.research/runs/`, where a research project keeps its run metrics.

One word is replaced throughout the copies: the repository does not allow an ambiguous origin label, so the experiment resources, `check_result_recomputation.py` and `ts_iieta/template.json` say "traceability" where upstream used that label (the audit report is `RESULT_TRACEABILITY_AUDIT.md`), and the template's key of that name is `source`.

## Written for this pack

- `mode.yml` — routes, phases, gates and scripts.
- `gates/run_gate.py` — runs the upstream linters unchanged and prints their result as findings for `research_check`.
- `skills/<name>/SKILL.md` — each upstream skill restated against the research tools: which tool replaces which upstream script or key, and what "done" means in `research_check` terms.

## Replaced by platform capabilities

| Upstream | Replaced by |
|---|---|
| `gen_image.py`, `TS_FIG_*` keys | `research_media` generate-image with the image endpoint from the research settings (gpt-image-2 by default) |
| `fetch_reference_figures.py` | `research_media` fetch-reference-figures |
| `audit_svg.py`, `render_svg.py`, `svg_to_pdf.py` | `research_media` audit-svg, which runs the upstream `audit_svg.py` unchanged from the platform's `runtime/figures/`, and export-figure |
| `kg_recall.py`, `novelty_check.py`, `embed.py`, `cluster.py`, `kg_build.py`, `kg_lint.py`, `TS_EMBED_*` keys, the `kg_ai` archive | `research_knowledge` and the built-in graph distilled from `kg_ai` without its vectors |
| `doi2bib.py` as a step | `research_evidence` literature-import (the script stays for `citations_lint.py --resolve`) |
| `run_gates.py <stage>` | `research_check` with the phase as scope |
| templates copied by hand, the bundled `neurips` demo template | the platform venue library (`research_artifact` list-venues and apply-template) |
| `handoff_to_experiments.py`, `paper_config.yaml`, `init_paper_overleaf.py` | experiments run in the same project with `research_experiment` |

## Not included

`ts-figure-optimize` (DrawAI, which needs about 4 GB of local models) apart from its `check_vector_pdf.py` gate; the official PaperBanana engine and its setup script; the Overleaf push; `check_update.py`; `_dotenv.py` (keys live in the research settings); `check_pdf_layout.py` and `collect_results.py` (render-pages and run collection cover them).
