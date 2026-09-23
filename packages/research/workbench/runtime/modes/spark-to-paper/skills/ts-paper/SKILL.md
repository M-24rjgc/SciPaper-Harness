---
name: ts-paper
description: Runs the spark-to-paper mode — preflight, route the input (idea, proposal, proposal with measured results), carry the paper stage by stage through the ts-* skills to a compiled PDF, then run the experiments, and say when to ask and when it is done.
---

# spark-to-paper

One idea, a proposal, or a proposal with measured results in; a complete compiled paper out — real citations, editable vector figures, every number traced to data. Adapted from spark-to-paper-skills (MIT). The upstream orchestrator — the suite map, preflight, Stage 0 routing, the data-aware flow, the stage chain, Stage 8, the trace and the quality stack — is in `references/upstream.md`; read it once per project. Quality first: never skip a verification, a review or a fix to save a turn.

You drive the work. The research service keeps the record and runs the gates; it never tells you what to do next and never refuses your work.

## 1. Know where you are

`research_project` action current: mode, route, venue, autonomy, the phases the last check left open, and the skill for each phase. If the phases were never checked or look stale, run `research_check` once.

## 2. Preflight

Credentials are the user's; the environment is yours.

- **Image model** (ts-paper-figure): `research_media` generate-image uses the image endpoint in the research settings (gpt-image-2 by default). If it reports no credential, ask the user to add the key there — never ask for it in chat. If they decline, skip the image-model figures and log it; results plots need no key.
- **Knowledge graph** (ts-idea2story): `research_knowledge` graph-status. The built-in AI graph always recalls lexically; semantic recall and novelty need the embedding endpoint in the settings. Without it, say the novelty check is lexical and continue.
- **Environment**: the platform Python and TeX Live come from Tools & models in the research settings; SVG export uses the platform Python. Install what is missing there yourself.

Record the outcome in `logs/0_route.io.md`.

## 3. Stage 0 — the route

| Class | What was given | Route | `results_mode` |
|---|---|---|---|
| a | a bare idea: one line or a thin note | `idea` | `proposal` |
| b | a structured proposal: problem, method, evaluation, contributions — nothing measured | `proposal` | `proposal` |
| c | a proposal or report with real results: measured numbers in the text, or any attached data file | `data` | `data_aware` |
| d | an existing `story.json` | `proposal` (or `data` with real results beside it) | as its route |

Any real measured data wins (hyperparameters, dataset sizes and years are not results); then a complete proposal; otherwise an idea. Reference lists and `retrieved_papers.json` are citation seeds, never route signals. If the recorded route is wrong, `research_project` set-mode with mode `spark-to-paper`, the route and a one-line reason naming the signal; with checkpoints, confirm with `ask_user_question` first and record-decision the answer. Re-assert `results_mode` in `template.json` after the plan stage applies the template.

## 4. The stages

A stage is done when `research_check` with that phase as scope is clean — the base checks plus the upstream gates the pack runs unchanged. Load the stage's skill before you start it; each skill maps the upstream scripts to the research tools. After each stage write `logs/<n>_<stage>.io.md` (INPUT, DECISIONS, OUTPUT); at the end, `logs/index.md` linking them.

| Phase | Route | Skill | Writes |
|---|---|---|---|
| story | idea | ts-idea2story (ts-kg-build for a field outside the built-in graph) | `story.json`, `story_proposal.md`, `retrieved_papers.json` |
| data | data | ts-paper-data, results-ingest | data evidence, `results.facts.json` |
| plan | all | ts-paper-plan | `template.json` (via the venue), `blueprint.json` |
| cite | all | ts-paper-cite | `refs.bib`, `claims_map.json` |
| write | all | ts-paper-write | `sections/<id>.tex`, `sections/abstract.tex` |
| refine | all | ts-paper-refine | edits in place, `logs/4_refine.io.md` |
| review | all | ts-paper-review | `reviews/review.md`, `logs/5_review.io.md` |
| figures | all | ts-paper-figure, ts-figure-svg, ts-paper-data | `figures/<label>.{png,svg,pdf}`, `figures/figures.manifest.json` |
| latex | all | ts-paper-latex, latex-compile-and-fix, visual-self-review | `main.tex`, the PDF |
| experiments | idea, proposal | ts-paper-experiment, running-experiments | runs, filled tables, `results.facts.json` |
| submission | all | submission-package | the export |

The experiments phase is upstream's Stage 8: it starts after a complete first draft compiles, and it runs in this same project — no separate workspace, no Overleaf. It is a checkpoint phase: before anything runs, say what runs, how many, on which GPUs and roughly how long.

## 5. Numbers, by route

- `idea` and `proposal`, before experiments: every result cell is `--`; result prose is forward-looking; no invented number anywhere. `draft-lint` fails on a result-looking number; a hyperparameter is fine.
- `data`, and every route once experiments ran: every decimal and percentage in the prose is in `results.facts.json`, and every table number traces to collected metrics or imported data (`numbers`).

## 6. When to ask

The route when you chose it, the story, before running experiments, a material change of method, results that contradict the hypothesis, before the final export — plus the upstream stops: a missing credential, no official template for a real submission, an expensive or external-data experiment. With checkpoints, ask each with `ask_user_question` (your recommendation first) and record-decision the answer with decidedBy user; with automatic, decide, record-decision with a one-sentence rationale and keep going. Either way, ask when genuinely blocked and say exactly what you need.

## 7. Done

When the user asks for the paper, create a goal: "Complete the spark-to-paper paper for <title>; done when research_check is clean." Each round: re-read current, take the first unfinished phase, do it, check it.

Done means `research_check` scope all is clean, the review is current, every page was looked at and an export was made. Report the PDF path, page count, sections, reference count, the review outcome (found, closed, left for the author and the tier that ran), the figures (all editable vector PDFs), and anything the author must still supply.

## Never

- Never state a number the data does not give, never invent a citation, never hand-make a venue style file.
- Never call a phase done with gate errors outstanding, and never skip the review because it takes time.
