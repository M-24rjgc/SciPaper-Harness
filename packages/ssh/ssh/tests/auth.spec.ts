/** SSH destinations, password authentication through SSH_ASKPASS, and failure classification. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  askpassProgram, classifySshFailure, disposeAskpass, parseSshHost, planSshAuth, sshDestinationArguments, SshFailure, sshFailureFrom,
  sshFailureOf, sshHostKeyOf, sshPasswordKey, SshPasswordStore, sshPasswordStoreOf, SSH_HOST_PATTERN, validateSshPassword,
  type PasswordRecords,
} from '../src/auth.ts'

const client = vi.hoisted(() => ({ banner: '', error: undefined as (Error & { code?: string }) | undefined }))

vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  // `ssh -V` prints its banner on standard error.
  execFile: (_file: string, _args: string[], _options: object, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    done(client.error ?? null, '', client.banner)
  },
}))

afterEach(async () => {
  client.banner = ''
  client.error = undefined
  await disposeAskpass()
})

/** In-memory credential records, as the local provider keeps them. */
function records(): PasswordRecords & { readonly stored: Map<CredentialKey, CredentialRecord> } {
  const stored = new Map<CredentialKey, CredentialRecord>()
  return {
    stored,
    readRecord: key => Promise.resolve(stored.get(key)),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(stored.get(key))
      if (next !== undefined) stored.set(key, next)
      return next
    },
    deleteRecord: (key) => { stored.delete(key); return Promise.resolve() },
  }
}

const TRICKY = 'pässwörd测试 &%^"\'x!'

describe('SSH destinations', () => {
  it('splits an optional port from an alias or user@host and leaves other spellings to OpenSSH', () => {
    expect(parseSshHost('lab')).toEqual({ host: 'lab' })
    expect(parseSshHost('alice@lab.example.org')).toEqual({ host: 'alice@lab.example.org' })
    expect(parseSshHost('alice@10.0.0.7:2222')).toEqual({ host: 'alice@10.0.0.7', port: 2222 })
    expect(parseSshHost('ssh://alice@lab:2222')).toEqual({ host: 'ssh://alice@lab:2222' })
    expect(sshDestinationArguments('lab')).toEqual(['lab'])
    expect(sshDestinationArguments('alice@lab:2222')).toEqual(['-p', '2222', 'alice@lab'])
    expect(sshDestinationArguments('ssh://alice@lab:2222')).toEqual(['ssh://alice@lab:2222'])
  })

  it('refuses a port outside 1 through 65535', () => {
    expect(() => parseSshHost('lab:0')).toThrow('SSH port must be between 1 and 65535')
    expect(() => parseSshHost('lab:65536')).toThrow('SSH port must be between 1 and 65535')
    expect(parseSshHost('lab:65535').port).toBe(65_535)
  })

  it('accepts only aliases and user@host with an optional decimal port', () => {
    for (const accepted of ['lab', 'alice@lab', 'alice@lab:22', 'a.b-c_d@h1:65535']) expect(SSH_HOST_PATTERN.test(accepted)).toBe(true)
    for (const refused of ['', '-oProxyCommand=x', 'lab:', 'lab:123456', 'lab:x', 'a b', 'lab;x', 'lab:22:22', 'ssh://lab']) {
      expect(SSH_HOST_PATTERN.test(refused)).toBe(false)
    }
  })
})

