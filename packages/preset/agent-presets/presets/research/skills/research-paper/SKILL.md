---
name: research-paper
description: Use whenever you work on a research project or the user asks for a paper, an idea developed into a paper, or a paper written from existing results. Routes the project to a mode, gives the phases and the skill for each, says when to ask the user and when you are done.
---

# Carrying a research project to a paper

You drive the work. The research service keeps the record (files, sources, runs, decisions) and reports checks; it never tells you what to do next and never refuses your work. This skill is how you decide.

## 1. Know where you are

Call `research_project` with action `current`. Read `mode`, `autonomy`, `phases` (from the last check), `decisions`, and the files, sources and runs on record. If `phases` is empty or stale, run `research_check` once to see what is open.

## 2. Route the project (only when mode is unset)

Classify what the user gave you — the brief, the files in the folder, what they said:

| Signal | Mode |
|---|---|
| Measured results exist: CSV/JSON/tables of numbers, logs of finished runs, "we got 0.62 on X" | `from-results` |
| An idea, a sketch, or a proposal without results | `paper-first` |
| A bounded task ("add a related-work paragraph", "fix the figure", "compile it") | `free` |

Call `set-mode` with the mode and a one-line reason naming the signal. With `checkpoints` autonomy, confirm the route with `ask_user_question` first, then `record-decision`. Switching modes later never loses anything; it only changes which phases the check reports.

## 3. Work the phases

A phase is done when `research_check` with that phase as scope is clean. Load the phase's skill before you start it.

**paper-first** — the complete method paper first, experiments second:

| Phase | Skill | Done when |
|---|---|---|
| idea | `idea-development` | `idea.md` states the problem, contributions and a falsifiable question |
| literature | `literature-review` | every citation resolves to a complete, verified entry |
| plan | `paper-plan` | `outline.md` (or the section skeleton) exists |
| draft | `paper-writing`, `method-diagram`, `latex-compile-and-fix`, `visual-self-review`, `paper-review` | the whole paper is written except results: `--` in result tables, `\tbd{}` in result prose; architecture diagram in; compiles; pages looked at |
| ◆ checkpoint | | see §4 — before spending compute |
| experiments | `running-experiments` | runs completed and collected |
| results | `figures-from-data`, `paper-writing` | no placeholders left; every number traces to a run or data; plots come from scripts |
| polish | `paper-review`, `visual-self-review` | review current with no open blocker/major; pages looked at since the last compile |
| submission | `submission-package` | `research_check` (scope all) clean; export |

**from-results** — the data exists; the paper is written from it:

| Phase | Skill | Done when |
|---|---|---|
| ingest | `results-ingest` | the results are imported as data evidence; derived numbers come from a script |
| plan | `paper-plan` | outline exists |
| literature | `literature-review` | citations resolve and are verified |
| write | `paper-writing`, `method-diagram` | full paper, every number traced, no placeholders |
| figures | `figures-from-data` | every figure exists; result plots record data and script |
| polish | `paper-review`, `visual-self-review`, `latex-compile-and-fix` | review current; pages looked at |
| submission | `submission-package` | check clean; export |

**free** — no phases. Do the task; run the relevant check (e.g. scope `cite` or `compile`) before saying it is done.

## 4. When to ask

Key decisions: the route (when you chose it), the research question, **◆ before running experiments** (what runs, how many, which GPUs, rough time), before the final export, a material change of method, results that contradict the hypothesis.

- `checkpoints`: ask each with `ask_user_question` — give your recommendation and the concrete options — then `record-decision` with their answer and `decidedBy: user`.
- `automatic`: decide, then `record-decision` with the decision and a one-sentence rationale. Keep going.
- Either way, ask when you are genuinely blocked: data you cannot find or generate, a missing credential, no GPU after trying, no venue template and none you can fetch. Say exactly what you need.

Do not ask about things you can find out by looking.

## 5. Keep going across rounds

When the user asks for the paper (not one edit), create a goal: objective "Complete the <mode> paper for <title>; done when research_check is clean". Each round: re-read `current`, pick the first unfinished phase, do it, check it. In checkpoint autonomy the goal waits at each `ask_user_question` and resumes when answered. Mark the goal complete only when `research_check` (scope all) is clean.

## 6. Done means

`research_check` (scope all) clean, the review current, the pages looked at, and an export made. Report: the PDF path, page count, sections, references, review outcome (issues found/closed/left for the author), and anything the author must still supply.

## Never

- Never state a number the data does not give, never invent a citation (see `paper-writing`, `literature-review`).
- Never mark a phase done with check errors outstanding, and never skip the review because it takes time.
- Never overwrite the user's edits blindly: the research tools keep every revision; read before rewriting a file someone else touched.
