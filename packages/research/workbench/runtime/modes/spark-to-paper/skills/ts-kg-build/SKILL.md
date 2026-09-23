---
name: ts-kg-build
description: Use in spark-to-paper when the idea's field is outside the built-in AI knowledge graph — distil a paper corpus into reusable problem → solution → story patterns and build a project knowledge graph that recall and novelty read.
---

# Distil a corpus into a research-pattern graph

Adapted from spark-to-paper-skills `ts-kg-build` (MIT). The full upstream method — story-first extraction with its anti-summary rule, cluster naming with its banned words, tiers by size and coherence, the edge definitions and the integrity rules — is in `references/upstream.md`; read it and follow it. You do the reasoning (extraction, naming, summaries); `research_knowledge` does the math (vectors, clustering, graph assembly, validation).

First run `research_knowledge` graph-status. The platform ships a built-in graph distilled from the upstream AI corpus (patterns over tens of thousands of machine-learning papers). If the idea sits inside it, skip this skill and recall from it. Build a project graph only for another field or a corpus the user supplies.

## Steps

1. **Corpus.** `corpus.jsonl`, one paper per line (`paper_id`, `title`, `abstract`, `venue`, `year`, `doi` or `url`, optional reviews). Collect it with `research_evidence` literature-search, or take the user's file. Never fabricate an abstract.
2. **Extract** (you). For each paper write `base_problem`, `solution_pattern`, `story` (a reframe, never a summary), `application`, `idea`, `domain`, `sub_domains` into `papers.jsonl`, with the self-QC `references/upstream.md` gives.
3. **Cluster.** `research_knowledge` build-graph with `papers` = `papers.jsonl` and `domain`. It vectorizes the story-first text (story, base problem, solution pattern) — with the embedding endpoint from the research settings when one is configured, otherwise with term weights, and it says which — clusters it, and returns each cluster's coherence and exemplars. The clusters are kept under `.research/kg/`.
4. **Name** (you). From each cluster's exemplars write `cluster_meta.json`: `{cluster_id: {name, summary, llm_enhanced_summary, tier}}` — a three-to-six-word story angle without the banned generic words, tier by size and coherence together.
5. **Assemble.** `research_knowledge` name-patterns with `names` = `cluster_meta.json`. It builds the pattern, paper, idea and domain nodes and the `uses_pattern`, `in_domain`, `belongs_to` and `works_well_in` edges, validates them, and reports the counts. From then on recall and novelty read the project graph beside the built-in one.

## Done when

name-patterns reports a valid graph, and `logs/kg_build.io.md` records the corpus size, the vector basis, rejected extractions, cluster names with tiers and why, and the final counts.
