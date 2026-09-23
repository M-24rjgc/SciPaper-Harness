<!-- Upstream: spark-to-paper-skills @ c17149d, skills/ts-paper-experiment/resources/reporting_guideline_router.md (MIT, see the pack's LICENSE). Kept verbatim as the method reference; the research tools replace its scripts and keys, as ../SKILL.md says. -->

# Reporting Guideline Router

Route the paper type to the relevant reporting checklist (EQUATOR network). Use the checklist's
*spirit* even when the paper is not a clinical study: report data, method, evaluation, results,
limitations, and reproducibility.

| Paper type | Guideline |
|------------|-----------|
| Systematic review / meta-analysis | **PRISMA** |
| Observational study (cohort, case-control, cross-sectional) | **STROBE** |
| Randomized controlled trial | **CONSORT** |
| Animal preclinical study | **ARRIVE** |
| Diagnostic accuracy study | **STARD** |
| Case report | **CARE** |
| General ML / engineering paper | **Internal ML/engineering checklist** (below) |

## Internal ML / engineering checklist

For general ML/engineering papers without a formal guideline, report at minimum:

- **Data:** source, size, splits (train/val/test), preprocessing, leakage controls.
- **Method:** architecture/algorithm, key hyperparameters, training procedure.
- **Evaluation protocol:** metrics, baselines, comparison fairness, number of runs/seeds.
- **Results:** main results with variance; ablations where claimed.
- **Reproducibility:** seeds, hardware, software/library versions, code/data availability.
- **Limitations:** scope of validity, known failure modes, untested conditions.

## Usage

1. Identify the paper type during diagnosis (Step 2).
2. Pick the row above and note the guideline in `EXPERIMENT_GAP_REPORT.md`.
3. Use it to find **missing reporting items**, not to force experiments that were never run.
