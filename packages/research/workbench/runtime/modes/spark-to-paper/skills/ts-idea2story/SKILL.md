---
name: ts-idea2story
description: Use on the idea route of spark-to-paper to turn a raw idea into a grounded 8-field research story (story.json, story_proposal.md, retrieved_papers.json) — recall patterns from the knowledge graph, search the closest work, reframe, critique, check novelty.
---

# From an idea to a research story

Adapted from spark-to-paper-skills `ts-idea2story` (MIT). The full upstream method — packaging the idea, three-axis reasoning over recalled patterns, intent-tagged search packs, reframe-not-combine, the blind comparative critique loop with its pass bar, the novelty bands and the `retrieved_papers.json` schema — is in `references/upstream.md`; read it and follow it. The idea is the protagonist; a recalled pattern is the tool it wields.

## With the research tools

| Upstream step | Do it with |
|---|---|
| `kg_recall.py --idea … --kg …` | `research_knowledge` recall with the retrieval query, `topK` 8, `path` `recall.json`. It searches the built-in AI graph and any project graph (ts-kg-build); the result says whether the score was semantic (an embedding endpoint is configured in the research settings) or lexical — treat lexical hits as weaker |
| WebSearch / WebFetch query packs | `research_evidence` literature-search (crossref, openalex, arxiv) for each intent pack — core method, task setting, contrast, evaluation, plus the literal idea — and the web search tool where it helps. Import the closest two to four papers with literature-import; they seed the citations |
| `novelty_check.py <workdir>` | `research_knowledge` novelty: it compares `story.json` with the `retrieved_papers.json` abstracts and the recalled exemplars and always writes `novelty_report.json`. On a semantic basis act on the bands (≥ 0.88 pivot, ≥ 0.82 sharpen, at most two pivots); on a lexical basis it lists the closest works and you judge |
| `story_lint.py <workdir>` | `research_check` scope `story` (the `story-lint` gate) |

## Steps, in short

1. Write `idea_brief.json` — motivation, problem, stated and inferred assumptions kept apart, constraints, an English retrieval query.
2. Recall, then reason over the candidates in one pass on stability, novelty and domain distance.
3. Search, and record every real paper in `retrieved_papers.json` — never an invented paper or abstract (`abstract_source: "missing"` when there is none).
4. Pick a stable near-domain seed pattern; keep novel and far ones in reserve.
5. Write the eight fields — reframe, never combine; a title that names the insight; forward-looking plans and claims with no numbers.
6. Critique blind against exemplar stories and refine, at most three rounds, keeping the global best.
7. Run novelty, write `story.json` and `story_proposal.md`, and make the story phase of `research_check` clean.

## Then

With checkpoints autonomy, ask the user to confirm the story (`ask_user_question`, your recommendation first) and record-decision; with automatic, record the decision and why. Write `logs/idea2story.io.md` as `references/upstream.md` specifies, then hand `story_proposal.md` to ts-paper-plan.
