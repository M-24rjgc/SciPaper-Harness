---
name: ccf-submission-checker
description: Check CCF venue rules and the submission package — template, page accounting, anonymity, fonts, metadata, references, required forms, build logs and artifact reproducibility — against the current official rules, into one readiness record. Use for 投稿检查, 会议格式, page limits and artifact readiness. Polishing belongs to ccf-paper-writer.
---

# CCF Submission Checker

Adapted from CCFA-Skills `ccf-submission-checker` (MIT). The upstream skill — venue-format, package-check, artifact and full modes, the workflow and the output contract — is in `references/upstream.md`. Follow it; this page says how it runs here.

## Rules

Read `ccfa.yaml`, then the venue guide at `template/<venue>/GUIDE.md` (after apply-template). The guide gives the expected rules; the final decision needs the official page for the exact venue, year and track — open it with `web_fetch` and record its URL and today's date. ICLR 2027 carries year-specific template, page-budget and AI-use statement checks.

## Package

- **Build:** the latest `research_artifact` compile must be of the current sources and succeed; read its log, not the presence of a PDF.
- **Pages and layout:** render-pages and read_image every page; count pages the way the venue counts them (main text, references, appendix).
- **Anonymity:** author block, acknowledgments, self-citations, file metadata, and machine paths — `research_check` scope `path-privacy` scans the sources, `code/`, `submission/` and `artifact/` for local home paths.
- **Fonts and metadata:** embedded fonts, PDF title and author fields.
- **Artifact:** code, data, models, environment, seeds, hardware, licence, access and README for a reproducibility package.

## The record

Write `submission/checks.md` (or the path `ccfa.yaml` records), updated in place:

```markdown
Venue: <name, year, track>
Official rules: <url>
Checked: <YYYY-MM-DD>
Mode: venue-format | package-check | artifact | full

| Check | Status | Evidence | Fix |
| --- | --- | --- | --- |
| Page limit (9 pages main text) | pass | 8.7 pages in the compiled PDF |  |
```

Status is `pass`, `fail`, `not applicable` or `not verified`; a missing tool means not verified, never pass. `research_check` scope `submission-checks` lists every fail as an error, every not-verified item as a warning, and warns when the record predates the latest manuscript change. Hand fixes to their owners: text and page budget to ccf-paper-writer (compression when over the limit), floats and figure readability to ccf-visual-composer, reproducibility experiments to ccf-experiment-designer.

## Export

When the record has no fail, `research_artifact` export builds the archive (sources, PDF, data manifest, check report); the submission-package skill covers it. Never upload or submit anything because a readiness check was requested.

## Done when

The submission phase of `research_check` (every check and gate) is clean and the pages were looked at.
