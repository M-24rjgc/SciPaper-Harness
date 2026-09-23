---
name: ccf-visual-composer
description: Render and redesign CCF figures, visual tables and method or architecture diagrams from supplied content — a gpt-image-2 first pass, editable SVG or draw.io, vector PDF, render QA — preserving values and topology. Use for 绘图美化, 排版, 配色, GPT Image 2 generation and pure SVG. Experiment evidence design belongs to ccf-experiment-designer.
---

# CCF Visual Composer

Adapted from CCFA-Skills `ccf-visual-composer` (MIT). The upstream skill — destinations, the visual contract, nine modes with their references, the eight-step workflow — is in `references/upstream.md`, with its references beside it (visual contract, adaptive architecture style, architecture generation, paper vs presentation diagrams, reference layout, icons, figure-table layout, palettes, plot recipes, plot inspiration, editable PPTX, render QA). Follow it; this page says how it runs here.

## Method and architecture figures

1. Resolve the topology, labels and takeaway from the method's owner; missing topology is never invented.
2. **First pass, gpt-image-2** (upstream's default renderer): `research_media` generate-image with the full prompt — layout geometry, text inventory, typography (Times New Roman), palette — and up to four reference images. For published-paper style references, `research_media` fetch-reference-figures saves overview figures under `figures/refs/` to study, never to copy. The key is in the research settings; if it is missing, ask the user to add it there, and say so rather than substitute another backend.
3. **Editable figure.** Reconstruct the accepted draft as live text, shapes and typed connectors: an SVG (the method-diagram skill) or a draw.io file. Never embed the raster and call it editable.
4. **QA.** `research_media` audit-svg on the SVG (overflow, overlapping text, clipped arrowheads, dangling connectors, small type, glyphs outside Times, path soup); fix and re-audit until clean. Then export-figure writes the vector PDF with live text and 1440/480 px previews for read_image.
5. Register the figure (`research_artifact` register-artifact kind diagram) and include the PDF in the paper.

## Result plots

Numbers come from data files a script wrote (the figures-from-data skill). For the upstream recipes, `research_artifact` run-script plot-recipe `--list` shows them; write the recipe's arguments (rows or matrix from the real results, keys, title) to a JSON file with a script, then run-script plot-recipe `<recipe> --spec <file.json> --out figures/<name>.svg`, audit-svg and export-figure it. Register each plot with its data and script as inputs so the `figures` check can trace it.

## Tables and layout

Supplied values only; float order, caption placement and final-size type follow `figure-table-layout.md`. Look at the compiled pages (render-pages, read_image) after any figure change.

## Done when

The visuals phase of `research_check` is clean: an editable method figure exists, every included figure resolves, result plots record their data and script, and the pages were looked at.
