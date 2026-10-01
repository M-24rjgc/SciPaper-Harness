# Agent Note: Marks on knowledge-graph results that every recall honors

Status: proposed

English | [中文](2026-10-01-knowledge-graph-annotations.zh.md)

## Problem

Recall ranks the built-in research-pattern graph (29,240 papers, 318 patterns, five recorded nearest papers each) and a project's own graph by shared words, and by meaning when an embedding endpoint is configured. The person reading the results knows what the ranking cannot: this paper matters, that one targets another setting. Nothing records that judgement, so the next recall shows the same papers again, and the agent can neither honor the judgement nor say what it changed.

## Proposal

The person and the agent share marks on the graph. [knowledge-annotations.ts](../../../../packages/research/workbench/src/knowledge-annotations.ts) holds the store and the re-ranking, as pure code that the knowledge engine (`research-knowledge-provider`, `ctx.researchKnowledge`) calls.

- **A mark** names a target (a pattern or paper of the `ai` or `project` graph, by its id), a verdict (`pin` or `irrelevant`), an optional reason of at most 280 characters on one line, its author (`user` or `agent`) and its time. Its id is the target's graph-view node id (`ai:paper:<id>`), so a target holds one mark and the opposite verdict replaces it.
- **The store** is `.research/kg/annotations.json`, `{version: 1, annotations}` ordered by id, at most 1,000 marks and 1 MiB. Writers hold the file's `withFileLock` and commit by atomic rename; readers take no lock. Setting the same mark again, or removing a missing one, writes nothing. A mark whose target a rebuilt graph lacks stays stored and is reported as orphaned. A file that does not parse, or holds malformed records, yields the marks that could be read and one problem per defect, the first ten listed and the rest counted; the next change copies the file to `annotations.json.<time>.bak` before rewriting it. A file of a newer format version is neither honored nor rewritten.
- **The re-ranking**, `applyAnnotations`, takes recall's complete fused rankings before their cut. When no mark names a target in a loaded graph, it returns the first `limit` candidates unchanged. Otherwise each list starts with its pins, those the query recalled in query order and then the others newest first, at most five; a target marked irrelevant leaves the list and is named with its reason in `skipped` when the query had placed it in view; every other candidate sorts by its place plus 3 × penalty − 3 × boost, ties keeping query order, so marks move a result down fewer than six places.
- **The weight** of a paper mark on a paper is 1 − Π(1 − 0.5ᵏ) over the simple paths of k ≤ 3 recorded similarity links between them, read in both directions: the chance that the verdict reaches the paper when each link passes it on with probability 0.5. A pattern mark weighs 0.5 on each of its papers. Marks of one verdict combine the same way, and a weight under 0.15 counts as none. A pattern's weight is the mean over its papers, so one marked paper counts against its pattern in proportion to how much of the pattern lies near it. Penalty is the weight of irrelevant marks, boost that of pins.
- **Every item says why.** `why` is `pinned` (with `recalled`), `demoted` or `boosted` (the shift in places, the penalty and boost, the mark of the most weight with its relation, the heaviest mark the other way when it counts, and how many marks weigh on it), or `unchanged`. A relation is `similar` with its number of links, `in-pattern`, or `members` with the links to the pattern's nearest paper and how many of its papers the mark reaches. The summary counts the marks applied, pinned, skipped, demoted, boosted, orphaned and on unloaded graphs, and `describeAnnotations` turns it into one paragraph for the agent.
- **Cost.** `prepareAnnotationGraph` builds, per parsed graph, the undirected link arrays, id maps and pattern members (44–52 ms for the built-in graph) in a WeakMap keyed by the graph object, so they are released with the loaded graph. The same structure keeps the spreads of the last 2,000 paper marks. A recall with 1,000 marks takes 29–34 ms the first time and about 10 ms after; with 100 marks 5 ms and 1 ms.

Recall, the knowledge tool's mark actions and the graph view are wired to this module separately.

## Measurements on the built-in graph

[knowledge-annotations-real.spec.ts](../../../../packages/research/workbench/tests/knowledge-annotations-real.spec.ts) reproduces every number here with `RESEARCH_KG_EVAL=1` in about a minute. It first checks that its rankings equal `KnowledgeBase.recall` for twelve written queries; the scenarios use those twelve and 88 paper ideas as queries, with views of eight results. The label "same pattern" says whether a paper belongs to the marked paper's story-angle cluster; lexical TF-IDF cosine is the check that does not come from the embeddings behind the links.

How related two papers are by the links between them, over 1,500 papers (a random pair shares a pattern 0.66% of the time, mean lexical cosine 0.022):

