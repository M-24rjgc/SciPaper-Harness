---
name: ccf-literature-searcher
description: Find and verify external literature, prior art, datasets, benchmarks and citation candidates — closest-work clusters, opportunity maps and a search folder. Use for 文献检索, 相关工作, benchmark搜索. Recurring recent-paper watch belongs to ccf-literature-monitor; auditing existing citations to ccf-integrity-auditor.
---

# CCF Literature Searcher

Adapted from CCFA-Skills `ccf-literature-searcher` (MIT). The upstream skill — exploratory, quick and standard breadth, the twelve-item mandatory checklist, paper types and scoring, the folder layout and the output contracts — is in `references/upstream.md`, with `search-and-scoring.md` and `report-template.md` beside it. Follow it; this page says how it runs here.

## Retrieval

- **Queries** are public-safe (`../ccf-common/references/privacy-and-evidence.md`); never paste private draft text into a search. MDPI and other policy-excluded sources are never searched, cited or listed.
- **Discovery:** `research_evidence` literature-search (providers crossref, openalex, arxiv) and `web_search` for DBLP, Semantic Scholar, OpenReview, ACL Anthology, CVF, PMLR, ACM, IEEE and USENIX pages. `research_knowledge` recall adds the closest research patterns and their exemplar papers from the built-in graph — leads to verify, never citations on their own.
- **Verification:** read the paper's primary page or PDF (`web_fetch`), not a snippet. Every paper the paper will cite is imported with `research_evidence` literature-import, which re-fetches the record by its identifier and returns verified BibTeX; an open-access PDF worth quoting can be imported as evidence for page-level quotes.
- Deduplicate by DOI, arXiv id and normalized title before deeper reading.

## Output

Write the folder when the work needs reusable output — in a CCFA route it does:

```text
ccfa-workfiles/literature/<topic-slug>/
  papers.md          # the screened table: venue/year, source status, paper type, relevance, stable link
  papers.csv         # only when structured reuse is needed
  search-notes.md    # only when queries and coverage must persist
  idea-grounding.md  # when the search feeds ccf-idea-optimizer
```

Update an existing folder in place and store the search date inside the report. Return the standard or quick contract of `references/upstream.md` in your reply, and hand off in the shape it lists: clusters and gaps to the writer, the grounding packet to the optimizer, datasets and baselines to the experiment designer, missing related work to the reviewer.

## Done when

The literature phase of `research_check` shows `papers.md`; the paper cites only imported, verified records (the `cite` check).