describe('ssh failure classification', () => {
  it('recognizes the client phrases of a wrong password, an unreachable host and an untrusted host key', () => {
    expect(classifySshFailure('alice@lab: Permission denied (publickey,password).')).toBe('auth')
    expect(classifySshFailure('Permission denied, please try again.')).toBe('auth')
    expect(classifySshFailure('Received disconnect: Too many authentication failures')).toBe('auth')
    for (const text of [
      'ssh: Could not resolve hostname nowhere.invalid: No such host is known.',
      'ssh: connect to host 10.0.0.9 port 22: Connection refused',
      'Connection to 10.255.255.1 port 22 timed out',
    ]) expect(classifySshFailure(text)).toBe('unreachable')
    for (const text of [
      'banner exchange: Connection to UNKNOWN port -1: Connection refused',
      'kex_exchange_identification: Connection closed by remote host',
      'Connection timed out during banner exchange',
      'Connection closed by 198.18.1.43 port 22',
    ]) expect(classifySshFailure(text)).toBe('handshake')
    expect(classifySshFailure('No ED25519 host key is known for [127.0.0.1]:2222 and you have requested strict checking.\nHost key verification failed.')).toBe('host-key')
    expect(classifySshFailure('Host key verification failed.')).toBe('host-key')
    expect(classifySshFailure(
      '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key for [127.0.0.1]:2222 has changed and you have requested strict checking.\nHost key verification failed.',
    )).toBe('host-key-changed')
  })

  it('never takes a remote command failure for an ssh failure', () => {
    expect(classifySshFailure("Error: EACCES: permission denied, open '/srv/project'")).toBeUndefined()
    expect(classifySshFailure('bash: line 1: /srv/run.sh: Permission denied')).toBeUndefined()
    expect(classifySshFailure('SSH workspace is not a directory')).toBeUndefined()
    expect(classifySshFailure('')).toBeUndefined()
  })

  it('reports a classified failure with the last diagnostic line, and anything else as the fallback', () => {
    const fallback = new Error('fallback')
    expect(sshFailureFrom('plain remote error', fallback)).toBe(fallback)
    const failure = sshFailureFrom('banner\n\nalice@lab: Permission denied (password).\n', fallback)
    expect(failure).toBeInstanceOf(SshFailure)
    expect(failure.message).toBe('SSH authentication failed: alice@lab: Permission denied (password).')
    expect(sshFailureFrom(`Permission denied (x).${'!'.repeat(500)}`, fallback).message.length).toBeLessThan(400)
    expect(new SshFailure('unsupported').message).toBe('SSH password login is not available on this computer')
  })

  it('reads the kind of a failure thrown by any copy of the module and nothing else', () => {
    expect(sshFailureOf(new SshFailure('host-key'))).toBe('host-key')
    const foreign = Object.assign(new Error('x'), { name: 'SshFailure', kind: 'unreachable' })
    expect(sshFailureOf(foreign)).toBe('unreachable')
    expect(sshFailureOf(Object.assign(new Error('x'), { name: 'SshFailure', kind: 'odd' }))).toBeUndefined()
    expect(sshFailureOf(new Error('x'))).toBeUndefined()
    expect(sshFailureOf('SshFailure')).toBeUndefined()
  })
})

describe('the host key an unknown host presents', () => {
  const fingerprint = 'SHA256:zCYWjkRQRY+WeviSPL50T/cy+RxRuyZ6L09VwGtUuEM'

  it('rides on a host-key failure and is read back from any copy of the module', () => {
    const failure = new SshFailure('host-key', undefined, { type: 'ED25519', fingerprint })
    expect(failure.message).toBe('SSH host key is not trusted yet')
    expect(sshHostKeyOf(failure)).toEqual({ type: 'ED25519', fingerprint })
    const foreign = Object.assign(new Error('x'), { name: 'SshFailure', kind: 'host-key', hostKey: { type: 'RSA', fingerprint } })
    expect(sshHostKeyOf(foreign)).toEqual({ type: 'RSA', fingerprint })
  })

  it('reads nothing from a failure without a well-formed key, or from anything else', () => {
    expect(sshHostKeyOf(new SshFailure('host-key'))).toBeUndefined()
    expect(sshHostKeyOf(new SshFailure('host-key', undefined, { type: 'ED25519', fingerprint: 'SHA256:short' }))).toBeUndefined()
    expect(sshHostKeyOf(Object.assign(new SshFailure('host-key'), { hostKey: { type: 1, fingerprint } }))).toBeUndefined()
    expect(sshHostKeyOf(Object.assign(new SshFailure('host-key'), { hostKey: { type: 'ED25519', fingerprint: 5 } }))).toBeUndefined()
    expect(sshHostKeyOf(Object.assign(new Error('x'), { hostKey: { type: 'ED25519', fingerprint } }))).toBeUndefined()
    expect(sshHostKeyOf('x')).toBeUndefined()
  })
})

describe('saved passwords', () => {
  it('keys a password by a hash of its host, so the credential file does not list hosts', () => {
    const key = sshPasswordKey('alice@lab.example.org:2222')
    expect(key).toMatch(/^ssh\/host-[0-9a-f]{32}$/u)
    expect(key).not.toContain('lab')
    expect(sshPasswordKey('alice@lab.example.org:2222')).toBe(key)
    expect(sshPasswordKey('alice@lab.example.org')).not.toBe(key)
  })

  it('validates a password as one prompt answer without echoing it', () => {
    expect(() => { validateSshPassword(TRICKY) }).not.toThrow()
    for (const bad of ['', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(1025)]) {
      expect(() => { validateSshPassword(bad) }).toThrow('SSH password must be 1 to 1024 characters on one line')
    }
    expect(() => { validateSshPassword('x'.repeat(1024)) }).not.toThrow()
  })

  it('stores, reads, replaces and forgets a password in the credential record store', async () => {
    const backing = records()
    const store = new SshPasswordStore(backing)
    expect(await store.get('lab')).toBeUndefined()
    await store.set('lab', TRICKY)
    expect(await store.get('lab')).toBe(TRICKY)
    expect(await store.get('other')).toBeUndefined()
    await store.set('lab', 'second')
    expect(await store.get('lab')).toBe('second')
    await store.delete('lab')
    expect(await store.get('lab')).toBeUndefined()
    await store.delete('lab')
    await expect(store.set('lab', '')).rejects.toThrow('SSH password must be')
  })

  it('reads nothing from a record that is not a saved password', async () => {
    const backing = records()
    const store = new SshPasswordStore(backing)
    backing.stored.set(sshPasswordKey('grant'), { kind: 'grant', payload: { token: 'x' } })
    backing.stored.set(sshPasswordKey('env'), { kind: 'api-key', env: { A: 'b' } })
    backing.stored.set(sshPasswordKey('blank'), { kind: 'api-key', key: '' })
    for (const host of ['grant', 'env', 'blank']) expect(await store.get(host)).toBeUndefined()
  })

  it('builds the store over the composed credential provider, when there is one', async () => {
    const ctx = new Context()
    expect(sshPasswordStoreOf(ctx)).toBeUndefined()
    const backing = records()
    ctx.provide('credentials', backing as never)
    const store = sshPasswordStoreOf(ctx)
    await store?.set('lab', 'pw')
    expect([...backing.stored.keys()]).toEqual([sshPasswordKey('lab')])
  })
})

