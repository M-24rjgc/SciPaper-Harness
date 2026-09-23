---
name: results-ingest
description: Use when results already exist or after experiments — to bring measured data into the project as evidence, align the claims with what the data actually shows, and produce every derived number with a script.
---

# Bringing results in

The paper may only state numbers the data gives. This skill makes the data the project's ground truth.

## Steps

1. **Inventory** what the user has: result tables (CSV/JSON/XLSX exported to CSV), training logs, notes, draft text. Ask for anything referenced but missing.
2. **Import** each data file with `research_evidence` import. CSV and JSON become `data` evidence whose numbers the `numbers` check traces to. Import drafts and notes too (as full text) so they are quotable.
3. **Derive with a script, never by hand.** Means over seeds, standard deviations, deltas against a baseline, relative improvements, significance tests: write `code/analysis/derive.py` that reads the imported data and writes `data/derived/facts.json` (flat keys, e.g. `"ours.cifar10.acc.mean": 0.8123`). Run it in the project environment (`pwsh`/`bash` with the environment's python, or `research_experiment` for anything long), then import `facts.json`. Register the script as `code` and the facts file with the script as its input.
4. **Align the story with the data.** Compare what the draft or the user claims with what the numbers show. Where they disagree, the data wins: revise the claim, and record contradicted hypotheses as `contradicted` claims. With checkpoint autonomy, a result that contradicts the main hypothesis is a decision for the user.
5. **Link each key claim to its number**: `claim` with an exact quote (the number) at its locator (the CSV line or JSON key).

## Done when

Done when at least one current data source exists and every number you intend to report is present in imported data or a script's facts file (`facts.json`, `results.facts.json`).
