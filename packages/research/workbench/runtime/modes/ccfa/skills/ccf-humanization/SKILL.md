---
name: ccf-humanization
description: Required first preflight before every CCFA skill, including research, review, retrieval, experiments and visuals — direct reasoning and communication, no empty defensive framing, evidence and uncertainty preserved. Also for 去防御性 and 论文人性化 edits within an authorized task.
---

# CCF Humanization

Adapted from CCFA-Skills `ccf-humanization` (MIT). The upstream skill — the family baseline, the core rule, the four modes, the editing workflow and the warning contract — is in `references/upstream.md`, with `references/humanization-policy.md` (sentence decisions, bilingual repairs, punctuation) and `references/experiment-discipline.md` (full-method comparisons, ablations, smoke-check scope). Follow it; this page says how it runs here.

## Every task

Apply the family baseline once per task, then load ccf-common. Communicate the task, evidence and decisions directly; keep real risks, findings, uncertainty and mandatory checks; turn nothing critical into praise. This creates no report, warning file or separate agent.

## Editing prose

Only inside an authorized writing task (usually through ccf-paper-writer):

1. Recover each paragraph's scientific message and state it directly; delete self-defense instead of moving it elsewhere.
2. Keep citations, equations, numbers, terminology, negative results and required disclosures exactly.
3. For a section or the whole paper, run `research_artifact` run-script prose-quality with the file and `--scope section` or `--scope paper` (the upstream `check_prose_quality.py`), and look at the `prose` findings of `research_check`. Inspect each candidate in context; do not rewrite correct scientific language to clear a heuristic.
4. For experiment descriptions and tables, apply `experiment-discipline.md`: compare full configurations, label ablations.

## Warnings

A concrete decision the evidence cannot settle gets the upstream warning block in your reply — never inserted into a file. Under `checkpoints`, a blocking one becomes an `ask_user_question`; under `automatic`, decide on the evidence, record-decision and continue.
