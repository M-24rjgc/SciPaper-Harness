---
description: "Host and Client job control: the roster one session can see and one job's retained output, mirrored to the browser without touching the model's consuming cursor, and a kill on a human's behalf."
kind: "package-reference"
---
# Job Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-job-controller` lets the desktop list a session's visible jobs, read their retained output, stop one job, or stop all session work and verify settlement. `job.list` mirrors the roster; `job.follow` reads output from an absolute byte offset. Neither stream changes the model's consuming cursor or completion notices. `job.kill` and `job.stopAll` act on the human's behalf. The Client `ctx.jobs` service shares roster and output streams among viewers and supplies the session-header job list and stop controls.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Host controller requires the live Agent registry and the job registry (`dsh-jobs-local` in the shipped compositions) and fails to load without them. `job.list({ sessionId })` yields the session's visible set — its live runtime ownership tree's jobs plus every unowned job — once on open and again after each coalesced burst of lifecycle commits (registration, progress, stopping, settlement, removal); output appends never refresh the roster, since a settled projection already carries the final byte count. `job.follow({ sessionId?, jobId, from? })` resolves visibility through `getTree` and preserves the actual caller session for every non-consuming read — an unowned job needs no session — and yields one `opened` anchor carrying the job projection, coalesced `output` frames, then one terminal `status` once the job has settled and its ring is drained, after which the stream closes normally; a removal announced mid-stream (the owner's teardown) closes it with the removed job's terminal projection. Both reads are non-consuming: the model's `job_output` cursor and notice state never observe them.

`job.kill({ sessionId, jobId })` cancels one job the session can see with the reason `cancelled by the user`, which the registry merges into the killed job's detail. It is not a kill the model requested — `dsh-tool-jobs` withholds a notice only for settlements a live wait collected — so the owning agent's completion notice stays due, reason included, and a shell tool still waiting on that job reads the reason as `[stopped: cancelled by the user]` in its own result. It answers `{ outcome: 'requested' }` or `{ outcome: 'already-finished' }` and rejects an id the session cannot see as `job/not-found`; runtime ownership grants the root access to its descendants' jobs; unrelated roots remain isolated.

The Client entry installs `ctx.jobs` (`IJobs`), backed by the package-internal `ClientJobsModel`. `kill(sessionId, jobId)` forwards to `job.kill` and returns the Remote result for the caller's admission verdict. `watchRows(sessionId)` keeps one roster stream open per watched session however many viewers hold it and drops the rows after the last release; a reconnect's first frame is already the whole truth. `observe(sessionId, jobId)` opens one Gateway stream per job however many viewers expand it, keeps a bounded render tail per job with `gapBefore` marking eviction or resume gaps, closes the view on the terminal frame or records a stream failure on it, and drops the view after the last viewer releases. The plugin resolves the Gateway stream factory and the `job` namespace while its own context is current, because stream (re)opens run on caller stacks whose dynamic context has not declared `remote.job`.

`job.stopAll({ sessionId })` explicitly cancels the session's active turn and live runtime-owned descendants, clears their queued work, and requests cancellation of their jobs and all unowned jobs visible to the session. It observes Agent quiescence and job settlement concurrently within `stopWaitTimeoutMs` (default 30 seconds, maximum 60 seconds). The result includes `agents`, `jobs`, and independent-work `sources` with actual states and errors; `confirmed` is false for timeout, failed cancellation, active work, or possible orphaned processes. Independent-work hooks run only for this explicit command, and a final source scan after Agent quiescence catches work admitted during shutdown. Every phase shares the same absolute deadline. Ordinary `session.cancel` continues to leave detached background work alive. The Client `ctx.jobs.stopAll(sessionId)` forwards this report.

### Config

| Field | Default | Meaning |
|---|---:|---|
| `stopWaitTimeoutMs` | `30,000` | Bounded concurrent Agent and job stop observation, at most 60,000 ms |
| `observeFlushMs` | `100` | Coalescing window after a registry commit before the next rows or output read, in milliseconds |
| `observeMaxFrameBytes` | `65,536` | Soft byte budget per observation output frame; one larger chunk ships whole |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-job-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as job observation is browser and Host control state; it registers no prompt, tool, or session event. The model's own view of the same work stays with [`dsh-tool-jobs`](../../jobs/tool-jobs/README.md).

#### KV Cache effect

No direct effect; observation reads never touch model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The ring is a best-effort live preview, not a terminal transcript: producers' pull sources are copied per poll round, so two streams' writes inside one poll window land stdout first, and the client concatenates chunks regardless of `channel`.
- Both streams are process-local: a Host restart loses every ring and roster; a resumed observation then anchors on an empty registry, and a re-opened roster starts empty.
- Per-session fencing is enforced by the caller argument of each registry read; the Remote layer itself serves any connected browser.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The controller is a stateless projection of `ctx.jobs` reads; the registry's own `@deepseek-ai/dsh-jobs/invariant` owns the event protocol and event-versus-read relations these streams forward.
