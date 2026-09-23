---
name: ts-paper-write
description: Stage 3 of spark-to-paper — draft every section as a LaTeX body file (sections/<id>.tex plus sections/abstract.tex) from the blueprint and refs.bib, following the template's recipes and the numbers rule of the route.
---

# Draft all sections

Adapted from spark-to-paper-skills `ts-paper-write` (MIT). The full upstream method — the output format, every per-section recipe, the table, notation and figure patterns, the data-aware rules — is in `references/upstream.md`; read it before writing and follow it. This page says how each step runs with the research tools.

## Inputs and outputs

- In: `blueprint.json`, `refs.bib`, `claims_map.json`, `template.json` (recipes, word bands, citation style, `results_mode`), and `results.facts.json` on the data route.
- Out: `sections/<id>.tex` for every section of the template plus `sections/abstract.tex` — body only, no `\section` line (assembly adds the canonical heading) — and `logs/3_write.io.md`.

Write with the ordinary file tools, one physical line per paragraph.

## The numbers rule, by route

- `proposal` (idea and proposal routes): no result number anywhere in a sentence — no percentages, decimals, signed deltas, multipliers or word-form magnitudes; result table cells are `--`; results prose is forward-looking. A hyperparameter decimal is fine.
- `data_aware` (data route, and after experiments): the result-bearing sections report the real numbers in past tense, and every decimal or percentage appears in `results.facts.json`; tables and prose carry identical values.

## Figures while drafting

Place at least `figures.min` figure placeholders across method, experiments and analysis, each with its `%% FIGURE-SPEC type=…` and `%% DESC:` comment lines, exactly as `references/upstream.md` shows. ts-paper-figure draws them later. Results plots (data route only) come from a script: `research_artifact` run-script `plot-results` with `--script figures/<label>.plot.py --out figures/<label>.png`.

## Check and hand over

1. `research_check` scope `write` runs the upstream `draft-lint` (numbers, non-ASCII outside math, bold in prose, numbered headings, recipe shapes, word bands, the figure floor, the AI-tell phrases) and `citations-lint` (every `\cite` resolves and is justified in `claims_map.json`, per-section coverage). Fix every finding and check again.
2. Self-review the judgement items the linter cannot see: citation-claim match, design rationales, hedging, terminology, prose flow (no bare-comma lists).
3. `research_artifact` run-script `reflow-sections` normalizes every section to one line per paragraph.
4. Write `logs/3_write.io.md` — INPUT (blueprint, refs.bib), DECISIONS (self-review findings and fixes), OUTPUT (the section files and their word counts). Hand over to ts-paper-refine.

## Done when

The write phase of `research_check` is clean.
