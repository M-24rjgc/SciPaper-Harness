---
name: ccf-pipeline-orchestrator
description: Runs the CCFA mode — reads the project and ccfa.yaml, picks the route (full paper, manuscript improvement, post-review response, open), assigns each stage to its specialist owner with its gate, keeps ccfa.yaml's stage current, and says when to ask and when the work is done. Use for 任务拆解, 流程规划, project status and end-to-end coordination.
---

# CCFA orchestrator

Adapted from CCFA-Skills `ccf-pipeline-orchestrator` (MIT). The upstream skill — goal and stage mapping, gates defined by evidence, output, pass condition, blocker and owner, the continuity contract — is in `references/upstream.md`, with the intake protocol, approach options and design brief in `references/workflow-planning/`. Read it once per project. Upstream has no fixed pipeline; the routes below are its suggested routes (`approach-options.md`), and each stage's gate is a `research_check` phase.

You drive the work; the specialists own their outputs. The research service keeps the record and runs the checks; it never tells you what to do next and never refuses your work.

## 1. Know where you are

`research_project` action current (mode, route, venue, autonomy, the phases the last check left open and each phase's skills), then `ccfa.yaml` if it exists. If the phases were never checked, run `research_check` once. For an unclear request use the intake protocol: scope `single-task`, `multi-stage`, `too-broad` or `unclear`; missing facts `must-know`, `useful-to-know` or `safe-to-assume` — ask only the must-know ones.

## 2. The route

| What exists | Route |
|---|---|
| a direction, a seed or an idea; no manuscript | `full-paper` |
| a manuscript to strengthen before submission | `manuscript-improvement` |
| reviews of a submitted paper (rebuttal, revision, resubmission) | `post-review-response` |
| one bounded task — an idea review, a search, a figure, a paper review, a compression | `open` |

Pick from what exists, not from what the user calls it. If the recorded route is wrong, `research_project` set-mode with mode `ccfa`, the route and a one-line reason; under `checkpoints` confirm with `ask_user_question` first and record-decision the answer. On `open`, route each request to its owner with `../ccf-common/references/routing.md` and run the checks that fit (`research_check` with scope cite, numbers, compile, figures, prose, review-report …).

## 3. The stages

Load the stage's owner skill before you start it. A stage is done when `research_check` with the phase as scope is clean — its gate in upstream terms: the evidence exists, the output is at its path, the check passes. "Tool completion alone does not pass a gate."

| Phase | Routes | Owner | Writes |
|---|---|---|---|
| scaffold | all but open | ccf-project-scaffolder | `ccfa.yaml`, the venue template |
| idea | full-paper | ccf-idea-optimizer, then ccf-idea-reviewer | `ccfa-workfiles/ideas/<idea>/idea-card.md`, `idea-review.md` |
| literature | full-paper | ccf-literature-searcher (ccf-literature-monitor for recent overlap) | `ccfa-workfiles/literature/<topic>/papers.md`, imported literature |
| design | full-paper | ccf-experiment-designer | `experiments/design.md` |
| experiments | full-paper | ccf-experiment-designer with running-experiments, results-ingest | runs, `experiments/results.*` as data evidence |
| diagnose | manuscript-improvement | ccf-paper-reviewer (full mode) | `ccfa-review-reports/<paper-slug>-<venue>-review.md` |
| ledger | post-review-response | ccf-rebuttal-writer (revision-ledger) | `reviews/revision-ledger.md` |
| response | post-review-response | ccf-rebuttal-writer | `ccfa-workfiles/responses/<paper>/response.tex` or `.md` |
| writing | full-paper, manuscript-improvement | ccf-paper-writer | the manuscript, compiled, pages inspected |
| revision | post-review-response | ccf-paper-writer with ccf-rebuttal-writer | the revised manuscript; every ledger row done |
| visuals | full-paper | ccf-visual-composer | the method figure (editable, vector PDF), result figures |
| integrity | full-paper, manuscript-improvement | ccf-integrity-auditor (full mode) | `ccfa-workfiles/checks/integrity/audit.md` |
| review | full-paper, manuscript-improvement | ccf-paper-reviewer, then ccf-paper-writer for fixes | the review report with no open critical or major finding |
| submission | all but open | ccf-submission-checker, submission-package | `submission/checks.md`, the export |

Work backward from the requested outcome to missing prerequisites, including upstream work the user did not name (`routing.md`, conditional dependency routes). Continue independent stages around a blocker. Reopen only what a change affected.

## 4. ccfa.yaml

While a route runs, keep the state current: `stage.current` is the phase you are in, `stage.gate` is `open` or `passed` from its last check, `stage.updated_at` today's date; preserve every other field and the schema. Record claims, experiments and reviews in their lists as they become real. A planning-only request proposes the change instead of writing it.

## 5. When to ask

Under `checkpoints`, ask with `ask_user_question` (your recommendation first) and record-decision the answer with decidedBy user: the route when you chose it, which idea to develop after the idea review, before running experiments (what runs, how many, on which GPUs and for how long), a changed claim or protocol, results that contradict the hypothesis, before the final export. Under `automatic`, decide those yourself, record-decision with a one-line rationale and keep going. Either way, ask when genuinely blocked and name exactly what you need.

## 6. Done

When the user asks for the whole route, create a goal: "Complete the CCFA <route> for <title>; done when research_check is clean." Each round: re-read current, take the first unfinished phase, do it through its owner, check it.

Report in the upstream shape (project goal, current stage, known and missing artifacts, gate decision, next owner, ccfa.yaml update, risks) only for a status or planning request; at the end of a route report the PDF, the review outcome, the submission checklist and anything the author must still supply.

## Never

- Never invent a completed stage, a result, a citation or a background job.
- Never call a phase done with check errors outstanding.
