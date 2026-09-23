---
name: ccf-paper-reviewer
description: Review a manuscript's claims, evidence and writing without rewriting it — scientific, writing, full or version-comparison mode — into the canonical CCFA review report with typed findings and calibrated scores. Use for 文章审核, 审稿, 稿件有什么硬伤, 结论站得住吗, 投稿成熟度 and version comparison. Concept-only judgment belongs to ccf-idea-reviewer; prose edits to ccf-paper-writer.
---

# CCF Paper Reviewer

Adapted from CCFA-Skills `ccf-paper-reviewer` (MIT). The upstream skill — the four modes, the eight-step workflow, the report profiles and the version-comparison contract — is in `references/upstream.md`, with its references beside it: `fixed-output-format.md` (the 14-section scientific/full, 9-section writing and 5-section brief profiles, the finding record), `calibration-and-rank.md` (the seven-dimension rubric and scales), `review-workflow.md`, `universal-review-rubric.md`, `venue-review-styles.md`, `reviewer-panel.md`, `desk-checks.md`, `version-comparison.md` and `writing-review/`. Follow them; this page says how they run here.

## Before reviewing

- The venue guide is `template/<venue>/GUIDE.md` (after apply-template; `research_artifact` list-venues otherwise).
- Read the paper from its sources and its compiled PDF (render-pages and read_image for figures, tables and layout). Private material stays private: search only with public-safe queries.
- Missing novelty evidence goes to ccf-literature-searcher, decisive number or citation conflicts to ccf-integrity-auditor, protocol questions to ccf-experiment-designer.

## The panel

For a standard full assessment, the `subagent` tool gives each reviewer role of `reviewer-panel.md` its own context: give each only its role, the rubric, the venue style and the paper text, and ask for evidence-anchored findings. Merge in your own context: consolidate duplicates, countercheck every major or critical finding against the strongest passage that could answer it, narrow or withdraw refuted ones. Without subagents, label the roles as one reviewer's simulation.

## The report

Save it to `ccfa-review-reports/<paper-slug>-<venue>-review.md` and overwrite it in place on every re-review; dates and compared versions go inside. Begin with a scope block of plain `Label: value` lines, which the check reads:

```text
Template: ccfa-review-1
Mode: scientific | writing | full | version-comparison
Detail: detailed | brief
Rubric: generic-7 | writing | <venue form name>
Scores: none            (only for a no-score review)
Source version: <commit, date or file digest>
Contribution type: <method | benchmark | system | theory | …>
```

The numbered sections are `## 1. …` headings in the profile's order; findings are `### C001: …` records with Type, Severity, Location, Evidence, Countercheck, Judgment, Criterion, Resolution and Status, defined once in the concerns section and cited elsewhere as `[C001]`. On re-review keep each finding's ID and update its Status (`unresolved`, `partially_resolved`, `resolved`, `not_applicable`) against the current text.

`research_check` scope `review-report` runs the upstream `validate_version_comparison.py --report` on every report (headings, finding records, the scorecard, Overall and Scholarly Confidence) and lists each open critical or major finding as an error. For a version comparison, validate the JSON comparison too with `research_artifact` run-script validate-comparison and the file.

## The loop

Review is assessment only: concrete edit actions go to ccf-paper-writer, reviewer responses to ccf-rebuttal-writer. In the review phase, after the writer's fixes land, re-review the affected findings and update their Status.

## Done when

The review phase of `research_check` is clean: the report passes the format check and holds no open critical or major finding. The `review` check warns when the report is older than the latest manuscript change; re-review the changed parts then. In the diagnose phase the report only has to exist; still run `research_check` scope `review-report` and fix every format error — the open findings it lists are what the revision works through.
