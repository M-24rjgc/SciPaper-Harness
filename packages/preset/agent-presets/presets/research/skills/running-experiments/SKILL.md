---
name: running-experiments
description: Use to run the planned experiments — set up the project environment, write runnable code, submit independent runs that survive the chat, wait for them, lay out the experiment board, collect metrics and outputs, and fill the paper's placeholders from real results.
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
- writes deliverables (per-epoch curves, per-class tables, predictions for plots) to `$RESEARCH_OUTPUT_DIR` (a relative `outputs/` also works);
- appends one JSON object per line to `$RESEARCH_PROGRESS_PATH` as it goes (every epoch or every few hundred steps): the numbers worth watching, plus `progress` (0 to 1) and a short `note` such as `"fold 2/5"`. The run cards and the experiment board draw these lines live; skip it when the variable is unset.

Smoke-test on a tiny setting first (a few steps, small subset) before a full run.

## 3. Before spending compute — the ◆ checkpoint

List the runs (configs × seeds), GPUs, and a time estimate. With `checkpoints` autonomy ask with `ask_user_question`; with `automatic`, record the plan with `record-decision`. There is no budget in the program — the judgement is yours and the user's.

## 4. Submit and wait

`research_experiment` experiment `{requestId: <new UUID>, spec: {environmentId, name, argv: ["{python}", "code/train.py", "--config", "..."], cwd: ".", seed, maxSeconds, gpuIds: ["0"], dataEvidenceIds: [...], codeArtifactIds: [], codePaths: ["code"], metricsPath: "metrics.json"}}`.

- If a response is lost, submit again with the **same** requestId; never a new one.
- `experiment-wait {runIds, timeoutSeconds}` blocks until a run finishes (up to 30 minutes per call) — use it instead of polling. While long runs go, do other work (writing, figures) and wait again later.
- `experiment-logs` when a run fails; fix the code and submit a new run (new requestId). A run whose state is `unknown` after inspection can be dropped with `experiment-dismiss`.

Completed runs are collected automatically: metrics and `outputs/` files become verified data evidence.

## 5. The experiment board

The user follows the experiments on the board (Experiment board, in the conversation header). It already lists every run and each experiment machine; your part is the layout that says what the runs mean for this project, with `research_board` board-update. Lay it out once, when you plan the runs, and change it when the plan changes or a conclusion comes in — never after every run, and never with numbers typed in: scripts keep every number current, so no model call is spent watching.

- The paper's result tables become `table` blocks whose cells follow runs by name (`{run: "main/cifar", metric: "acc", scale: 100, digits: 1}`); a name with several seeds shows the mean ± sd. Mark a target the method has to reach with `target`.
- Group a batch of runs in a section with a `runs` block (`match: "ablation/*"`) and a `text` block with the batch's purpose; when it finishes, write its conclusion into that `text` block and fold superseded batches with `collapsed`.
- Plot curves from the progress lines with `chart` blocks (`{run, key: "val_acc"}`).
- When the runs are not submitted through `research_experiment` (a queue the user runs on a server, a results folder), write a small read-only collector script (standard library only) that reads those files and prints `{stats, sections, alerts}`, and add it to `collectors`. Check it with board-refresh until it reports no error.

## 6. Use the results

- Fill result tables and prose from the collected metrics (and a derive script for means/deltas — see `results-ingest`). Replace every `--` and `\tbd{}` the results answer.
- Plot from the collected outputs (`figures-from-data`).
- Report negative and inconclusive results honestly; if the hypothesis fails, say so and adjust the claims (a key decision under checkpoints).

## Done when

Done when the runs are completed and collected, none is in progress, and `research_check` shows no placeholders or untraced numbers.
