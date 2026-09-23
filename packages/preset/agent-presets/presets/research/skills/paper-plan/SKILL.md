---
name: paper-plan
description: Use to plan the paper before writing it — title, contributions, notation, the experiment design and a per-section plan with word targets — written to outline.md.
---

# Planning the paper

Output: `outline.md`. Writing goes faster and stays consistent when these decisions are made once, here.

## Contents of outline.md

1. **Title** — specific, at most ~12 words; the key technique and the task.
2. **Contributions** — the (at most three) from `idea.md`, sharpened to what the paper will show.
3. **Notation and terms** — every symbol and every named component, defined once; use exactly these names everywhere, including figures.
4. **Experiment design** — datasets (with splits and leakage precautions), baselines (with why each is included), metrics (with direction: higher/lower is better), ablations (one per design choice worth defending), seeds, hardware and a rough compute estimate. In from-results mode, describe the experiments that were actually run, from the data.
5. **Result tables and figures** — each planned table (rows, columns, metric) and figure (what it shows, what data draws it). In paper-first mode these are the placeholders the draft will carry.
6. **Section plan** — for each section: its job in one sentence, the claims it makes, the citations it needs, and a word target.

## Word targets (adjust to the venue)

| Section | Share |
|---|---|
| Abstract | 150–250 words |
| Introduction | ~15% |
| Related work | ~12% |
| Method | ~30% |
| Experiments / results | ~30% |
| Discussion, limitations, conclusion | ~13% |

## Venue

Ask which venue if it is not known (checkpoint autonomy) or choose the most fitting one and record it (automatic). Get its official template with `research_artifact` import-template when the user supplies it or it can be downloaded; the check warns while the paper uses a generic class.

## Done when

`outline.md` exists and names every table and figure the paper will contain.
