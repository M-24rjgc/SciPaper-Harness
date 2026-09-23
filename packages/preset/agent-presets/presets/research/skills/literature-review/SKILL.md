---
name: literature-review
description: Use to find, verify and cite related work — building the bibliography from real, fully specified papers and placing each in the section it supports. Never invent a citation.
---

# Literature: real papers only

Output: a bibliography file (e.g. `paper/refs.bib`) whose every cited entry came from a scholarly provider, and notes on which work supports which section.

## Steps

1. **Seed** from the user's references and the works found while developing the idea. Import any user PDFs with `research_evidence` import so their text is quotable.
2. **Search broadly**: several `literature-search` queries per section need — the problem, each baseline, each technique the method uses, each dataset and metric. Use all three providers; arxiv for recent preprints, crossref for published versions.
3. **Triage by abstract.** Keep a paper only if you can say in one line what it contributes to *this* paper and which section cites it. Off-topic filler weakens the paper.
4. **Import each kept paper** with `literature-import` (pass the search result item unchanged). It re-fetches the record by DOI/arXiv id and returns verified BibTeX — paste that BibTeX into the bibliography. Prefer the published version over the preprint when both exist.
5. **Cite by key** in the text. When a claim rests on a specific statement in a source you have the text of, link it with a `claim` and an exact quote at its locator.

A typical full paper cites 30–50 works; a short paper fewer. Coverage matters more than count: every baseline, dataset and borrowed technique is cited where it first appears.

## Done when

`research_check` with scope `cite` is clean: every `\cite` key has an entry; every cited entry has author, title, year and a venue/DOI/URL. Warnings name entries not verified against a provider — import those or replace them.

## Never

- Never write a BibTeX entry from memory or guess a DOI, volume or page range.
- Never cite a paper you only know by title for a claim about its content; read at least the abstract.
- If a needed reference cannot be found, write `\tbd{citation: <what is needed>}` and tell the user.
