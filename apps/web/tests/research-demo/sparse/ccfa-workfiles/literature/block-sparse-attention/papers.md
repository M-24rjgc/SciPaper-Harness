# Literature Search: block-sparse attention at long context

Date: {{date}}
Search purpose: novelty grounding for the idea card, and the related work and baselines of the paper
Target venue/family: NeurIPS (machine learning)
Source-quality policy: applied

## Summary

- Closest-work clusters: fixed sparse patterns (Longformer, BigBird); learned or content-based dynamic sparsity (MInference, MoBA, NSA); long-context evaluation (RULER, LongBench); fast dense attention (FlashAttention-3).
- Opportunity map: the dynamic methods each compare one mechanism with full attention; none isolates fixed against dynamic selection across context lengths.
- Strongest baselines: full attention with FlashAttention-3; fixed local-plus-strided blocks at the same sparsity.
- Benchmark/dataset candidates: RULER at 32K and 64K, reported per task category; LongBench-E for natural documents.
- Novelty risks: a paper framed as "a dynamic block-selection method" overlaps MInference, MoBA and NSA directly.
- Recommended next action: frame the contribution as a controlled measurement; hand the protocol to ccf-experiment-designer.

## Paper Table

| # | Title | Year | Venue/source | Link | Type | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Longformer: The Long-Document Transformer | 2020 | arXiv | https://doi.org/10.48550/arxiv.2004.05150 | pure method | sliding window plus global tokens; evaluated around 4K tokens |
| 2 | Big Bird: Transformers for Longer Sequences | 2020 | arXiv (NeurIPS 2020) | https://doi.org/10.48550/arxiv.2007.14062 | pure method | random, window and global attention; fixed block layout |
| 3 | MInference 1.0: Accelerating Pre-filling for Long-Context LLMs via Dynamic Sparse Attention | 2024 | NeurIPS 2024 | https://doi.org/10.52202/079017-1663 | pure method | per-head dynamic sparse patterns for pre-filling |
| 4 | MoBA: Mixture of Block Attention for Long-Context LLMs | 2025 | NeurIPS 2025 | https://doi.org/10.52202/085713-0602 | pure method | top-k block routing over key blocks, closest to our dynamic variant |
| 5 | Native Sparse Attention: Hardware-Aligned and Natively Trainable Sparse Attention | 2025 | ACL 2025 | https://doi.org/10.18653/v1/2025.acl-long.1126 | pure method | trainable compressed, selected and sliding branches |
| 6 | RULER: What's the Real Context Size of Your Long-Context Language Models? | 2024 | arXiv (COLM 2024) | https://doi.org/10.48550/arxiv.2404.06654 | pure benchmark | effective context far below the claimed length; aggregation hardest |
| 7 | LongBench: A Bilingual, Multitask Benchmark for Long Context Understanding | 2024 | ACL 2024 | https://doi.org/10.18653/v1/2024.acl-long.172 | pure benchmark | natural long-document tasks; LongBench-E balances lengths |
| 8 | FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision | 2024 | arXiv (NeurIPS 2024) | https://doi.org/10.48550/arxiv.2407.08608 | system/tool | faster dense attention raises the bar for any sparse method |

## Clusters

### Cluster 1: Fixed sparse patterns

- Representative papers: Longformer, BigBird.
- What this cluster already solves: linear-cost attention with a pattern fixed before seeing the input.
- Remaining gap: evaluated around 4K tokens; says nothing about 32K and beyond.
- Possible rescue or differentiation route: use the fixed pattern as the controlled baseline.
- How it affects the user's paper: baseline and related work.

### Cluster 2: Dynamic, content-based sparsity

- Representative papers: MInference, MoBA, NSA.
- What this cluster already solves: choosing blocks or tokens from the input, with good accuracy against full attention.
- Remaining gap: none compares fixed and dynamic selection at the same sparsity across context lengths.
- Possible rescue or differentiation route: hold the mechanism fixed and measure the gap as length grows.
- How it affects the user's paper: the novelty boundary; cite all three and state the difference in the introduction.

### Cluster 3: Long-context evaluation

- Representative papers: RULER, LongBench.
- What this cluster already solves: task-typed and natural-document evaluation at long lengths.
- Remaining gap: sparse attention variants are rarely reported per task category.
- Possible rescue or differentiation route: report RULER per category, aggregation separately.
- How it affects the user's paper: the benchmark choice.

## Opportunity Map

| Cluster | Status | Open gap | Possible direction | Evidence needed | Risk |
| --- | --- | --- | --- | --- | --- |
| Dynamic sparsity | crowded but open | fixed vs dynamic across lengths | controlled measurement at 32K and 64K | RULER per category, three seeds | a reviewer reads it as an incremental method paper |
| Long-context evaluation | benchmark gap | per-category reporting for sparse attention | aggregation tasks reported separately | RULER categories | small per-category samples |

## Benchmark And Dataset Candidates

| Name | Link | Task | Metrics | Baselines | Fit | Risks |
| --- | --- | --- | --- | --- | --- | --- |
| RULER | https://doi.org/10.48550/arxiv.2404.06654 | synthetic retrieval, tracing, aggregation, QA | accuracy | full attention | direct: lengths are configurable | synthetic tasks |
| LongBench-E | https://doi.org/10.18653/v1/2024.acl-long.172 | natural long documents | task metrics | full attention | checks transfer to natural text | fewer items at 64K |

## Citation And Positioning Cautions

- Claims that need direct citation: the 4K evaluation range of fixed patterns; the effective-context finding of RULER.
- Papers that may weaken novelty: MInference, MoBA, NSA.
- Papers that only support background: FlashAttention-3.
