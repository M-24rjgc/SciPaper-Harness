/** Explicit stop-all adapter for independent supervisors; disposal never terminates them. */
import { setTimeout as delay } from 'node:timers/promises'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionStopRequest } from '@deepseek-ai/dsh-jobs'
import type { StopSourceReport, StopSourceTarget } from '@deepseek-ai/dsh-jobs/view'
import type { ExperimentRecord, ProjectId, ResearchProject } from './types.ts'

const ACTIVE = new Set(['queued', 'running', 'unknown'])
const CONFIRMED = new Set(['completed', 'failed', 'cancelled'])

interface Admission {
  project: ResearchProject
  run: ExperimentRecord
  /** Exact runtime objects, captured before the work is submitted. */
  owners: ReadonlySet<Agent>
  controller: AbortController
  submitting: boolean
  requested: boolean
  settled: boolean
  confirmedStatus?: ExperimentRecord['status']
  ready: Promise<void>
  release(): void
}

/** Producer controls used only while immutable inputs and the supervisor submission are prepared. */
export interface ExperimentSubmissionControl {
  readonly signal: AbortSignal
  submitting(): void
  readonly cancelledBeforeSubmission: boolean
  ready(status?: ExperimentRecord['status']): void
}

/** The durable ledger operations the stop adapter may perform. */
export interface ExperimentStopLedger {
  projects(): ResearchProject[]
  projectAt(cwd: string): Promise<ResearchProject | undefined>
  observe(project: ResearchProject, run: ExperimentRecord, action: 'status' | 'cancel', signal: AbortSignal): Promise<ExperimentRecord>
  save(project: ResearchProject, original: ExperimentRecord, observed: ExperimentRecord): Promise<void>
  /** Issue a bounded stop request after observation time is exhausted; never claims completion. */
  requestCancel(project: ResearchProject, run: ExperimentRecord): void
}

/** Owns in-memory control capabilities, separately from the editable sessionId recorded for display. */
export class ExperimentStops {
  private readonly admissions = new Map<string, Admission>()
  constructor(private readonly agents: AgentRegistry, private readonly ledger: ExperimentStopLedger) {}

  /**
   * Capture verified producer ancestry. A reused session id conveys no control over an old admission.
   * @param project - project snapshot identifying the submitted resource.
   * @param run - queued run whose immutable identity the admission captures.
   * @param caller - registered producer Agent, or undefined for desktop submission.
   * @returns preparation cancellation and submission settlement controls.
   */
  admit(project: ResearchProject, run: ExperimentRecord, caller: Agent | undefined): ExperimentSubmissionControl {
    const owners = new Set<Agent>()
    if (caller !== undefined) {
      if (this.agents.get(caller.id) !== caller) throw new Error('The experiment caller is not the registered runtime Agent')
      owners.add(caller)
      let child = caller
      while (true) {
        const parent = this.agents.list().find(candidate => this.agents.isOwnedBy(child.id, candidate))
        if (parent === undefined || owners.has(parent)) break
        owners.add(parent)
        child = parent
      }
    }
    const controller = new AbortController()
    let release = (): void => {}
    const ready = new Promise<void>((resolve) => { release = resolve })
    const admission: Admission = {
      project: structuredClone(project), run: structuredClone(run), owners, controller,
      submitting: false, requested: false, settled: false, ready, release,
    }
    this.admissions.set(this.key(project.id, run.id), admission)
    return {
      signal: controller.signal,
      submitting: () => { admission.submitting = true },
      get cancelledBeforeSubmission() { return admission.requested && !admission.submitting },
      ready: (status) => {
        admission.settled = true
        if (status !== undefined && CONFIRMED.has(status)) admission.confirmedStatus = status
        admission.release()
      },
    }
  }

  /**
   * Stop only verified current producers; old independent runs in this workspace are explicitly unconfirmed.
   * @param request - live caller authority and shared stop deadline.
   * @returns stop observations for every selected or unowned active experiment.
   */
  async stop(request: SessionStopRequest): Promise<StopSourceReport> {
    if (request.sessionId !== undefined && request.caller === undefined) {
      return { confirmed: false, targets: [], error: 'Experiment stop requires the exact live runtime caller' }
    }
    const here = request.caller?.session.header.cwd
    const project = here === undefined ? undefined : await this.ledger.projectAt(here)
    const selected = [...this.admissions.values()].filter(admission =>
      request.caller === undefined ? admission.owners.size === 0
        : admission.owners.has(request.caller) || request.agents.some(agent => admission.owners.has(agent))
          || admission.owners.size === 0 && project?.id === admission.project.id)
    const trustedKeys = new Set(selected.map(admission => this.key(admission.project.id, admission.run.id)))
    // A valid foreign admission has a known producer outside this caller's
    // authority; it is neither a stop target nor an unowned historical run.
    for (const admission of this.admissions.values()) {
      const liveProducer = admission.owners.size === 0
        || [...admission.owners].some(owner => this.agents.get(owner.id) === owner)
      if (liveProducer && this.resource(admission) !== undefined) trustedKeys.add(this.key(admission.project.id, admission.run.id))
    }
    const projects = request.caller === undefined ? this.ledger.projects() : project === undefined ? [] : [project]
    const unknown: StopSourceTarget[] = projects.flatMap(current => current.experiments
      .filter(run => ACTIVE.has(run.status) && !trustedKeys.has(this.key(current.id, run.id)))
      .map(run => ({ id: this.key(current.id, run.id), status: run.status, confirmed: false,
        error: 'Independent experiment has no verified runtime producer; cancel this run explicitly and inspect its supervisor' })))
    const targets = [...await Promise.all(selected.map(admission => this.stopOne(admission, request))), ...unknown]
    return { confirmed: targets.every(target => target.confirmed), targets }
  }

