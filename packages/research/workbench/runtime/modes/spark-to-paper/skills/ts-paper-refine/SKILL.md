---
name: ts-paper-refine
description: Stage 4 of spark-to-paper — one holistic pass that right-sizes every section to the template's word bands, keeps terminology and claims coherent, scrubs AI tells, and closes single review issues in review-fix mode.
---

# Right-size and polish

Adapted from spark-to-paper-skills `ts-paper-refine` (MIT). The full upstream method — right-sizing toward the template's bands without over-compressing, coherence, the de-AI pass, the logic self-check, the data-aware branch and review-fix mode — is in `references/upstream.md`; read it and follow it. This page says how each step runs with the research tools.

## The full pass

1. Read the whole draft at once. Expand thin sections with real substance and trim only genuine bloat, toward the word bands in `template.json`.
2. Keep the blueprint's terminology everywhere; no contradictions between sections; the abstract and introduction say what the method and experiments actually say.
3. De-AI pass: turn bare-comma lists into connected prose, and remove the tell phrases and translationese `references/upstream.md` lists. The context-free phrases (it is worth noting, plays a crucial role, delve into, in order to …) must be gone — `draft-lint` fails on them; the context-dependent ones (em-dash abuse, connective stacks, not only … but also) are yours to judge.
4. Preserve every `\cite`, equation, `\ref`, label and `--` placeholder exactly; on the data route keep every real number consistent with `results.facts.json` and in past tense.
5. After each edit, re-read the passage for a contradiction, a silent renaming or broken English it introduced.

Then `research_check` scope `refine` (the upstream `draft-lint` and `citations-lint`) must be clean; `research_artifact` run-script `reflow-sections` restores one line per paragraph. Write `logs/4_refine.io.md` — INPUT (word counts before), DECISIONS (per-section changes), OUTPUT (word counts after, all in band).

## Review-fix mode

When ts-paper-review hands you one issue `{section, severity, evidence_quote, close_criterion}`, make the minimal edit to that section that makes the close criterion true — nothing else. A symbol the fix adds to an equation goes into the notation table in the same edit. Re-run `research_check` scope `refine`, append the fix (issue id, section, what changed) to `logs/5_review.io.md`, and return to the review.

## Done when

The refine phase is clean and the log is written. Hand over to ts-paper-review.
