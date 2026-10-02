---
name: research-knowledge
description: Use in any research mode to find related research patterns, compare a claim with prior work, or build and inspect a project knowledge graph.
---

# Research knowledge graph

The same graph serves general research, CCF and Spark to Paper. Use it when a task benefits from related mechanisms, prior-work comparison or a corpus map; a mode switch does not create a separate graph.

## Retrieval and comparison

Run `research_knowledge` `graph-status` to inspect available sources. `recall` takes a search-friendly English query and returns patterns, exemplar papers and the ranking basis. Verify the original papers before treating them as evidence. `graph-view` shows recorded pattern, domain and paper relationships; use its pattern id to inspect related papers.

For novelty comparison, send `novelty` with `claim` and optional `references: [{title, text, url}]`. Supply verified abstracts or source passages. No Spark files are required. Existing Spark projects may instead pass `story` and use their `retrieved_papers.json`. Similarity is a retrieval signal, not proof of novelty. Inspect the closest work and report the evidence coverage.

## The person's marks and their map

The person marks papers and patterns on the Domain map as relevant (pin) or not relevant (irrelevant); you may mark too, on their request or with a reason you state. `recall` follows the marks: pinned results come first, irrelevant ones leave the results and are listed under `annotations.skipped` with the reason, nearby results move a few places, and each result carries `why`. Tell the person which marks shaped a recall (`annotations.applied`). `marks` lists them and says when the person paused them; then `recall` applies none and its note says so, and you rank by the graph alone. Only the person turns that switch. The person's marks win over yours; `unmark {id}` removes one.

The Domain map places the research's idea from your latest `recall`, so recall with an English query that states the idea; a brief written in another language is not placed until you do. The map shows distances only where papers are near each other, and its sparse areas say where the drawing holds few papers, not that nobody has worked there; never report one as an unexplored topic.

With no embedding endpoint or a failed endpoint, retrieval and clustering use words and report that basis. If a graph is unavailable, continue with the healthy sources and literature search. If the plugin or tool is absent, use `research_evidence` and web search; do not repeatedly call a missing tool, claim that the graph was consulted or stop the research workflow.

## Naming results in your reply

Write a pattern, paper, entity or relation that a call returned as a Markdown link with the `kg:` scheme, such as `[MoBA](kg:ai:paper:42)`. The person sees a chip that opens the item in the graph beside the conversation, struck through when they marked it not relevant. A `recall` result carries each item's `link`. A mark's link is `kg:` and its `id`. A relation's link is `kg:` and the id in brackets from `relations-neighbourhood` or `relations-paths`; an entity's id is the `<from>` or `<to>` part of `<kind>:<from>><to>`. Use only ids that a call returned in this conversation, and never invent or edit one. Any other link shows as plain text, so write a name you did not read in a result without a link. Keep the link text short: the item's name, or `A —kind→ B` for a relation.

## Relations of methods, tasks, datasets and papers

The research keeps its own relation graph: which method extends or beats another, which method was applied to a task or evaluated on a dataset, which paper introduces what. Read before you propose: `relations-neighbourhood` lists the relations around a method, task, dataset, metric or paper with the source of each, `relations-paths` explains how two of them connect, and `relations-suggestions` lists entities that may be one. Propose with `relations-propose`, a few relations at a time, when a source you imported states them.

Quote the source's own words. Search the evidence (`research_evidence` `search-evidence`) for the passage and copy one or two sentences of it, with the evidence id and revision it returned; the quotation must itself name both ends of the relation, by name or by an acronym the source defines, and must say how they relate. Do not paraphrase, and do not quote a sentence that names only one end. The tool's description states the whole rule; a refusal says which part failed, and a quotation that stays refused means the source does not state the relation, so leave it out. A proposal is recorded at once and the person can reject it, so propose only what the source says. Reject a relation you find wrong with `relations-reject` and a reason; a relation the person rejected stays rejected. You cannot merge entities: tell the person which suggested ones may be one.

`relations-gaps` shows methods against tasks, datasets or settings as the project's own literature covers them. `absent` means no imported paper reports the pair; `uncovered` means the imported papers do not name the method or the column at all. Neither says anything about work outside the project: never write that nobody has tested a pair or that the field has a gap. Search the literature, import what you find, and read the matrix again before you draw a conclusion.

## Build a project graph

Use the built-in graph when it covers the topic. For another field or a supplied corpus:

1. Collect verified papers from project evidence, literature search or a supplied corpus. Preserve title, identifier, URL, abstract and coverage. Do not invent missing abstracts.
2. Write project-relative `papers.jsonl`, one record per paper: `paper_id`, `title`, `url`, `domain`, `base_problem`, `solution_pattern`, `story`, `idea`, `application`, `sub_domains`. Extract the problem and mechanism from the paper. The story expresses the transferable reasoning behind the work rather than merely summarizing it.
3. Call `build-graph` with `papers` and `domain`. It accepts 3 to 2000 extracted papers. The result gives clusters, exemplars, coherence, rejected records and the embedding or term-weight basis. Inspect these before naming clusters.
4. Write `cluster_meta.json` keyed by cluster id, with `name`, `summary`, `llm_enhanced_summary`, `tier` (A, B or C). Use specific three-to-six-word research angles, not generic labels such as method, framework, model, approach, network, system, technique, learning, based, novel or general. Size alone does not establish coherence.
5. Call `name-patterns` with the names file, fix reported validation issues, then inspect the result with `graph-view` using source `project`. Existing project graph paths remain `.research/kg/graph.json` and `.research/kg/clusters.json`.

Update a graph by rebuilding from the revised corpus and naming the resulting clusters. Keep the original corpus and source identifiers so a relation can be checked against its papers. Plugin disablement preserves these files.
