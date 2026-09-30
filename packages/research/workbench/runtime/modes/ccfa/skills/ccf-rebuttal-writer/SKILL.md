---
name: ccf-rebuttal-writer
description: Write CCF rebuttals, author responses, response letters and conservative resubmission plans, grounded in feasible changes and real evidence, with one revision ledger tracking every reviewer comment. Use for 审稿意见回复, rebuttal, revision ledger and 重投迁移. Ordinary manuscript writing belongs to ccf-paper-writer.
---

# CCF Rebuttal Writer

Adapted from CCFA-Skills `ccf-rebuttal-writer` (MIT). The upstream skill — rebuttal, revision-ledger, response-letter and resubmission modes, the workflow and the output contract — is in `references/upstream.md`, with `response-strategy.md`, `response-checklists.md`, `revision-ledger.md` and `tex-templates.md` beside it and the four TeX templates in `assets/templates/` (`default-general-common-reviewer.tex`, `reviewer-specific-response.tex`, `compact-response.tex`, `ac-focused-response.tex`). Follow them; this page says how they run here.

## The reviews

Import the reviews, meta-review and any AC message with `research_evidence` import, so every comment has a locator and a quote you can cite back. Resubmission is conservative: no new experiments and no bibliography changes unless the user authorizes them.

## The ledger

`reviews/revision-ledger.md` (or the path `ccfa.yaml` records), one Markdown table updated in place. The check reads the columns `comment_id`, `status` and `location` by name; keep the other columns of `revision-ledger.md` (source, versions, concern, response_claim, manuscript_action, owner_skill, origin, applies_to, affected_dimensions, comparative_score_effect, evidence, risk) or the compact twelve-column template.

- Status is `open`, `planned`, `drafted`, `done`, `blocked` or `accepted_limit` for revision work; `unresolved`, `partially_resolved`, `resolved` or `not_applicable` in a comparative review.
- `done` only when the manuscript location exists and the change is there; `accepted_limit` when the right answer is an acknowledged limitation.
- The response promises nothing the ledger lacks.

`research_check` scope `revision-ledger` checks the table: columns, unique IDs, valid statuses, a location for every done row — and lists every row that is not finished yet. That list is expected while the response is drafted; the revision phase closes when it is empty.

## The response

Draft it at `ccfa-workfiles/responses/<paper>/response.tex` (from a template in `assets/templates/`, compiled with `research_artifact` compile and read back) or `response.md`, in the order of `response-strategy.md`: quote, direct answer, evidence, deeper intent, the exact change or a transparent limitation. Keep the word budget. A planned experiment or promised edit stays planned in the text until it is done; after the revision, update the letter to what was actually changed and where.

## The revision

Manuscript changes go through ccf-paper-writer; authorized evidence work through ccf-experiment-designer; venue rules for a resubmission through ccf-submission-checker. Verify each change's location before marking its row done. Drafting a reply never authorizes posting or submitting it.
