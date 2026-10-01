/** First-connection host-key trust: reading an unknown host's key, and recording it only once confirmed. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scanHostKey, trustHostKey } from '../src/host-key.ts'

/** The key and fingerprint of the local test server used for the real end-to-end check. */
const ED25519 = 'AAAAC3NzaC1lZDI1NTE5AAAAIBOwtt1yb0I8QZDVNp7UsxAeeE02FjyGjmhsX2ses+8S'
const ED25519_FINGERPRINT = 'SHA256:zCYWjkRQRY+WeviSPL50T/cy+RxRuyZ6L09VwGtUuEM'
const RSA = 'AAAAB3NzaC1yc2EAAAADAQABAAABAQC7vbqajDw4o6gJy8UtmIbkcpNkwHcPflSxMvwb6gpQqRhPODP8cNvM2e0VCn7qY9mUcQwTwhGrMBGr1F8zAcXHk3mJy2aS4y9ZBs0aQ0WqkoYmYF7uVzRa'
const ECDSA = 'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHxCAbtQVNrrb4eEsyj0k0W2QIz4z1pn0sMOjFmQGJXsLH4r7bBl1fQmJuRXb8k5D3b3jQZqBqjNXvxvQ2rJqsA='

interface Reply { stdout?: string; stderr?: string; error?: Error & { code?: string | number } }

const client = vi.hoisted((): {
  calls: { file: string; args: string[] }[]
  replies: Record<'config' | 'scan' | 'probe', Reply>
} => ({ calls: [], replies: { config: {}, scan: {}, probe: {} } }))

vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: (
    file: string, args: string[], _options: object,
    done: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    client.calls.push({ file, args })
    const reply = args.includes('-G') ? client.replies.config : file === 'ssh-keyscan' ? client.replies.scan : client.replies.probe
    done(reply.error ?? null, reply.stdout ?? '', reply.stderr ?? '')
  },
}))

let directory = ''
let knownHosts = ''

/** The settings `ssh -G` prints, with the known_hosts file of this test unless it is replaced. */
function config(settings: Record<string, string> = {}): Reply {
  const all: Record<string, string> = {
    user: 'alice', hostname: '192.0.2.10', port: '2222', userknownhostsfile: `${knownHosts} ${knownHosts}2`, ...settings,
  }
  return { stdout: `\n${Object.entries(all).map(([key, value]) => `${key} ${value}`).join('\n')}\n` }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-host-key-'))
  knownHosts = join(directory, 'ssh', 'known_hosts')
  client.calls.length = 0
  client.replies.config = config()
  client.replies.scan = { stdout: `[192.0.2.10]:2222 ssh-ed25519 ${ED25519}\n`, stderr: '# 192.0.2.10:2222 SSH-2.0-OpenSSH_9.6\n' }
  client.replies.probe = { stderr: 'alice@192.0.2.10: Permission denied (publickey,password).\n' }
})

afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('reading the key an unknown host presents', () => {
  it('resolves the destination through ssh, scans that name and port, and computes the fingerprint locally', async () => {
    const key = await scanHostKey('alice@lab:2222')
    expect(key).toEqual({
      type: 'ED25519', fingerprint: ED25519_FINGERPRINT, entry: `[192.0.2.10]:2222 ssh-ed25519 ${ED25519}`, knownHosts,
    })
    expect(client.calls[0]).toEqual({ file: 'ssh', args: ['-G', '-p', '2222', 'alice@lab'] })
    expect(client.calls[1]?.file).toBe('ssh-keyscan')
    expect(client.calls[1]?.args).toEqual(['-T', '10', '-t', 'ed25519,ecdsa,rsa', '-p', '2222', '192.0.2.10'])
  })

  it('names port 22 without brackets and uses the host key alias when ssh configures one', async () => {
    client.replies.config = config({ port: '22', hostkeyalias: 'lab-alias' })
    const key = await scanHostKey('lab')
    expect(key?.entry).toBe(`lab-alias ssh-ed25519 ${ED25519}`)
    expect(client.calls[1]?.args.at(-1)).toBe('lab-alias')
  })

  it('prefers ed25519, then ecdsa, then rsa, and ignores lines it does not understand', async () => {
    client.replies.scan = { stdout: [
      `[192.0.2.10]:2222 ssh-rsa ${RSA}`, `[192.0.2.10]:2222 ecdsa-sha2-nistp256 ${ECDSA}`, `[192.0.2.10]:2222 ssh-ed25519 ${ED25519}`,
      '[192.0.2.10]:2222 ssh-dss AAAA', 'garbage', '',
    ].join('\n') }
    expect((await scanHostKey('lab'))?.type).toBe('ED25519')
    client.replies.scan = { stdout: `[192.0.2.10]:2222 ssh-rsa ${RSA}\n[192.0.2.10]:2222 ecdsa-sha2-nistp256 ${ECDSA}\n` }
    expect((await scanHostKey('lab'))?.type).toBe('ECDSA')
    client.replies.scan = { stdout: `[192.0.2.10]:2222 ssh-rsa ${RSA}\n` }
    const rsa = await scanHostKey('lab')
    expect(rsa?.type).toBe('RSA')
    expect(rsa?.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/u)
  })

  it('reads nothing from a host that offers no usable key or does not answer', async () => {
    client.replies.scan = { stdout: '[192.0.2.10]:2222 ssh-dss AAAA\nnot a key line\n' }
    expect(await scanHostKey('lab')).toBeUndefined()
    client.replies.scan = { stdout: '' }
    expect(await scanHostKey('lab')).toBeUndefined()
    client.replies.scan = { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }
    expect(await scanHostKey('lab')).toBeUndefined()
    client.replies.scan = { stdout: '', stderr: 'ssh-keyscan: connection refused', error: new Error('exit 1') }
    expect(await scanHostKey('lab')).toBeUndefined()
  })

  it('does not scan when ssh cannot say where it connects, or connects through a proxy', async () => {
    for (const reply of [
      config({ proxyjump: 'bastion' }), config({ proxycommand: 'nc %h %p' }),
      { error: Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }) },
      { stdout: 'user alice\nport 22\n' }, config({ hostname: 'a b' }), config({ hostname: '[::1]' }),
      config({ port: 'x' }), { stdout: 'hostname lab\nport 22\n' },
    ]) {
      client.replies.config = reply
      client.calls.length = 0
      expect(await scanHostKey('lab')).toBeUndefined()
      expect(client.calls.every(call => call.file !== 'ssh-keyscan')).toBe(true)
    }
    client.replies.config = config({ proxyjump: 'none', proxycommand: 'none' })
    expect(await scanHostKey('lab')).toBeDefined()
  })

  it('takes the first known_hosts file ssh reads, however ssh spells the list', async () => {
    const expectations: Array<[string, string]> = [
      ['C:\\Users\\Some User/.ssh/known_hosts C:\\Users\\Some User/.ssh/known_hosts2', 'C:\\Users\\Some User/.ssh/known_hosts'],
      ['"/home/a b/hosts" /other', '/home/a b/hosts'],
      ['~/.ssh/known_hosts ~/.ssh/known_hosts2', `${homedir()}/.ssh/known_hosts`],
      ['/etc/custom-hosts /other', '/etc/custom-hosts'],
      ['/srv/known_hosts', '/srv/known_hosts'],
    ]
    for (const [value, file] of expectations) {
      client.replies.config = config({ userknownhostsfile: value })
      expect((await scanHostKey('lab'))?.knownHosts).toBe(file)
    }
  })
})

