---
name: ccf-experiment-designer
description: Design the smallest sufficient experiment package for a claim — datasets, baselines, metrics, ablations, robustness and execution priority — and present real results as tables and figure specs with explicit missing values. Use for 实验设计, 消融, baseline选择 and result tables. Visual composition belongs to ccf-visual-composer.
---

# CCF Experiment Designer

Adapted from CCFA-Skills `ccf-experiment-designer` (MIT). The upstream skill — design, result-template and result-presentation modes, the workflow and the design contract — is in `references/upstream.md`, with `evidence-design.md` and `result-templates.md` beside it and `../ccf-humanization/references/experiment-discipline.md` for full-method comparisons. Follow it; this page says how it runs here.

## Design

Write the design to `experiments/design.md` in the upstream shape: claim-evidence matrix, dataset and benchmark needs, confirmed method and baseline versions, baseline matrix, main experiments, ablations, robustness/failure/efficiency where claim-relevant, result tables with `TBD` cells, execution priority, no-fabrication status. Datasets, baselines and protocols whose origin is unresolved go to ccf-literature-searcher first. Record each planned experiment in `ccfa.yaml` `experiments`.

## Running it

The design becomes runs in this same project:

1. **Checkpoint.** Before anything runs, say what runs, how many seeds, on which GPUs and roughly how long. Under `checkpoints` ask with `ask_user_question` and record-decision the answer; under `automatic`, record-decision and go.
2. `research_environment` for the environment, code under `code/`, then `research_experiment` experiment per run (a new requestId each, seed and maxSeconds set, the data evidence and code named) and experiment-wait — the running-experiments skill has the details.
3. Write `experiments/results.md` (or `.csv`/`.json`) from the collected metrics with a script, never by hand; import it with `research_evidence` import so every number traces (the `numbers` check). The author's own measured results are imported the same way (the results-ingest skill).
4. Results that contradict the hypothesis are results: report them and hand the claim change to the orchestrator.

Smoke tests only for changed critical code paths, outside the evidence. A simplified run never fills a missing value.

## Presenting results

Result tables carry units, seeds, confidence intervals and metric direction from the collected data; a missing value stays marked. Figure specs (values, units, uncertainty, caption facts) go to ccf-visual-composer.

## Done when

The design phase shows `experiments/design.md`; the experiments phase shows collected results, no run in progress and `experiments/results.*` imported as data.
