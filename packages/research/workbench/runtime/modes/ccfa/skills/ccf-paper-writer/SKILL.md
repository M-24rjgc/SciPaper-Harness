---
name: ccf-paper-writer
description: Draft, revise, polish, compress or presentation-adapt CCF manuscript prose in its source format, evidence-bound, compiled and checked. Use for 写作, 润色论文, 改写, 压缩论文, abstracts, sections, slides and rewrites based on reviews. Assessment without rewriting belongs to ccf-paper-reviewer; rebuttals to ccf-rebuttal-writer.
---

# CCF Paper Writer

Adapted from CCFA-Skills `ccf-paper-writer` (MIT). The upstream skill — the writing standard, polish, draft, compress and presentation modes with the references each loads, the ten-step workflow — is in `references/upstream.md`, with its references beside it: storyline blueprint, section modules, research-writing patterns, citation workflow, prose guardrails, writing checklists, compression rules, length budget, table style, venue adapters, the exemplar cards (`references/exemplars/index.md`, 29 cards) and the default format (`references/custom-format/default-user-format.md`). Follow it; this page says how it runs here.

## Venue and length

- Upstream's `references/venue-guides/index.md` is the platform venue library: `research_artifact` list-venues, then the guide at `template/<venue>/GUIDE.md` after apply-template (ccf-project-scaffolder applies it). With no venue, draft against the NeurIPS guide as a stated assumption.
- The page budget comes from the guide and `length-budget-policy.md`; final policy freshness belongs to ccf-submission-checker.

## Exemplars

For a full manuscript or a requested style, select from `references/exemplars/index.md` (one card to start, at most four; with no venue, `llava-4d.md` and `vggt.md` per the default format). The project's own cards, made by ccf-paper-to-exemplar, live in `ccfa-workfiles/exemplars/cards/` with their `index.md`; read those too. Never copy exemplar wording or content.

## Evidence

- Citations: only records imported with `research_evidence` literature-import (they carry verified BibTeX); missing sources go to ccf-literature-searcher. Keep unrelated keys.
- Numbers: only from collected runs, imported data or a script's output; an unavailable result stays `TBD` in prose and `--` in a table cell.
- Claims tied to quotes: `research_evidence` claim.

## Draft, compile, look

Write the manuscript in place (`ccfa.yaml` `artifacts.manuscript`, normally `paper/main.tex`, started from the venue's `main.tex.tmpl`). Then:

1. `research_artifact` compile (xelatex for CJK text), fix errors — the latex-compile-and-fix skill.
2. render-pages and read_image every page; check the page count against the budget, floats, overfull lines — the visual-self-review skill.
3. Prose: `research_check` scope `prose`, and `research_artifact` run-script prose-quality with the file and `--scope paper` (upstream `check_prose_quality.py`). Fix real problems; keep justified scientific language.
4. For a substantial draft, ask ccf-paper-reviewer for a bounded claim-evidence check of the affected text.

Recompile after relevant changes; if a pass makes no progress, change the approach or report the exact issue. Do not loop to fill pages.

## Done when

The writing phase of `research_check` is clean: the manuscript compiles from current sources, citations resolve to verified entries, no placeholder remains, and the pages were looked at since the last compile.
