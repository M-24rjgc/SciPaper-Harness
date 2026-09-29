---
name: research-knowledge
description: Use in any research mode to find related research patterns, compare a claim with prior work, or build and inspect a project knowledge graph.
---

# Research knowledge graph

The same graph serves general research, CCF and Spark to Paper. Use it when a task benefits from related mechanisms, prior-work comparison or a corpus map; a mode switch does not create a separate graph.

## Retrieval and comparison

Run `research_knowledge` `graph-status` to inspect available sources. `recall` takes a search-friendly English query and returns patterns, exemplar papers and the ranking basis. Verify the original papers before treating them as evidence. `graph-view` shows recorded pattern, domain and paper relationships; use its pattern id to inspect related papers.

For novelty comparison, send `novelty` with `claim` and optional `references: [{title, text, url}]`. Supply verified abstracts or source passages. No Spark files are required. Existing Spark projects may instead pass `story` and use their `retrieved_papers.json`. Similarity is a retrieval signal, not proof of novelty. Inspect the closest work and report the evidence coverage.

With no embedding endpoint or a failed endpoint, retrieval and clustering use words and report that basis. If a graph is unavailable, continue with the healthy sources and literature search. If the plugin or tool is absent, use `research_evidence` and web search; do not repeatedly call a missing tool, claim that the graph was consulted or stop the research workflow.

## Build a project graph

Use the built-in graph when it covers the topic. For another field or a supplied corpus:

1. Collect verified papers from project evidence, literature search or a supplied corpus. Preserve title, identifier, URL, abstract and coverage. Do not invent missing abstracts.
2. Write project-relative `papers.jsonl`, one record per paper: `paper_id`, `title`, `url`, `domain`, `base_problem`, `solution_pattern`, `story`, `idea`, `application`, `sub_domains`. Extract the problem and mechanism from the paper. The story expresses the transferable reasoning behind the work rather than merely summarizing it.
3. Call `build-graph` with `papers` and `domain`. It accepts 3 to 2000 extracted papers. The result gives clusters, exemplars, coherence, rejected records and the embedding or term-weight basis. Inspect these before naming clusters.
4. Write `cluster_meta.json` keyed by cluster id, with `name`, `summary`, `llm_enhanced_summary`, `tier` (A, B or C). Use specific three-to-six-word research angles, not generic labels such as method, framework, model, approach, network, system, technique, learning, based, novel or general. Size alone does not establish coherence.
5. Call `name-patterns` with the names file, fix reported validation issues, then inspect the result with `graph-view` using source `project`. Existing project graph paths remain `.research/kg/graph.json` and `.research/kg/clusters.json`.

Update a graph by rebuilding from the revised corpus and naming the resulting clusters. Keep the original corpus and source identifiers so a relation can be checked against its papers. Plugin disablement preserves these files.
