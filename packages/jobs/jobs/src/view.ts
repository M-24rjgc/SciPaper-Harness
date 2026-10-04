/**
 * Client-safe job vocabulary: the read-only projection of one job and the
 * chunks its output ring hands out. This leaf reaches no Host package, so
 * browser programs and Remote wire types import it without pulling the
 * registry's Host declaration merges.
 * @module @deepseek-ai/dsh-jobs/view
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the Workspace registry's archive-admission family map this seam merges `job` into.
import type {} from '@deepseek-ai/dsh-workspace/types'
import type { JobId } from './brand.ts'

/**
 * Job lifecycle: `running`, optionally `stopping`, then exactly one terminal
 * status. Producer-specific facts belong in {@link JobView.progress} and
 * {@link JobView.detail}.
 */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** A background job owned by this session is running or stopping. */
    job: true
  }
}

/**
 * Producer-defined job kinds. Plugins extend this map by declaration merging;
 * the registry treats every value as an opaque id namespace.
 */
export interface JobKindMap {
  bash: 'bash'
  subagent: 'subagent'
}

/** The merge-extensible union of registered producer kind names. */
export type JobKind = JobKindMap[keyof JobKindMap]

/**
 * Stream label of one output chunk. `stdout` and `stderr` reach the model's
 * consuming read; `log` marks producer narration (a workflow's phase lines)
 * that only observers see. Consumers treat an unrecognized label like an
 * absent one.
 */
export type JobChannel = 'stdout' | 'stderr' | 'log'

/** One chunk of a job's output ring: absolute offset, text, channel, and loss marker. */
export interface JobChunk {
  /** Absolute offset of the chunk's first byte; offsets never move once assigned. */
  readonly at: number
  /** Chunk text exactly as appended (possibly tail-trimmed by retention). */
  readonly text: string
  /** Stream label, when the producer supplied one. */
  readonly channel?: JobChannel
  /** Bytes immediately before this chunk were lost, at the producer or to retention. */
  readonly gapBefore?: true
}

/**
 * Read-only projection of one job — a fresh object per call, never live
 * registry state. The model tools, the browser roster, and the observation
 * stream all consume this one shape.
 */
export interface JobView {
  /** The registry-issued id (`<kind>-N`). */
  readonly id: JobId
  /**
   * The producer kind the job was registered with: a Host-registered
   * `JobKind`, carried as an open string because a browser bundle or a Remote
   * codec sees only the `JobKindMap` merges its own program compiles.
   */
  readonly kind: string
  /** The producer-supplied one-line label. */
  readonly label: string
  /** Owning session; absent for an unowned job, which every caller can see. */
  readonly owner?: SessionId
  /** Producer-owned cap for complete model-facing notices and reads, in UTF-8 bytes. */
  readonly outputLimitBytes?: number
  /** Current lifecycle state. */
  readonly status: JobStatus
  /** The producer's live progress line (`3/10`, the current phase); cleared at settlement. */
  readonly progress?: string
  /** Terminal reason (`exit code: 3`); a recorded kill reason is merged in. */
  readonly detail?: string
  /** Epoch ms when the job was registered. */
  readonly startedAt: number
  /** Epoch ms when the job settled; absent while live. */
  readonly finishedAt?: number
  /**
   * The output ring's absolute coordinates and the complete-stream files
   * behind it. `total` is the offset the next chunk starts at (0 while
   * nothing was written); `earliest` is the oldest retained byte, greater
   * than zero exactly when retention dropped the head. `spillPaths` lists the
   * spill files the job's pull sources currently keep, in source order and
   * deduplicated, and is absent while no source keeps one: it outlives any
   * chunk, so a reader below `earliest` can still name where the bytes went.
   */
  readonly output: { readonly total: number; readonly earliest: number; readonly spillPaths?: readonly string[] }
}

/** Cancellation and observed settlement for one job, including a failed stop. */
export interface JobStopResult {
  readonly job: JobView
  /** Cancellation or observation failure; a terminal record alone does not prove termination after this failure. */
  readonly error?: string
}

/** One independently managed target observed by an explicit stop source. */
export interface StopSourceTarget {
  /** Source-specific stable resource identifier. */
  readonly id: string
  /** Fresh observed lifecycle state, including unknown when observation failed. */
  readonly status: string
  /** True only after the adapter verified this resource is no longer active. */
  readonly confirmed: boolean
  /** Cancellation or observation failure for this target. */
  readonly error?: string
}

/** Bounded cancellation report supplied by a detached-work adapter. */
export interface StopSourceReport {
  /** True only when every selected independent target was confirmed stopped. */
  readonly confirmed: boolean
  /** Individual resource observations; an empty list alone does not confirm an adapter failure. */
  readonly targets: readonly StopSourceTarget[]
  /** Adapter-wide cancellation or observation failure. */
  readonly error?: string
}

/** Source identity and its observed independent work. */
export interface NamedStopSourceReport extends StopSourceReport {
  /** Effect-scoped adapter's public registration label. */
  readonly source: string
}

/** Bounded stop of the live jobs owned by a session and its live runtime descendants. */
export interface JobStopReport {
  /** True only when all selected jobs and independent work were verified stopped. */
  readonly confirmed: boolean
  /** Actual ordinary-job projections and any cancellation or observation failures. */
  readonly jobs: readonly JobStopResult[]
  /** Explicit-stop adapters; these do not participate in ordinary cancellation or disposal. */
  readonly sources: readonly NamedStopSourceReport[]
}
