# Evidence-grounded summaries: a synthetic consistency illustration

## Abstract

A fluent summary can contain factual statements that its source does not support. This note describes a source-support check and illustrates a paired comparison with six synthetic scores. Mean illustrative consistency is 87% for the baseline and 91% for the evidence-grounded condition, a difference of four percentage points. The scores are authored demonstration values, not outcomes of a model evaluation or an annotation study.

## Problem and mechanism

The research question is whether associating each factual statement with source spans can reduce unsupported content without losing important information. The candidate first drafts a summary, associates factual statements with supporting spans, and revises or omits statements lacking support. The proposed mechanism is the support check, so the appropriate control removes that check while holding the source, model, length budget and decoding settings constant.

## Evaluation definition

Consistency is the fraction of factual summary statements supported by their source. A real annotation study would predefine segmentation, the denominator and how unverifiable statements are treated. Coverage and readability are necessary companion measurements because consistency alone can reward omission.

## Demonstration results

`data/results.csv` has three paired illustrative seeds per condition. Each condition has a sample standard deviation of one percentage point.

| Condition | Mean consistency (%) | Difference from baseline (percentage points) |
| --- | ---: | ---: |
| Baseline | 87 | 0 |
| Evidence-grounded | 91 | 4 |

Each paired row differs by four percentage points. Figure 1 shows the means on a 0–100 scale. `code/analyze.py` reproduces the means and paired differences without third-party dependencies. Percentages and percentage-point changes are kept distinct.

## Evidence boundary

No summaries were generated or annotated for this illustration. The synthetic rows contain no coverage, readability, human agreement, latency or token-cost evidence. No significance or generalization claim follows from the constant paired difference. A real mechanism test requires a support-check ablation with paired documents and blinded annotation.

## Conclusion

The example makes the result table, arithmetic and research claim agree. Source grounding is a testable mechanism, but its factuality benefit and information-retention cost remain empirical questions.
