---
name: ccf-integrity-auditor
description: Audit existing claims, numbers, terminology and citations against supplied or verified evidence — a claim-evidence matrix, numeric consistency, citation metadata and citation-context support — without repairing by invention. Use for 引用核验, claim审计, 数字一致性 and BibTeX checks. Full scientific review belongs to ccf-paper-reviewer.
---

# CCF Integrity Auditor

Adapted from CCFA-Skills `ccf-integrity-auditor` (MIT). The upstream skill — claim, numeric, citation and full audits, the workflow and the output contract — is in `references/upstream.md`. Follow it; this page says how it runs here.

## What the checks already establish

Start from `research_check`: `cite` (every cite key has an entry, entries are complete and verified against a scholarly provider), `numbers` (every decimal and percentage in results, tables, abstract and conclusion traces to collected metrics, imported data or code values), `claims` (claims linked to quotes stay consistent with their evidence), `placeholders`. Their findings are part of the audit, with file and line.

## What you add

1. **Claim-evidence matrix.** Each important claim: supported, partially supported, unsupported, overstated or unclear, with the evidence location (`research_evidence` search-evidence gives exact quotes and locators; link supported claims with `research_evidence` claim).
2. **Numbers.** Cross-check text, tables, figures, captions, abstract and conclusion. Deltas, ratios and rounding come from a script you run over the data, never from arithmetic in your head. Distinguish not comparable from inconsistent.
3. **Citations.** Identity through the primary record (literature-import re-fetches it) and context support through the cited paper itself — read the passage (`web_fetch`, or import the PDF). Keep metadata problems separate from context problems.

## Output

Write the audit to `ccfa-workfiles/checks/integrity/audit.md` in the upstream shape (mode, artifacts checked, claim-evidence matrix, numeric findings, citation metadata findings, citation-context findings, severity, safe edit suggestions, next owner, no-invention status), with exact locations. Update it in place on re-audit. An audit does not rewrite the manuscript: wording fixes go to ccf-paper-writer, figure problems to ccf-visual-composer.

## Done when

The integrity phase of `research_check` is clean: the audit exists and `cite`, `numbers`, `claims` and `placeholders` carry no errors.
