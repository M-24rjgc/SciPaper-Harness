/** Remote runs: how the ssh client is started for keys and for a saved password. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { disposeAskpass, SshPasswordStore, type PasswordRecords } from '@deepseek-ai/dsh-ssh/auth'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSshPasswords, ssh } from '../src/process.ts'

const client = vi.hoisted(() => ({
  banner: 'OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3',
  stdout: '',
  stderr: '',
  spawned: [] as { command: string; args: string[]; env: Record<string, string> | undefined }[],
}))

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    // `ssh -V` prints its banner on standard error.
    execFile: (_file: string, _args: string[], _options: object, done: (error: Error | null, stdout: string, stderr: string) => void) => {
      done(null, '', client.banner)
    },
    spawn: (command: string, args: string[], options: { env?: Record<string, string> }) => {
      if (command !== 'ssh') return actual.spawn(command, args, options as never)
      client.spawned.push({ command, args, env: options.env })
      const child = Object.assign(new EventEmitter(), {
        pid: 4242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      })
      child.stdin.resume()
      queueMicrotask(() => {
        child.stdout.end(client.stdout)
        child.stderr.end(client.stderr)
        setImmediate(() => { child.emit('close', 0) })
      })
      return child
    },
  }
})

const SECRET = 'pässwörd测试 &%^"\'x!'

function records(): PasswordRecords {
  const stored = new Map<CredentialKey, CredentialRecord>()
  return {
    readRecord: key => Promise.resolve(stored.get(key)),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(stored.get(key))
      if (next !== undefined) stored.set(key, next)
      return next
    },
    deleteRecord: (key) => { stored.delete(key); return Promise.resolve() },
  }
}

/** A context whose credential provider holds a password for each listed host. */
async function contextWith(passwords: Record<string, string>): Promise<Context> {
  const ctx = new Context()
  const backing = records()
  ctx.provide('credentials', backing as never)
  for (const [host, password] of Object.entries(passwords)) await new SshPasswordStore(backing).set(host, password)
  return ctx
}

afterEach(async () => {
  client.spawned.length = 0
  client.stdout = ''
  client.stderr = ''
  client.banner = 'OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3'
  await disposeAskpass()
})

describe('ssh() for remote runs', () => {
  it('keeps the batch-mode key invocation for a host without a saved password', async () => {
    const dispose = installSshPasswords(await contextWith({ other: SECRET }))
    await ssh('research-host', ['python', '-c', "print('x')"])
    dispose()
    expect(client.spawned).toHaveLength(1)
    expect(client.spawned[0]?.args).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'research-host', "'python' '-c' 'print('\\''x'\\'')'"])
    expect(client.spawned[0]?.env?.['SSH_ASKPASS']).toBeUndefined()
    expect(client.spawned[0]?.env?.['DSH_SSH_ASKPASS_SECRET']).toBeUndefined()
  })

  it('names the port of user@host:port, and passes an ssh:// address through for OpenSSH to read', async () => {
    await ssh('alice@192.0.2.10:2222', ['true'])
    await ssh('ssh://alice@192.0.2.10:2222', ['true'])
    expect(client.spawned[0]?.args.slice(0, 6)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-p', '2222'])
    expect(client.spawned[0]?.args.slice(6, 7)).toEqual(['alice@192.0.2.10'])
    expect(client.spawned[1]?.args.slice(4, 5)).toEqual(['ssh://alice@192.0.2.10:2222'])
  })

  it('logs in with the password saved for the host, which only the ssh child environment carries', async () => {
    const dispose = installSshPasswords(await contextWith({ 'alice@192.0.2.10:2222': SECRET }))
    client.stdout = `out ${SECRET}`
    client.stderr = `Permission denied, please try again. ${SECRET}`
    const result = await ssh('alice@192.0.2.10:2222', ['true'])
    dispose()
    const call = client.spawned[0]
    expect(call?.args.join('\u0000')).not.toContain(SECRET)
    expect(call?.args).toEqual(expect.arrayContaining(['-p', '2222', 'alice@192.0.2.10', 'BatchMode=no', 'NumberOfPasswordPrompts=1', 'ConnectTimeout=15']))
    expect(call?.args).not.toContain('BatchMode=yes')
    expect(call?.env?.['DSH_SSH_ASKPASS_SECRET']).toBe(SECRET)
    expect(call?.env?.['SSH_ASKPASS_REQUIRE']).toBe('force')
    expect(result).toEqual({ code: 0, stdout: 'out ***', stderr: 'Permission denied, please try again. ***' })
  })

  it('stops using saved passwords once the source is removed, and ignores the removal of a replaced source', async () => {
    const first = installSshPasswords(await contextWith({ lab: SECRET }))
    const second = installSshPasswords(await contextWith({}))
    first()
    await ssh('lab', ['true'])
    expect(client.spawned[0]?.args).toContain('BatchMode=yes')
    second()
    const third = installSshPasswords(await contextWith({ lab: SECRET }))
    second()
    await ssh('lab', ['true'])
    third()
    expect(client.spawned[1]?.args).toContain('BatchMode=no')
    await ssh('lab', ['true'])
    expect(client.spawned[2]?.args).toContain('BatchMode=yes')
  })

  it('refuses a saved password the installed OpenSSH cannot supply', async () => {
    client.banner = 'OpenSSH_8.2p1 Ubuntu-4ubuntu0.5, OpenSSL 1.1.1f'
    const dispose = installSshPasswords(await contextWith({ lab: SECRET }))
    await expect(ssh('lab', ['true'])).rejects.toMatchObject({ name: 'SshFailure', kind: 'unsupported' })
    dispose()
    expect(client.spawned).toHaveLength(0)
  })
})