describe('recording a confirmed key', () => {
  it('writes the key once, creating the file and its directory, and keeps the connection strict', async () => {
    await trustHostKey('alice@lab:2222', ED25519_FINGERPRINT)
    expect(await readFile(knownHosts, 'utf8')).toBe(`[192.0.2.10]:2222 ssh-ed25519 ${ED25519}\n`)
    await trustHostKey('alice@lab:2222', ED25519_FINGERPRINT)
    expect((await readFile(knownHosts, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
    const probe = client.calls.find(call => call.file === 'ssh' && !call.args.includes('-G'))
    expect(probe?.args).toEqual(expect.arrayContaining(['StrictHostKeyChecking=yes', 'PreferredAuthentications=none', '-p', '2222', 'alice@lab']))
  })

  it('appends after existing entries, with a newline when the file lacks one', async () => {
    await mkdir(join(directory, 'ssh'), { recursive: true })
    await writeFile(knownHosts, 'other.example ssh-ed25519 AAAAexisting')
    await trustHostKey('lab', ED25519_FINGERPRINT)
    expect(await readFile(knownHosts, 'utf8')).toBe(`other.example ssh-ed25519 AAAAexisting\n[192.0.2.10]:2222 ssh-ed25519 ${ED25519}\n`)
    await rm(knownHosts)
    await writeFile(knownHosts, 'first ssh-rsa AAAA\n')
    await trustHostKey('lab', ED25519_FINGERPRINT)
    expect(await readFile(knownHosts, 'utf8')).toBe(`first ssh-rsa AAAA\n[192.0.2.10]:2222 ssh-ed25519 ${ED25519}\n`)
  })

  it('records nothing when the host now presents a key other than the one the person confirmed', async () => {
    await expect(trustHostKey('lab', `SHA256:${'A'.repeat(43)}`)).rejects.toMatchObject({ name: 'SshFailure', kind: 'host-key-changed' })
    expect(existsSync(knownHosts)).toBe(false)
  })

  it('records nothing when no key can be read safely', async () => {
    client.replies.scan = { stdout: '' }
    await expect(trustHostKey('lab', ED25519_FINGERPRINT)).rejects.toMatchObject({ kind: 'host-key' })
    expect(existsSync(knownHosts)).toBe(false)
  })

  it('never accepts a changed key: a host with a different key recorded stays refused', async () => {
    client.replies.probe = {
      stderr: '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key for [192.0.2.10]:2222 has changed and you have requested strict checking.\n',
    }
    await expect(trustHostKey('lab', ED25519_FINGERPRINT)).rejects.toMatchObject({ kind: 'host-key-changed' })
    expect(existsSync(knownHosts)).toBe(false)
  })

  it('reports a known_hosts file it cannot read instead of overwriting it', async () => {
    await mkdir(knownHosts, { recursive: true })
    await expect(trustHostKey('lab', ED25519_FINGERPRINT)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('reports a probe that could not run at all', async () => {
    client.replies.probe = { error: Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }) }
    await expect(trustHostKey('lab', ED25519_FINGERPRINT)).rejects.toThrow('ENOENT')
    expect(existsSync(knownHosts)).toBe(false)
  })
})
