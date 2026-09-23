---
name: ts-paper-data
description: Use in spark-to-paper when the paper is written from real measured results (the data route, or after experiments ran) — read the data, write results.facts.json by script, fill the tables with the real numbers in past tense, and draw the results plots in the house style.
---

# Write the paper from real results

Adapted from spark-to-paper-skills `ts-paper-data` (MIT). The full upstream method — the facts file, filling the result tables, the data-aware rules per section, the plot toolkit, the number audit and inline fusion — is in `references/upstream.md`, and the plot house style is `references/plot-style.md`. Read them and follow them. This page says how each step runs with the research tools.

It applies when `template.json` has `results_mode: "data_aware"`: on the `data` route from the start, and on the other routes once the experiments phase has collected results.

## With the research tools

| Upstream step | Do it with |
|---|---|
| Read the user's data (CSV, JSON, a pasted table, numbers in prose) | `research_evidence` import each result file as data evidence first, so every number has a registered source; numbers only in prose go into a small CSV you import the same way |
| Write `results.facts.json` | a script, never by hand: write `code/facts.py` that reads the imported files and prints the facts, run it with the shell, and import `results.facts.json` as data evidence too. The results-ingest skill says how to register the script as the producer |
| Fill the result tables | edit `sections/experiments.tex` directly, with the real numbers, `null` as `--` and `"TBD"` as `TBD` |
| `plot_results.py` + `plot_style.py` | `research_artifact` run-script `plot-results` with `--script code/plot_<label>.py --out figures/<label>.png`; the script ends with `finalize(fig, OUT)`, and a PNG and a vector PDF are written |
| `draft_lint.py` number audit | `research_check` scope `write`: `draft-lint` flags a decimal or percentage in the prose that is not in `results.facts.json`, and the base `numbers` check traces table numbers to data evidence |

## Rules that do not bend

- Every number comes from the user's data. A number that was not given is never written; a measured but unavailable metric is `"TBD"`, a cell never run is `null`.
- Past tense for what was measured; no "we expect" about results that exist.
- Fix a flagged number by correcting the prose, never by adding it to the facts file.
- A proposal that claimed more than the data shows now says what the data shows.
- A `null` or `TBD` value is a gap in a plot, never a point.

## Done when

`research_check` scope `write` has no `draft-lint` or `numbers` error, every results plot is registered with its data and script as inputs (`research_artifact` register-artifact, kind `figure`), and `logs/data.io.md` is written as `references/upstream.md` specifies.
