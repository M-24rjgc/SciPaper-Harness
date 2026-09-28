import { Context } from '@deepseek-ai/cordis'
import { posix } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import { describe, expect, it, vi } from 'vitest'
import { SessionFileReferences } from '../src/file-references.ts'

describe('SessionFileReferences', () => {
  it('delegates the resolved Agent, query, and cancellation signal unchanged', async () => {
    const ctx = new Context()
    const candidates: FileReferenceCandidate[] = [{ path: 'src', kind: 'directory' }]
    const list = vi.fn(() => Promise.resolve(candidates))
    ctx.provide('fileReferences', { list } as never)
    const adapter = new SessionFileReferences(ctx)
    const agent = Object.assign({} as Agent, { id: 'target', session: { header: {} } })
    const signal = new AbortController().signal

    await expect(adapter.list(agent, 'sr', signal)).resolves.toBe(candidates)
    expect(list).toHaveBeenCalledWith(agent, 'sr', signal)
  })

  it('lists SSH candidates only through the isolated remote filesystem', async () => {
    const ctx = new Context()
    const localList = vi.fn(async () => [{ path: 'local-secret.txt', kind: 'file' }])
    const localFs = { listDir: vi.fn(async () => [{ name: 'local-secret.txt', type: 'file' }]) }
    ctx.provide('fileReferences', { list: localList } as never)
    ctx.provide('fs', localFs as never)
    const directories = new Map([
      ['/srv/study', [
        { name: 'src', type: 'directory' }, { name: 'node_modules', type: 'directory' },
        { name: '.env', type: 'file' }, { name: 'README.md', type: 'file' },
      ]],
      ['/srv/study/src', [
        { name: 'test.ts', type: 'file' }, { name: 'temporary.ts', type: 'file' },
        { name: '.secret', type: 'file' },
      ]],
    ])
    const remoteFs = {
      resolve: vi.fn(async (path: string) => ({ targetKey: path })),
      lstat: vi.fn(async (path: string) => ({ type: path.endsWith('/link') ? 'symlink' : 'directory' })),
      contains: vi.fn((parent: { targetKey: string }, child: { targetKey: string }) => {
        const relative = posix.relative(parent.targetKey, child.targetKey)
        return relative === '' || (relative !== '..' && !relative.startsWith('../'))
      }),
      listDir: vi.fn(async (target: { targetKey: string }) => directories.get(target.targetKey) ?? []),
    }
    const serviceFor = vi.fn(() => remoteFs)
    ctx.provide('agentPresets', { serviceFor } as never)
    const adapter = new SessionFileReferences(ctx)
    const agent = Object.assign({} as Agent, { ctx, session: { header: { cwd: '/srv/study', execution: { kind: 'ssh', host: 'campus' } } } })
    const signal = new AbortController().signal

    await expect(adapter.list(agent, '', signal)).resolves.toEqual([
      { path: 'src', kind: 'directory' }, { path: 'README.md', kind: 'file' },
    ])
    await expect(adapter.list(agent, 'src/te', signal)).resolves.toEqual([
      { path: 'src/temporary.ts', kind: 'file' }, { path: 'src/test.ts', kind: 'file' },
    ])
    await expect(adapter.list(agent, '../local', signal)).resolves.toEqual([])
    await expect(adapter.list(agent, 'link/private', signal)).resolves.toEqual([])
    expect(serviceFor).toHaveBeenCalledWith(agent, 'fs')
    expect(remoteFs.listDir).toHaveBeenCalledTimes(2)
    expect(localList).not.toHaveBeenCalled()
    expect(localFs.listDir).not.toHaveBeenCalled()
  })

  it('refuses SSH completion when its isolated filesystem is missing or aliases the Host filesystem', () => {
    const ctx = new Context()
    const localList = vi.fn(async () => [{ path: 'local-secret.txt', kind: 'file' }])
    const localFs = { listDir: vi.fn() }
    ctx.provide('fileReferences', { list: localList } as never)
    ctx.provide('fs', localFs as never)
    const adapter = new SessionFileReferences(ctx)
    const agent = Object.assign({} as Agent, { ctx, session: { header: { cwd: '/srv/study', execution: { kind: 'ssh', host: 'campus' } } } })
    const signal = new AbortController().signal
    expect(() => adapter.list(agent, '', signal)).toThrow('SSH file-reference provider is unavailable')
    ctx.provide('agentPresets', { serviceFor: () => localFs } as never)
    expect(() => adapter.list(agent, '', signal)).toThrow('SSH file-reference provider is unavailable')
    expect(localList).not.toHaveBeenCalled()
    expect(localFs.listDir).not.toHaveBeenCalled()
  })
})