describe('authentication plans', () => {
  it('keeps key and agent authentication unchanged when no password exists', async () => {
    const plan = await planSshAuth('lab')
    expect(plan.options).toEqual(['-o', 'BatchMode=yes'])
    expect(plan.env).toBeUndefined()
    expect(plan.destination).toEqual(['lab'])
    expect(plan.redact('anything')).toBe('anything')
    const withStore = await planSshAuth('alice@lab:2222', new SshPasswordStore(records()))
    expect(withStore.options).toEqual(['-o', 'BatchMode=yes'])
    expect(withStore.destination).toEqual(['-p', '2222', 'alice@lab'])
    expect(withStore.env).toBeUndefined()
  })

  it('supplies a saved password only through the environment of the ssh child', async () => {
    client.banner = 'OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3'
    const store = new SshPasswordStore(records())
    await store.set('alice@lab:2222', TRICKY)
    const plan = await planSshAuth('alice@lab:2222', store)
    const argv = [...plan.options, ...plan.destination]
    expect(argv.join('\u0000')).not.toContain(TRICKY)
    expect(argv.some(item => item.includes('pässwörd'))).toBe(false)
    expect(plan.options).toEqual([
      '-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'PubkeyAuthentication=no',
      '-o', 'PreferredAuthentications=password,keyboard-interactive',
    ])
    expect(plan.destination).toEqual(['-p', '2222', 'alice@lab'])
    expect(plan.env?.['SSH_ASKPASS_REQUIRE']).toBe('force')
    expect(plan.env?.['DSH_SSH_ASKPASS_SECRET']).toBe(TRICKY)
    expect(JSON.stringify(plan.env?.['SSH_ASKPASS'])).not.toContain('pässwörd')
    expect(existsSync(plan.env?.['SSH_ASKPASS'] as string)).toBe(true)
  })

  it('prefers an explicit password to a saved one and removes it from diagnostics', async () => {
    client.banner = 'OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024'
    const store = new SshPasswordStore(records())
    await store.set('lab', 'saved')
    const plan = await planSshAuth('lab', store, 'typed-secret')
    expect(plan.env?.['DSH_SSH_ASKPASS_SECRET']).toBe('typed-secret')
    expect(plan.redact('alice: typed-secret rejected; typed-secret again')).toBe('alice: *** rejected; *** again')
    await expect(planSshAuth('lab', store, 'bad\npassword')).rejects.toThrow('SSH password must be')
  })

  it('refuses a password with an OpenSSH that predates SSH_ASKPASS_REQUIRE or cannot be recognized', async () => {
    for (const banner of ['OpenSSH_8.3p1 Ubuntu-1, OpenSSL 1.1.1f', 'OpenSSH_7.9p1 Debian-10', 'SomethingElse 1.0', '']) {
      client.banner = banner
      await disposeAskpass()
      await expect(planSshAuth('lab', undefined, 'pw')).rejects.toMatchObject({ name: 'SshFailure', kind: 'unsupported' })
    }
    client.error = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
    client.banner = ''
    await disposeAskpass()
    await expect(planSshAuth('lab', undefined, 'pw')).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('lets the real ssh start report a missing client and accepts OpenSSH 8.4 and newer', async () => {
    client.error = Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })
    expect((await planSshAuth('lab', undefined, 'pw')).options).toContain('BatchMode=no')
    client.error = undefined
    for (const banner of ['OpenSSH_8.4p1', 'OpenSSH_8.10p1', 'OpenSSH_10.0p2']) {
      client.banner = banner
      await disposeAskpass()
      expect((await planSshAuth('lab', undefined, 'pw')).env?.['SSH_ASKPASS_REQUIRE']).toBe('force')
    }
  })

  it('checks the installed OpenSSH once', async () => {
    client.banner = 'OpenSSH_9.0p1'
    await planSshAuth('lab', undefined, 'pw')
    client.banner = 'OpenSSH_7.0p1'
    await expect(planSshAuth('lab', undefined, 'pw')).resolves.toBeDefined()
  })
})

