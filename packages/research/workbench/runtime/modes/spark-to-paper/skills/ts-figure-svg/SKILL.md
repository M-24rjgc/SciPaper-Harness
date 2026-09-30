---
name: ts-figure-svg
description: Use in spark-to-paper to turn an approved figure render into a native, editable SVG — learn its design language, redraw it from the paper's facts, repair it over at least four audited rounds, then export a vector PDF with embedded fonts.
---

# Design language in, native SVG out

Adapted from spark-to-paper-skills `ts-figure-svg` (PaperBanana+, MIT). The full upstream method — the figure brief, choosing among candidates, the style sheet, the drawing non-negotiables, the repair loop and page-level acceptance — is in `references/upstream.md`, and the defect catalogue is `references/svg-craft.md`. Read both before drawing and follow them. This page says how each step runs with the research tools.

Two rules never change: never trace the pixels (a traced figure is still blurry and editable by nobody), and never take the render's logic (style from the render, content from the paper).

## Stages with the research tools

0. **Brief.** Write `figures/work/<label>.brief.md` with the five sections `references/upstream.md` gives (reader question, caption intent, scientific facts to preserve, must-not-appear, visual design with canvas and type-size floors). Compile the paper once first and note its page count and warnings.
1. **Candidates.** The approved renders come from ts-paper-figure (`research_media` generate-image). Look at each with `read_image` and choose by correctness, then reading speed, legibility at column width, tidiness, beauty. Record the choice and what you will deliberately not copy in `figures/work/<label>.design_selection.md`. Under checkpoints, show the user the candidates before drawing — the upstream skill treats candidate acceptance as a human decision.
2. **Style sheet, then round 1.** Write `figures/work/<label>.style.json` (palette and what each hue means, strokes, radii, type scale, spacing grid, arrow and icon idiom, layout skeleton). Draw `figures/work/round_01.svg` from the brief with real `rect/path/text/marker/g` elements, the Times New Roman font stack, sizes as classes, small fixed arrowheads (`markerUnits="userSpaceOnUse"`), connectors before nodes before text.
3. **Repair loop, at least four rounds, no upper bound while defects remain.** Each round:
   - snapshot `round_0N.svg`;
   - run `research_media` audit-svg on it with `save` true, which writes the JSON report to `figures/audit_logs/`;
   - run `research_media` export-figure, which returns previews at 1440 px and at the 480 px column width;
   - look at both previews with `read_image`;
   - append the observed change to `figures/repair_logs/<label>.log`.
   The audit catches overflow, overlapping text, shapes over labels, stroke-scaled or clipped arrowheads, dangling connectors, small type, font-fallback glyphs, CSS-cascade colour traps and traced path soup.
4. **Final files.** Copy the clean round to `figures/<label>.svg`; `research_media` export-figure writes `figures/<label>.pdf` with live text and embedded fonts. Insert it extension-less, compile, and look at the page with render-pages and `read_image`.

## Record

Update the figure's entry in `figures/figures.manifest.json`: `svg_redraw: true`, `svg_rounds` (at least 4), `svg_audit: "figures/audit_logs/<label>.audit.json"`. The `figure-critique` gate checks the round count, that the audit report passes, and that the repair log is not empty.

## Done when

The SVG passes its audit, the PDF carries live text, the figure reads at column width on the compiled page, and the manifest records the redraw.