| links | papers per paper | share in the same pattern | mean lexical cosine |
|---|---|---|---|
| 1 | 8.1 | 0.696 | 0.175 |
| 2 | 47.5 | 0.476 | 0.106 |
| 3 | 209.6 | 0.237 | 0.067 |
| 4 | 833.3 | 0.070 | 0.044 |

Papers that list each other share the pattern 0.80 of the time, papers linked one way 0.65. Two links away, a paper reached by one, two, three or four shortest routes shares it 0.42, 0.67, 0.79 and 0.84 of the time. One link from a paper with 6 or fewer, 7 to 14, or 15 or more neighbours, it is shared 0.66, 0.70 and 0.75 of the time. The number of routes matters, and dense neighbourhoods are the more coherent ones.

Spreading methods, judged on every paper within three links of 400 marked papers (AUC: ranks papers of the marked paper's pattern first; ECE: calibration error of a 0–1 weight):

| method | AUC | AUC at 1 / 2 / 3 links | rho with lexical cosine | ECE | mean weight at 1 / 2 / 3 links |
|---|---|---|---|---|---|
| hop decay 0.5 per link | 0.625 | 0.500 / 0.500 / 0.500 | 0.312 | 0.149 | 0.50 / 0.25 / 0.13 |
| noisy-OR over shortest paths, t = 0.65 | 0.711 | 0.500 / 0.595 / 0.668 | 0.374 | 0.081 | 0.65 / 0.47 / 0.35 |
| personalised PageRank, row-normalised, restart 0.15 | 0.714 | 0.537 / 0.572 / 0.667 | 0.334 | – | 0.16 / 0.02 / 0.00 |
| personalised PageRank, row-normalised, restart 0.5 | 0.688 | 0.494 / 0.525 / 0.622 | 0.294 | – | 0.07 / 0.01 / 0.00 |
| personalised PageRank, symmetric, restart 0.15 | 0.726 | 0.541 / 0.587 / 0.687 | 0.342 | – | 0.15 / 0.02 / 0.00 |
| Katz walk counts, b = 0.1 | 0.721 | 0.677 / 0.743 / 0.666 | 0.405 | – | 0.14 / 0.02 / 0.00 |
| simple-path noisy-OR, t = 0.5, depth 1 | 0.533 | 0.500 / 0.500 / 0.500 | 0.205 | 0.294 | 0.50 / 0.00 / 0.00 |
| simple-path noisy-OR, t = 0.5, depth 2 | 0.630 | 0.675 / 0.595 / 0.500 | 0.318 | 0.231 | 0.66 / 0.29 / 0.00 |
| simple-path noisy-OR, t = 0.3, depth 3 | 0.727 | 0.705 / 0.747 / 0.666 | 0.411 | 0.218 | 0.48 / 0.21 / 0.04 |
| simple-path noisy-OR, t = 0.4, depth 3 | 0.730 | 0.707 / 0.748 / 0.666 | 0.414 | 0.136 | 0.65 / 0.38 / 0.09 |
| **simple-path noisy-OR, t = 0.5, depth 3** | 0.730 | 0.707 / 0.748 / 0.666 | 0.414 | **0.046** | 0.78 / 0.56 / 0.18 |
| simple-path noisy-OR, t = 0.65, depth 3 | 0.734 | 0.707 / 0.748 / 0.666 | 0.417 | 0.158 | 0.90 / 0.78 / 0.36 |
| simple-path noisy-OR, t = 0.8, depth 3 | 0.734 | 0.692 / 0.746 / 0.666 | 0.415 | 0.372 | 0.96 / 0.92 / 0.60 |

With t = 0.5 a weight reads as the chance of sharing the pattern: papers weighted 0.125, 0.236, 0.334, 0.451, 0.550, 0.639, 0.741, 0.845 and 0.953 on average share it 0.165, 0.307, 0.387, 0.476, 0.523, 0.626, 0.708, 0.764 and 0.852 of the time. Every paper one or two links from a mark passes the 0.15 threshold, and 28% of those three links away (those reached by two or more paths).

What the production setting does to recall's views (moves are places down, + , or up, −, in the eight-paper view, by links from the nearest marked paper):

| scenario | papers replaced of 8 | demoted in view | top-3 that left view | move at 1 / 2 / 3 / 4+ links | largest drop | patterns replaced of 8 | patterns demoted |
|---|---|---|---|---|---|---|---|
| S2 top paper hit marked irrelevant | 0.24 | 3.33 | 0 | 0.95 / 0.56 / −0.38 / −0.40 | 2 | 0.01 | 0.75 |
| S3 top hit and its 4 nearest marked irrelevant | 0.29 | 3.67 | 0 | 0.88 / 0.76 / −0.32 / −0.53 | 2 | 0.03 | 2.19 |

Without marks, with one orphaned mark, and with a pin more than four links from every candidate, all 100 queries return byte-identical ranked lists (S0, S1); the far pin is listed first with `recalled: false`. Pinning the top hit and marking its nearest neighbour irrelevant (S4) lists the pin first in every query, and of the 280 results weighed on both ways 141 move down and 139 up. Three papers of the top pattern marked irrelevant (S5) move that pattern from first to 1.95th on average, at most third; marking the pattern itself skips it in every query and moves 2.0 of its papers down in the paper view. Pinning the fifth paper hit (S6) lifts 2.36 papers in view and brings 0.18 in from below.

Sensitivity of S2 to each constant, the others at their production values:

| setting | papers replaced of 8 | move at 1 / 2 / 3 links | largest drop | top-3 that left view | patterns demoted |
|---|---|---|---|---|---|
| transmission 0.3 | 0.12 | 0.61 / 0.07 / −0.27 | 2 | 0 | 0.17 |
| transmission 0.4 | 0.20 | 0.85 / 0.29 / −0.38 | 2 | 0 | 0.44 |
| **transmission 0.5** | 0.24 | 0.95 / 0.56 / −0.38 | 2 | 0 | 0.75 |
| transmission 0.65 | 0.28 | 0.93 / 0.80 / −0.07 | 2 | 0 | 1.23 |
| transmission 0.8 | 0.31 | 0.88 / 0.78 / 0.56 | 2 | 0 | 1.74 |
| depth 1 | 0.10 | 0.81 / −0.22 / −0.28 | 1 | 0 | 0.02 |
| depth 2 | 0.16 | 0.99 / 0.05 / −0.41 | 2 | 0 | 0.19 |
| **depth 3** | 0.24 | 0.95 / 0.56 / −0.38 | 2 | 0 | 0.75 |
| largest move 1 | 0.00 | 0.00 / 0.00 / 0.00 | 0 | 0 | 0.76 |
| largest move 2 | 0.13 | 0.52 / 0.25 / −0.24 | 1 | 0 | 0.76 |
| **largest move 3** | 0.24 | 0.95 / 0.56 / −0.38 | 2 | 0 | 0.75 |
| largest move 4 | 0.31 | 1.32 / 0.76 / −0.47 | 3 | 0 | 0.75 |
| largest move 6 | 0.64 | 2.13 / 1.37 / −0.62 | 5 | 0 | 0.75 |
| largest move 8 | 0.95 | 2.81 / 1.79 / −0.63 | 6 | 0.03 | 0.75 |
| threshold 0 | 0.23 | 0.94 / 0.54 / −0.36 | 2 | 0 | 5.36 |
| threshold 0.1 | 0.23 | 0.94 / 0.54 / −0.36 | 2 | 0 | 1.04 |
| **threshold 0.15** | 0.24 | 0.95 / 0.56 / −0.38 | 2 | 0 | 0.75 |
| threshold 0.25 | 0.25 | 0.97 / 0.57 / −0.41 | 2 | 0 | 0.32 |
| threshold 0.35 | 0.26 | 1.02 / 0.57 / −0.50 | 2 | 0 | 0.17 |

With five marked neighbours (S3), a largest move of 1, 2, 3, 4 and 6 replaces 0.00, 0.17, 0.29, 0.47 and 0.79 papers of 8, and transmission 0.3, 0.5 and 0.8 replaces 0.23, 0.29 and 0.40.

The constants follow from these tables. Transmission 0.5 is the value whose weights are calibrated (ECE 0.046 against 0.136 at 0.4 and 0.158 at 0.65); the ordering hardly depends on it (AUC 0.727–0.734). Depth 3 adds what two links miss (AUC 0.630 to 0.730), including the three-link paths through a shared neighbour that order the direct neighbours (AUC at one link 0.675 to 0.707); four links would reach 833 papers per mark, sharing the pattern 7% of the time, and walk 5,798 paths per mark on average (at most 61,682) instead of 662 (at most 9,185). A largest move of 3 in each direction is the largest symmetric bound under which a result in the query's top three stays within an eight-result view whatever lies below it, since it moves down fewer than 3 + 3 places; at 8 a top-three match left the view in 3% of the queries. The threshold 0.15 leaves out a paper reached by a single three-link path (weight 0.125, sharing the pattern 17% of the time) and cuts the patterns flagged as demoted from 1.04 to 0.75 per recall at 0.1, while the paper view stays as it is (0.23 against 0.24 papers replaced).

Inside recall's own 30 paper candidates, with the top hit marked irrelevant:

| method | AUC | other candidates touched, of 29 | share in its pattern among the m it ranks first |
|---|---|---|---|
| simple-path noisy-OR, t = 0.5, depth 3 | 0.785 | 12.3 | 0.514 |
| personalised PageRank, row-normalised, restart 0.15 | 0.815 | 25.8 | 0.514 |
| personalised PageRank, row-normalised, restart 0.5 | 0.812 | 25.8 | 0.512 |
| personalised PageRank, symmetric, restart 0.15 | 0.816 | 25.8 | 0.516 |
| Katz walk counts, b = 0.1 | 0.778 | 12.3 | 0.514 |
| Rocchio on TF-IDF: cosine to the marked paper | 0.720 | 29.0 | 0.443 |
| Rocchio without the query's words: Jaccard to the marked paper | 0.622 | 28.9 | 0.405 |

m is the number of candidates the production setting moves. PageRank's higher AUC comes from ordering the candidates four or more links away, which this design deliberately leaves where they are.

## Alternatives considered

**Personalised PageRank over the recorded links, with marks as seeds.** It divides a paper's mass among its neighbours, while on this graph high-degree papers have the more coherent neighbourhoods, so it hardly separates related from unrelated direct neighbours (AUC at one link 0.54 against 0.71). Its mass has no probability scale (0.15, 0.02 and 0.00 at one, two and three links), so a bound in places would need a second calibration; it yields no link count to explain a move; inside recall's candidates it touches 25.8 of 29 papers and picks the ones to move no better (0.512–0.516 against 0.514). In the harness's own implementations it costs 8–9 ms per mark against 1.4 ms. Restart 0.5 ranks worse (AUC 0.688).

**PageRank with the strongest hits as positive seeds.** Of the 230 candidates linked to the marked paper, 228 stay net demoted: it changes almost nothing, and the little it changes undoes the person's verdict with the ranking the person just corrected.

**Rocchio-style adjustment by vectors.** The built-in graph ships no vectors, and embeddings exist only for pattern texts and only with an endpoint. On TF-IDF vectors every candidate shares the query's words with the marked paper, so the adjustment touches all 29 candidates and picks worse (precision 0.443; 0.405 without the query's words).

