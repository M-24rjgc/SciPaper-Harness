---
name: idea-development
description: Use to turn a spark, a one-line idea or a rough sketch into a research idea worth a paper — the problem, why it matters, what is new, and a falsifiable question — written to idea.md.
---

# From a spark to an idea

Output: `idea.md` in the project root. It is the input to the plan and the first thing the user reviews.

## Steps

1. **Restate the spark** in one sentence, then name the problem it addresses in the terms a reviewer in that field would use.
2. **Check it is open.** Run 3–6 `research_evidence` literature-search queries (crossref, openalex, arxiv) with different phrasings. Read the abstracts of the closest hits. If the idea is already done, say so and propose the nearest open variant; do not pretend novelty.
3. **Find the gap**: what the closest work cannot do, assumes, or has not measured. One gap, stated precisely.
4. **Write the contributions** — at most three, each a thing the paper will deliver (a method, an analysis, a dataset, a result), not a promise of quality.
5. **Make it falsifiable**: the research question plus the observation that would show it wrong. Name the metric and the comparison (e.g. "beats X on Y by a margin larger than seed variance").
6. **Sketch the method** in a paragraph and the evaluation in a list: datasets, baselines, metrics, ablations. Keep it realistic for the compute available; ask if you do not know the compute.

## idea.md

```
# <working title>
Problem: …
Gap: … (cite the closest 2–4 works by title)
Contributions: 1. … 2. … 3. …
Question: … — falsified if …
Method sketch: …
Evaluation: datasets …, baselines …, metrics …, ablations …
Risks: what could make this fail, and what the paper says if it does
```

## Then

With `checkpoints` autonomy, ask the user to confirm the question and contributions (`ask_user_question`, recommendation first), then `record-decision`. With `automatic`, record the decision and your rationale. Import the closest works you found with literature-import — they seed the literature phase.
