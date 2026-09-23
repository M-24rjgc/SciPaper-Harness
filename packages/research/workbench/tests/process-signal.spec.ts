import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'

// Only POSIX reports a signal death as a null exit code; a scripted child shows it on every host.
vi.mock('node:child_process', () => ({
  spawn: () => {
    const streams = { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() }
    const child = Object.assign(new EventEmitter(), { pid: 1, ...streams })
    setImmediate(() => { child.emit('close', null) })
    return child
  },
}))

const { runProcess } = await import('../src/process.ts')

it('reports a child ended by a signal as exit code -1', async () => {
  expect(await runProcess('research-signalled', [])).toEqual({ code: -1, stdout: '', stderr: '' })
})
