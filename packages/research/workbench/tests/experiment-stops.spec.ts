/** Independent experiment stop capabilities use runtime identity and real job source dispatch. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionStopRequest } from '@deepseek-ai/dsh-jobs'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobs from '../../../jobs/jobs-local/src/index.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { ExperimentStops, type ExperimentStopLedger } from '../src/experiment-stops.ts'
import { newProject } from '../src/project.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { EnvironmentId, ExperimentId, ExperimentRecord } from '../src/types.ts'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

function agent(id: string, cwd: string): Agent {
  const sessionId = SessionId(id)
  return { id: sessionId, ctx: ctx!, options: {}, status: 'idle', inbox: unsupportedInbox(),
    session: Session.create(sessionId, [], { version: SESSION_FORMAT_VERSION, id: sessionId, cwd, createdAt: 0, isSeeded: false }),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
}

async function fixture() {
  ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobs)
  const project = newProject({ title: 'Stop fixture', root: process.cwd(), brief: '' }, 'fixture-workspace' as WorkspaceId)
  const owner = agent('experiment-owner', project.root)
  const detach = ctx.agents.enter(owner, undefined)
  const run: ExperimentRecord = {
    id: 'experiment-run' as ExperimentId, status: 'running', directory: `${project.root}/.research/runs/experiment-run`,
    inputRevision: 1, environmentFingerprint: 'fixture-fingerprint', metrics: {}, message: '', collected: false,
    createdAt: '', updatedAt: '', snapshotPath: '.research/runs/experiment-run/inputs.json', sessionId: owner.id,
    spec: { name: 'Train', environmentId: 'fixture-env' as EnvironmentId, argv: ['{python}', 'train.py'], cwd: '.', seed: 1,
      maxSeconds: 60, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' },
  }
  project.experiments.push(run)
  let state: ExperimentRecord['status'] = 'cancelled'
  const observe = vi.fn<ExperimentStopLedger['observe']>(async (_project, current) => ({ ...current, status: state }))
  const requestCancel = vi.fn<ExperimentStopLedger['requestCancel']>()
  const ledger: ExperimentStopLedger = {
    projects: () => [project], projectAt: async cwd => cwd === project.root ? structuredClone(project) : undefined,
    observe, save: async (_project, _original, observed) => { project.experiments[0] = observed },
    requestCancel,
  }
  const stops = new ExperimentStops(ctx.agents, ledger)
  const request = (caller = owner, timeout = 1000): SessionStopRequest => ({
    sessionId: caller.id, caller, agents: [caller], deadline: Date.now() + timeout,
  })
  return { project, owner, detach, run, stops, observe, requestCancel, request, state: (value: typeof state) => { state = value } }
}

it('stops the supervisor through the explicit job source and waits for actual confirmation', async () => {
  const f = await fixture()
  const control = f.stops.admit(f.project, f.run, f.owner)
  control.submitting(); control.ready()
  ctx!.jobs.registerStopSource('research-experiments', request => f.stops.stop(request))
  const report = await ctx!.jobs.stopAll(f.owner.id, 1000)
  expect(report).toMatchObject({ confirmed: true, sources: [{ source: 'research-experiments', confirmed: true, targets: [{ status: 'cancelled', confirmed: true }] }] })
  expect(f.observe).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'cancel', expect.any(AbortSignal))
  expect(f.project.experiments[0]?.status).toBe('cancelled')
})

it('retains verified producer ancestry after a child runtime drains', async () => {
  const f = await fixture()
  const child = agent('experiment-child', f.project.root)
  const detach = ctx!.agents.enter(child, f.owner)
  const control = f.stops.admit(f.project, f.run, child)
  control.submitting(); control.ready(); detach()
  expect((await f.stops.stop(f.request())).confirmed).toBe(true)
  expect(f.observe).toHaveBeenCalledTimes(1)
})

it('does not grant old ownership to a replacement runtime using the same session id', async () => {
  const f = await fixture()
  const control = f.stops.admit(f.project, f.run, f.owner)
  control.submitting(); control.ready(); f.detach()
  const replacement = agent(f.owner.id, f.project.root)
  ctx!.agents.enter(replacement, undefined)
  const report = await f.stops.stop(f.request(replacement))
  expect(report.confirmed).toBe(false)
  expect(report.targets[0]?.confirmed).toBe(false)
  expect(report.targets[0]?.error).toContain('no verified runtime producer')
  expect(f.observe).not.toHaveBeenCalled()
})

it('reports restart-era runs as unconfirmed regardless of their mutable display session id', async () => {
  const f = await fixture()
  f.project.experiments[0]!.sessionId = f.owner.id
  const report = await f.stops.stop(f.request())
  expect(report.confirmed).toBe(false)
  expect(report.targets).toHaveLength(1)
  expect(f.observe).not.toHaveBeenCalled()
  const missing = await f.stops.stop({ sessionId: f.owner.id, agents: [], deadline: Date.now() + 1000 })
  expect(missing.confirmed).toBe(false)
  expect(missing.targets).toEqual([])
  expect(missing.error).toContain('exact live')
})

it('keeps unrelated runtime and project scopes outside the stop target set', async () => {
  const f = await fixture()
  const control = f.stops.admit(f.project, f.run, f.owner)
  control.submitting(); control.ready()
  const other = agent('unrelated', `${f.project.root}/other-project`)
  ctx!.agents.enter(other, undefined)
  expect(await f.stops.stop(f.request(other))).toEqual({ confirmed: true, targets: [] })
  expect(f.observe).not.toHaveBeenCalled()
})

it('excludes another live root\'s trusted admission in the same project while retaining unknown restart-era runs', async () => {
  const f = await fixture()
  const foreign = agent('foreign-live-root', f.project.root)
  ctx!.agents.enter(foreign, undefined)
  const control = f.stops.admit(f.project, f.run, foreign)
  control.submitting(); control.ready()
  expect(await f.stops.stop(f.request())).toEqual({ confirmed: true, targets: [] })
  expect(control.signal.aborted).toBe(false)
  expect(f.observe).not.toHaveBeenCalled()
  const old = { ...structuredClone(f.run), id: 'old-restart-run' as ExperimentId, sessionId: f.owner.id }
  f.project.experiments.push(old)
  const report = await f.stops.stop(f.request())
  expect(report.confirmed).toBe(false)
  expect(report.targets.map(target => target.id)).toEqual([`${f.project.id}/${old.id}`])
  expect(report.targets[0]?.error).toContain('no verified runtime producer')
  expect(control.signal.aborted).toBe(false)
  expect(f.observe).not.toHaveBeenCalled()
  // A substituted resource cannot inherit the foreign submission's trust.
  f.run.directory = 'substituted-directory'
  const changed = await f.stops.stop(f.request())
  expect(changed.confirmed).toBe(false)
  expect(changed.targets.map(target => target.id)).toContain(`${f.project.id}/${f.run.id}`)
  expect(f.observe).not.toHaveBeenCalled()
})

it('cancels preparation without submitting a supervisor, while ordinary cancel and disposal never call the source', async () => {
  const f = await fixture()
  const control = f.stops.admit(f.project, f.run, f.owner)
  ctx!.jobs.registerStopSource('research-experiments', request => f.stops.stop(request))
  f.owner.cancel({ kind: 'user' })
  expect(control.signal.aborted).toBe(false)
  const stopping = ctx!.jobs.stopAll(f.owner.id, 1000)
  await vi.waitFor(() => { expect(control.signal.aborted).toBe(true) })
  expect(control.cancelledBeforeSubmission).toBe(true)
  f.project.experiments[0]!.status = 'cancelled'
  control.ready('cancelled')
  expect((await stopping).confirmed).toBe(true)
  expect(f.observe).not.toHaveBeenCalled()
  await ctx!.fiber.dispose(); ctx = undefined
  expect(f.observe).not.toHaveBeenCalled()
})

it('never treats unreachable or interrupted supervisors as confirmed stopped', async () => {
  const f = await fixture()
  const control = f.stops.admit(f.project, f.run, f.owner)
  control.submitting(); control.ready()
  f.state('unknown')
  const first = await f.stops.stop(f.request(f.owner, 25))
  expect(first).toMatchObject({ confirmed: false, targets: [{ status: 'unknown', confirmed: false }] })
  f.state('interrupted')
  const interrupted = await f.stops.stop(f.request())
  expect(interrupted).toMatchObject({ confirmed: false, targets: [{ status: 'interrupted', confirmed: false }] })
  expect(interrupted.targets[0]?.error).toContain('termination has not been confirmed')
})

it('validates the captured resource and consults the actual supervisor despite a terminal-looking ledger', async () => {
  const f = await fixture()
  const control = f.stops.admit(f.project, f.run, f.owner)
  control.submitting(); control.ready()
  const directory = f.run.directory
  f.project.experiments[0]!.directory = 'tampered'
  const tampered = await f.stops.stop(f.request())
  expect(tampered).toMatchObject({ confirmed: false, targets: [{ confirmed: false }] })
  expect(tampered.targets[0]?.error).toContain('trusted submission')
  expect(f.observe).not.toHaveBeenCalled()
  f.project.experiments[0]!.directory = directory
  f.project.experiments[0]!.status = 'completed'
  f.state('running')
  expect(await f.stops.stop(f.request(f.owner, 25))).toMatchObject({ confirmed: false, targets: [{ status: 'running', confirmed: false }] })
  expect(f.observe).toHaveBeenCalled()
})

it('requests cancellation even when the shared observation deadline has already elapsed', async () => {
  const f = await fixture()
  const control = f.stops.admit(f.project, f.run, f.owner)
  control.submitting(); control.ready()
  expect(await f.stops.stop({ ...f.request(), deadline: Date.now() })).toMatchObject({ confirmed: false, targets: [{ status: 'running', confirmed: false }] })
  expect(control.signal.aborted).toBe(true)
  expect(f.requestCancel).toHaveBeenCalledTimes(1)
  expect(f.observe).not.toHaveBeenCalled()
})

it('reuses a confirmed terminal observation without issuing another cancellation RPC', async () => {
  const f = await fixture()
  const control = f.stops.admit(f.project, f.run, f.owner)
  control.submitting()
  f.project.experiments[0]!.status = 'completed'
  control.ready('completed')
  expect((await f.stops.stop(f.request())).confirmed).toBe(true)
  expect(f.observe).not.toHaveBeenCalled()
  expect(f.requestCancel).not.toHaveBeenCalled()
})

it('does not claim preparation stopped while its durable run remains queued', async () => {
  const f = await fixture()
  f.run.status = 'queued'
  const control = f.stops.admit(f.project, f.run, f.owner)
  control.ready('cancelled')
  expect(await f.stops.stop(f.request())).toMatchObject({ confirmed: false, targets: [{ status: 'queued', confirmed: false }] })
  expect(f.observe).not.toHaveBeenCalled()
})
