---
name: ts-paper-experiment
description: Stage 8 of spark-to-paper — after the first draft compiles, diagnose the research logic, run only feasible experiments in this project, fill the result tables with the measured numbers, and repair the whole manuscript for claim–evidence consistency.
---

# Experiments and repair

Adapted from spark-to-paper-skills `ts-paper-experiment` (MIT). The full upstream workflow — its 18 steps, the non-negotiable rules (GR-018 to GR-027), the consistency gate with its six audits, the table necessity audit, the polish, reference and layout checks, the post-repair review and its verdict labels, and suggestion capture — is in `references/upstream.md`, with the policy files beside it in `references/` (`golden_rules.md`, `claim_evidence_rules.md`, `experiment_templates.md`, `dataset_license_gate.md`, `experiment_prerun_approval_gate.md` and the rest). Read them and follow them.

It runs in this project, not in a separate workspace: the manuscript is `sections/*.tex`, `main.tex` and `refs.bib` in the project root. There is no Overleaf sync and no git repository inside the paper; nothing is pushed anywhere.

## Where the upstream paths go

| Upstream | Here |
|---|---|
| `./paper/` (source of truth) | the project's manuscript files — edit them in place |
| `./workspace/diagnosis/`, `./workspace/experiments/`, `./workspace/lessons/` | the same folders in the project root |
| `./outputs/reports/` | the same folder in the project root |
| `./input/data/`, `./input/code/` | data evidence (`research_evidence` import) and `code/` |
| Initial commit in `./paper/` (the baseline Step 17 diffs against) | before the first edit, copy `main.tex`, `sections/` and `refs.bib` to `workspace/draft-baseline/` |
| `./.claude/skills/…/memory/lessons_candidate.md` | `workspace/lessons/lessons_candidate.md` — the pack itself is read-only |

## With the research tools

| Upstream step | Do it with |
|---|---|
| Pre-run plan and resource approval (Step 2) | this is a checkpoint phase: with checkpoints autonomy, present the plan (what runs, how many, which GPUs, runtime, disk, external data) with `ask_user_question` and record-decision the answer; with automatic, record-decision and go, but still ask before an expensive run or an external download, as GR-021 requires |
| Dataset, licence and terms gate (Step 3) | report it before any download; import each downloaded dataset with `research_evidence` import so runs can name it in `dataEvidenceIds` |
| Run feasible experiments (Step 3) | `research_environment` environment, then `research_experiment` experiment per run with the seeds from the plan, `gpuIds`, `dataEvidenceIds`, `maxSeconds`; the script writes metrics to `$RESEARCH_METRICS_PATH`. `experiment-wait`, `experiment-logs` on a failure. The running-experiments skill covers the details |
| Raw result recomputation, code artifact scan (Step 5) | `research_artifact` run-script `recompute-results` (tabulates every run's metric files under `.research/runs/`) and `scan-code` (lists the reproducibility artifacts in `code/`); both write their aid reports to `outputs/reports/` |
| Fill the tables (GR-025) | write `results.facts.json` with a script from the collected metrics (`code/facts.py`), import it as data evidence, set `"results_mode": "data_aware"` in `template.json`, then fill the tables and rewrite the result prose by the ts-paper-data rules; plots by `research_artifact` run-script `plot-results` |
| Risky wording scan (Step 13) | `research_artifact` run-script `consistency-check` with the section file |
| Reference verification (Step 12) | `research_evidence` literature-import re-fetches each record; `research_check` scope `cite` |
| Rendered PDF layout check (Step 14) | run-script `assemble-paper`, `research_artifact` compile, render-pages, and `read_image` on every page (visual-self-review) |
| Commit and push (Step 16) | not used; the export at submission is the deliverable |

## Done when

- The experiments phase of `research_check` is clean: runs collected or the author's results imported, no active run, `results.facts.json` present, no `--` left in a result table that was run, every number traced (`placeholders`, `numbers`, `draft-lint`, `compile`).
- The upstream output checklist is complete — or, when nothing could run, `workspace/experiments/EXPERIMENT_REQUIREMENTS.md` explains why and the tables stay in proposal form. Never an invented number.
- `outputs/reports/FINAL_NARRATIVE_INTEGRITY_REVIEW.md` carries one verdict label, and `workspace/lessons/SUGGESTIONS_FOR_USER.md` is written, with the closing message to the user.

Afterwards the refine, review and latex phases are re-checked on the repaired manuscript (GR-027), then submission.
