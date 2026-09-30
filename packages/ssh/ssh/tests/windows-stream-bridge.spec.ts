/** A separate SSH exec channel bridges a verified POSIX helper socket. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { runSshStreamBridge } from '../src/helper.ts'

const transport = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('node:net', async original => ({
  ...await original<typeof import('node:net')>(), createConnection: transport.connect,
}))

async function fixture() {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-bridge-'))
  const entryPath = join(directory, 'helper.js')
  const bytes = 'verified helper entry'
  await writeFile(entryPath, bytes)
  const helperHash = createHash('sha256').update(bytes).digest('hex')
  const input = new PassThrough()
  const output = new PassThrough()
  const socket = new PassThrough()
  transport.connect.mockReturnValue(socket)
  onTestFinished(async () => {
    input.destroy()
    output.destroy()
    socket.destroy()
    transport.connect.mockReset()
    platform.mockRestore()
    await rm(directory, { recursive: true })
  })
  return { entryPath, helperHash, input, output, socket, signal: new AbortController() }
}

describe('SSH stdio stream bridge', () => {
  it('checks the helper digest before connecting and copies bytes through the POSIX socket', async () => {
    const f = await fixture()
    const bytes = new Promise<string>((resolve) => { f.output.once('data', (chunk) => { resolve(String(chunk)) }) })
    const bridge = runSshStreamBridge({
      path: '/tmp/dsh-ssh-remote/stdout', entryPath: f.entryPath, helperHash: f.helperHash,
      input: f.input, output: f.output, signal: f.signal.signal,
    })
    queueMicrotask(() => { f.socket.emit('connect') })
    f.input.write('stream payload')
    expect(await bytes).toBe('stream payload')
    expect(transport.connect).toHaveBeenCalledWith({ path: '/tmp/dsh-ssh-remote/stdout', allowHalfOpen: true })
    f.socket.destroy()
    await bridge
  })

  it('rejects a changed helper before a stream socket is opened', async () => {
    const f = await fixture()
    await expect(runSshStreamBridge({
      path: '/tmp/dsh-ssh-remote/stdout', entryPath: f.entryPath, helperHash: '0'.repeat(64),
      input: f.input, output: f.output, signal: f.signal.signal,
    })).rejects.toThrow('digest differs')
    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('aborts a pending stream and releases its socket', async () => {
    const f = await fixture()
    const bridge = runSshStreamBridge({
      path: '/tmp/dsh-ssh-remote/stdout', entryPath: f.entryPath, helperHash: f.helperHash,
      input: f.input, output: f.output, signal: f.signal.signal,
    })
    f.signal.abort(new Error('cancelled'))
    await expect(bridge).rejects.toThrow('cancelled')
    expect(f.socket.destroyed).toBe(true)
  })
})
