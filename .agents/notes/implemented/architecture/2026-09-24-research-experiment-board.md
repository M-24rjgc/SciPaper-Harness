# Agent Note: An experiment board the agent lays out and scripts keep current

Status: implemented

English | [中文](2026-09-24-research-experiment-board.zh.md)

## Problem

Long experiments on a remote GPU server were followed by hand. A project that ran its own queue kept a hand-built dashboard: a local bridge that logged in over SSH, ran a project-specific collector and drew fold progress, training curves, paper tables and GPU use. The workbench had nothing like it. A run reported its metrics only when it exited, its card showed elapsed time against its time limit, and nothing showed the machines. Asking the agent to watch and restate the numbers would spend a model call on every look, and fixed fields such as folds and epochs fit one field of research and not the next.

## Decision

The workbench's experiment tab is a board with a fixed part and an agent-owned layout, and every number on it is read by scripts, never by the model.

- **Fixed part.** Every project gets the runs by status, each run in flight with its progress, estimate and curves, each experiment machine, and every run with its command, metrics and curves. The conversation header and each run card open the board.
- **Agent layout, no fixed fields.** `research_board` board-update stores sections built from eight kinds of block (`stats`, `table`, `chart`, `list`, `runs`, `text`, `kv`, `log`) in `.research/board/board.json`. A value is fixed, or follows runs by id or by name and seed. The page resolves it against the live record, so a finished run fills its table cells without a new read or an agent turn, and several finished seeds show their mean and sample standard deviation. The agent changes the layout when the plan or a conclusion changes, not after each run.
- **Progress lines.** A run appends JSON lines to `$RESEARCH_PROGRESS_PATH`. The supervisor's status carries the last line into the run record, so run cards show real progress on the observation they already make. The board draws the curves from the whole file, read locally, by the probe for a remote run in flight, or from the copy a finished remote run brings home.
- **Machine probe.** A standard-library script runs once per host, over SSH or locally, and reports GPUs through `nvidia-smi`, processor and memory use (a cgroup's quota and limit when there is one) and disk. Each read adds a sample to six hours of history.
- **Collectors.** For what only the project can read, such as a queue the user starts on a server, the agent writes a read-only Python script. The board runs it with an environment's interpreter while it is open, and the script prints `{stats?, sections?, alerts?}`. It runs without an approval prompt, as the agent's experiments already do. Parts that fail to parse are dropped and named, and the rest is kept. board-refresh runs every collector at once and reports each error, so the agent can fix a script in a few calls.
- **Reads without a model.** While the board is open the page asks every fifteen seconds; the service starts a background read at most every ten seconds, shares one under way, and saves the result in `.research/board/snapshot.json` for a reopened board.

## Consequences

- An open board makes one probe call per experiment host and one call per due collector every ten to thirty seconds; a closed board makes none, so its GPU history has gaps.
- GPU readings need NVIDIA's `nvidia-smi`; macOS processor and memory use are not read.
- A collector is project code the platform runs repeatedly on the user's server. It is visible in the project, bounded by a two-minute timeout and 4 MB of output, and runs only while the board is open or when the agent asks.
- The experiment tab's form for submitting a run by hand moved below the board, folded.
- The header utilities described in [Research Workbench as a conversation-first surface](../feature/2026-09-21-research-workbench-conversation-first-surface.md) gain the board button beside the project folder.

## Alternatives considered

**Have the agent keep the board's numbers.** Every refresh would cost a model call and tokens proportional to the board, and the numbers would be only as fresh as the last turn. The agent keeps the layout and scripts keep the numbers.

**A fixed dashboard schema of folds, epochs and datasets.** It fits the project that inspired the board and few others. The block kinds carry any protocol, and a collector covers what the blocks do not.
