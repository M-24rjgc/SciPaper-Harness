# Bounded SciFact scientific retrieval challenge

This is a fixed **32-query / 512-document enriched candidate challenge**, not full SciFact, not a BEIR leaderboard run, and not a product-wide release-quality claim. It compares actual SciPaper BM25, actual text EmbeddingGemma 2 worker, and actual equal-weight RRF k=60 with existing human evidence labels. No paid service, private data, threshold tuning, fine-tuning, new labels, or corpus/weight redistribution.

## Data rights and provenance

Primary source: https://github.com/allenai/scifact/blob/a5254a1bf108726a1704d8e191b8a7f2225a029f/LICENSE.md

The primary repository explicitly licenses claims and evidence annotations **CC BY 4.0**, abstracts **ODC-By 1.0**, and code Apache 2.0. Exact license bytes and SHA-256 are preserved here and checked by the runner. The Hugging Face `allenai/scifact` card still says CC BY-NC 2.0; this conflicting secondary card is not being silently treated as permissive. We rely on the named data creator's explicit pinned license statement. This is evaluation-only use, not permission to distribute publisher fulltexts or add corpus/weights to SciPaper releases. ODC database rights do not imply unrestricted rights in every underlying work.

Attribution: David Wadden, Shanchuan Lin, Kyle Lo, Lucy Lu Wang, Madeleine van Zuylen, Arman Cohan, and Hannaneh Hajishirzi, *Fact or Fiction: Verifying Scientific Claims*, EMNLP 2020. https://aclanthology.org/2020.emnlp-main.609/ . Scientific abstracts originate from Semantic Scholar S2ORC: https://github.com/allenai/s2orc . Dataset source repository: https://github.com/allenai/scifact . License texts: https://creativecommons.org/licenses/by/4.0/ and https://opendatacommons.org/licenses/by/1-0/ . Input text transformation is abstract sentences joined by a space; titles retained separately for lexical ranking. Outputs contain only identifiers, metric numbers and provenance. No source corpus text is included in CI artifacts.

Download URL is the upstream official `release/latest/data.tar.gz`; **the SHA-256 and byte size, not `latest`, pin the exact release bytes**. If upstream bytes change, the job fails rather than silently adopting them. Archive member hashes are also pinned. Only two known tar members are read in memory; no archive paths are extracted.

## Frozen methodology

The public original `claims_dev` split has labels while original `claims_test` does not. We hold these 32 claims out from all tuning in this experiment; they are NOT hidden test labels and may overlap model pretraining. Take claims with nonempty evidence, order by SHA-256 of fixed seed + ID, first 32. The 512-candidate corpus includes all human evidence documents for those claims, actual full-corpus product BM25 top 8 per claim as hard distractors, and hash-ordered corpus remainder. This label-stratified construction is intentionally easier than retrieval among all 5,183 papers; it must not be presented as full-corpus benchmark performance. IDs and labels were frozen before native embeddings were run. Freeze verification is mandatory at each execution.

Supports and refutes are both relevant evidence, never "claim verified". Unjudged papers are treated as nonrelevant, an incompleteness caveat. Queries with no evidence are excluded, so absence-of-evidence quality is not measured. No train split is used, no parameters selected on these metrics. Fixed cutoffs 1/5/10/20, macro Recall/nDCG/MRR@k, and full candidate MRR. Retain per-query ranks and metrics to audit regressions.

The runner imports actual `clustering.ts` (no relative imports/dependencies) with Node 24 native TypeScript stripping, including tokenization, k1=1.2/b=.75 BM25, Float32 cosine and RRF k=60. Actual product worker is invoked unchanged with exact prefixes, 768-dimensional unit normalization, CPU 2 threads, overflow ERROR, 8 GiB address-space limit, 32 documents per process. Dense inputs are abstract-only, matching product `chunk.text`; lexical gets title + text. Abstracts are treated as one already-extracted chunk. This is not a PDF extraction/index/session/UI test. All sampled abstracts pass 8,192-byte admission without truncation; tokenizer overflow fails the run rather than dropping a positive or changing text.

## CI invocation

Python 3.12 and Node 24, standard Linux runner. No pip packages needed for evaluator. Parent must download/hash-verify and extract the exact pinned Linux LiteRT wheel plus pinned text model from the product's `runtime/assets.json` (already approved runtime preparation); do not pip-install an unpinned replacement. Extracted `litert_lm` native module is the worker's only nonstdlib dependency. Set total CI timeout to 65 minutes to permit bounded asset downloads plus the script's 60-minute inference budget; each process has 300-second ceiling. No automatic retries on inference failure.

```
python -m unittest discover -s PATH_TO_EVAL -p 'test_*.py'
python PATH_TO_EVAL/evaluate.py \
  --product-root PATH_TO_COPIED_PRODUCT_ROOT \
  --runtime PATH_TO_VERIFIED_EXTRACTED_WHEEL \
  --model PATH_TO_VERIFIED_TEXT_MODEL \
  --work "$RUNNER_TEMP/scifact-work" \
  --output quality-results
```

The copied product root only needs the three files named in `product-contracts.json` with matching bytes. Worker has no relative imports. No root workspace pnpm install is needed. The evaluator checks model hash and writes runtime-file hashes; parent asset preparation must establish wheel hash before extraction. `--lexical-only` skips native args for source/selection/ranking validation.

Upload **only quality-results/**, never work/external, model, wheel cache, or vectors. Keep evaluator files and frozen manifest/selection in source. Cache files are local normalized vectors bound to config/assets/contracts and request content. Resume uses validated exact IDs/dimensions/space/finite vectors, and explicitly reports cache hits; timings are not comparable to fresh execution. Batch timings include process and model reload. Peak child RSS includes ranking subprocesses; report it as observed evaluator child peak, not exclusive steady-state model RAM. CPU/memory/OS metadata is recorded. Runtime failure does not constitute a negative relevance result.

## Out of scope / next scientific visual evaluation

No red/blue image fixtures count as scientific retrieval evidence. A credible follow-on needs real scientific PDF pages or figure-caption retrieval with existing human page/figure relevance and individual source rights verified. ViDoRe candidates often contain generated questions, so their labels cannot silently be called human scientific judgments. Propose a separately reviewed, licensed human-annotated scientific-page subset before execution; compare title-only BM25, extracted-text retrieval, and vision on identical candidates and report exact-page accuracy. This work has not selected or executed such a visual benchmark.

## Recorded runtime repair, before any semantic quality result

Initial run `38148862660` at `d64c372b59df7baae00cb2d07f575fcc26c473fd` failed after 256 documents. Exact-batch diagnostic `38149335979` at `bb07a43805c59acc6fe3e639260a1dc4bb588aba` isolated document 27768226 (6,896 UTF-8 bytes), whose native error reported 1,336 tokens versus a 1,024 default limit. The artifact supports an 8,192-token signature. The shipped provider repair explicitly selects max_input_length=8192 and versions the embedding space/profile; ERROR overflow and 8 GiB memory limit remain. The evaluator now passes this same explicit context argument and pins the repaired worker. Frozen queries, all 512 documents, human labels, full abstract text, ranking constants and cutoffs are unchanged. No document was dropped, truncated or split to improve scores. Earlier failed runs are not quality results.
