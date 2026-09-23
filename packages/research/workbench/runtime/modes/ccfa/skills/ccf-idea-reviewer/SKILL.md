---
name: ccf-idea-reviewer
description: Judge a research idea concept-only — problem importance, novelty against closest work, insight, mechanism coherence, elegance and audience fit — with a weighted scorecard and a verdict. Use for 想法评审, 靠谱吗, 值得做吗, even when a full PDF is given for the core idea. Manuscript evidence and writing review belong to ccf-paper-reviewer.
---

# CCF Idea Reviewer

Adapted from CCFA-Skills `ccf-idea-reviewer` (MIT). The upstream skill — concept-only scope, the seven-step workflow and the report contract — is in `references/upstream.md`, with `strict-idea-review.md` (report structure, 12 detailed or 5 brief sections), `rubric.md` and `calibration.md` (six weighted dimensions, verdict thresholds), `expert-panel.md` and `source-notes.md` beside it. Follow it; this page says how it runs here.

## Review

1. Normalize the idea to problem → gap → insight → mechanism. Do not ask for experiments; do not grade missing results.
2. **Novelty grounding.** `research_knowledge` recall with the idea's core claim as an English query gives the closest research patterns and their exemplar papers from the built-in graph. Inspect each candidate overlap at its primary source (`web_fetch`, or `research_evidence` import) before claiming it; record coverage as searched, partially searched, supplied-only or unsearched. Missing closest-work evidence goes to ccf-literature-searcher first.
3. **Perspectives.** For a standard review, the `subagent` tool gives each perspective of `expert-panel.md` its own context: give each only the idea card, its role and the rubric, then merge duplicate issues under stable IDs. Without subagents, label the perspectives as one reviewer's simulation.
4. **Scores.** Weighted score = Σ(score × weight) / Σ(assessed weights), with the weights of `rubric.md`; verdict `accept-to-develop`, `revise`, `pivot-with-rescue-route`, `abandon` or `needs-literature-search`. `abandon` needs the reason no meaningful reformulation remains.

## Output

A user-requested review follows `strict-idea-review.md` in full by default. In a CCFA route, save it beside the card as `ccfa-workfiles/ideas/<idea>/idea-review.md` and update it in place on re-review. A bounded check for ccf-idea-optimizer returns findings to it without a separate report.
