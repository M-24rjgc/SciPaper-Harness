---
name: paper-review
description: Use to review the paper adversarially before calling a draft or the final paper done — isolated reviewer subagents, verification of each issue against the text, fixes, and repeat until a round finds nothing new. Writes reviews/review.md.
---

# Adversarial review

Self-review misses what the author believes. Isolated reviewers who did not write the paper find more.

## Round

1. **Spawn 2–3 reviewers** with the `subagent` tool, each with a distinct brief and no access to your reasoning — only the compiled PDF path / the `.tex` files and the plan (`blueprint.json` or `outline.md`):
   - *Methods reviewer*: correctness, missing assumptions, unjustified design choices, reproducibility.
   - *Experiments reviewer*: baselines, fairness of comparison, statistical support, claims beyond the evidence, missing ablations.
   - *Clarity reviewer*: structure, notation consistency, figures and tables, overclaiming language.
   Ask each for issues with a severity (blocker / major / minor) and a **verbatim quote** of the passage each issue concerns (this stops skimmed, generic comments).
2. **Verify** every issue yourself against the text: is the quote real, and is the criticism valid? Discard invalid ones, noting why.
3. **Fix** valid issues (through `paper-writing`), or mark them as needing the author (e.g. an experiment that cannot be run).
4. **Repeat** with fresh reviewers until a round produces no new valid blocker/major issue (usually 2–3 rounds).

## reviews/review.md

```
# Review — round N (<date>)
- [x] [major] Methods: "<quote>" — <issue> → fixed in §3.2
- [ ] [major] Experiments: "<quote>" — <issue> → needs author: <what>
- [x] [minor] Clarity: …
- (discarded) [major] …: quote not in the paper
```

The research check reads this file: unchecked `[blocker]`/`[major]` items are errors; a review older than the manuscript is a warning. Keep it current after changes.

## Done when

The latest round found no new valid blocker/major issue, and every remaining one is either fixed or explicitly left for the author with the reason.
