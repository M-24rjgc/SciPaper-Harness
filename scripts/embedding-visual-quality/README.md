# SPIQA test-C: bounded within-paper figure evidence retrieval

This fixed evaluation uses 32 human-written scientific questions, 31 papers, and all 216 released figures/tables from those selected papers. Each question searches only its own paper's figures. It is not a page-localization test, global literature-search benchmark, answer-quality test, or claim-verification test. No native quality result exists until CI writes a complete results.json.

## Primary provenance and rights

SPIQA creators explicitly release the dataset under CC BY 4.0 in Appendix A: https://arxiv.org/html/2407.09413 . Creator-hosted distribution: https://huggingface.co/datasets/google/spiqa . This code does not confuse the separate Apache-2.0 evaluation-code license with the dataset license.

Attribution: Shraman Pramanick, Rama Chellappa, Subhashini Venugopalan, *SPIQA: A Dataset for Multimodal Question Answering on Scientific Papers*, NeurIPS Datasets and Benchmarks 2024. The test-C human questions originate from QASPER: Pradeep Dasigi, Kyle Lo, Iz Beltagy, Arman Cohan, Noah A. Smith, Matt Gardner, *A Dataset of Information-Seeking Questions and Answers Anchored in Research Papers*, NAACL 2021, https://aclanthology.org/2021.naacl-main.365/ . Credit also belongs to original paper/figure authors identified by the released paper IDs, titles and caption records. CC BY 4.0 terms: https://creativecommons.org/licenses/by/4.0/ . Data and images stay external, never bundled into SciPaper or uploaded in CI results; the released creator dataset license is the basis for this bounded evaluation, not a claim that all arXiv works have uniform rights.

SPIQA section 3.2 states that test-C uses human-written QASPER questions and additional manual filtering to verify the evidence figures are helpful. This differs from model-generated test-A and from merely pairing a figure with its caption. These are human-checked evidence references, not exhaustive independent graded relevance judgments for every distractor. Some other candidate figures may also be useful and are unjudged.

## Exact frozen data

Creator revision: 1774b71511f029b82089a069d75328f25fbf0705. Assets and SHA-256/byte lengths are in assets.json. Original test-C has 314 papers / 493 questions, all with released referred_figures_tables labels. Selection hashes fixed seed + paper ID + question index and takes the first 32, before native inference. frozen-selection.json pins query keys, all relevant IDs, all selected-paper candidates, image hashes, dimensions and byte lengths. No label fabrication, question rewriting, missing-image dropping, or test-driven threshold tuning. The original PNG bytes are unchanged; no resize, crop or synthesized page.

The selected original images total 216, largest 413,295 bytes and largest 2,109,228 pixels. ZIP admission rejects absolute/parent/backslash paths, symlinks, encrypted entries, duplicate names, excessive members and expansion. No archive member is extracted to a filesystem path; selected bytes are read by exact allowlisted names and verified against frozen hashes. All assets are hash-checked before use.

## Methods

- Caption BM25: actual product tokenization and BM25 on the released figure/table captions, with title empty. No answer text enters any method.
- Vision: the repaired, hash-pinned actual product worker and pinned text+vision model; exact query prefix, 768-dimensional normalized embeddings, CPU two threads, explicit 8192-token context, overflow ERROR, 8 GiB limit. Original images enter native document embedding; their captions do not enter this branch.
- Hybrid: actual product RRF k=60 on caption and vision ranks, no tuned weights.

All candidates belonging to a question's paper are eligible for all methods. The product BM25 returns only documents sharing a token; it can return fewer than k (including none). Semantic ranks include all candidates. Report macro Recall/nDCG/MRR at 1/3/5/10 plus full-candidate MRR, with candidate counts per query. Small within-paper pools make high-k recall easy for complete ranks, so top-1 and MRR are especially informative. No release threshold is inferred from this small sample. Do not compare its numbers with text SciFact scores as though they share a task.

## CI and outputs

Node 24 / Python 3.12, Linux CPU only. No evaluator pip dependencies. Wheel and model preparation are pinned to official product assets with byte/hash checks, local inference only; no LLM judge, remote embedding API, private data or paid model. Use:

```
python -m unittest discover -s scripts/embedding-visual-quality -p 'test_*.py' -v
python scripts/embedding-visual-quality/evaluate.py \
  --product-root scripts/embedding-visual-quality/product \
  --runtime "$RUNNER_TEMP/visual-runtime" \
  --model "$RUNNER_TEMP/visual-model/embeddinggemma-2-text-vision-440m.litertlm" \
  --work "$RUNNER_TEMP/spiqa-work" --output visual-quality-results
```

Upload only visual-quality-results. Never upload source metadata (contains fulltext), original images, model weights, runtime cache or embeddings. Output ranks/labels are identifiers only. A timeout, overflow or runtime failure means incomplete evaluation, not failed relevance scores. Batch timings include process/model reload; peak child RSS includes ranker. These are CI resources, not target-device latency. The same fixed sample is used for source validation and inference; no tuning follows lexical-only results.
