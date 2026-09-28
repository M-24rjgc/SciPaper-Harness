# Evaluation design

## Question and mechanism

The proposed mechanism assigns a score to each attention block from its query and key content, then retains the highest-scoring blocks under a fixed budget. The hypothesis is that allocating the same budget to relevant blocks loses less task accuracy than retaining a fixed geometric pattern.

## Matched comparison

Dense attention is the accuracy reference. Fixed sparse attention and content-adaptive attention both retain 25% of entries. A real evaluation would hold the backbone, tokenizer, sequence lengths, training data, optimizer, training steps and seeds constant. The selector's additional computation belongs in end-to-end latency and peak-memory measurements.

## Tests tied to claims

1. Accuracy at a matched retained fraction tests the allocation hypothesis.
2. A random selector with the same budget separates content selection from sparsity alone.
3. A budget sweep tests whether the effect persists beyond one fraction.
4. End-to-end latency and peak memory test computational benefit, including selector overhead.

The bundled CSV illustrates only the first comparison with synthetic values. It contains no evidence for the other three claims. Confidence intervals and significance claims require genuine repeated observations and an appropriate sampling design.
