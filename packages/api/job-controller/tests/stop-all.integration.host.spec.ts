import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import SubagentRuntime, { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { JobController } from '../src/index.ts'

describe('stop-all over a real in-process subagent lifecycle', () => {
  it('keeps a naturally finished child background job visible and stops it from the root', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('lifecycle-test')
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(JobController, { stopWaitTimeoutMs: 1000 })
    const adapter = new MockAdapter([toolCallResponse('launch', 'launch_detached', {}), textResponse('child complete')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agentLoop.create(SessionId('lifecycle-parent'), { provider: 'mock', model: 'mock' })
    let jobId: JobId | undefined
    let cancelled = false
    ctx.tools.register(defineContentToolFixture({
      name: 'launch_detached', description: 'Start background test work', parameters: {},
      async execute(_args, execution) {
        if (execution.agent === undefined) throw new Error('expected a real child Agent')
        let settle!: (outcome: JobOutcome) => void
        jobId = ctx.jobs.start({
          kind: 'bash', label: 'child detached work', owner: execution.agent.id,
          run: () => ({
            cancel: () => { cancelled = true; settle({ status: 'killed' }) },
            done: new Promise((resolve) => { settle = resolve }),
          }),
        })
        return [{ type: 'text', text: `started ${jobId}` }]
      },
    }))
    const run = await startInProcessRun({
      label: 'child lifecycle', prompt: [{ type: 'text', text: 'Run the child task' }], parent,
      signal: new AbortController().signal,
      descriptor: snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'test', label: 'child lifecycle' }),
    }, {})
    try {
      await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
      const child = ctx.agents.get(run.id)
      expect(child?.status).toBe('idle')
      expect(ctx.jobs.listTree(parent.id)).toMatchObject([{ id: jobId, owner: run.id, status: 'running' }])
      const stopped = await ctx.jobController.stopAll({ sessionId: parent.id }, new AbortController().signal)
      expect(cancelled).toBe(true)
      expect(stopped).toMatchObject({ confirmed: true, jobs: [{ job: { id: jobId, status: 'killed' } }] })
      await run.dispose()
      expect(ctx.agents.get(run.id)).toBeUndefined()
      expect(ctx.jobs.listTree(parent.id)).toEqual([])
    } finally {
      await run.dispose()
      await ctx.fiber.dispose()
    }
  })
})
