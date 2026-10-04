import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'
import { JobController } from '../src/index.ts'

function producer(label = 'sleep 60') {
  let settle!: (outcome: JobOutcome) => void
  const cancels: (string | undefined)[] = []
  const spec = {
    kind: 'bash' as const,
    label,
    run: () => ({
      cancel: (reason?: string) => { cancels.push(reason) },
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
    }),
  }
  return { spec, cancels, settle: (outcome: JobOutcome) => { settle(outcome) } }
}

async function registerAgent(ctx: Context, session: Session, owner?: Agent): Promise<Agent> {
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: vi.fn(),
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
  }
  if (owner === undefined) await ctx.agents.register(agent)
  else ctx.agents.enter(agent, owner)
  return agent
}

async function harness(config: { stopWaitTimeoutMs?: number } = {}): Promise<{
  ctx: Context
  session: Session
  agent: Agent
  controller: JobController
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('kill-test')
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(JobController, config)
  const session = ctx.sessions.create()
  const agent = await registerAgent(ctx, session)
  return { ctx, session, agent, controller: ctx.jobController }
}

function failureCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    const failure = remoteErrorOf(error)
    if (failure !== undefined) return failure.code
    throw error
  }
  throw new Error('expected a RemoteError failure')
}

describe('JobController.kill', () => {
  it('kills an owned running job without claiming the terminal report', async () => {
    const { ctx, session, agent, controller } = await harness()
    const task = producer('pnpm run watch')
    const id = ctx.jobs.start({ ...task.spec, owner: agent.id })

    expect(controller.kill({ sessionId: session.id, jobId: id })).toEqual({ outcome: 'requested' })
    expect(task.cancels).toEqual(['cancelled by the user'])
    // The kill reason is recorded for the killed detail; the notice ledger
    // lives in tool-jobs, which never learns of this kill, so the completion
    // notice stays due.
    expect(ctx.jobs.get(id, agent.id)).toMatchObject({ status: 'stopping' })
  })

  it('reports an already-finished job instead of failing', async () => {
    const { ctx, session, agent, controller } = await harness()
    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, owner: agent.id })
    task.settle({ status: 'completed', detail: 'exit code: 0' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(controller.kill({ sessionId: session.id, jobId: id })).toEqual({ outcome: 'already-finished' })
    expect(ctx.jobs.get(id, agent.id).status).toBe('completed')
  })

  it('kills an unowned job from a session without a live agent', async () => {
    const { ctx, controller } = await harness()
    const task = producer('unowned work')
    const id = ctx.jobs.start(task.spec)
    const cold = ctx.sessions.create()

    expect(controller.kill({ sessionId: cold.id, jobId: id })).toEqual({ outcome: 'requested' })
  })

  it('rejects an unknown job id as job/not-found', async () => {
    const { session, controller } = await harness()
    expect(failureCode(() => controller.kill({ sessionId: session.id, jobId: 'bash-99' as JobId })))
      .toBe('job/not-found')
  })

  it('rejects a foreign session\'s job as job/not-found', async () => {
    const { ctx, agent, controller } = await harness()
    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, owner: agent.id })
    // The other session cannot see the owned job.
    const other = ctx.sessions.create()

    expect(failureCode(() => controller.kill({ sessionId: other.id, jobId: id })))
      .toBe('job/not-found')
    expect(ctx.jobs.get(id, agent.id).status).toBe('running')
  })

  it('propagates a producer cancel throw instead of masking it as job/not-found', async () => {
    const { ctx, session, agent, controller } = await harness()
    const id = ctx.jobs.start({
      kind: 'bash',
      label: 'flaky cancel',
      owner: agent.id,
      run: () => ({
        cancel: () => { throw new Error('cancel boom') },
        done: new Promise(() => {}),
      }),
    })
    // The registry contract: a producer throw propagates with job state
    // unchanged — the Remote must not rewrite it into a lookup failure.
    expect(() => controller.kill({ sessionId: session.id, jobId: id })).toThrow('cancel boom')
    expect(ctx.jobs.get(id, agent.id).status).toBe('running')
  })

  it('kills a child session\'s own job from its list: the owner fence is the only access rule', async () => {
    const { ctx, controller } = await harness()
    const child = ctx.sessions.create(undefined, { meta: { origin: 'subagent' } })
    const childAgent = await registerAgent(ctx, child)
    const task = producer('child work')
    const id = ctx.jobs.start({ ...task.spec, owner: childAgent.id })

    expect(controller.kill({ sessionId: child.id, jobId: id })).toEqual({ outcome: 'requested' })
    expect(task.cancels).toEqual(['cancelled by the user'])
    expect(ctx.jobs.get(id, childAgent.id).status).toBe('stopping')
  })
})

