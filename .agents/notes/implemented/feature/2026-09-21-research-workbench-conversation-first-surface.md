# Agent Note: Research Workbench as a conversation-first surface

Status: implemented

English | [中文](2026-09-21-research-workbench-conversation-first-surface.zh.md)

## Problem

The Research Workbench shipped as a second application beside the conversation: a `main` panel of six tab pages, listed in the sidebar as a peer of the chat, holding forms for evidence import, artifact editing, environment binding and experiment submission. Neither surface explained its relation to the other, and the panel asked researchers to paste internal UUIDs into text inputs to submit a run.

That layout contradicts the system underneath it. Every stage of `dsh-research-workbench` produces a prompt that goes into an ordinary session, the model does the work through research tools, and exactly three decisions are the user's: the question, the method, and the experiment protocol with its budget. A form-filling surface hides the one thing a researcher needs to see — where the research stands and what it is waiting on.

Two facts the design needed were also absent from the record. `ResearchStage` carried no timestamp, so "you confirmed this on the 18th" could not be stated. `ExperimentRecord` carried no start time, because `stateSchema` in `experiments.ts` is a non-strict Zod object and silently dropped the `startedAt`/`finishedAt` the Python supervisor already writes into `state.json` every half second.

## Decision

Research contributes into the shipped conversation through slots and owns no application of its own.

- Blank session: the flask mark, three openings that teach what to say, three standing promises. Unchanged from the previous pass.
- Active session: the stage position in the conversation header (`conversation.session.header.actions`), the project folder and pause controls beside it (`.utilities`), the open decision above the composer (`conversation.input.dock`), and the submitted experiment group below it (same seat, higher order).
- The record reports itself read-only in the right sidebar: a stage spine with a caption per stage, counts carrying their own exceptions (stale evidence, unverified claims, open runs), the approved run budget and what it has bought, and the environment the runs are pinned to.
- A claim's sources open over the whole frame from the rail, through `shell.overlay` and the `Modal` primitive. There is no dialog service in the client; `shell.overlay` is the only frame-wide seat.
- Every configurable value lives in the settings panel. The workbench surfaces carry none.
- The project's files stay reachable as a `main` panel, but the `sidebar.panellist` row is gone, so nothing presents them as a peer of the conversation. The header's project-folder control is now the only way in.
- The composer's tool row carries the one way to start a project without addressing the model first. It renders only while this conversation has no project, picks a folder through `remote.directoryPicker`, creates the project there with the composer draft as its brief, and starts the materials stage — that start is what binds the pipeline to this session, and without it the conversation would stay unattached and nothing would report on it. Removing the sidebar row without this control left a fresh installation with no way to create its first project at all.

Every session-scoped seat selects its project by `project.sessionId === sessionId`, never by position in the snapshot. `snapshot()` returns every project in the domain table across every workspace, and `dispatchStage` binds a project to the session its pipeline runs in, so the session id is the only thing that says which research a given conversation is about. Two of these seats write — the header's pause and the decision card's confirm — so a positional pick could halt or settle a stage in research the open conversation has nothing to do with. A conversation no project has been dispatched into reports nothing, which is correct: it is not that project's conversation. The blank-session resume card stays deliberately cross-project, because walking back into another project is what it is for.

Two fields were added to the record so the surface can state facts rather than approximate them. `ResearchStage.confirmedAt` is set by `confirmStage` and deleted wherever `confirmedRevision` is deleted. `ExperimentRecord.startedAt`/`finishedAt` come from widening `stateSchema` to keep the supervisor's epoch seconds, converted to ISO in one `applyState` helper shared by `launchExperiment` and `observeExperiment`.

## Alternatives considered

**Render the protocol decision as the six-field grid the design draws (datasets, baselines, metrics, ablations, seeds, hardware).** Only the last two are on the record; the rest live in free text inside `ResearchStage.summary` and the protocol artifact. Structuring them would mean a new command field, a schema change, a tool-schema change and a prompt change so the model fills it — a product change beyond this surface. The card shows the summary, the environment, the budget, and a link to the protocol artifact in full.

**Show live metric values on a running experiment card.** `experiment_runner.py` writes `metrics.json` only after `child.wait()`, and `observeExperiment` assigns `state.metrics ?? run.metrics` where an empty object is not nullish, so a mid-run poll overwrites with `{}`. A running card therefore shows elapsed time against the approved ceiling and nothing it cannot substantiate.

**Link "manage environments" to the settings panel.** `ui-settings` exposes `openSection` only to the onboarding coordinator; there is no plugin-facing API to open the panel. The rail names the destination instead of offering a control that cannot work.

**Delete the file workbench outright.** The design removes it as a peer application, not as a capability, and nothing else in the product edits an artifact or drives draw.io. Unlisting it achieves the former without discarding the latter.

## Consequences

`ctx.layout.selectPanel` throws when its `main` key is unregistered, so the `main` registration and `ResearchInjected.expand` must stay together; the header control is now their only caller. Removing `ResearchCompanion` removed the duplicate side panel and two of the package's lint violations.

`t` interpolates `{name}` placeholders, so counted and dated sentences are single dictionary entries rather than fragments concatenated at the render site; `decisionBudgetMath` was collapsed from two keys plus glue into one. Dates format through dictionary templates and `pad2`, not `Intl`, because `toLocaleString` follows the browser language rather than the interface language.

The package's stylesheets now satisfy the theme gates that were already red before this change: `corner-shape: round` accompanies every circular radius, solid neutral-token borders are 0.5px hairlines, and each scroll container on a tinted surface rebinds the l2 scrollbar pair.

`publicProject` still blanks `EvidenceRecord.chunks`, so the claim sheet shows `EvidenceLink.quote` — the text the host validated against the source at write time — and shows a source digest only while `source.revision === link.revision && !source.stale`, because the stored hash belongs to the current revision and not to the one the link cites.
