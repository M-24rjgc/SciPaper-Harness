---
name: ts-paper-review
description: Stage 5 of spark-to-paper — adversarial review before finalizing — isolated reviewers with verbatim quotes, skeptics who try to refute each issue, loop until dry, then fixes through refine and a re-check.
---

# Adversarial review

Adapted from spark-to-paper-skills `ts-paper-review` (MIT). The full upstream algorithm — the three reviewer lenses, the gatekeeper core, merge rules, the three refutation angles, the dry rule, triage and the log contract — is in `references/upstream.md`, and the reference implementation of the panel is `references/review_panel.workflow.js.md`. Read them and follow them. This page says how the tiers run here.

It runs by default after refine. Skip it only when the user explicitly asks for a quick draft, and record that in `logs/0_route.io.md`.

## Running the panel

1. Assemble the paper text from `sections/*.tex` and the abstract: headings, prose, table and figure captions. `resultsMode` comes from `template.json`.
2. Tier 2 is the normal path: the `subagent` tool gives each reviewer and each verifier its own context.
   - Per round, spawn the three lens reviewers in one message. Each prompt holds only the gatekeeper core, one lens, the venue profile, the mode note, the isolation rule and the paper text, and asks for the issue table as JSON. Every issue carries an exact verbatim `evidence_quote` (no quote, no issue) and a `close_criterion`.
   - Merge in your own context, and drop issues without a usable close criterion.
   - For each new candidate, spawn three verifier subagents in parallel (misreading / already-addressed / scope-or-severity). An issue is dropped when at least two refute it.
   - Repeat until a dry round (no new issue, or none survives), within the budget: lean `maxRounds 2, dryStop 1`, thorough `4, 2`.
3. Without subagents, run Tier 3 in context under the isolation discipline `references/upstream.md` describes.

## Triage, fix, re-check

- **fix now** (blocker, major, a cheap minor): hand each to ts-paper-refine in review-fix mode.
- **author-required** (new data, a design decision, a claim only the author can own): list it for the user; under checkpoints ask with `ask_user_question`.
- **drop**: record why.

After the fixes land, `research_check` scope `refine` must be clean again. Only then write the OUTPUT block of the log.

## Record it where the check reads it

- `reviews/review.md`: one line per issue — `- [ ] [major] I-03 method: <summary>` while open, `- [x] …` once its close criterion holds. The `review` check fails on an open blocker or major and warns when the review is older than the manuscript.
- `logs/5_review.io.md`:
  - INPUT: text size, resultsMode, knobs, the tier that ran.
  - DECISIONS: `id | severity | section | evidence_quote | close_criterion | verdict | what the fix changed`, plus rounds, refuted and dropped counts.
  - OUTPUT: the post-fix check result and its time, and the author-required items.

## Done when

The review phase of `research_check` is clean: `reviews/review.md` is newer than the manuscript, has no open blocker or major, and the log exists.