  private key(project: ProjectId, run: string): string { return `${project}/${run}` }

  /**
   * A live supervisor observation may settle this capability without a later stop RPC.
   * @param project - project identity of the observed supervisor.
   * @param run - terminal observation with the immutable submitted resource identity.
   */
  confirmed(project: ProjectId, run: ExperimentRecord): void {
    const admission = this.admissions.get(this.key(project, run.id))
    if (admission !== undefined && CONFIRMED.has(run.status) && run.directory === admission.run.directory
      && run.environmentFingerprint === admission.run.environmentFingerprint
      && JSON.stringify(run.spec) === JSON.stringify(admission.run.spec)) {
      admission.confirmedStatus = run.status
    }
  }

  private resource(admission: Admission): ExperimentRecord | undefined {
    const project = this.ledger.projects().find(candidate => candidate.id === admission.project.id)
    const run = project?.experiments.find(candidate => candidate.id === admission.run.id)
    if (project?.root !== admission.project.root || run === undefined
      || run.directory !== admission.run.directory || run.environmentFingerprint !== admission.run.environmentFingerprint
      || JSON.stringify(run.spec) !== JSON.stringify(admission.run.spec)) {
      return undefined
    }
    return run
  }

  private current(admission: Admission): ExperimentRecord {
    const run = this.resource(admission)
    if (run === undefined) throw new Error('The experiment resource no longer matches its trusted submission')
    return run
  }

  private async stopOne(admission: Admission, request: SessionStopRequest): Promise<StopSourceTarget> {
    const id = this.key(admission.project.id, admission.run.id)
    let status = 'unknown'
    const remaining = request.deadline - Date.now()
    try {
      status = this.current(admission).status
      if (admission.confirmedStatus !== undefined && status === admission.confirmedStatus) return { id, status, confirmed: true }
      admission.requested = true
      admission.controller.abort()
      if (remaining <= 0 || request.signal?.aborted) {
        if (admission.settled && admission.submitting) this.ledger.requestCancel(admission.project, this.current(admission))
        return { id, status, confirmed: false, error: 'Experiment stop was not confirmed before the deadline' }
      }
    } catch (error) { return { id, status, confirmed: false, error: String(error) } }
    const deadlineSignal = AbortSignal.timeout(remaining)
    const signal = request.signal === undefined ? deadlineSignal : AbortSignal.any([request.signal, deadlineSignal])
    try {
      let run = this.current(admission)
      status = run.status
      let abort = (): void => {}
      try {
        await Promise.race([admission.ready, new Promise<never>((_resolve, reject) => {
          abort = () => { reject(new Error('Experiment stop deadline reached')) }
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })])
      } finally { signal.removeEventListener('abort', abort) }
      run = this.current(admission)
      status = run.status
      if (!admission.submitting) {
        return admission.confirmedStatus === 'cancelled' && status === 'cancelled'
          ? { id, status, confirmed: true }
          : { id, status, confirmed: false, error: 'Preparation ended but its cancelled ledger state has not been committed' }
      }
      let action: 'cancel' | 'status' = 'cancel'
      while (!signal.aborted && Date.now() < request.deadline) {
        const observed = await this.ledger.observe(admission.project, run, action, signal)
        await this.ledger.save(admission.project, admission.run, observed)
        run = observed
        status = run.status
        if (CONFIRMED.has(status)) {
          admission.confirmedStatus = run.status
          return { id, status, confirmed: true }
        }
        // Interrupted proves only that the supervisor is gone; its child may still be alive.
        if (status === 'interrupted') return { id, status, confirmed: false, error: 'The supervisor exited; training termination has not been confirmed' }
        action = status === 'unknown' ? 'cancel' : 'status'
        await delay(Math.min(250, Math.max(1, request.deadline - Date.now())), undefined, { signal })
      }
      return { id, status, confirmed: false, error: 'Experiment stop was not confirmed before the deadline' }
    } catch (error) {
      return { id, status, confirmed: false, error: String(error) }
    }
  }
}
