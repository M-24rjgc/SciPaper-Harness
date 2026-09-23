---
name: ts-idea2story
description: Use on the idea route of spark-to-paper to turn a bare idea into a structured research story (story.json) grounded in the closest existing work, before any planning or writing.
---

# From an idea to a research story

Output: `story.json` and `story_proposal.md` in the project root. The story is the input to the plan, and the first thing the user reviews.

## Steps

1. **Restate the idea** in one sentence, then name the problem it addresses in the terms a reviewer in that field would use.
2. **Find the closest work.** Run 3–6 `research_evidence` literature-search queries (crossref, openalex, arxiv) with different phrasings. Read the abstracts of the closest hits and keep the best in `retrieved_papers.json` (title, year, venue, identifier, abstract, why it is close). Import the closest two to four with literature-import — they seed the citations.
3. **Judge novelty honestly.** If the closest work already does it, say so and pivot to the nearest open variant — at most two pivots before you ask the user. Never pretend novelty.
4. **Write the story** (below).
5. **Check it** against the rules, fix, and write `story_proposal.md`: the same story as prose a reader can review in two minutes.

## story.json — eight fields

```json
{
  "title": "specific; at most 20 words",
  "abstract": "problem, gap, approach, what the evaluation will show — no numbers",
  "problem_framing": "the problem in the field's terms and why it matters",
  "gap_pattern": "what the closest work cannot do, assumes, or has not measured — one gap, cited",
  "solution": "the idea in a paragraph",
  "method_skeleton": "the method's components and how they connect; at least 12 words",
  "experiments_plan": "datasets, baselines, metrics, ablations; realistic for the compute available",
  "innovation_claims": ["at most three things the paper will deliver"]
}
```

## Rules the story must pass

- Every field is filled with real content — no "TBD", "N/A", "…", "placeholder" or lorem ipsum.
- No fabricated results. A story is written before anything is measured: no percentages, no "outperforms X by", no "state-of-the-art by", no "from 0.6 to 0.8", no "3× faster". A forecast must read as one ("we expect", "we will test whether").
- The gap is backed by the works you found, cited by title.

## Then

With `checkpoints` autonomy, ask the user to confirm the story (`ask_user_question`, recommendation first), then record-decision. With `automatic`, record the decision and your rationale. Log the stage in `logs/idea2story.io.md` (INPUT, DECISIONS, OUTPUT).
