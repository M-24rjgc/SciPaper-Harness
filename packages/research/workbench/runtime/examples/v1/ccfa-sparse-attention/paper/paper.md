# Content-adaptive sparse attention: a synthetic research illustration

## Abstract

A fixed sparse attention pattern spends the same budget on every input, although the useful connections may vary with content. This note formulates content-adaptive block selection and illustrates a matched-budget comparison using nine synthetic measurements. At a retained fraction of 0.25, mean illustrative accuracy is 88% for content-adaptive selection and 86% for a fixed pattern; the dense reference is 90%. These authored values demonstrate the structure of a research comparison and do not establish performance on a real model or dataset.

## Research question

The question is whether content-dependent allocation preserves more task information than a fixed allocation at the same sparsity. Separating allocation from budget is essential: a comparison with different retained fractions cannot isolate the selection mechanism.

## Candidate method

Partition the attention matrix into blocks. For block b, compute a relevance score s_b from its query and key content. Given B blocks and a retained fraction rho, retain K = ceil(rho B) blocks with the highest scores. Normalize attention within the retained entries. The fixed sparse control retains the same K blocks according to a content-independent pattern.

## Demonstration comparison

The CSV pairs three illustrative seeds across dense, fixed sparse and content-adaptive conditions. Accuracy is measured in percent. Each condition has a sample standard deviation of one percentage point.

| Method | Retained fraction | Mean accuracy (%) |
| --- | ---: | ---: |
| Dense | 1.00 | 90 |
| Fixed sparse | 0.25 | 86 |
| Content-adaptive | 0.25 | 88 |

The paired difference between the two sparse conditions is two percentage points in every row. Content-adaptive accuracy remains two percentage points below the dense reference. Figure 1 presents these same means; `code/analyze.py` calculates them directly from `data/pilot.csv`.

## Evidence boundary

All measurements are synthetic demonstration data. They support arithmetic inspection of the example, not an empirical advantage. A real study would include a random-selection control, multiple retention budgets, end-to-end latency, peak memory and genuine repeated training runs. The selector's overhead cannot be inferred from the retained fraction.

## Conclusion

The comparison separates the selection rule from its budget and gives each proposed claim a corresponding test. Its numerical pattern is illustrative; the content-allocation hypothesis remains untested on real workloads.