**Hop decay or noisy-OR over shortest paths only.** Both treat all papers at one distance alike or nearly so (AUC at one link 0.500), although two to four routes raise the share in the pattern from 0.42 to 0.67–0.84.

**Katz walk counts.** They rank about as well (AUC 0.721) but are unbounded, count walks that turn back on themselves, and need a transform to become a bounded weight; the chosen weight carries the same path counts as a probability.

**Only removing the marked target.** Nothing near an irrelevant paper moves, so a person who marks the top hit sees its neighbours where they were; it is the reference row of the scenario table.

**Scaling the fused score instead of moving places.** Reciprocal-rank scores are flat (the first and the tenth place of one ranking score 1/61 and 1/70), so halving a score drops a result some sixty places and cannot keep a strong match in view.

## Open questions

- Pins are listed in addition to the query's `limit`, at most five per list; the owner may prefer them to take the query's places.
- Marks move a direct neighbour of an irrelevant paper about one place and replace a quarter of a paper in an eight-paper view; a stronger move gives up the guarantee for the top three.
- The agent's marks weigh the same as the person's.
- A mark on the built-in graph does not reach the same paper in the project graph, and irrelevant marks do not change novelty checks.

## Acceptance criteria

- Recall reads the marks with `readAnnotations`, passes its complete fused rankings to `applyAnnotations`, and returns the lists it gives; without marks its output stays byte-identical, which the harness's identity test pins on the built-in graph.
- The knowledge tool sets and removes marks through `setAnnotation` and `removeAnnotation`, with input validated by `annotationInputSchema` and refused in example projects; recall's result carries `why`, `skipped`, the summary and `describeAnnotations`' paragraph when the project has marks, and a recorded-session snapshot pins that output.
- The graph view shows marks on its nodes and edits them by node id.
- `knowledge-annotations.ts` keeps per-file 100% coverage, and the harness passes with `RESEARCH_KG_EVAL=1`.

## Risks

- The "same pattern" label comes from the clustering that also produced the similarity links, which favours graph methods; lexical cosine agrees (rho 0.414) but measures shared words, not the person's reason.
- The constants were measured on the built-in graph. A project graph has its own links, or none; without links a mark reaches only its target and its pattern.
- Paper ids repeat in the built-in graph (three ids, seven copies; two of the ids have copies under different patterns); a mark covers every copy, and a pin the query did not recall shows the last copy, the one the graph links.
- Relation corrections need a format version 2, which this build refuses to rewrite; a version 1 reader honors none of a version 2 file's marks.
- Pins add up to ten items to what the model reads per recall.
- The timings come from a machine running other jobs at the time.
