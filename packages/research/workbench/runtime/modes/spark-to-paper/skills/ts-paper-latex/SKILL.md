---
name: ts-paper-latex
description: Stage 7 of spark-to-paper — assemble sections/*.tex, refs.bib and blueprint.json into main.tex in the venue template, compile it, fix compile errors with minimal syntax-only edits, and look at every page.
---

# Assemble and compile

Adapted from spark-to-paper-skills `ts-paper-latex` (MIT). The full upstream method — the template-driven assembly, the deterministic post-processes, the bounded fix loop, vector figure embedding and the front matter — is in `references/upstream.md`; read it and follow it. This stage never authors or alters content: no renaming, no filling result cells, only format, assembly and compile.

## With the research tools

| Upstream step | Do it with |
|---|---|
| `assemble_paper.py <workdir>` | `research_artifact` run-script `assemble-paper` — builds `main.tex` from `template.json`, `blueprint.json` and `sections/*.tex` and copies the template's style files and assets. Pass `--backup` as an extra argument on the first attempt only, which snapshots `sections/` to `sections.bak/` |
| `latexmk -pdf` inside the script | `research_artifact` compile (it reads the log, not the exit code) |
| Read `error_tail` | the compile result and `research_check` scope `latex` (`compile`, `cite`) |
| Page check | `research_artifact` render-pages, then `read_image` on every page (the visual-self-review skill) |
| `run_gates.py all` vector check | `research_check` scope `latex`, and the `vector-figures` gate from the figures phase |

## The fix loop

Up to about three attempts. For each compile error, make the minimal syntax-only fix in the offending `sections/*.tex` (close an unbalanced `$` or environment, escape a stray `& % # _`, pair `\begin`/`\end`, `1-10` → `1--10`), then run assemble-paper and compile again. Never change content, math, citations, labels or `--` placeholders. If the error count goes up, restore `sections/` from `sections.bak/` and report instead of thrashing. A missing figure file or a bad bounding box is a figure problem: go back to ts-paper-figure, never edit prose for it. The latex-compile-and-fix skill covers the common error classes.

## Templates

A venue's style files come from the venue's official kit or from the user, never hand-made. The bundled `ts_iieta` template is an unofficial demo style (`"official": false` in its `template.json`) — say so before anyone submits with it. With a real venue template, the ts-paper-plan stage has already put its `template.json`, `main.tex.tmpl` and style files in the project root, and assemble-paper uses those.

## Done when

The latex phase of `research_check` is clean — `compile` has no errors, `cite` has no unresolved citation, `structure` and `visual` pass — every page has been looked at, and `logs/7_latex.io.md` records each error and its fix plus the page count, with `logs/index.md` linking every stage's log.
