---
name: ts-paper-cite
description: Stage 2 of spark-to-paper — build a complete, real refs.bib and claims_map.json from verified literature, broad enough for the template's citation floor, never a stub or an invented entry.
---

# Real, complete citations

Adapted from spark-to-paper-skills `ts-paper-cite` (MIT). The full upstream method — search angles, triage by abstract, placement, coverage bands, the post-draft sweep — is in `references/upstream.md`; read it and follow it. This page says how each step runs with the research tools.

## Inputs and outputs

- In: the proposal or `story_proposal.md`, `blueprint.json`, `template.json` (its `citations` block sets the floor and the per-section bands), and `retrieved_papers.json` when idea2story ran.
- Out: `refs.bib` (complete entries only), `claims_map.json` (`{key: {claim, support_label, section}}`), `retrieval_plan.md` (the angles, kept and rejected counts), and `logs/2_cite.io.md`.

## With the research tools

| Upstream step | Do it with |
|---|---|
| WebSearch per angle | `research_evidence` literature-search (crossref, openalex, arxiv — try each for an angle), and the web search tool for venue pages and surveys |
| Read each candidate's abstract | the abstract literature-search returns; fetch the venue or arXiv page when it is missing |
| `doi2bib.py <doi>` to get complete BibTeX | `research_evidence` literature-import with the item: it re-fetches the record from its provider and returns verified BibTeX; paste that entry into `refs.bib` unchanged |
| `citations_lint.py` | `research_check` with scope `cite` (this stage) — it runs the upstream linter on `refs.bib` and `claims_map.json`; the full cite-to-section rules run from the write stage on |
| Opt-in `--resolve` DOI check | not needed: only imported, verified records go into `refs.bib` |

User-provided references come first; import each through literature-import so it is verified too.

## Rules that do not change

- Every entry has authors, year, a venue and a DOI, URL or arXiv id. A title-only `@misc` is forbidden; a paper you cannot verify is not cited.
- One key per real paper (`firstauthorYEARkeyword`, ASCII), reused everywhere.
- The floor (`citations.floor`, 40 for `ts_iieta`) is reached only by searching more broadly — more angles, surveys, the foundational work behind each component — never by padding.
- `support_label` is one of direct_core, same_line_support, context, baseline, dataset_metric, definition. If the honest label is off_topic, adjacent or weak, do not cite; soften or drop the claim.
- No citation in the abstract or in headings, and never a citation hung on a result the paper does not have.

## Done when

`research_check` with scope `cite` is clean: no incomplete or duplicate entry, `claims_map.json` present, and at least the floor's number of entries. After writing (stage 3) and refining (stage 4), `citations-lint` runs the full upstream rules — every `\cite` resolves, no orphan entries, every cited key justified in the section it is cited in, no evidence-bearing section without citations — so run the post-draft sweep then (see `references/upstream.md`).
