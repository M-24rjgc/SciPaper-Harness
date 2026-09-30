---
name: ccf-literature-monitor
description: Watch arXiv, OpenReview, proceedings, labs and named competitors for new papers that overlap the user's idea or paper, and report RELAX, RESEARCH or FOLLOW-UP signals. Use for 最新论文, recent similar ideas, competitor tracking and venue watch. Deep retrieval belongs to ccf-literature-searcher.
---

# CCF Literature Monitor

Adapted from CCFA-Skills `ccf-literature-monitor` (MIT). The upstream skill — six modes, the workflow and the monitoring report — is in `references/upstream.md`, with `monitoring-workflow.md` and `report-template.md` beside it. Follow it; this page says how it runs here.

## Scan

1. Read `ccfa.yaml` for the idea, venue, claims, `tracked_competitors` and `watch_queries`.
2. Fix an explicit date window; for "latest", "recent" or "this week", check today's date first.
3. Scan with public-safe queries: `research_evidence` literature-search with provider arxiv (and openalex for venues), `web_search` and `web_fetch` for OpenReview, Semantic Scholar, DBLP, accepted-paper lists, lab and project pages.
4. Classify each overlap by problem, mechanism, evidence, benchmark, dataset, claim and positioning, with the evidence basis you actually read.

## Report

Write the upstream monitoring report to `ccfa-workfiles/literature/<watch-topic>/` — update a one-time scan in place; keep dated observations only for a recurring watch. Propose `ccfa.yaml` monitoring-field updates rather than writing them unless the user asks you to persist them.

A report is not a scheduler: claim ongoing monitoring only when a scheduled job actually exists. An empty scan is not proof of novelty.
