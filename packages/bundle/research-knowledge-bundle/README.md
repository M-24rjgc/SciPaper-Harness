---
description: "Shared research-pattern retrieval and visual knowledge graphs."
kind: "package-bundle"
---

# Research Knowledge Graph

English | [中文](README.zh.md)

## Summary

Optional SciPaper Harness bundle for shared research-pattern retrieval, claim comparison, project graph construction, and visual exploration. Its plugin page is listed under Research extensions.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Enabling the bundle provides `researchKnowledge`; research presets then register `research_knowledge` and the `research-knowledge` Skill. These methods are available in General, CCF and Spark to Paper. Disabling the bundle cancels graph work and removes its tool and Skill contributions without deleting project files under `.research/kg`.

Retrieval uses the bundled AI corpus and an optional project graph. An embedding endpoint adds semantic ranking; without one, lexical retrieval remains available. Claim comparison accepts claim/reference texts directly and retains compatibility with Spark to Paper's `story.json`.

The plugin page supports graph search, source/domain filters, node details and source-paper links. Project graph construction uses extracted `papers.jsonl` and agent-authored cluster names; the shared Skill describes the extraction and naming workflow. Embedding configuration is shared with research figure search, and API keys remain in the host credential store.

No runtime invariant companion is published because this package only selects the graph provider; the research service owns its lifecycle, cache, tools and project data invariants.

## Model Experience

### Shared knowledge retrieval

#### What the model sees

Enabled research presets expose the `research_knowledge` tool and the `research-knowledge` Skill in General, CCF and Spark to Paper. The tool returns structured pattern, paper, graph and claim-comparison results. Disabling the plugin removes those contributions from subsequent requests.

#### Token effect

Tool schemas, requested Skill content and returned retrieval results consume model context. The full bundled corpus is read locally and is not inserted into model requests.

#### KV Cache effect

Enabling or disabling the plugin changes the tool catalog and capability guidance in later requests. An unchanged plugin configuration keeps those contributions stable; query results still vary by request.

## Known Limitations and Deferred Work

- The bundled corpus covers AI research; other domains require a project graph built from extracted papers.
- Semantic ranking requires an embedding endpoint. Keyword retrieval remains available without one.
- Claim comparison is a retrieval aid and does not establish scientific novelty or validate paper claims.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
