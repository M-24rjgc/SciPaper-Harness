---
name: ts-paper-figure
description: Stage 6 of spark-to-paper — fill every figure placeholder — results plots from real data by script, every other figure designed, grounded on a top-venue main figure, rendered with the image model, critiqued at least twice, then redrawn as an editable vector figure.
---

# Figures

Adapted from spark-to-paper-skills `ts-paper-figure` (MIT). The full upstream method — routing by section, the design blueprint, wiring the figure from the equations, grounding, the four critique dimensions and their red lines, the refine loop, the manifest and the trace — is in `references/upstream.md`; read it and follow it. This page says how each step runs with the research tools.

## With the research tools

| Upstream step | Do it with |
|---|---|
| `gen_image.py` and `TS_FIG_*` keys (gpt-image-2) | `research_media` generate-image — the image endpoint configured in the research settings (gpt-image-2 by default); `size` 1536x1024, `quality` high for final renders, `references` for the grounding image. No key in chat: if generation reports no credential, ask the user to add the key in the settings (checkpoints) or skip the free-form figures and log it |
| Official PaperBanana pipeline | not used: the distilled loop below is the Visualizer and you are Planner, Stylist and Critic |
| WebSearch + `fetch_reference_figures.py` (grounding) | find the on-topic top-venue paper with `research_evidence` literature-search or the web search tool, then `research_media` fetch-reference-figures with its arXiv id and the figure label; look at the saved candidates with `read_image` |
| Read the PNG (critique) | `read_image` on the render |
| `plot_results.py` (results plots, data route only) | `research_artifact` run-script `plot-results` with `--script figures/<label>.plot.py --out figures/<label>.png`; the script ends with `finalize(fig, OUT)` so a vector PDF is written beside the PNG |
| ts-figure-svg redraw, `audit_svg.py`, `svg_to_pdf.py` | the ts-figure-svg skill, with `research_media` audit-svg and export-figure |
| DrawAI hybrid fallback | not available; if the redraw cannot converge, keep the approved PNG and log it — never a flat hand-drawn diagram |

## Per placeholder, in short

1. Classify and route by section: a real-data results plot in the results section (data route only) goes to `plot-results`; every other figure — architecture, pipeline, concept, qualitative — goes through the image model. In proposal mode remove any results plot placeholder; never draw fabricated results.
2. Design the figure concretely and write the prompt to `figures/<label>.prompt.txt` (generate-image also saves the prompt it used). Wire each shown symbol from the module whose equation defines it.
3. Ground it: fetch the main figure of an on-topic top-venue paper and pass the chosen image as `references`. Grounding is mandatory for schematic types; if a genuine multi-query search finds none, stop and tell the user.
4. Render with generate-image, one distinct file per round (`figures/<label>_vN.png`).
5. Critique each render with `read_image` on faithfulness (including against the equations), conciseness, readability, aesthetics and richness. Run at least two rounds and write each round's observed change to `figures/repair_logs/<label>.log`.
6. Redraw the approved render as an editable SVG with ts-figure-svg (at least four audited rounds), export the vector PDF, keep the PNG.
7. Insert `\includegraphics[width=\columnwidth]{figures/<label>}` (extension-less) in place of the `\fbox{\rule…}` token, and append the figure to `figures/figures.manifest.json` with `label`, `type`, `engine` (`image-model`, or `matplotlib` for results plots), `reference_used`, `grounding` (`image-cond`), `critic_rounds`, and — after the redraw — `svg_redraw: true`, `svg_rounds`, `svg_audit`.
8. Register each figure with `research_artifact` register-artifact (kind `figure`; a results plot records its data evidence and plot script as inputs).

## Done when

The figures phase of `research_check` is clean:
- `vector-figures`: every figure has its file, and every converted figure has an editable SVG and a PDF;
- `figure-critique`: engines, grounding, critique rounds, SVG rounds and passing audits;
- the base `figures` check.

Write `logs/6_figure.io.md` as `references/upstream.md` specifies.
