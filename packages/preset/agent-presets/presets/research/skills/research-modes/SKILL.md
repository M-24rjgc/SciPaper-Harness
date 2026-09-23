---
name: research-modes
description: Use when deciding how to run research work — what the general mode offers, which installed modes carry a paper through a method with their own skills and checks, and when to suggest switching.
---

# Modes

Every project has a mode. `research_project` action current names it and what it asks of you; action modes lists what is installed, with each mode's routes and phases.

## The general mode

No pipeline. Every research tool is available — evidence and literature search, the research-pattern knowledge graph (`research_knowledge`), the venue template library (list-venues, apply-template), LaTeX compile and page rendering, draw.io, image generation, SVG figure audit and export, experiments, checks — together with the general skills: literature-review, paper-writing, paper-review, method-diagram, figures-from-data, results-ingest, running-experiments, latex-compile-and-fix, visual-self-review and submission-package. Do what the user asks, then run the check that fits (`research_check` with scope cite, numbers, compile, figures …) before you say it is done.

## Pack modes

A pack mode adds a method on top of the same tools: its own skills, which you see only while the mode is active; phases, each with a definition of done; and gates that `research_check` runs. The current brief names the skills to load first.

- **spark-to-paper** — an idea, a proposal, or a proposal with measured results in; a complete compiled paper out, with real citations, editable vector figures and every number traced. Routes: `idea` (a line or a thin note — the story is built first), `proposal` (problem, method and evaluation are set, nothing is measured — result cells stay `--` until experiments run), `data` (measured numbers or data files exist — every number traces to them).
- **ccfa** — research aimed at a CCF-A venue through specialist skills (idea development and concept review, literature grounding, experiment design, writing, figures, integrity audit, reviewer-grade assessment, submission checks, rebuttals), with `ccfa.yaml` as the project state. Routes: `full-paper` (a direction or an idea to a submission-ready paper), `manuscript-improvement` (an existing manuscript: diagnosis, revision, audit, re-review), `post-review-response` (reviews are in: revision ledger, response, revision), `open` (any single CCFA task, no stages).

Other installed modes appear in `research_project` action modes with their own summaries.

## When to suggest a mode

Stay in the general mode for bounded work: a paragraph, a figure, a compile, a literature search, a review of one section, a question about the data.

Suggest a mode when the user wants a whole paper carried through a method — from a spark, a proposal or finished results to a submittable PDF — or asks for one of a method's specialist tasks. spark-to-paper fits carrying one idea or result set straight to a compiled paper; ccfa fits working toward a CCF-A venue with reviewer-grade review, an existing manuscript to strengthen, or reviews to answer. Pick the route from what exists, not from what the user calls it: for spark-to-paper, measured results mean `data`, a structured proposal `proposal`, a line or a sketch `idea`; for ccfa, a manuscript means `manuscript-improvement`, received reviews `post-review-response`, one bounded task `open`.

## Switching

`research_project` action set-mode with the mode, the route and a one-line reason.

- `checkpoints`: ask first with `ask_user_question` (your recommendation first, then the alternatives), then record-decision with the answer and decidedBy user.
- `automatic`: switch, then record-decision with your reason.

Switching never loses files, sources, runs or decisions. It changes which skills you have and which phases the check reports. After switching, read `research_project` current again and load the skills it names.
