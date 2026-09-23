---
name: ts-paper-plan
description: Use in spark-to-paper to plan the paper before writing it — title, keywords, contributions, notation, sections with word targets, planned tables and figures — written to blueprint.json.
---

# Planning the paper

Output: `blueprint.json` in the project root (and, for the reader, `outline.md` with the same plan in prose). Writing stays fast and consistent when these decisions are made once, here.

## Inputs

The story (`story.json` / `story_proposal.md`) on the idea route, the user's proposal on the proposal route, or the proposal plus `results.facts.json` on the data route. On the data route, plan the experiments that were actually run, from the data — never the ones you wish had been.

## blueprint.json

```json
{
  "paper_title": "specific; the key technique and the task",
  "keywords": ["4–6, lowercase"],
  "contributions": ["the (at most three) contributions, sharpened to what the paper will show"],
  "notation": [{ "symbol": "x_t", "meaning": "…" }],
  "section_order": ["introduction", "related_work", "method", "experiments", "conclusion"],
  "sections": {
    "introduction": { "job": "…", "claims": ["…"], "citations_needed": ["…"], "target_words": [600, 800] }
  },
  "result_tables": [{ "id": "main", "rows": ["…"], "columns": ["…"], "metric": "…, higher is better" }],
  "figures": [{ "label": "arch", "type": "architecture", "shows": "…", "data": "none" }]
}
```

- **Notation and terms**: every symbol and named component is defined once; the same names are used everywhere, figures included.
- **Experiment design**, inside the experiments section plan: datasets (splits, leakage precautions), baselines (why each), metrics (direction), ablations (one per design choice worth defending), seeds, hardware and a rough compute estimate.
- **Planned tables and figures**: on the idea and proposal routes they are the placeholders the draft will carry (`--` cells). Plan at least one architecture figure.
- **Word targets** (adjust to the venue): abstract 150–250 words; introduction ~15%; related work ~12%; method ~30%; experiments ~30%; discussion, limitations and conclusion ~13%.

## Venue

Ask which venue if it is not known (checkpoints) or choose the most fitting one and record it (automatic). Bring its official template into the project with `research_artifact` import-template when the user supplies it or it can be downloaded; the check warns while the paper uses a generic class.

## Done when

`blueprint.json` exists, names every table and figure the paper will contain, and the plan phase of `research_check` is clean. Log the stage in `logs/1_plan.io.md` (INPUT, DECISIONS, OUTPUT).
