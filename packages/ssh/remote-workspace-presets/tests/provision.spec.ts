import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  calls: [] as { args: string[]; input: Buffer; env: Record<string, string> | undefined }[], failure: '',
}))

vi.mock('node:child_process', () => ({
  // The `ssh -V` check that precedes a password login.
  execFile: (_file: string, _args: string[], _options: object, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    done(null, '', 'OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024')
  },
  spawn: (_command: string, args: string[], options?: { env?: Record<string, string> }) => {
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
      mock.calls.push({ args, input, env: options?.env })
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

import { disposeAskpass, SshPasswordStore, type PasswordRecords } from '@deepseek-ai/dsh-ssh/auth'
import { provisionRemoteWorkspace, sshCommand, validateRemoteWorkspace } from '../src/provision.ts'

const SECRET = 'pässwörd测试 &%^"\'x!'

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

  it('accepts user@host with a port and refuses anything OpenSSH could read as an option', () => {
    expect(() => { validateRemoteWorkspace({ host: 'alice@192.0.2.10:2222', path: '/srv' }) }).not.toThrow()
    for (const host of ['-oProxyCommand=x', 'host:', 'a b', 'host:1:2']) {
      expect(() => { validateRemoteWorkspace({ host, path: '/srv' }) }).toThrow('OpenSSH alias or user@host')
    }
  })
})

describe('remote workspace password login', () => {
  const store = (): SshPasswordStore => {
    const stored = new Map<string, unknown>()
    return new SshPasswordStore({
      readRecord: key => Promise.resolve(stored.get(key)),
      modifyRecord: async (key, mutate) => { const next = await mutate(undefined); stored.set(key, next); return next },
      deleteRecord: (key) => { stored.delete(key); return Promise.resolve() },
    } as PasswordRecords)
  }

  it('runs every setup command with the password in the child environment only', async () => {
    mock.calls = []
    mock.failure = ''
    const runtime = await provisionRemoteWorkspace({ host: 'alice@192.0.2.10:2222', path: '/srv/input' }, { password: SECRET })
    expect(runtime.canonicalPath).toBe('/srv/canonical')
    expect(mock.calls).toHaveLength(3)
    for (const call of mock.calls) {
      expect(call.args.join('\u0000')).not.toContain(SECRET)
      expect(call.args).toEqual(expect.arrayContaining(['-p', '2222', 'alice@192.0.2.10', 'BatchMode=no', 'NumberOfPasswordPrompts=1', 'StrictHostKeyChecking=yes', 'ForwardAgent=no']))
      expect(call.args).not.toContain('BatchMode=yes')
      expect(call.env?.['DSH_SSH_ASKPASS_SECRET']).toBe(SECRET)
      expect(call.env?.['SSH_ASKPASS_REQUIRE']).toBe('force')
    }
    await disposeAskpass()
  })

  it('uses the password saved for the host, and key login for a host without one', async () => {
    const passwords = store()
    await passwords.set('lab', SECRET)
    mock.calls = []
    await sshCommand('lab', 'true', undefined, undefined, { passwords })
    await sshCommand('other', 'true', undefined, undefined, { passwords })
    expect(mock.calls[0]?.env?.['DSH_SSH_ASKPASS_SECRET']).toBe(SECRET)
    expect(mock.calls[1]?.env).toBeUndefined()
    expect(mock.calls[1]?.args).toContain('BatchMode=yes')
    await disposeAskpass()
  })

  it.each([
    ['alice@lab: Permission denied (publickey,password).', 'auth'],
    ['ssh: connect to host lab port 22: Connection refused', 'unreachable'],
    ['ssh: Could not resolve hostname lab: Name or service not known', 'unreachable'],
    ['No ED25519 host key is known for lab and you have requested strict checking.\nHost key verification failed.', 'host-key'],
    ['Host key for lab has changed and you have requested strict checking.\nHost key verification failed.', 'host-key-changed'],
  ])('classifies an ssh refusal as %s without exposing the password', async (stderr, kind) => {
    mock.calls = []
    mock.failure = `${stderr}\nthe password ${SECRET} was not accepted`
    const failure = await provisionRemoteWorkspace({ host: 'lab', path: '/srv/input' }, { password: SECRET }).catch((error: unknown) => error)
    mock.failure = ''
    expect(failure).toMatchObject({ name: 'SshFailure', kind })
    expect((failure as Error).message).not.toContain(SECRET)
    expect((failure as Error).message).toContain('***')
    await disposeAskpass()
  })

  it('keeps the remote command output of a failure that ssh did not cause, with the password removed', async () => {
    mock.failure = `EACCES: permission denied, open '/srv/x' with ${SECRET}`
    const failure = await provisionRemoteWorkspace({ host: 'lab', path: '/srv/input' }, { password: SECRET }).catch((error: unknown) => error)
    mock.failure = ''
    expect((failure as Error).name).toBe('Error')
    expect((failure as Error).message).toContain('SSH setup failed (exit 1): EACCES: permission denied')
    expect((failure as Error).message).not.toContain(SECRET)
    await disposeAskpass()
  })
})
