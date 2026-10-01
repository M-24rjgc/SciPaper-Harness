# Domain map quality

This report records how the layout in `ai-map.bin` was chosen and how accurate it is. [MAP-FORMAT.md](MAP-FORMAT.md) describes the file, and [`scripts/build_kg_map.py`](../../scripts/build_kg_map.py) builds it. The measurements were made on 2026-10-01 with throwaway scripts that are not part of the repository. All numbers refer to the 29,240 papers of `ai-kg.json.gz`. Map distances are in map units, where the map is 1 wide.

## Summary

The shipped layout is UMAP over a fused graph. The graph joins the 30 nearest neighbours in a 128-dimensional LSA space of each paper's title, idea, problem, solution and story with the graph's recorded five nearest neighbours at weight 0.5 (`min_dist` 0, seed 11). It keeps more recorded neighbours than any layout built from text alone (11.7% within the map's 15 nearest, against at most 10.8%), and it places held-out papers as well as the best candidates: the median placed point lies within the 70 nearest papers of the true position. Its trustworthiness against an independent embedding model, 0.848, is within 0.01 of the best candidate. It also fills the frame instead of scattering islands. The layouts built from the owner's embedding model (qwen3.7-text-embedding-flash) were worse on every measure except continuity and, for one of them, the share of its own neighbours kept (0.054 against 0.048). They would also make the asset depend on one person's model, so none of them ships. Placement uses mean shift over the recall hits and reports how much of the hit weight agrees: in the most confident quarter of placements the median error is 0.0034, and in the least confident quarter it is 0.05. Thirteen gap candidates were found; the six that recur across seeds and parameter changes are shipped.

## Reference spaces and baselines

| Space | Median cosine distance to 1st / 15th neighbour | Same pattern among 10 nearest | Same domain among 10 nearest | Recorded 5-NN among 10 nearest |
| --- | --- | --- | --- | --- |
| LSA (title twice, idea, problem, solution) | 0.220 / 0.346 | 42.8% | 68.4% | 17.7% |
| qwen3.7-text-embedding-flash, 1024-d (title, idea, problem, solution) | 0.443 / 0.530 | 32.5% | 64.5% | 20.7% |
| Random papers | | 0.46% | 39.8% | |

Pattern purity counts only the 19,407 papers assigned to a pattern. The two text spaces agree on only 14% of their 10 nearest neighbours, so no single neighbour list is ground truth. The tables below report preservation of each list. The qwen space is an independent reference for the layouts that do not use it. The patterns (upstream story clusters) are independent of every layout except the two marked "uses patterns". The recorded neighbours (from upstream vectors) are an input of the graph-only layout, of the layouts "with recorded neighbours" and of the shipped one, so rec5@15 favours those.

## Candidates

Neighbour preservation and purity use the whole corpus. "rec5@15" is the share of each paper's recorded neighbours found among its 15 nearest on the map, and "qwen10@10" the share of its qwen 10 nearest among its 10 nearest on the map. T and C are trustworthiness and continuity at k = 10 against the qwen space, computed on a fixed random subsample of 3,000 papers with ranks taken within the subsample. "Occupied" is the share of a 64 × 64 grid holding at least one paper; lower means tighter clusters. Placement was measured on a tuning set of 1,000 random papers that is disjoint from the test set below, with lexical recall hits and mean shift (bandwidth 0.02). "Rank" is the number of papers closer to the true position than the placed point, as a median and 90th percentile. "Region" is how often the placed point falls in the same one of 36 density regions as the true position.

| Layout | rec5@15 | qwen10@10 | T | C | Pattern purity | Domain purity | Occupied | Rank median / p90 | Region |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Graph only: recorded 5-NN plus same-pattern anchor edges | 0.304 | 0.051 | 0.803 | 0.709 | 0.472 (uses patterns) | 0.667 | 0.371 | 82 / 12,414 | 0.725 |
| LSA, 30-NN, min_dist 0.1 | 0.084 | 0.043 | 0.843 | 0.726 | 0.304 | 0.629 | 0.257 | 92 / 8,947 | 0.738 |
| LSA with story, 30-NN, min_dist 0 | 0.096 | 0.049 | 0.855 | 0.709 | 0.356 | 0.653 | 0.176 | 84 / 9,637 | 0.796 |
| qwen, 30-NN, min_dist 0.1 | 0.040 | 0.039 | 0.770 | 0.814 | 0.143 | 0.569 | 0.753 | 344 / 11,241 | 0.579 |
| qwen, 30-NN, min_dist 0 | 0.051 | 0.054 | 0.793 | 0.810 | 0.168 | 0.571 | 0.702 | 253 / 11,745 | 0.599 |
| qwen centred, PCA to 50 dimensions | 0.021 | 0.023 | 0.794 | 0.806 | 0.085 | 0.528 | 0.758 | 760 / 14,861 | 0.490 |
| qwen with recorded neighbours (weight 1) | 0.099 | 0.036 | 0.783 | 0.795 | 0.265 | 0.615 | 0.562 | 200 / 10,140 | 0.647 |
| LSA graph fused with qwen graph | 0.061 | 0.039 | 0.815 | 0.785 | 0.261 | 0.621 | 0.610 | 114 / 6,955 | 0.728 |
| LSA with story fused with centred qwen | 0.076 | 0.048 | 0.838 | 0.779 | 0.316 | 0.638 | 0.491 | 78 / 7,135 | 0.765 |
| densMAP over LSA | 0.068 | 0.036 | 0.794 | 0.731 | 0.266 | 0.606 | 0.555 | 152 / 11,317 | 0.677 |
| LSA, supervised by pattern (target weight 0.3) | 0.100 | 0.048 | 0.847 | 0.725 | 0.440 (uses patterns) | 0.645 | 0.216 | 82 / 10,225 | 0.746 |
| **Shipped**: LSA with story fused with recorded neighbours (0.5), 30-NN, min_dist 0 | 0.118 | 0.048 | 0.848 | 0.736 | 0.383 | 0.663 | 0.322 | 71 / 7,520 | 0.786 |

The qwen layouts are uniform blobs. The qwen space has a narrow distance range (its 15th neighbour is barely farther than its 1st), and a 2D layout of it keeps fewer of its own neighbours than the LSA layouts do (T 0.77 to 0.79 against 0.85). Centring, removing leading components and PCA did not help. Fusing it with the LSA graph improved continuity and the 90th-percentile placement rank, but lost trustworthiness, purity and crispness. The pattern-supervised layout scores higher on purity only because it was trained on the patterns. The graph-only layout keeps its own input edges best but keeps the least of the text neighbourhoods. The shipped layout uses the recorded neighbours as a second signal: rec5@15 rises from 0.096 to 0.118, pattern purity (which it does not see) from 0.356 to 0.383, and the 90th-percentile placement rank falls from 9,637 to 7,520, while T drops by 0.007.

The final build tokenises with accent folding, so its layout differs slightly from the experiment. Measured on the shipped asset: rec5@15 0.117, qwen10@10 0.048, T 0.848, C 0.736, pattern purity 0.383, domain purity 0.665, occupied 0.333.

### Parameter sweeps

| Variant of the shipped method | rec5@15 | T | C | Pattern purity | Occupied | Rank median / p90 | Region |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 15 neighbours | 0.132 | 0.847 | 0.738 | 0.401 | 0.315 | 73 / 8,483 | 0.770 |
| 50 neighbours | 0.108 | 0.849 | 0.735 | 0.376 | 0.319 | 69 / 7,289 | 0.781 |
| Recorded weight 0.3 | 0.107 | 0.853 | 0.732 | 0.373 | 0.295 | 77 / 8,044 | 0.779 |
| Recorded weight 1.0 | 0.150 | 0.843 | 0.739 | 0.418 | 0.357 | 70 / 8,499 | 0.763 |
| min_dist 0.05 | 0.117 | 0.844 | 0.738 | 0.382 | 0.370 | 68 / 7,900 | 0.769 |

For the LSA layout without the recorded graph and with `min_dist` 0.1, 15, 30 and 50 neighbours gave T 0.846, 0.843 and 0.842; `min_dist` 0.3 lowered T to 0.819, and 500 epochs changed nothing material. Including the story text raised pattern purity from 0.309 to 0.356 at `min_dist` 0. The shipped settings sit in the middle of a flat optimum. Across seeds 11 to 15 the shipped configuration varies little: rec5@15 0.115 to 0.118, T 0.847 to 0.849, C 0.733 to 0.736, pattern purity 0.383 to 0.386.

## Labels

The map has 40 regions, and 0.96% of papers lie in specks too small for a region. For the spot check, 15 regions were drawn at random (seed 15), and 10 random titles were sampled from each. On average 67% of the sampled titles contain a word of the label. Eight labels match at least 8 of 10 sampled titles: "time series forecasting", "conformal prediction / coverage", "differentially private / privacy", "federated learning / distributed", "continual learning / forgetting", "reasoning / language models", "multi-agent / planning" and "offline reinforcement learning". Three labels fit 6 or 7 titles, and the titles they miss are on the same topic in other words: "graph / gnns", "semantic segmentation" and "object detection / point cloud". Four labels name only part of a large, mixed region in the central mass: "image / diffusion" (image generation with speech synthesis and face generation), "contrastive learning / vision" (representation learning with EEG decoding and interpretability), "optimization / stochastic" (learning theory) and "fine-tuning / scaling laws" (pruning and training efficiency). Those regions have 1,200 to 1,500 papers each; their keyword lists in the asset (five keywords) describe them better than their two-keyword labels. No two label boxes overlap at the reference size (1000 px map, 12 px type, 7.2 px per character).

## Placement accuracy

Test set: 1,000 random papers (seed 20261001), disjoint from the tuning set. Each paper was removed from the graph the knowledge base searches: its texts were emptied, its pattern was unassigned, its recorded neighbours were dropped, and it was removed from its pattern's exemplars; other papers' links to it then reach no pattern. It was then placed from its title and idea through the runtime path: `KnowledgeBase.recall`, then `builtinIndices` and `hitsFromRecall`, then `placeFromHits` on the shipped asset. Each placement was compared with the paper's own position in the map. The map itself was built with the test papers present, as it would be for any paper the graph contains. Pattern centres include them too, which changes a centre by at most one member in 15. The semantic runs used the owner's endpoint for the query and pattern vectors (the pattern texts as the blanked graph shows them), cached and replayed through an `Embedder`. A second query form, the paper's story field alone, stands in for a paraphrase: it shares fewer words with the paper's title. Placing points uniformly at random gives a median error of 0.45.

| Query | Recall | Median error | 90th percentile error | Rank median / p90 | Same region |
| --- | --- | --- | --- | --- | --- |
| Title and idea | lexical | 0.0081 | 0.238 | 70 / 10,132 | 78.1% |
| Title and idea | semantic + lexical | 0.0081 | 0.228 | 70 / 9,944 | 78.5% |
| Story only | lexical | 0.0119 | 0.303 | 107 / 12,441 | 69.1% |
| Story only | semantic + lexical | 0.0123 | 0.320 | 110 / 12,559 | 68.8% |

Same region compares the 40 shipped regions at the placed and at the true position, over the 992 test papers that lie in a region. A Python mirror of the runtime path reproduced these numbers. The typical placement is close: within 0.01 of the true position, which is the median distance from a paper to its 70th nearest paper on the map. The 90th percentile is far: 17.6% of the title-and-idea placements land more than 0.1 from the true position, and 89% of those have a confidence below 0.5 (median 0.28, against 0.49 for the rest). Semantic recall hardly changes placement, because recall ranks patterns, not papers, semantically, and pattern centres are coarse. With the tuning set, pattern weights of 0 to 0.25 of the paper weight performed alike, and weights of 0.5 or more moved placements away from the truth, so `PATTERN_WEIGHT` is 0.1: it matters mainly when no paper matches. For reference, a semantic paper index that the asset does not ship, made of top-30 papers by qwen cosine fused with the BM25 hits, would lower the median rank from 70 to 64 for title queries and from 107 to 99 for story queries; the qwen hits alone do worse (192 and 401) on this lexically built map.

Mean shift beats averaging. On the tuning set and the shipped asset, the weighted mean of the paper hits had a median error of 0.074, their weighted geometric median 0.018, the single best paper 0.023, the best pattern's centre 0.027, and mean shift 0.0084. A bandwidth of 0.02 trades the median (0.015 is slightly better) against the 90th percentile (0.03 is better).

Confidence is the share of hit weight within 0.05 of the placed point. It ranks placements by reliability:

| Query | Recall | Median error by confidence quartile (lowest to highest) | Share with confidence ≥ 0.5 | Of those, farther than 0.1 |
| --- | --- | --- | --- | --- |
| Title and idea | lexical | 0.051, 0.011, 0.0067, 0.0034 | 42% | 4.5% |
| Title and idea | semantic + lexical | 0.045, 0.010, 0.0063, 0.0034 | 42% | 4.7% |
| Story only | lexical | 0.091, 0.020, 0.0084, 0.0041 | 33% | 7.4% |
| Story only | semantic + lexical | 0.097, 0.020, 0.0085, 0.0041 | 33% | 6.8% |

A low confidence means the hits split between distant areas. `placeFromHits` then still returns the densest concentration, never the average, and lists the other concentrations that hold 15% of the weight or more as `alternatives`. Real ideas were not measured. They are usually shorter than a paper's title and idea and worded differently, so their accuracy is likely nearer the story rows, and lower for very short queries.

## Gaps

A gap candidate is an area below 10% of the median paper density, enclosed by denser cells (a hole, or an inlet narrower than 0.04), of at least 0.001 of the map, and bordered by two or more regions. Its identity across layouts is the set of papers on its rim, within 0.015 of it, because coordinates are not comparable between UMAP runs. A gap recurs in another run when that run has a gap whose rim papers overlap its own with a Jaccard index of at least 0.25. The shipped run was compared with nine other runs: four other seeds (12 to 15) and five parameter variants (15 or 50 neighbours, recorded weight 0.3 or 1.0, `min_dist` 0.05).

- The shipped run had 13 candidates; the other runs had 7 to 11.
- Recurrence across the four other seeds: five candidates recurred in none, one in one, one in two, three in three and three in all four.
- Recurrence across the five parameter variants: five candidates recurred in none, two in one, three in three and three in four. None recurred in all five.
- The six candidates that recur in at least three seeds are the six that recur in at least three variants; those six are shipped. Their mean best-match Jaccard is 0.42 across seeds and 0.33 across variants. For the seven dropped candidates it is 0.12 and 0.10.
- Chance level: in the experimental layout, rim-sized groups of nearby papers around 300 random points recurred in at least three of four seeds 5.3% of the time, and in all four 3.3% of the time.

The shipped gaps lie between "object detection / point cloud", "video / gaussian splatting" and "semantic segmentation"; between "video / gaussian splatting", "image / diffusion" and "multimodal / visual"; between "contrastive learning / vision", "attention / transformers" and "multimodal / visual"; between "attention / transformers" and "multimodal / visual"; between "reasoning / language models", "multi-agent / planning" and "code / generation"; and between "reinforcement learning / policy" and "multi-agent / planning". Recurring makes a gap a stable property of this kind of projection, not a finding about research. A gap means "sparse in this map". The papers of two regions may be far apart in the text space, or the 2D projection may have had no room to place work between them. The corpus covers only the conferences upstream collected. A gap is a prompt to search the literature, not evidence that the topic is unexplored. `describeGap` words it that way.

### Original-space check of the shipped gaps

Recurring across layouts does not show that papers on the two sides of a gap are unlike each other in the space the map was built from, so the six gaps were tested there (the build's 128-dimension LSA space with the recorded neighbours fused in; rebuilding with the pinned versions gave a byte-identical asset). For each gap the share of its rim papers' 10 nearest neighbours that lie inside or across it, the share of rim-to-rim links that cross it, and how many papers are more similar to both ends of an across pair than the ends are to each other were compared with 400 control shapes of the same size elsewhere on the map. The thresholds were written down before any gap was measured. The disc version of the test could not return "real" for any gap, because a disc does not follow the gaps' shapes, so a version that uses each gap's own shape was added after seeing the first results; its thresholds were not changed.

- Gap 0 (object detection, video / splatting, segmentation) holds up: its rim papers have far fewer original neighbours across it than the controls (p about 0.002 on three statistics), and the independent embedding does not confirm it (p 0.14).
- Gap 2 (contrastive learning, attention, multimodal) leans the same way (p 0.03 to 0.12).
- Gaps 3 and 5 are inconclusive. Gaps 1 and 4 are artefacts of the drawing: papers on either side are as linked as in the controls.
- The p-values are approximate, because the controls overlap on one map, and only gap 0 would survive correcting for six tests.

None of this supports "few papers study this". Every gap stays "sparse in this map", the layer is off until the person turns it on, and the viewer names how often a gap recurred but not whether it is real.

## Asset

`ai-map.bin` is 321,487 bytes: 117 KB of paper coordinates and three 64 KB grids (density, region, gap) at 256 × 256, plus pattern, region, gap and string records. Two builds in the same environment produced identical bytes. The asset was built without the embedding endpoint: the qwen vectors were used only to choose the method and to measure it, and none of them is stored.

## Limits

- Distances are meaningful locally. The arrangement of far-apart regions and islands is not.
- The large central regions are heterogeneous, and their two-keyword labels name only their most distinctive part.
- Accuracy was measured on queries written like the corpus. Ideas in other words, or in other languages before translation, will place less accurately; confidence and alternatives are there to show it.
- A rebuild on another CPU or library build can move points by rounding (UMAP's optimiser is compiled with fastmath), so labels and gaps can change, and the asset should then be re-measured.