describe('JobController.stopAll', () => {
  it('stops independent work admitted before Agent quiescence and preserves adapter failures', async () => {
    const { ctx, session, agent, controller } = await harness()
    let admitted = false
    let cancelled = false
    agent.whenIdle = async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      admitted = true
    }
    ctx.jobs.registerStopSource('experiment', async (request) => {
      expect(request.caller).toBe(agent)
      if (!admitted) return { confirmed: true, targets: [] }
      cancelled = true
      return { confirmed: true, targets: [{ id: 'late-run', status: 'cancelled', confirmed: true }] }
    })
    ctx.jobs.registerStopSource('unreachable', async () => { throw new Error('transport failed') })
    const report = await controller.stopAll({ sessionId: session.id }, new AbortController().signal)
    expect(cancelled).toBe(true)
    expect(report.confirmed).toBe(false)
    expect(report.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'experiment', targets: [{ id: 'late-run', status: 'cancelled', confirmed: true }] }),
      expect.objectContaining({ source: 'unreachable', error: 'Error: transport failed' }),
    ]))
    await ctx.fiber.dispose()
  })

  it('stops a descendant job admitted just before the parent reaches idle', async () => {
    const { ctx, session, agent, controller } = await harness()
    const child = await registerAgent(ctx, ctx.sessions.create(), agent)
    let admitted = false
    let stopped = false
    let lateId: JobId | undefined
    agent.whenIdle = async () => {
      if (admitted) return
      await new Promise(resolve => setTimeout(resolve, 10))
      admitted = true
      let settle!: (outcome: JobOutcome) => void
      lateId = ctx.jobs.start({ kind: 'bash', label: 'late child work', owner: child.id, run: () => ({
        cancel: () => { stopped = true; settle({ status: 'killed' }) },
        done: new Promise((resolve) => { settle = resolve }),
      }) })
    }
    const report = await controller.stopAll({ sessionId: session.id }, new AbortController().signal)
    expect(stopped).toBe(true)
    expect(report).toMatchObject({ confirmed: true, jobs: [{ job: { id: lateId, status: 'killed' } }] })
    await ctx.fiber.dispose()
  })

  it('shares one deadline across Agent shutdown and a late job stop', async () => {
    const { ctx, session, agent, controller } = await harness({ stopWaitTimeoutMs: 30 })
    const task = producer('late unresponsive work')
    let admitted = false
    agent.whenIdle = async () => {
      if (admitted) return
      await new Promise(resolve => setTimeout(resolve, 20))
      admitted = true
      ctx.jobs.start({ ...task.spec, owner: agent.id })
    }
    vi.useFakeTimers()
    try {
      const startedAt = Date.now()
      const stopping = controller.stopAll({ sessionId: session.id }, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(30)
      const report = await stopping
      expect(report).toMatchObject({ confirmed: false, jobs: [{ job: { status: 'stopping' } }] })
      expect(report.jobs[0]?.error).toContain('timeout')
      expect(Date.now() - startedAt).toBe(30)
      expect(task.cancels).toEqual(['cancelled by the user'])
      task.settle({ status: 'killed' })
      await ctx.fiber.dispose()
    } finally { vi.useRealTimers() }
  })
  it('permits a root to stop a visible child job through the row control', async () => {
    const { ctx, session, agent, controller } = await harness()
    const child = await registerAgent(ctx, ctx.sessions.create(), agent)
    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, owner: child.id })
    expect(controller.kill({ sessionId: session.id, jobId: id })).toEqual({ outcome: 'requested' })
    task.settle({ status: 'killed' })
    await ctx.fiber.dispose()
  })
  it('cancels the runtime session tree and confirms jobs only after settlement', async () => {
    const { ctx, session, agent, controller } = await harness()
    const child = await registerAgent(ctx, ctx.sessions.create(), agent)
    const other = await registerAgent(ctx, ctx.sessions.create())
    const rootCancel = vi.fn()
    const childCancel = vi.fn()
    const otherCancel = vi.fn()
    agent.cancel = rootCancel
    child.cancel = childCancel
    other.cancel = otherCancel
    const tasks = [producer('root job'), producer('child job')]
    const ids = tasks.map((task, index) => ctx.jobs.start({ ...task.spec, owner: index === 0 ? agent.id : child.id }))
    const foreign = producer('other root job')
    const foreignId = ctx.jobs.start({ ...foreign.spec, owner: other.id })
    const stopping = controller.stopAll({ sessionId: session.id }, new AbortController().signal)
    expect(rootCancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(childCancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(otherCancel).not.toHaveBeenCalled()
    expect(tasks.map(task => task.cancels)).toEqual([['cancelled by the user'], ['cancelled by the user']])
    tasks.forEach((task) =>{  task.settle({ status: 'killed' }) })
    expect(await stopping).toMatchObject({ confirmed: true, jobs: ids.map(id => ({ job: { id, status: 'killed' } })), agents: [{ sessionId: agent.id, status: 'idle' }, { sessionId: child.id, status: 'idle' }] })
    expect(ctx.jobs.get(foreignId, other.id).status).toBe('running')
    foreign.settle({ status: 'completed' })
    await ctx.fiber.dispose()
  })

  it('keeps an unquiesced Agent unconfirmed even with no live jobs', async () => {
    const { ctx, session, agent, controller } = await harness({ stopWaitTimeoutMs: 10 })
    agent.whenIdle = () => new Promise(() => {})
    const report = await controller.stopAll({ sessionId: session.id }, new AbortController().signal)
    expect(report).toMatchObject({ confirmed: false, jobs: [], agents: [{ sessionId: agent.id }] })
    expect(report.agents[0]?.error).toContain('timeout')
    await ctx.fiber.dispose()
  })

  it('contains one Agent cancellation failure and still stops jobs', async () => {
    const { ctx, session, agent, controller } = await harness()
    agent.cancel = () => { throw new Error('agent cancel boom') }
    const task = producer()
    ctx.jobs.start({ ...task.spec, owner: agent.id })
    const stopping = controller.stopAll({ sessionId: session.id }, new AbortController().signal)
    task.settle({ status: 'killed' })
    expect(await stopping).toMatchObject({ confirmed: false, jobs: [{ job: { status: 'killed' } }], agents: [{ error: 'Error: agent cancel boom' }] })
    await ctx.fiber.dispose()
  })
})
