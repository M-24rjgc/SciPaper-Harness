---
description: "Shared research-pattern retrieval and visual knowledge graphs."
kind: "package-bundle"
---

# Research Knowledge Graph

English | [中文](README.zh.md)

## Summary

Optional SciPaper Harness bundle for shared research-pattern retrieval, claim comparison, project graph construction, visual exploration, a view of the evidence behind each conclusion of a research, a view of what earlier researches leave for the next one, and a graph of how the methods, tasks, datasets and papers of a research relate. Its plugin page is listed under Research extensions.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

The bundle mounts five plugins, each a row with its own switch on the plugin page. The Knowledge graph engine (`research-knowledge-provider`) provides `researchKnowledge`; research presets then register `research_knowledge` and the `research-knowledge` Skill in General, CCF and Spark to Paper, and the Knowledge tab gains its Catalog view. The Domain map (`research-knowledge-map`) provides `researchKnowledgeMap` and adds the Domain map view; it injects the engine, so it is off whenever the engine is, and it places the research's idea, imported literature, the agent's recalls and the person's marks over a map of the built-in graph's 29,240 papers. The Evidence graph (`research-knowledge-evidence`) provides `researchKnowledgeEvidence` and adds the My research view: the research question, each conclusion with the runs and literature behind it, and which conclusions have evidence, lack it or need re-checking. It reads only the project record and works without the engine. The Research memory (`research-knowledge-memory`) provides `researchKnowledgeMemory` and adds the Memory view: the literature, finished experiments, ready environments and venue templates of the researches on this computer, the failures and decisions they recorded, and a switch per kind for what a new research carries. It reads only the project records and works without the engine. The Relations (`research-knowledge-relations`) provides `researchKnowledgeRelations`: typed relations between the methods, tasks, datasets, metrics and papers of a research, each grounded in a quotation of an imported source or in a completed run, with neighbourhoods, paths between two entities and a gap matrix of methods against tasks, datasets or settings. It reads and writes only the project, in `.research/kg/relations.json`, and works without the engine. Its row takes `citationMaxAgeDays` (30) and `pauseMs` (120) for fetching reference lists from OpenAlex and Crossref.

Disabling a plugin cancels its work and removes its contributions and its view; a command of a disabled plugin fails with an error that names it. No project file is deleted, including those under `.research/kg`. Disabling the whole bundle disables all five rows.

Retrieval uses the bundled AI corpus and an optional project graph. An embedding endpoint adds semantic ranking; without one, lexical retrieval remains available. Claim comparison accepts claim/reference texts directly and retains compatibility with Spark to Paper's `story.json`.

The plugin page supports graph search, source/domain filters, node details and source-paper links. Project graph construction uses extracted `papers.jsonl` and agent-authored cluster names; the shared Skill describes the extraction and naming workflow. Embedding configuration is shared with research figure search, and API keys remain in the host credential store.

No runtime invariant companion is published because this package only selects the graph provider; the research service owns its lifecycle, cache, tools and project data invariants.

## Model Experience

### Shared knowledge retrieval

#### What the model sees

Enabled research presets expose the `research_knowledge` tool and the `research-knowledge` Skill in General, CCF and Spark to Paper. The tool returns structured pattern, paper, graph and claim-comparison results. Disabling the engine removes those contributions from subsequent requests. The Domain map and the Evidence graph add no tool or Skill; they serve the Knowledge tab only. The Research memory adds the read-only `memory` action to `research_project`, which returns the kinds the person lets new researches carry from the other researches, and fails naming the plugin while it is off. The Relations adds six actions to `research_knowledge`, which read the research's relation graph and propose and reject relations in it, and a section of the `research-knowledge` Skill; the tool description states the rule that a quotation must meet, and the actions fail naming the plugin while it is off. The agent receives text, one line per relation or hop, and never merges entities or fetches reference lists.

#### Token effect

Tool schemas, requested Skill content and returned retrieval results consume model context. The Relations' grounding rule and action descriptions add roughly a thousand tokens to every request that lists `research_knowledge`; a neighbourhood read returns at most 20 relations by default. The full bundled corpus is read locally and is not inserted into model requests.

#### KV Cache effect

Enabling or disabling the plugin changes the tool catalog and capability guidance in later requests. An unchanged plugin configuration keeps those contributions stable; query results still vary by request.

## Known Limitations and Deferred Work

- The bundled corpus covers AI research; other domains require a project graph built from extracted papers.
- Semantic ranking requires an embedding endpoint. Keyword retrieval remains available without one.
- Claim comparison is a retrieval aid and does not establish scientific novelty or validate paper claims.
- The Domain map draws the built-in AI graph only, as one 2-D layout of the papers: distances far apart say little, and the optional sparse-area layer marks where this drawing holds few papers, which is not evidence that a topic is unexplored. It places a research's idea from the agent's latest English recall, so a brief written in another language is not placed until the agent recalls.
- The Relations accepts a relation only when a quotation of an imported source states it under the rule in the tool description. That rule is lexical: it accepts a sentence that names both ends and a word of the relation without stating it, and refuses a relation stated by a pronoun or without such a word, and the cue words are English and Chinese only. The person rejects what is wrong and adds what is missing.
- The gap matrix speaks only of the project's own sources: `absent` means no imported paper reports a pair and `uncovered` that the sources do not name the method or the column, neither of which shows that nobody has tested it. Reference lists from OpenAlex cover recent papers poorly, so citation paths are missing where the literature is newest.
- The Evidence graph derives every status from the record's fields. A conclusion is expected to gain evidence from a run only when that run is in progress or finished without collected results, because the record does not tie a planned run to a claim.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