describe('askpass program', () => {
  const runProgram = (program: string, env: Record<string, string | undefined>): { status: number | null; stdout: string } => {
    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/c', program], { env: { ...process.env, ...env }, encoding: 'utf8' })
      : spawnSync(program, [], { env: { ...process.env, ...env }, encoding: 'utf8' })
    return { status: result.status, stdout: result.stdout }
  }

  it('prints the password from the environment of the ssh child it runs under, in UTF-8', async () => {
    const program = await askpassProgram()
    const answer = runProgram(program, { DSH_SSH_ASKPASS_SECRET: TRICKY, SSH_ASKPASS_PROMPT: undefined })
    expect(answer.status).toBe(0)
    expect(answer.stdout).toBe(`${TRICKY}\n`)
  })

  it('declines a confirmation prompt and a missing secret', async () => {
    const program = await askpassProgram()
    expect(runProgram(program, { DSH_SSH_ASKPASS_SECRET: 'x', SSH_ASKPASS_PROMPT: 'confirm' }).status).not.toBe(0)
    expect(runProgram(program, { DSH_SSH_ASKPASS_SECRET: undefined, SSH_ASKPASS_PROMPT: undefined }).status).not.toBe(0)
  })

  it('keeps one private directory per process, holding no secret, and removes it on disposal and at exit', async () => {
    const once = vi.spyOn(process, 'once')
    const first = await askpassProgram()
    expect(await askpassProgram()).toBe(first)
    const exit = once.mock.calls.find(([event]) => event === 'exit')?.[1] as (() => void) | undefined
    once.mockRestore()
    expect(readFileSync(first, 'utf8')).not.toContain('pässwörd')
    if (process.platform !== 'win32') expect(statSync(join(first, '..')).mode & 0o077).toBe(0)
    exit?.()
    expect(existsSync(first)).toBe(false)
    const second = await askpassProgram()
    await disposeAskpass()
    expect(existsSync(second)).toBe(false)
    await disposeAskpass()
  })

  it('writes the POSIX shell script with owner-only permissions', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-askpass-test-'))
    try {
      const program = await askpassProgram('linux', {}, parent)
      expect(program.endsWith('askpass.sh')).toBe(true)
      expect(readFileSync(program, 'utf8')).toContain('printf')
      if (process.platform !== 'win32') expect(statSync(program).mode & 0o077).toBe(0)
    } finally {
      await disposeAskpass()
      await rm(parent, { recursive: true, force: true })
    }
  })

  // The directory under test must itself be a usable ASCII location; a temporary directory with a
  // non-ASCII user name would move the program to the next candidate.
  it.skipIf(!/^[\x20-\x7e]+$/u.test(tmpdir()))('writes the Windows launcher without routing the secret through cmd.exe', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-askpass-test-'))
    try {
      const program = await askpassProgram('win32', { ProgramData: parent }, parent)
      expect(program.endsWith('askpass.cmd')).toBe(true)
      const launcher = readFileSync(program, 'utf8')
      expect(launcher).toContain('-File "%~dp0askpass.ps1"')
      expect(launcher).toContain('<nul')
      expect(launcher).not.toContain('DSH_SSH_ASKPASS_SECRET')
      expect(readFileSync(join(program, '..', 'askpass.ps1'), 'utf8')).toContain('UTF8Encoding $false')
    } finally {
      await disposeAskpass()
      await rm(parent, { recursive: true, force: true })
    }
  })

  it.skipIf(!/^[\x20-\x7e]+$/u.test(tmpdir()))('skips Windows directories whose path the OpenSSH client cannot start a program from', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-askpass-test-'))
    try {
      // The temporary directory holds non-ASCII characters, so the next ASCII candidate is used.
      const program = await askpassProgram('win32', { ProgramData: parent }, 'C:\\Users\\管理员\\AppData\\Local\\Temp')
      expect(program.startsWith(parent)).toBe(true)
    } finally {
      await disposeAskpass()
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('reports password login as unavailable when no directory can hold the program', async () => {
    const missing = join(tmpdir(), 'dsh-askpass-missing-parent', 'nested')
    await expect(askpassProgram('win32', { ProgramData: missing, SystemDrive: 'Z:' }, missing)).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(askpassProgram('linux', {}, missing)).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
