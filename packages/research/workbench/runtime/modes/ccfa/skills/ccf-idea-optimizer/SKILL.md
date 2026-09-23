---
name: ccf-idea-optimizer
description: Develop or rescue a CCF research idea — a rough direction into a concrete problem, grounded gap, causal insight, mechanism and falsifiable evidence plan, as an idea card. Use for 想法打磨, idea development and direction rescue. A standalone judgment (靠谱吗, 值得做吗) belongs to ccf-idea-reviewer.
---

# CCF Idea Optimizer

Adapted from CCFA-Skills `ccf-idea-optimizer` (MIT). The upstream skill — exploratory, quick and standard modes, the nine-step workflow and the idea-card contract — is in `references/upstream.md`, with its references beside it (intake, frontier ideation, literature-grounded evolution, problem-method blueprint, venue adapters, minimum evidence design, research taste). Follow it; this page says how it runs here.

## Grounding

- **Built-in graph first.** `research_knowledge` recall with the idea as an English query returns the closest research patterns (problem → solution → story), their exemplar papers and why each was recalled. Use it to find mechanism primitives, crowded directions and differentiation routes; it is lexical unless the embedding endpoint is configured, and each result says which. The papers it names are leads: verify each at its primary source before it becomes evidence.
- **Search.** Public-safe queries only (`../ccf-common/references/privacy-and-evidence.md`): `web_search` and `web_fetch` for discovery, `research_evidence` literature-search and literature-import for the papers you will lean on. Hand deeper retrieval to ccf-literature-searcher and recent-overlap watch to ccf-literature-monitor; reuse their `idea-grounding.md` packet when it exists.
- Label every fact `known from user-provided material`, `known from public source`, `inferred` or `unknown`. Unsearched novelty is uncertainty, not novelty.

## The card

Write the developed idea to `ccfa-workfiles/ideas/<idea>/idea-card.md`: problem, source-backed gap, insight, method, contribution type, evidence plan (minimum discriminating tests), closest-work difference, material assumptions and the next decision. Keep alternatives only when they are developed and genuinely different. Update the card in place as it improves.

Then hand the card to ccf-idea-reviewer for the concept check; integrate its findings and revise the card until its verdict is `accept-to-develop` or a decision is recorded. Under `checkpoints`, which idea to develop is the user's call: ask with `ask_user_question` after the review, then record-decision.

## Done when

The idea phase of `research_check` shows the card and its review beside it.
