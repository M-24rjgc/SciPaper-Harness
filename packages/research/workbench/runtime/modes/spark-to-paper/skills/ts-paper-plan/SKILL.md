---
name: ts-paper-plan
description: Stage 1 of spark-to-paper — apply the venue template, then plan the whole paper in blueprint.json (title, keywords, contributions, notation, terminology, experiment design, per-section plans with word targets).
---

# Proposal to blueprint

Adapted from spark-to-paper-skills `ts-paper-plan` (MIT). The full upstream method — the blueprint schema, the per-template rules, Method-First writing order, the data-aware branch — is in `references/upstream.md`; read it and follow it. This page says how each step runs with the research tools.

## Step 0 — the template

The suite is template-driven: every later stage reads `template.json` in the project root.

1. Pick the venue: the one the user named, or ask (checkpoints) or choose and record it (automatic). `research_artifact` list-venues shows what is available; `ts_iieta` (Traitement du Signal) and `neurips` are the upstream demo templates.
2. `research_artifact` apply-template with the venue: it copies `template.json`, `main.tex.tmpl` and the style files into the project and records the venue. This replaces the upstream `template_lint.py` + `cp` step; `research_check` scope `template-lint` validates the copy.
3. Set `results_mode` in `template.json`: `data_aware` on the data route, `proposal` otherwise. Record the mode in `logs/1_plan.io.md`.

A demo template must be replaced by the venue's official files before a real submission; if no official template exists for the venue, say so (checkpoints: ask).

## The blueprint

Write `blueprint.json` in one reasoning pass, against `template.json`: its sections, ids, titles and word bands; the contributions count; the result-table set of the experiments recipe; the title and keyword limits; the citation types. The schema and the rules (title, keywords, terminology glossary, figures — at least `figures.min`, schematic in proposal mode, plus results plots on the data route — tables only in experiments, paragraph outlines) are in `references/upstream.md`.

On the data route, plan the result tables with the real method and metric names read from the data (`results.facts.json`), never invented placeholders.

## Validate

`research_artifact` run-script `blueprint-fix` repairs what the upstream linter can repair (citation-type aliases, missing sections, word-band shape); then `research_check` scope `plan` must be clean (it runs `template-lint` and `blueprint-lint`). Do not go on with a failing blueprint.

## Done when

The plan phase is clean and `logs/1_plan.io.md` records INPUT (the proposal), DECISIONS (title, word targets, keywords, results_mode) and OUTPUT (a one-line summary of the blueprint). Hand over to ts-paper-cite.
