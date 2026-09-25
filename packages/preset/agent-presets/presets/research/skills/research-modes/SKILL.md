---
name: research-modes
description: Use when choosing how to run research work — the brief says the mode is not chosen, the user wants a whole paper carried through a method, or the user asks for another mode. The one table of modes and routes, and how set-mode records the choice.
---

# Modes

Every research has a mode. `research_project` action current names it, says whether it was chosen (`modeChosen`, `modeSetBy`) and whether its route is settled (`routingSettled`); action modes lists what is installed, with each mode's routes and phases.

## The general mode

No pipeline. Every research tool is available — evidence and literature search, the research-pattern knowledge graph (`research_knowledge`), the venue template library (list-venues, apply-template), LaTeX compile and page rendering, draw.io, image generation, SVG figure audit and export, experiments, checks — together with the general skills: literature-review, paper-writing, paper-review, method-diagram, figures-from-data, results-ingest, running-experiments, latex-compile-and-fix, visual-self-review and submission-package. Do what the user asks, then run the check that fits (`research_check` with scope cite, numbers, compile, figures …) before you say it is done.

## Pack modes

A pack mode adds a method on top of the same tools: its own skills, which you see only while the mode is active; phases, each with a definition of done; and gates that `research_check` runs. The brief names the skills to load when you start a phase's work.

- **spark-to-paper** — an idea, a proposal, or a proposal with measured results in; a complete compiled paper out, with real citations, editable vector figures and every number traced.
- **ccfa** — research aimed at a CCF-A venue through specialist skills (idea development and concept review, literature grounding, experiment design, writing, figures, integrity audit, reviewer-grade assessment, submission checks, rebuttals), with `ccfa.yaml` as the working notes its gates read.

Other installed modes appear in `research_project` action modes with their own summaries.

## Choosing the mode and route

A new research starts in the general mode with the mode not chosen (`modeChosen: false`). Choose after the user's first message, from what exists, not from what the user calls it. This is the one routing table; a pack's entry skill routes again only while `routingSettled` is false.

| What exists, and what the user wants | Mode · route |
|---|---|
| bounded work: a paragraph, a figure, a compile, a literature search, a review of one section, a question about the data | general |
| a line or a thin note, carried straight to a compiled paper (the story is built first) | spark-to-paper · `idea` |
| a structured proposal (problem, method, evaluation) with nothing measured; result cells stay `--` until experiments run | spark-to-paper · `proposal` |
| measured numbers or data files; every number traces to them | spark-to-paper · `data` |
| a direction or an idea aimed at a CCF-A venue, with reviewer-grade review | ccfa · `full-paper` |
| a manuscript to strengthen before submission | ccfa · `manuscript-improvement` |
| reviews of a submitted paper to answer (rebuttal, revision, resubmission) | ccfa · `post-review-response` |
| one bounded CCFA task: an idea review, a search, a figure, a paper review | ccfa · `open` |

Real measured data wins over a proposal; hyperparameters, dataset sizes and years are not results.

- `checkpoints`: ask once with `ask_user_question` (your recommendation first, then the alternatives), then set-mode with decidedBy user.
- `automatic`: decide, then set-mode.

## set-mode

`research_project` action set-mode with the mode, the route and a one-line reason. It records the decision itself (question 模式与路线, key `mode`), so no separate record-decision follows; the reason stays on record until a later set-mode gives a new one. From then on the route is settled (`routingSettled`). Change the mode later only when the user asks.

Switching never loses files, sources, runs or decisions. It changes which skills you have and which phases the check reports; under a new mode or route every phase starts unchecked. After switching, read `research_project` current again. If a goal is running, update its objective to the new mode in the same turn.
