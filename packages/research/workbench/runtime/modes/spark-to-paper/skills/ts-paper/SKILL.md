---
name: ts-paper
description: Runs the spark-to-paper mode — routes the input (idea, proposal, proposal with measured results), carries the paper stage by stage to a compiled PDF, and says when to ask and when it is done.
---

# spark-to-paper

One idea, a proposal, or a proposal with measured results in; a complete compiled paper out — real citations, editable vector figures, every number traced to data, and a deterministic check that says whether it is done. Adapted from spark-to-paper-skills (MIT); the research tools replace its scripts.

You drive the work. The research service keeps the record and runs the checks; it never tells you what to do next and never refuses your work.

## 1. Know where you are

`research_project` action current: mode, route, autonomy, the phases the last check left open, the decisions already made. If the phases were never checked or look stale, run `research_check` once.

## 2. Stage 0 — the route

Classify what the user gave you (the brief, the files in the folder, what they said):

| Class | What was given | Route |
|---|---|---|
| a | a bare idea: one line or a thin note, no method or evaluation structure | `idea` |
| b | a structured proposal: problem, method, evaluation, contributions — nothing measured | `proposal` |
| c | a proposal or report with real results: measured numbers in the text, or any attached data file | `data` |
| d | an existing `story.json` | `proposal` (or `data` when real results come with it) |

Apply the rules in this order: any real measured data → `data` (hyperparameters, dataset sizes and years are not results); otherwise a complete proposal → `proposal`; otherwise `idea`. Reference lists and retrieved papers are citation seeds, never route signals.

If the recorded route is wrong, call `research_project` action set-mode with mode `spark-to-paper`, the route and a one-line reason naming the signal. With `checkpoints`, confirm with `ask_user_question` first and record-decision the answer.

## 3. The stages

A stage is done when `research_check` with that phase as scope is clean. Load the stage's skill before you start it. Keep an audit trail: after each stage write `logs/<n>_<stage>.io.md` with three blocks — INPUT (the files consumed), DECISIONS (the judgement calls), OUTPUT (what was written, with a short excerpt).

| Phase | Route | Skill | Writes | Done when |
|---|---|---|---|---|
| story | idea | ts-idea2story | `story.json`, `story_proposal.md` | the 8-field story passes its rules; closest work is known |
| data | data | results-ingest | data evidence, `results.facts.json` | the measured results are imported; derived numbers come from a script |
| plan | all | ts-paper-plan | `blueprint.json` (and `outline.md`) | title, contributions, notation, sections with word targets, planned tables and figures |
| cite | all | literature-review | `refs.bib` | every citation resolves to a complete, verified entry |
| write | all | paper-writing | the manuscript and its sections | every section written; numbers as the route allows (below) |
| refine | all | paper-writing | edits in place | right-sized, de-AI pass done, logic self-checked |
| review | all | paper-review | `reviews/review.md` | an adversarial review is current, with no open blocker or major issue |
| figures | all | method-diagram, figures-from-data | figures | an editable architecture diagram; result plots from data, vector |
| latex | all | latex-compile-and-fix, visual-self-review | the PDF | it compiles and every page has been looked at |
| experiments | idea, proposal | running-experiments, figures-from-data | runs, filled tables | runs completed and collected; no placeholder left; every number traces |
| submission | all | submission-package | the export | `research_check` scope all is clean |

## 4. Numbers, by route

- `idea` and `proposal`, before experiments: every result cell is `--`; result prose is `\tbd{what will go here}`; no invented number anywhere — no percentages, deltas, "x times faster". A decimal that is a hyperparameter (learning rate, dropout, temperature …) is fine.
- `data`, and every route once experiments ran: every decimal and percentage in results, tables, the abstract and the conclusion comes from collected run metrics, imported data or a script's output (`results.facts.json`).

## 5. When to ask

The key decisions: the route (when you chose it), the research story, **before running experiments** (what runs, how many, which GPUs, rough time), before the final export, a material change of method, results that contradict the hypothesis. The upstream method's own stops also apply: a missing credential (image or embedding endpoint), no official template for a real submission, an expensive or external-data experiment.

- `checkpoints`: ask each with `ask_user_question` — your recommendation first, then the concrete options — and record-decision the answer with decidedBy user.
- `automatic`: decide, record-decision with a one-sentence rationale, keep going.
- Either way, ask when genuinely blocked, and say exactly what you need.

## 6. Keep going, and what done means

When the user asks for the paper, create a goal: "Complete the spark-to-paper paper for <title>; done when research_check is clean." Each round: re-read current, take the first unfinished phase, do it, check it.

Done means `research_check` scope all is clean, the review is current, the pages were looked at, and an export was made. Report the PDF path, page count, sections, reference count, the review outcome (issues found, closed, left for the author), the figures, and anything the author must still supply.

## Never

- Never state a number the data does not give, and never invent a citation.
- Never mark a phase done with check errors outstanding, and never skip the review because it takes time.
