/** SSH file previews must bind to the Session's isolated remote filesystem. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness | undefined
afterEach(async () => { await harness?.dispose(); harness = undefined })

describe('SSH workspace file routing', () => {
  it('reads remote text without consulting the local filesystem', async () => {
    harness = await openWorkspace('dsh-remote-workspace-files-')
    const localResolve = vi.spyOn(harness.ctx.fs, 'resolve')
    const root = { targetKey: FsTargetKey('remote-root'), displayPath: '/srv/lab' }
    const file = { targetKey: FsTargetKey('remote-file'), displayPath: '/srv/lab/paper.md' }
    const info = { type: 'file' as const, version: FsVersion('remote-v1'), size: 8 }
    const remoteMethods = {
      resolve: vi.fn(async (path: string) => path === '/srv/lab' ? root : file),
      lstat: vi.fn(async () => info),
      stat: vi.fn(async () => info),
      streamText: vi.fn(async () => (async function* () { yield '# remote' })()),
      processPath: vi.fn(() => '/srv/lab/paper.md'),
    }
    const remoteFs = new Proxy(harness.ctx.fs, {
      get(_target, property) {
        if (property === 'then') return undefined
        if (typeof property === 'string' && property in remoteMethods) {
          return remoteMethods[property as keyof typeof remoteMethods]
        }
        throw new Error(`Unexpected remote filesystem method: ${String(property)}`)
      },
    })
    const agent = { ctx: harness.ctx }
    const resolveAgent = vi.fn(async () => ({ agent }))
    const serviceFor = vi.fn(() => remoteFs)
    harness.ctx.provide('sessionController', { resolveAgent } as never)
    harness.ctx.provide('agentPresets', { serviceFor } as never)
    const scope = {
      sessionId: SessionId('remote-session'), workspaceRoot: '/srv/lab',
      execution: { kind: 'ssh' as const, host: 'lab' },
    }
    const page = await harness.endpoint().read(scope, 'paper.md', {}, signal())
    expect(page).toMatchObject({ absolutePath: '/srv/lab/paper.md', text: '# remote', version: info.version })
    expect(resolveAgent).toHaveBeenCalledWith(scope.sessionId)
    expect(serviceFor).toHaveBeenCalledWith(agent, 'fs')
    expect(localResolve).not.toHaveBeenCalled()
  })

  it('fails closed if an SSH session has no isolated provider', async () => {
    harness = await openWorkspace('dsh-remote-workspace-files-')
    const localResolve = vi.spyOn(harness.ctx.fs, 'resolve')
    const agent = { ctx: harness.ctx }
    harness.ctx.provide('sessionController', { resolveAgent: async () => ({ agent }) } as never)
    harness.ctx.provide('agentPresets', { serviceFor: () => undefined } as never)
    await expect(harness.endpoint().read({
      sessionId: SessionId('remote-session'), workspaceRoot: '/srv/lab',
      execution: { kind: 'ssh', host: 'lab' },
    }, 'paper.md', {}, signal())).rejects.toMatchObject({ code: 'gateway/internal' })
    expect(localResolve).not.toHaveBeenCalled()
  })
})
