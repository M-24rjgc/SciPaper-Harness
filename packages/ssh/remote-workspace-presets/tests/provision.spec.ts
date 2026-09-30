import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ calls: [] as { args: string[]; input: Buffer }[], failure: '' }))

vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: () => boolean
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    const chunks: Buffer[] = []
    child.stdin.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    child.stdin.once('end', () => {
      const input = Buffer.concat(chunks)
      mock.calls.push({ args, input })
      if (args.at(-1)?.includes('process.execPath')) {
        child.stdout.end(JSON.stringify({ node: '/usr/bin/node', major: 24 }))
        child.emit('close', 0)
      } else if (mock.failure) {
        child.stderr.end(mock.failure)
        child.emit('close', 1)
      } else if (args.at(-1)?.includes('SSH LSP archive')) {
        child.stdout.end(JSON.stringify({
          typescriptLanguageServer: '/home/alice/.scipaper-harness/ssh-lsp/hash/node_modules/typescript-language-server/lib/cli.mjs',
        }))
        child.emit('close', 0)
      } else {
        child.stdout.end(JSON.stringify({
          helper: '/home/alice/.scipaper-harness/ssh-helper/hash/helper.mjs',
          canonicalPath: '/srv/canonical', rg: '/usr/bin/rg',
        }))
        child.emit('close', 0)
      }
    })
    return child
  },
}))

import { provisionRemoteWorkspace } from '../src/provision.ts'

describe('remote workspace helper setup', () => {
  it('uploads the bundled helper through strict noninteractive SSH and returns verified coordinates', async () => {
    mock.calls = []
    mock.failure = ''
    const runtime = await provisionRemoteWorkspace({ host: 'campus', path: '/srv/input' })
    expect(runtime.node).toBe('/usr/bin/node')
    expect(runtime.canonicalPath).toBe('/srv/canonical')
    expect(runtime.rg).toBe('/usr/bin/rg')
    expect(runtime.typescriptLanguageServer).toContain('/ssh-lsp/')
    expect(mock.calls).toHaveLength(3)
    for (const call of mock.calls) {
      expect(call.args).toContain('BatchMode=yes')
      expect(call.args).toContain('StrictHostKeyChecking=yes')
      expect(call.args).toContain('ForwardAgent=no')
      expect(call.args).toContain('campus')
    }
    const bytes = mock.calls[1]?.input
    expect(bytes?.length).toBeGreaterThan(100_000)
    expect(createHash('sha256').update(bytes as Buffer).digest('hex')).toBe(runtime.helperHash)
    expect(mock.calls[1]?.args.at(-1)).toContain("'/srv/input'")
    const archive = mock.calls[2]?.input
    expect(archive?.length).toBeGreaterThan(1_000_000)
    const files = JSON.parse(gunzipSync(archive as Buffer).toString('utf8')) as Array<[string, string]>
    expect(files.map(([name]) => name)).toEqual(expect.arrayContaining([
      'typescript-language-server/lib/cli.mjs',
      'typescript/lib/tsserver.js',
      'typescript/lib/_tsserver.js',
      'typescript/lib/typescript.js',
    ]))
    expect(mock.calls[2]?.args.at(-1)).toContain(createHash('sha256').update(archive as Buffer).digest('hex'))
  })

  it('propagates remote directory and installation errors without registering a preset', async () => {
    mock.calls = []
    mock.failure = 'SSH workspace is not a directory'
    await expect(provisionRemoteWorkspace({ host: 'campus', path: '/srv/missing' }))
      .rejects.toThrow('SSH workspace is not a directory')
  })
})
