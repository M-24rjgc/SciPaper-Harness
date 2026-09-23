---
name: paper-writing
description: Use to write or revise the LaTeX paper — section by section from outline.md, with result placeholders in paper-first mode and traced numbers once results exist, then a self-review and de-AI pass.
---

# Writing the paper

The manuscript lives in `paper/main.tex` (sections may be `\input` from `paper/sections/`), the bibliography in `paper/refs.bib`. Write with the ordinary file tools; the research check reads the files as they are.

## Before writing

Read `outline.md` and `idea.md`. Keep the notation table open: every symbol and component name is used exactly as defined there. If a venue template was imported (`template/`), use its document class.

## Section recipes

- **Abstract** — problem, gap, what you do, what you find (with the main number once it exists), why it matters. No citations.
- **Introduction** — the problem and why it matters; what existing work cannot do (cited); your approach in a sentence; the contributions as a short list; a pointer to the headline result.
- **Related work** — grouped by theme; for each group say how this paper differs. Cite only imported, verified works.
- **Method** — definitions, then the model/algorithm with equations and, when it helps, an algorithm box; the architecture figure early; every design choice justified or ablated. State assumptions and limitations plainly.
- **Experiments** — setup (datasets, baselines, metrics, implementation details, seeds, hardware), main results table, ablations, analysis. Report variance (mean ± std over seeds) when you have several runs.
- **Discussion / limitations / conclusion** — what the results do and do not show; honest limitations; no new claims.

## Numbers — the rule that matters most

- **paper-first, before experiments**: every result cell is `--`; result prose is `\tbd{what will go here}` (define `\newcommand{\tbd}[1]{\textcolor{red}{[TBD: #1]}}` in the preamble, with `xcolor`). Write the analysis forward-looking: "we evaluate…", "we expect…". Never write a plausible-looking number.
- **once results exist** (from-results, or after the experiments phase): every decimal and percentage in results, tables, the abstract and the conclusion must come from collected run metrics, imported data, or a script's output. Means, deltas, ratios and "x% better" come from a script that writes them to a file you import (see `results-ingest`), not from arithmetic in your head. Round consistently, as the data rounds.
- `research_check` scope `numbers` lists every number it cannot trace; `placeholders` lists what is still open.

## Revision pass (before calling a section done)

1. Right-size each section to its word target; cut repetition before cutting content.
2. Terms and notation consistent everywhere, figures included.
3. Every claim supported by a citation, an equation, or a result — or softened.
4. **De-AI pass**: remove filler and tells — "delve", "leverage", "pivotal", "crucial", "a testament to", "in the realm of", "it is worth noting", "furthermore/moreover" chains, stacked adjectives, empty summaries at section ends, symmetric "not only… but also" flourishes. Prefer plain verbs and concrete statements.
5. Compile (`latex-compile-and-fix`), look at the pages (`visual-self-review`).

## Done when

The phase's `research_check` is clean: in `draft`, structure, citations, figures, compile and numbers have no errors (placeholders allowed); in `results`/`write`, placeholders are gone too.
