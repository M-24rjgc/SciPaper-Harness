/**
 * The background-job Service Definition (`ctx.jobs`). It owns the contract for
 * job ids, session-scoped access, lifecycle state, the per-job output ring —
 * one bounded stream that the model consumes through a registry-kept cursor
 * and that any number of observers read at absolute byte offsets — and the
 * event stream announcing every commit, while producers retain their
 * execution resources. The process-local registry lives in
 * `@deepseek-ai/dsh-jobs-local`.
 * @module @deepseek-ai/dsh-jobs
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import { installJobArchiveAdmission } from './archive-admission.ts'
import type { JobEvents, JobId, JobOutputRead, JobRead, JobSpec, JobView, SessionStopRequest, SessionStopSource } from './types.ts'
import type { JobStopReport, JobStopResult, NamedStopSourceReport } from './view.ts'

export { JobId } from './types.ts'
export type { JobStopReport, JobStopResult, StopSourceTarget, StopSourceReport, NamedStopSourceReport } from './view.ts'
export type { SessionStopRequest, SessionStopSource } from './types.ts'
export type {
  JobAppendOptions,
  JobChannel,
  JobChunk,
  JobEvent,
  JobEventFilter,
  JobEventListener,
  JobEvents,
  JobHandle,
  JobHooks,
  JobKind,
  JobKindMap,
  JobOutcome,
  JobOutputRead,
  JobOutputSource,
  JobRead,
  JobSettleCause,
  JobSourceRead,
  JobSpec,
  JobStatus,
  JobView,
} from './types.ts'

interface StopSourceLayer {
  sources: Set<{ name: string; stop: SessionStopSource }>
  isEmpty(): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    jobs: JobRegistry
  }
}

/**
 * Abstract background job registry. Subclass, implement the abstract members,
 * and load the subclass as a plugin — it registers as `ctx.jobs` (one
 * implementation per context; loading a second throws, which is cordis'
 * standard duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - Registrations outlive producer and controller fibers. Owner and
 *   service disposal cancel live work and await compliant producers; a
 *   throwing teardown cancel force-fails only the record. Such settlements
 *   announce `cause: 'teardown'`, because a job whose owner is being destroyed
 *   has no reader left.
 * - Caller session ids resolve to exact registered runtimes. Owned-job access
 *   requires the captured owner or a trusted runtime ancestor; a replacement
 *   using the same session id inherits no access.
 * - Settlement is first-wins: one terminal record, released waiters, then one
 *   round of contained event delivery, even against a late producer outcome.
 *   The `settled` event follows every released waiter and reports whether it
 *   released one (`awaited`), so a completion reporter can skip settlements a
 *   waiting caller already collected.
 * - A settled record stays listed until its owner's disposal, service
 *   disposal, or an explicit {@link remove} by a caller that collected the
 *   terminal state itself and never handed the id out. Records reporting possibly
 *   orphaned work survive owner disposal, refuse explicit removal, and keep
 *   {@link stopAll} unconfirmed until service disposal removes them.
 * - {@link start} refuses work while no attached job controller serves the
 *   spec's owner, so a producer cannot start work that owner cannot collect
 *   or stop. One registry serves every composition in the process, so this
 *   question — and event delivery under `{ owners: 'scope' }` — is
 *   owner-relative rather than process-wide: registrations made from an
 *   unscoped context serve every owner, and registrations made under an agent
 *   composition's scope serve exactly the agents composed under it.
 * - Every job owns one output ring. Pull sources named by the spec are pumped
 *   by the registry and drained once more before settlement; pushed appends
 *   land whole. The model's consuming cursor and observers' absolute offsets
 *   read the same bytes and never disturb each other.
 * - Ring retention is bounded. Appends past the live cap drop the oldest
 *   retained bytes; a reader below the retained window gets a lossy read,
 *   never an error. Settlement trims retention to the settled cap and ends
 *   the stream; the ring has no separate lifecycle.
 */
