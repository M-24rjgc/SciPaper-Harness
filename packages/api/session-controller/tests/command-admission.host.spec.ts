import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import type { SessionCommandAdmission, SessionRequestId } from '../src/types.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function harness(cold = false) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  const sessionId = SessionId('ordinary-identity')
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false, cwd: '/examples/paper',
  }
  if (cold) {
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [header],
      inspect: async (id: SessionId) => id === sessionId ? { meta: header, events: [] } : undefined,
    }) as never)
  } else {
    ctx.sessions.create(sessionId, { meta: { cwd: header.cwd! } })
  }
  const activate = vi.fn(() => { throw new Error('denied command activated an Agent') })
  const compose = vi.fn(() => { throw new Error('denied command composed an Agent') })
  const attach = vi.fn()
  const workspaceId = 'example-workspace' as WorkspaceId
  ctx.provide('workspaceRegistry', {
    get: () => ({ id: workspaceId, path: header.cwd, attachSession: attach }),
    list: vi.fn(() => []),
  } as never)
  const agents = {
    ensureSession: activate, resolveAgent: activate, composeAgent: compose,
  } as unknown as ApiSessionAgentController
  return { ctx, sessionId, activate, compose, attach, workspaceId, controller: new SessionCommandController(ctx, agents, '/default') }
}

function mutation(controller: SessionCommandController, operation: SessionCommandAdmission['operation'], sessionId: SessionId) {
  switch (operation) {
    case 'create': return controller.create({ sessionId: SessionId('fresh'), cwd: '/examples/paper' })
    case 'fork': return controller.fork({ sessionId })
    case 'rename': return controller.rename({ sessionId, title: 'Changed' })
    case 'prompt': return controller.prompt({
      sessionId, requestId: 'request' as SessionRequestId, mode: 'queue', content: [{ type: 'text', text: 'Changed' }],
    })
    case 'updateQueue': return controller.updateQueue({ sessionId, itemId: MessageId('queued'), action: { kind: 'remove' } })
  }
}

describe('Session command admission', () => {
  it.each(['fork', 'rename', 'prompt', 'updateQueue'] as const)(
    'rejects attached %s before Agent activation or command effects', async (operation) => {
      const { ctx, sessionId, activate, compose, attach, controller } = await harness()
      const calls: SessionCommandAdmission[] = []
      ctx.on('api-session/command-admission', (admission) => {
        calls.push(admission)
        throw new RemoteError('session/read-only', 'This conversation is read-only.', { sessionId: admission.sessionId })
      })
      await expect(mutation(controller, operation, sessionId)).rejects.toMatchObject({ code: 'session/read-only' })
      expect(calls).toEqual([{ operation, sessionId, cwd: '/examples/paper' }])
      expect(activate).not.toHaveBeenCalled()
      expect(compose).not.toHaveBeenCalled()
      expect(attach).not.toHaveBeenCalled()
      using observation = await ctx.sessionQuery.observeSession(sessionId)
      expect(observation.events).toEqual([])
    },
  )

  it.each(['fork', 'rename', 'prompt', 'updateQueue'] as const)(
    'inspects cold %s without restoring or appending to the Session', async (operation) => {
      const { ctx, sessionId, activate, compose, controller } = await harness(true)
      ctx.on('api-session/command-admission', (admission) => {
        expect(admission.cwd).toBe('/examples/paper')
        throw new RemoteError('session/read-only', 'This conversation is read-only.', { sessionId: admission.sessionId })
      })
      await expect(mutation(controller, operation, sessionId)).rejects.toMatchObject({ code: 'session/read-only' })
      expect(ctx.sessions.get(sessionId)).toBeUndefined()
      expect(activate).not.toHaveBeenCalled()
      expect(compose).not.toHaveBeenCalled()
    },
  )

  it('resolves Workspace destinations and exposes existing identities before create effects', async () => {
    const { ctx, sessionId, activate, attach, workspaceId, controller } = await harness()
    const request = { sessionId, workspaceId, agentPreset: 'research' }
    ctx.on('api-session/command-admission', (admission) => {
      expect(admission).toMatchObject({ operation: 'create', sessionId, cwd: '/examples/paper', existing: { id: sessionId } })
      if (admission.operation === 'create') expect(admission.request).toBe(request)
      throw new RemoteError('session/read-only', 'This conversation is read-only.', { sessionId: admission.sessionId })
    })
    await expect(controller.create(request)).rejects.toMatchObject({ code: 'session/read-only' })
    expect(activate).not.toHaveBeenCalled()
    expect(attach).not.toHaveBeenCalled()
  })

  it('keeps resolved create values fixed while delegating the original request identity', async () => {
    const { ctx } = await harness()
    const request = { sessionId: SessionId('new'), cwd: '/ordinary', agentPreset: 'research' }
    const ensureSession = vi.fn(async (id: SessionId, cwd: string) => ({ session: ctx.sessions.create(id, { meta: { cwd } }) }))
    const controller = new SessionCommandController(ctx, {
      ensureSession, presetForSession: () => 'research',
    } as unknown as ApiSessionAgentController, '/default')
    const order: string[] = []
    ctx.on('api-session/command-admission', (admission, next) => {
      order.push('first')
      if (admission.operation === 'create') {
        expect(admission.request).toBe(request)
        request.cwd = '/examples/paper'
        request.sessionId = SessionId('tampered')
        request.agentPreset = 'different'
      }
      return next()
    })
    ctx.on('api-session/command-admission', (_admission, next) => { order.push('second'); return next() })
    expect(await controller.create(request)).toEqual({ sessionId: SessionId('new'), agentPreset: 'research' })
    expect(ensureSession).toHaveBeenCalledWith(SessionId('new'), '/ordinary', true, 'research')
    expect(order).toEqual(['first', 'second'])
  })

  it('delegates an ordinary fork without changing the source and disposes admission contributions', async () => {
    const { ctx } = await harness()
    const source = ctx.sessions.create(SessionId('ordinary-source'), { meta: { cwd: '/ordinary' } })
    source.append('turn/start', { turn: 1 })
    source.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Result' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) } as never)
    const create = vi.spyOn(ctx.agents, 'create').mockImplementation(async (options) => {
      const session = ctx.sessions.create(options.sessionId, {
        meta: options.meta!, seed: options.seed!, inheritedEventCount: options.inheritedEventCount!,
      })
      return { agent: { id: session.id, session } as Agent, dispose: async () => {} }
    })
    const controller = new SessionCommandController(ctx, {
      composeAgent: async () => ({ setup: () => {} }), presetForObservation: () => undefined,
    } as unknown as ApiSessionAgentController, '/default')
    const seen = vi.fn()
    const dispose = ctx.on('api-session/command-admission', (admission, next) => { seen(admission); return next() })
    expect((await controller.fork({ sessionId: source.id })).sessionId).not.toBe(source.id)
    expect(create).toHaveBeenCalledOnce()
    expect(seen).toHaveBeenCalledWith({ operation: 'fork', sessionId: source.id, cwd: '/ordinary' })
    using observation = await ctx.sessionQuery.observeSession(source.id)
    expect(observation.events).toHaveLength(3)
    dispose()
    await ctx.waterfall('api-session/command-admission', { operation: 'rename', sessionId: source.id }, () => Promise.resolve())
    expect(seen).toHaveBeenCalledOnce()
  })
})
