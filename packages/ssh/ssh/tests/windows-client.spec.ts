/** Windows SSH client: separate authenticated exec channels without POSIX mux sockets. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshRpcPeer } from '../src/protocol.ts'
import { SshConnection } from '../src/index.ts'

const transport = vi.hoisted(() => ({ spawn: vi.fn(), authenticate: vi.fn() }))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), spawn: transport.spawn,
}))
vi.mock('../src/stream-security.ts', () => ({ authenticateStream: transport.authenticate }))

class Child extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: string[] = []
  killed = false
  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal)
    this.killed = true
    queueMicrotask(() => {
      this.stdin.destroy()
      this.stdout.destroy()
      this.stderr.destroy()
      this.emit('close', 0, signal)
    })
    return true
  }
}

const config = {
  host: 'research-host', node: '/usr/bin/node', helper: '/opt/dsh/helper.js',
  helperHash: 'a'.repeat(64), workspace: '/home/research/project',
  requestTimeoutMs: 1000, maxFrameBytes: 4096, maxPending: 8, leaseMs: 30_000,
}

function setup() {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const main = new Child()
  const stream = new Child()
  transport.spawn.mockReturnValueOnce(main).mockReturnValueOnce(stream)
  const peer = new SshRpcPeer(main.stdin, main.stdout, 4096, 8, async (method) => {
    if (method === 'hello') return {
      protocol: 1, hash: config.helperHash, platform: 'linux', nodeVersion: 'v24.0.0',
      node: config.node, root: '/tmp/dsh-ssh-remote', workspace: config.workspace,
    }
    if (method === 'heartbeat' || method === 'close') return null
    if (method === 'echo') return { ok: true }
    throw new Error(`Unexpected RPC ${method}`)
  })
  const ctx = new Context()
  const service = new SshConnection(ctx, config)
  onTestFinished(async () => {
    await service.dispose()
    peer.close()
    await ctx.fiber.dispose()
    platform.mockRestore()
    transport.spawn.mockReset()
    transport.authenticate.mockReset()
  })
  return { service, main, stream }
}

describe('Windows SSH client', () => {
  it('uses a regular SSH exec channel for the verified helper and keeps RPC working', async () => {
    const { service } = setup()
    await service.ready
    expect(await service.request('echo', {}, z.object({ ok: z.boolean() }))).toEqual({ ok: true })
    const argv = transport.spawn.mock.calls[0]?.[1] as string[]
    expect(argv).toContain('BatchMode=yes')
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv).not.toContain('-M')
    expect(argv).not.toContain('-S')
    expect(argv.at(-1)).toContain("'/usr/bin/node' '--disable-sigusr1' '/opt/dsh/helper.js'")
  })

  it('opens each stream in its own SSH channel and joins child teardown', async () => {
    const { service, stream } = setup()
    await service.ready
    const authenticated = new PassThrough()
    transport.authenticate.mockResolvedValue(authenticated)
    const socket = await service.connectStream({
      path: '/tmp/dsh-ssh-remote/stdout', capability: 'b'.repeat(64),
    })
    expect(socket).toBe(authenticated)
    const argv = transport.spawn.mock.calls[1]?.[1] as string[]
    expect(argv).not.toContain('-M')
    expect(argv.at(-1)).toContain(`'--stream' '/tmp/dsh-ssh-remote/stdout' '${config.helperHash}'`)
    expect(transport.authenticate).toHaveBeenCalledWith(expect.anything(), 'b'.repeat(64), 1000, expect.any(AbortSignal))
    await service.dispose()
    expect(stream.signals).toContain('SIGTERM')
  })

  it('closes a failed stream channel before returning the authentication error', async () => {
    const { service, stream } = setup()
    await service.ready
    transport.authenticate.mockRejectedValue(new Error('TLS refused'))
    await expect(service.connectStream({
      path: '/tmp/dsh-ssh-remote/stdout', capability: 'b'.repeat(64),
    })).rejects.toThrow('TLS refused')
    expect(stream.signals).toContain('SIGTERM')
  })

  it('cancels a pending stream without leaving its SSH child running', async () => {
    const { service, stream } = setup()
    await service.ready
    const entered = Promise.withResolvers<undefined>()
    transport.authenticate.mockImplementation((_raw, _capability, _timeout, signal: AbortSignal) => new Promise((_resolve, reject) => {
      entered.resolve(undefined)
      signal.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('stream aborted'))
      }, { once: true })
    }))
    const controller = new AbortController()
    const connecting = service.connectStream({
      path: '/tmp/dsh-ssh-remote/stdout', capability: 'b'.repeat(64),
    }, controller.signal)
    await entered.promise
    controller.abort(new Error('caller cancelled'))
    await expect(connecting).rejects.toThrow('caller cancelled')
    expect(stream.signals).toContain('SIGTERM')
  })

  it('closes an active stream when the primary helper disconnects', async () => {
    const { service, main, stream } = setup()
    await service.ready
    const authenticated = new PassThrough()
    transport.authenticate.mockResolvedValue(authenticated)
    await service.connectStream({ path: '/tmp/dsh-ssh-remote/stdout', capability: 'b'.repeat(64) })
    const closed = new Promise<void>((resolve) => { authenticated.once('close', () => { resolve() }) })
    main.kill('SIGTERM')
    await closed
    expect(authenticated.destroyed).toBe(true)
    expect(stream.signals).toContain('SIGTERM')
  })

  it('disposes after a stream process has already exited', async () => {
    const { service, stream } = setup()
    await service.ready
    const authenticated = new PassThrough()
    transport.authenticate.mockResolvedValue(authenticated)
    await service.connectStream({ path: '/tmp/dsh-ssh-remote/stdout', capability: 'b'.repeat(64) })
    stream.kill('SIGTERM')
    await Promise.resolve()
    await expect(service.dispose()).resolves.toBeUndefined()
  })
})