export abstract class JobRegistry extends Service {
  private readonly stopSources = new ScopedLayers<StopSourceLayer>(() => ({
    sources: new Set<{ name: string; stop: SessionStopSource }>(),
    isEmpty() { return this.sources.size === 0 },
  }), () => {})
  constructor(ctx: Context) {
    // `abstract` erases at runtime, so a composition row naming this package
    // would register a ctx.jobs with no method implementations and fail far
    // from the misconfiguration. Fail loud at load instead.
    if (new.target === JobRegistry) {
      throw new Error('@deepseek-ai/dsh-jobs is the abstract job registry seam; load an implementation such as @deepseek-ai/dsh-jobs-local instead')
    }
    super(ctx, 'jobs')
    // Archive admission: the Workspace registry asks what still runs for a
    // Session before hiding it; owned jobs answer here for every implementation.
    installJobArchiveAdmission(ctx, this)
  }

  /** Lifecycle and output events, filtered per subscription. */
  abstract readonly events: JobEvents

  /**
   * Attach an explicit-stop adapter without adopting its independent resources.
   * Scope visibility and plugin teardown follow the registering Cordis context;
   * the source validates target authority from exact runtime ownership itself.
   * Ordinary cancellation and registry/owner disposal never invoke this hook.
   * @param name - stable adapter label included in the stop report.
   * @param source - bounded cancellation and real-state observation.
   * @returns disposer removing only the hook, without stopping its work.
   */
  registerStopSource(name: string, source: SessionStopSource): () => void {
    if (name.length === 0) throw new Error('stop source name must not be empty')
    const entry = { name, stop: source }
    return this.stopSources.effect(this.ctx, (layer) => {
      layer.sources.add(entry)
      return () => { layer.sources.delete(entry) }
    }, { label: `jobs.stopSource(${name})` })
  }

  /** Resolve only live runtime ownership; persisted fork headers are unrelated. */
  private stopRequest(
    caller: SessionId | undefined, deadline: number, reason: string | undefined, signal: AbortSignal | undefined,
  ): SessionStopRequest {
    const registry = this.ctx.get('agents')
    const root = caller === undefined ? undefined : registry?.get(caller)
    const agents: Agent[] = root === undefined ? [] : [root]
    const seen = new Set(agents)
    if (registry !== undefined) for (const parent of agents) {
      for (const child of registry.list()) if (!seen.has(child) && registry.isOwnedBy(child.id, parent)) {
        agents.push(child)
        seen.add(child)
      }
    }
    return {
      agents, deadline,
      ...caller === undefined ? {} : { sessionId: caller },
      ...root === undefined ? {} : { caller: root },
      ...reason === undefined ? {} : { reason },
      ...signal === undefined ? {} : { signal },
    }
  }

