---
name: ccf-paper-to-exemplar
description: Distill supplied paper PDFs into reusable writing-exemplar cards — story pattern, abstract, introduction, method and evidence moves, citation patterns, reusable techniques and a do-not-copy boundary — with source attribution. Use for 范文卡片 and PDF-to-writing exemplars. Drafting belongs to ccf-paper-writer.
---

# Paper-to-Exemplar

Adapted from CCFA-Skills `ccf-paper-to-exemplar` (MIT). The upstream skill — the eight-step workflow and the writer handoff — is in `references/upstream.md`. Follow it; this page says how it runs here.

## Extract

`research_artifact` run-script pdf-to-card with the PDF (inside the project), `--output-dir ccfa-workfiles/exemplars/<paper>`, `--full-text` and `--full-text-dir ccfa-workfiles/exemplars/<paper>/cache`. It is the upstream `convert.py`, reading the PDF with the platform Python's pypdfium2 instead of pymupdf; it writes a card skeleton with `[ANALYZE]` placeholders (never overwriting an existing card) and the page-marked full text. For page-level quotes the PDF can also be imported with `research_evidence` import. Check the extraction's page markers; an empty extraction is not complete.

## Analyze

Read the full text in coherent sections, look at pages with read_image where equations, figures or reading order matter, and fill every heading of the card in place. Record the title, venue and year when verified, the source identity and page or section anchors. Apply `../ccf-paper-writer/references/prose-quality-guardrails.md` so the advice excludes defensive habits and hype. No `[ANALYZE]` or `[MANUAL]` placeholder may remain.

## Register

The built-in library under ccf-paper-writer is read-only. Registration puts the card in the project library: move the finished card to `ccfa-workfiles/exemplars/cards/<slug>.md` and add one line to `ccfa-workfiles/exemplars/index.md` (venue, year, use when), without duplicates; the extraction stays in the paper's `cache/`. A project default goes in the same index, marked default, only when the user asks for it.
