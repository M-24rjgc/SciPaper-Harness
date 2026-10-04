/**
 * Wire types of the generated `job` Remote namespace: the per-session roster
 * stream, the per-job observation stream, and the human kill. Client-safe: no
 * Host imports.
 * @module @deepseek-ai/dsh-api-job-controller/types
 */

import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { JobChunk, JobView } from '@deepseek-ai/dsh-jobs/view'
import type { JobStopReport } from '@deepseek-ai/dsh-jobs/view'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type { JobChunk, JobView } from '@deepseek-ai/dsh-jobs/view'

/** Target of one `job.list` stream: the session whose visible jobs the stream mirrors. */
export interface JobListRequest {
  readonly sessionId: SessionId
}

/**
 * One `job.list` frame: the complete set the session can see — its live runtime
 * ownership tree's jobs plus every unowned job — after a lifecycle change. Whole-set replacement,
 * so a reconnect's first frame is already the truth.
 */
export interface JobListFrame {
  readonly type: 'rows'
  readonly jobs: readonly JobView[]
}

/** Human-initiated cancellation of one background job visible to a session. */
export interface JobKillRequest {
  /** Session whose live runtime ownership tree can see the job. */
  readonly sessionId: SessionId
  readonly jobId: JobId
}

/** Receipt after the registry accepted the human kill request. */
export interface JobKillValue {
  readonly outcome: 'requested' | 'already-finished'
}

/** Explicit human stop of a session's active turn and its live descendant work. */
export interface JobStopAllRequest {
  readonly sessionId: SessionId
}

/** Observed quiescence of one runtime Agent after the stop request. */
export interface SessionStopResult {
  readonly sessionId: SessionId
  readonly status: 'idle' | 'running'
  /** Cancellation, observation, or timeout failure. */
  readonly error?: string
}

/** Observed Agent quiescence and job settlement after an explicit session-tree stop. */
export interface JobStopAllValue extends JobStopReport {
  readonly agents: readonly SessionStopResult[]
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The session's job list no longer carries a killable row under that id. */
    'job/not-found': { readonly sessionId: SessionId; readonly jobId: JobId }
  }
}

/** Target of one `job.follow` stream: the job, its owning session, and an optional resume offset. */
export interface JobFollowRequest {
  /**
   * Caller session whose live runtime ownership tree can see the job. Omitted for an unowned job, which any
   * caller may observe.
   */
  readonly sessionId?: SessionId
  readonly jobId: JobId
  /**
   * Absolute byte offset to resume from (a prior frame's `next`). Omitted, the
   * stream starts at the oldest retained byte.
   */
  readonly from?: number
}

/**
 * Job observation stream frames: one `opened` anchor carrying the job's
 * projection (its `output.earliest` and `output.total` at open time) and the
 * offset the first `output` frame continues from, then coalesced `output`
 * batches, then — once the job has settled and its ring is drained — one
 * terminal `status` carrying the settled projection, after which the stream
 * closes normally. Status rides the same stream as output so settlement can
 * never race a still-open output channel.
 */
export type JobFollowFrame =
  | {
    readonly type: 'opened'
    readonly job: JobView
    /** Offset the first `output` frame continues from. */
    readonly from: number
  }
  | {
    readonly type: 'output'
    readonly chunks: readonly JobChunk[]
    /** Offset to resume from after this frame. */
    readonly next: number
    /** Bytes between the requested offset and `chunks` were already evicted. */
    readonly lossy?: true
  }
  | {
    readonly type: 'status'
    readonly job: JobView
  }
