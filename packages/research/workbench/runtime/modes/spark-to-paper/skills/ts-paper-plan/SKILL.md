---
name: ts-paper-plan
description: Stage 1 of spark-to-paper — apply the venue template, then plan the whole paper in blueprint.json (title, keywords, contributions, notation, terminology, experiment design, per-section plans with word targets).
---

# Proposal to blueprint

Adapted from spark-to-paper-skills `ts-paper-plan` (MIT). The full upstream method — the blueprint schema, the per-template rules, Method-First writing order, the data-aware branch — is in `references/upstream.md`; read it and follow it. This page says how each step runs with the research tools.

## Step 0 — the template

The suite is template-driven: every later stage reads `template.json` in the project root.

1. Pick the venue: the one the user named, or ask (checkpoints) or choose and record it (automatic). `research_artifact` list-venues searches the platform's library of 139 CCF venues by name, family or tier (for example `neurips`, `CCF-A security`).
2. `research_artifact` apply-template with the venue (stage review while drafting, final for camera-ready): it writes `template.json`, `main.tex.tmpl` and the venue's official style files into the project root, puts the kit, its example and the venue guide in `template/<venue>/`, and records the venue. This replaces the upstream `template_lint.py` + `cp` step; `research_check` scope `template-lint` validates the result. Read `template/<venue>/GUIDE.md` and any notes apply-template returns (a style file the library cannot bundle, a guide older than this year's call).
3. Set `results_mode` in `template.json`: `data_aware` on the data route, `proposal` otherwise; applying a venue again keeps the mode already set. Record it in `logs/1_plan.io.md`.

Without an applied venue, assembly falls back to the upstream `ts_iieta` demo style, which is not a venue's kit. A venue outside the library needs its official files from the user (`research_artifact` import-template) — never hand-made ones; say so, and with checkpoints ask.

## The blueprint

Write `blueprint.json` in one reasoning pass, against `template.json`: its sections, ids, titles and word bands; the contributions count; the result-table set of the experiments recipe; the title and keyword limits; the citation types. The schema and the rules (title, keywords, terminology glossary, figures — at least `figures.min`, schematic in proposal mode, plus results plots on the data route — tables only in experiments, paragraph outlines) are in `references/upstream.md`.

On the data route, plan the result tables with the real method and metric names read from the data (`results.facts.json`), never invented placeholders.

## Validate

`research_artifact` run-script `blueprint-fix` repairs what the upstream linter can repair (citation-type aliases, missing sections, word-band shape); then `research_check` scope `plan` must be clean (it runs `template-lint` and `blueprint-lint`). Do not go on with a failing blueprint.

## Done when

The plan phase is clean and `logs/1_plan.io.md` records INPUT (the proposal), DECISIONS (title, word targets, keywords, results_mode) and OUTPUT (a one-line summary of the blueprint). Hand over to ts-paper-cite.
