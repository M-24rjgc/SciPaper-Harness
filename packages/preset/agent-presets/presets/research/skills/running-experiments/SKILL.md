---
name: running-experiments
description: Use to run the planned experiments — set up the project environment, write runnable code, submit independent runs that survive the chat, wait for them, collect metrics and outputs, and fill the paper's placeholders from real results.
---

# Running experiments

Runs are independent processes: they keep going if the chat ends or the app restarts, and every run's code, data and environment are snapshotted so results stay reproducible.

## 1. Environment

`research_environment` environment `{name, kind: uv, target: local, python: "", requirements: [...], isDefault: true}` creates a managed Python 3.12 environment inside the project and locks its packages. Bind an existing interpreter (`kind: existing`/`conda`, absolute path) when the user already has one with CUDA; binding asks the user. For a remote GPU server: `target: ssh`, an OpenSSH alias as `sshHost`, a dedicated absolute `remoteRoot`.

## 2. Code

Put experiment code under `code/`. Each entry script:
- takes its configuration from arguments or a config file (no edits between runs);
- seeds everything from `$RESEARCH_SEED`;
- writes final numeric metrics as a flat JSON object to `$RESEARCH_METRICS_PATH`;
- writes deliverables (per-epoch curves, per-class tables, predictions for plots) to `$RESEARCH_OUTPUT_DIR` (a relative `outputs/` also works).

Smoke-test on a tiny setting first (a few steps, small subset) before a full run.

## 3. Before spending compute — the ◆ checkpoint

List the runs (configs × seeds), GPUs, and a time estimate. With `checkpoints` autonomy ask with `ask_user_question`; with `automatic`, record the plan with `record-decision`. There is no budget in the program — the judgement is yours and the user's.

## 4. Submit and wait

`research_experiment` experiment `{requestId: <new UUID>, spec: {environmentId, name, argv: ["{python}", "code/train.py", "--config", "..."], cwd: ".", seed, maxSeconds, gpuIds: ["0"], dataEvidenceIds: [...], codeArtifactIds: [], codePaths: ["code"], metricsPath: "metrics.json"}}`.

- If a response is lost, submit again with the **same** requestId; never a new one.
- `experiment-wait {runIds, timeoutSeconds}` blocks until a run finishes (up to 30 minutes per call) — use it instead of polling. While long runs go, do other work (writing, figures) and wait again later.
- `experiment-logs` when a run fails; fix the code and submit a new run (new requestId). A run whose state is `unknown` after inspection can be dropped with `experiment-dismiss`.

Completed runs are collected automatically: metrics and `outputs/` files become verified data evidence.

## 5. Use the results

- Fill result tables and prose from the collected metrics (and a derive script for means/deltas — see `results-ingest`). Replace every `--` and `\tbd{}` the results answer.
- Plot from the collected outputs (`figures-from-data`).
- Report negative and inconclusive results honestly; if the hypothesis fails, say so and adjust the claims (a key decision under checkpoints).

## Done when

The `experiments` phase is done (runs completed and collected, none in progress), and the `results` phase check shows no placeholders or untraced numbers.
