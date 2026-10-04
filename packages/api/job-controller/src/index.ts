/**
 * Host job Remote owner: streams the background-job roster one session can
 * see and one job's retained output to browsers over the generated `job`
 * namespace, and stops a job on a human's behalf. The streams are
 * projections of `ctx.jobs`; the model's consuming cursor and notice state
 * never observe them, and a human kill is not the model's own, so the
 * completion notice still reaches the owning agent.
 * @module @deepseek-ai/dsh-api-job-controller
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { observeJobOutput } from './observe.ts'
import { streamJobRows } from './rows.ts'
import type { JobStopResult, NamedStopSourceReport } from '@deepseek-ai/dsh-jobs/view'
import type { JobKillRequest, JobKillValue, JobFollowFrame, JobFollowRequest, JobListFrame, JobListRequest, JobStopAllRequest, JobStopAllValue, SessionStopResult } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host job Remote namespace owner. */
    jobController: JobController
  }
}

/** Default coalescing window between reads, in milliseconds. */
const DEFAULT_OBSERVE_FLUSH_MS = 100

/** Default soft byte budget per output frame. */
const DEFAULT_OBSERVE_MAX_FRAME_BYTES = 64 * 1024

/** Job Controller deployment policy. */
export interface Config {
  /** Settlement wait for an explicit stop-all, in milliseconds (default 30000, at most 60000). */
  readonly stopWaitTimeoutMs?: number
  /** Coalescing window after a registry commit before the next rows or output read, in milliseconds (default 100). */
  readonly observeFlushMs?: number
  /** Soft byte budget per observation output frame (default 65536); one larger chunk ships whole. */
  readonly observeMaxFrameBytes?: number
}

/** Host service backing the generated `ctx.remote.job` namespace. */
export class JobController extends TypertRemoteService {
  static inject = ['jobs', 'typert']

  static Config: z<Config> = z.object({
    stopWaitTimeoutMs: z.natural().min(1).max(60_000).default(30_000),
    observeFlushMs: z.natural().min(1).default(DEFAULT_OBSERVE_FLUSH_MS),
    observeMaxFrameBytes: z.natural().min(1).default(DEFAULT_OBSERVE_MAX_FRAME_BYTES),
  })

  private readonly observeFlushMs: number
  private readonly stopWaitTimeoutMs: number
  private readonly observeMaxFrameBytes: number

  /**
   * @param ctx - Host context carrying the live Agent registry and the job registry.
   * @param config - observation cadence and framing policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'jobController', { namespace: 'job' })
    // schemastery (the exported Config schema) has already filled the defaulted
    // fields; the assertion records that resolution, not a hidden fallback.
    const resolved = config as Required<Config>
    this.observeFlushMs = resolved.observeFlushMs
    this.stopWaitTimeoutMs = resolved.stopWaitTimeoutMs
    this.observeMaxFrameBytes = resolved.observeMaxFrameBytes
  }

  /**
   * Stream jobs in the session's captured runtime ownership tree plus unowned jobs
   * as whole-set frames: one on open, then one after each coalesced burst of
   * lifecycle commits. The stream has no natural end; the carrier closes it.
   * @param request - the session whose visible set to mirror.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns the roster frames.
   */
  @Remote({ mode: 'stream' })
  list(request: JobListRequest, signal: AbortSignal): AsyncIterable<JobListFrame> {
    return streamJobRows(this.ctx.jobs, request, { flushMs: this.observeFlushMs }, signal)
  }

  /**
   * Stream one job's retained output from an absolute byte offset, then its
   * terminal projection once settled and drained. Non-consuming: the
   * model-facing cursor and notice state never observe these reads. The
   * request's session is the fenced read's caller; the registry rejects a
   * job the session cannot see and an unknown job.
   * @param request - target job, owner or trusted ancestor session, and optional resume offset.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns anchor, coalesced output frames, and the terminal status.
   */
  @Remote({ mode: 'stream' })
  follow(request: JobFollowRequest, signal: AbortSignal): AsyncIterable<JobFollowFrame> {
    return observeJobOutput(this.ctx.jobs, request, {
      flushMs: this.observeFlushMs,
      maxFrameBytes: this.observeMaxFrameBytes,
    }, signal)
  }

  /**
   * Kill one background job on a human's behalf. The request's session is
   * the fenced read's caller, so the job must be one that session can see:
   * the registry requires its captured owner or a trusted runtime ancestor.
   * A replacement using the same session id has no access. The kill records
   * `cancelled by the user` as its reason; it is not one the model requested,
   * so the owning agent still receives the completion notice, and a shell
   * tool waiting on that job reads the reason in its own result.
   * @param request - Session whose job list carries the job, and the job id.
   * @returns the registry's admission of the kill request.
   */
  @Remote('kill')
  kill(request: JobKillRequest): JobKillValue {
    const jobs = this.ctx.jobs
    try {
      jobs.getTree(request.jobId, request.sessionId)
    } catch (error) {
      // `unknown job` and `belongs to another session` both mean this session's
      // list no longer carries a killable row; the client renders one story.
      throw new RemoteError('job/not-found', String(error), {
        sessionId: request.sessionId,
        jobId: request.jobId,
      })
    }
    // Same synchronous span as the lookup, so nothing can remove the job in
    // between — and a producer-cancel throw propagates per the registry
    // contract (job state unchanged) instead of masquerading as job-not-found.
    const outcome = jobs.kill(request.jobId, request.sessionId, 'cancelled by the user')
    return { outcome }
  }