  /** Invoke eligible detached-work adapters concurrently within the same absolute bound. */
  private async stopIndependentWork(request: SessionStopRequest): Promise<NamedStopSourceReport[]> {
    const eligible = new Set(this.stopSources.global.sources)
    for (const agent of request.agents) for (const layer of this.stopSources.chainLayers(scopeOf(agent.ctx))) {
      for (const source of layer.sources) eligible.add(source)
    }
    return Promise.all([...eligible].map(async (source) => {
      if (request.sessionId !== undefined && request.caller === undefined) {
        return { source: source.name, confirmed: false, targets: [], error: 'no live runtime caller is available to authorize independent work stops' }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      try {
        const report = await Promise.race([
          Promise.resolve().then(() => source.stop(request)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error('independent work stop was not confirmed before the timeout'))
            }, Math.max(0, request.deadline - Date.now()))
            onAbort = () => {
              const reason: unknown = request.signal?.reason
              reject(reason instanceof Error ? reason : new Error(String(reason)))
            }
            request.signal?.addEventListener('abort', onAbort, { once: true })
            if (request.signal?.aborted) onAbort()
          }),
        ])
        return { ...report, source: source.name }
      } catch (error) {
        return { source: source.name, confirmed: false, targets: [], error: String(error) }
      } finally {
        clearTimeout(timer)
        if (onAbort !== undefined) request.signal?.removeEventListener('abort', onAbort)
      }
    }))
  }

  /**
   * Preflight access, validation, owner cleanup, and implementation-owned
   * admission before starting and atomically registering work. Any preflight
   * rejection leaves no job id or execution resource. A throwing starter
   * leaves nothing registered; after it returns, registration cannot fail.
   * @param spec - job identity, owner, output sources, and synchronous starter.
   * @returns the registry-issued `<kind>-N` id.
   */
  abstract start(spec: JobSpec): JobId

  /**
   * List caller-owned and unowned jobs in registration order.
   * @param caller - reading session; omission sees only unowned jobs.
   * @returns fresh projections.
   */
  abstract list(caller?: SessionId): JobView[]

  /**
   * List accessible jobs across the caller's runtime ownership tree. A provider
   * may retain trusted admission-time ancestry until an owner's jobs drain.
   * Durable fork lineage never grants access to another root Agent.
   * @param caller - root session; omission sees only unowned jobs.
   * @returns deduplicated projections including unowned jobs.
   */
  listTree(caller?: SessionId): JobView[] {
    const jobs = new Map(this.list(caller).map(job => [job.id, job]))
    const agents = this.ctx.get('agents')
    const root = caller === undefined ? undefined : agents?.get(caller)
    if (root !== undefined && agents !== undefined) {
      const owners = [root]
      for (const owner of owners) {
        for (const child of agents.list()) {
          if (!agents.isOwnedBy(child.id, owner)) continue
          owners.push(child)
          for (const job of this.list(child.id)) jobs.set(job.id, job)
        }
      }
    }
    return [...jobs.values()]
  }

  /**
   * Project one job visible to the caller's live runtime ownership tree.
   * @param id - job to look up.
   * @param caller - root session; omission sees only unowned jobs.
   * @returns a fresh projection, rejecting unknown or unrelated jobs.
   */
  getTree(id: JobId, caller?: SessionId): JobView {
    return this.listTree(caller).find(job => job.id === id) ?? this.get(id, caller)
  }

  /**
   * Cancel all live accessible jobs, then await their settlement concurrently.
   * A timeout or aborted wait never claims termination. Cancellation failures
   * are isolated per job, and newly admitted live jobs remain unconfirmed.
   * @param caller - session whose live ownership tree is stopped.
   * @param timeoutMs - non-negative finite bound; zero requests stops without waiting.
   * @param reason - cancellation reason forwarded to every selected producer.
   * @param signal - cancels observation; already requested stops remain in force.
   * @param deadlineAt - optional enclosing absolute deadline; can only shorten this wait.
   * @returns actual job states and whether all selected work stopped.
   */
  async stopAll(
    caller: SessionId | undefined, timeoutMs: number, reason?: string, signal?: AbortSignal, deadlineAt?: number,
  ): Promise<JobStopReport> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('invalid stop timeout: expected non-negative finite milliseconds')
    signal?.throwIfAborted()
    const live = (job: JobView): boolean => job.status === 'running' || job.status === 'stopping'
    if (deadlineAt !== undefined && !Number.isFinite(deadlineAt)) throw new Error('invalid absolute stop deadline')
    const deadline = Math.min(Date.now() + timeoutMs, deadlineAt ?? Infinity)
    const results = new Map<JobId, JobStopResult>()
    const settled = new Map<JobId, JobView>()
    const stopErrors = new Map<JobId, string>()
    const unsubscribe = this.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'settled') settled.set(event.job.id, event.job)
    })
    const observedJob = (job: JobView): JobView => {
      try { return this.get(job.id, caller) } catch { return settled.get(job.id) ?? job }
    }
    const drainJobs = async (): Promise<void> => {
      while (true) {
        const selected = this.listTree(caller).filter(job => live(job) && !results.has(job.id))
        if (selected.length === 0) break
        for (const job of selected) {
          try { this.kill(job.id, caller, reason) } catch (error) { stopErrors.set(job.id, String(error)) }
        }
        const remainingMs = deadline - Date.now()
        const batch = await Promise.all(selected.map(async (job): Promise<JobStopResult> => {
          const error = stopErrors.get(job.id)
          if (error !== undefined) return { job: observedJob(job), error }
          if (remainingMs <= 0) return { job: observedJob(job), error: 'job stop was not confirmed before the timeout' }
          try {
            const observed = await this.wait(job.id, remainingMs, caller, signal)
            return live(observed) ? { job: observed, error: 'job stop was not confirmed before the timeout' } : { job: observed }
          } catch (error) {
            const observed = settled.get(job.id)
            return observed === undefined ? { job: observedJob(job), error: String(error) } : { job: observed }
          }
        }))
        for (const result of batch) results.set(result.job.id, result)
        // A cancelled observation requests no further stops; newly admitted
        // work remains visible in the final unconfirmed report.
        if (remainingMs <= 0 || signal?.aborted) break
      }
    }
    try {
      const [sources] = await Promise.all([this.stopIndependentWork(this.stopRequest(caller, deadline, reason, signal)), drainJobs()])
      if (!signal?.aborted) await drainJobs()
      const roster = this.listTree(caller)
      const remaining = roster.filter(live)
      for (const job of roster) {
        if (!job.detail?.includes('work may be orphaned')) continue
        results.set(job.id, { job, error: results.get(job.id)?.error ?? job.detail })
      }
      for (const job of remaining) {
        if (!results.has(job.id)) results.set(job.id, { job, error: 'job started while stopping the session' })
      }
      const stopped = [...results.values()]
      return {
        confirmed: sources.every(source => source.confirmed && source.error === undefined
          && source.targets.every(target => target.confirmed && target.error === undefined))
          && remaining.length === 0 && stopped.every(result => !live(result.job) && result.error === undefined
          && !result.job.detail?.includes('work may be orphaned')),
        jobs: stopped,
        sources,
      }
    } finally { unsubscribe() }
  }

  /**
   * Project one job without changing its cursor. Throws for an unknown or
   * foreign job.
   * @param id - job to look up.
   * @param caller - session resolving to the captured owner or a trusted runtime ancestor; absent sees unowned jobs.
   * @returns a fresh projection.
   */
  abstract get(id: JobId, caller?: SessionId): JobView

  /**
   * Consume the ring from the model cursor and advance it to the current
   * total. After settlement the first read also carries the producer's
   * result. Throws for an unknown or foreign job.
   * @param id - job to read.
   * @param caller - session resolving to the captured owner or a trusted runtime ancestor; absent sees unowned jobs.
   * @returns the chunks since the cursor, the lossy flag, the result once, and the post-read projection.
   */
  abstract read(id: JobId, caller?: SessionId): JobRead

  /**
   * Read retained ring output without moving the model cursor. Resume with
   * a previous read's `next`; an offset inside a retained chunk returns the
   * whole chunk (its `at` may precede `from`). Throws for a negative or
   * non-integer offset, or an unknown or foreign job.
   * @param id - job to read.
   * @param from - absolute byte offset to read from (0 for the retained head).
   * @param caller - session resolving to the captured owner or a trusted runtime ancestor; absent sees unowned jobs.
   * @returns retained chunks overlapping `[from, total)`, the resume offset, and the lossy flag.
   */
  abstract readAt(id: JobId, from: number, caller?: SessionId): JobOutputRead

  /**
   * Request cancellation, then mark the job stopping. A producer throw
   * propagates without changing job state. A supplied reason is merged into
   * terminal `detail` when the job settles `killed`. Throws for an unknown
   * or foreign job.
   * @param id - job to cancel.
   * @param caller - session resolving to the captured owner or a trusted runtime ancestor; absent sees unowned jobs.
   * @param reason - cancellation reason forwarded verbatim to the producer.
   * @returns `requested` for live work, otherwise `already-finished`.
   */
  abstract kill(id: JobId, caller?: SessionId, reason?: string): 'requested' | 'already-finished'

  /**
   * Wait for settlement or timeout without cancelling the job. Caller abort
   * rejects only while the job is live; after settlement the terminal
   * projection wins. Rejects for an invalid timeout or an unknown or foreign
   * job.
   * @param id - job to wait for.
   * @param timeoutMs - positive finite wait bound in milliseconds.
   * @param caller - session resolving to the captured owner or a trusted runtime ancestor; absent sees unowned jobs.
   * @param signal - optional cancellation of the wait itself.
   * @returns projection at settlement or timeout.
   */
  abstract wait(id: JobId, timeoutMs: number, caller?: SessionId, signal?: AbortSignal): Promise<JobView>

  /**
   * Drop one settled job's record from the visible set and announce
   * `removed`. For a caller that collected the terminal state through its own
   * {@link wait} and never handed the id to the model, such as a shell tool's
   * foreground call. Throws for a job that is still live, may have orphaned work,
   * is unknown, or is foreign.
   * @param id - settled job to drop.
   * @param caller - session resolving to the captured owner or a trusted runtime ancestor; absent sees unowned jobs.
   */
  abstract remove(id: JobId, caller?: SessionId): void

  /**
   * Attach an effect-scoped controller that can read and stop jobs. It serves the
   * owners its registering context's scope covers, and {@link start} refuses an
   * owner no attached controller serves.
   * @param name - diagnostic label; duplicate names remain independent.
   * @returns disposer that detaches this controller.
   */
  abstract attachController(name: string): () => void
}

export default JobRegistry
