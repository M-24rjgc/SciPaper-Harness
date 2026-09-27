---
name: latex-compile-and-fix
description: Use to compile the paper to PDF and fix LaTeX errors and warnings — undefined references, missing packages, overfull boxes — without breaking the text.
---

# Compile and fix

`research_artifact` compile `{engine}` builds the PDF from the main `.tex` (pass `path` if there are several). It runs LaTeX, BibTeX/Biber and the reruns; missing `.sty/.cls/.bst` files of the managed TeX distribution are installed automatically. Use `xelatex` for Chinese or other non-Latin text, otherwise `pdflatex` unless the template says otherwise.

## Reading the result

- "PDF built" — success; the diagnostics list warnings (undefined references/citations, overfull boxes).
- "No PDF was produced" — a hard error; read the first `!` line in the diagnostics and the log path it names.

## Fixing

Fix the **first** error first; later ones are often consequences.

| Symptom | Usual fix |
|---|---|
| `Undefined control sequence` | missing package or a typo in the macro |
| `File 'x.sty' not found` (persisting) | the package is not in TeX Live under that name — use an alternative |
| `Missing $ inserted` | math outside math mode (`_`, `^`, `\alpha` in text) |
| `Citation 'k' undefined` | key missing from the `.bib` (run `research_check` scope `cite`) |
| `Reference 'fig:x' undefined` | missing or misspelled `\label` |
| `Overfull \hbox` | long word/URL/formula: rephrase, `\url{}`, break the equation, resize the table |

At most three attempts per error; if the error count rises, undo your last change and rethink. Never delete content to make an error go away.

## Done when

The compile produces a PDF and `research_check` scope `compile` is clean (the latest compile matches the current sources). Then look at the pages: `visual-self-review`.