  /**
   * Stop the session's active turn, live runtime descendants, and their jobs.
   * Ordinary session cancellation retains detached jobs; this command explicitly
   * cancels them and reports observed settlement, including stops that timed out.
   * @param request - root session whose live ownership tree is stopped.
   * @param signal - cancellation of the bounded observation, not of requested stops.
   * @returns per-job states and whether no selected work remains live.
   */
  @Remote('stopAll')
  async stopAll(request: JobStopAllRequest, signal: AbortSignal): Promise<JobStopAllValue> {
    signal.throwIfAborted()
    const deadline = Date.now() + this.stopWaitTimeoutMs
    const agents = this.ctx.get('agents')
    const root = agents?.get(request.sessionId)
    const tree: Agent[] = []
    if (root !== undefined) tree.push(root)
    const gatherDescendants = (): void => {
      if (agents === undefined) return
      const seen = new Set(tree)
      for (const parent of tree) {
        for (const child of agents.list()) {
          if (!seen.has(child) && agents.isOwnedBy(child.id, parent)) {
            tree.push(child)
            seen.add(child)
          }
        }
      }
    }
    const cancelled = new Set<Agent>()
    const cancelErrors = new Map<Agent, string>()
    const stoppedAgents = new Map<Agent, SessionStopResult>()
    const stoppedJobs = new Map<string, JobStopResult>()
    const sources: NamedStopSourceReport[] = []
    const cancelAgents = (): void => {
      for (const agent of tree) {
        if (cancelled.has(agent) && agent.status !== 'running') continue
        try { agent.cancel({ kind: 'user' }, { keepInbox: false }) } catch (error) { cancelErrors.set(agent, String(error)) }
        cancelled.add(agent)
      }
    }
    while (true) {
      gatherDescendants()
      cancelAgents()
      const remainingMs = Math.max(0, deadline - Date.now())
      const [jobs, observedAgents] = await Promise.all([
        this.ctx.jobs.stopAll(request.sessionId, remainingMs, 'cancelled by the user', signal, deadline),
        Promise.all(tree.map(async agent => ({
          agent, result: await this.observeAgentStop(agent, cancelErrors.get(agent), remainingMs, signal),
        }))),
      ])
      jobs.jobs.forEach(result => stoppedJobs.set(result.job.id, result))
      sources.push(...jobs.sources)
      observedAgents.forEach(({ agent, result }) => stoppedAgents.set(agent, result))
      // Independent producers may admit work after the initial source scan,
      // while a cancelling Agent is still finishing its active tool call.
      // Observe them again after Agent quiescence, with the original deadline.
      if (!signal.aborted) {
        const final = await this.ctx.jobs.stopAll(request.sessionId, Math.max(0, deadline - Date.now()), 'cancelled by the user', signal, deadline)
        final.jobs.forEach(result => stoppedJobs.set(result.job.id, result))
        sources.push(...final.sources)
      }
      // Agent shutdown can finish a pending registration after the first job
      // scan. Re-scan both trees together before any success is returned.
      const count = tree.length
      gatherDescendants()
      const live = this.ctx.jobs.listTree(request.sessionId).filter(job => job.status === 'running' || job.status === 'stopping')
      const needsPass = tree.length !== count || live.some(job => !stoppedJobs.has(job.id))
        || tree.some(agent => stoppedAgents.get(agent)?.status !== agent.status)
      if (!needsPass || signal.aborted) break
      // A final zero-budget pass still issues cancellation for late jobs and
      // reports them unconfirmed; it never resets the total observation bound.
      if (remainingMs === 0) {
        cancelAgents()
        const final = await this.ctx.jobs.stopAll(request.sessionId, 0, 'cancelled by the user', signal, deadline)
        final.jobs.forEach(result => stoppedJobs.set(result.job.id, result))
        sources.push(...final.sources)
        break
      }
    }
    const jobs = [...stoppedJobs.values()]
    const agentStops = tree.map(agent => ({
      ...(stoppedAgents.get(agent) ?? { sessionId: agent.id, error: 'session stop was not observed' }), status: agent.status,
    }))
    const liveJobs = this.ctx.jobs.listTree(request.sessionId).some(job => job.status === 'running' || job.status === 'stopping')
    return {
      jobs, sources, agents: agentStops,
      confirmed: !liveJobs && agentStops.every(agent => agent.status === 'idle' && agent.error === undefined)
        && sources.every(source => source.confirmed && source.error === undefined
          && source.targets.every(target => target.confirmed && target.error === undefined))
        && jobs.every(result => result.job.status !== 'running' && result.job.status !== 'stopping' && result.error === undefined && !result.job.detail?.includes('work may be orphaned')),
    }
  }

  /** Bound whole-Agent quiescence without cancelling unrelated future work. */
  private async observeAgentStop(
    agent: Agent, cancelError: string | undefined, timeoutMs: number, signal: AbortSignal,
  ): Promise<SessionStopResult> {
    if (cancelError !== undefined) return { sessionId: agent.id, status: agent.status, error: cancelError }
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([
        agent.whenIdle(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { reject(new Error('session stop was not confirmed before the timeout')) }, timeoutMs)
          onAbort = () => {
            const reason: unknown = signal.reason
            reject(reason instanceof Error ? reason : new Error(String(reason)))
          }
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        }),
      ])
      return { sessionId: agent.id, status: agent.status }
    } catch (error) {
      return { sessionId: agent.id, status: agent.status, error: String(error) }
    } finally {
      clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }
}

export default JobController
