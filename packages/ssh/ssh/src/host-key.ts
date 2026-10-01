/**
 * First-connection host-key trust. Every real connection keeps `StrictHostKeyChecking=yes`; this module only
 * reads the key an unknown host presents, so a person can compare its fingerprint, and writes that one key to
 * the `known_hosts` file ssh reads after the person confirmed the fingerprint. A host whose recorded key
 * differs is never trusted here.
 * @module @deepseek-ai/dsh-ssh/host-key
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { classifySshFailure, sshDestinationArguments, SshFailure, type HostKeyOffer } from './auth.ts'

/** A key read from an unknown host, with the `known_hosts` line that would trust it. */
export interface ScannedHostKey extends HostKeyOffer {
  /** The line to append to {@link knownHosts}, without its newline. */
  readonly entry: string
  /** The `known_hosts` file ssh reads for this host. */
  readonly knownHosts: string
}

/** Key types in the order a host's key is offered: the one ssh prefers first. */
const KEY_TYPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^ssh-ed25519$/u, 'ED25519'],
  [/^ecdsa-sha2-nistp(?:256|384|521)$/u, 'ECDSA'],
  [/^ssh-rsa$/u, 'RSA'],
]

interface Captured { readonly stdout: string; readonly stderr: string }

/** Run a client to completion; a nonzero exit is a result, not an error, because ssh reports failures that way. */
function capture(command: string, args: readonly string[], timeout: number): Promise<Captured> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      // A client that could not start or ran out of time has no output worth reading.
      if (error !== null && (stdout === '' && stderr === '')) reject(new Error(error.message, { cause: error }))
      else resolve({ stdout, stderr })
    })
  })
}

/**
 * The first `known_hosts` file of `ssh -G`, whose value lists several files separated by spaces.
 * @param value - the `userknownhostsfile` value.
 * @returns the path, with `~` expanded.
 */
function firstKnownHostsFile(value: string): string {
  const quoted = /^"([^"]+)"/u.exec(value)?.[1]
  // The default pair is `known_hosts known_hosts2`, and a path may itself hold spaces.
  const named = /^(.+?known_hosts)(?=\s|$)/u.exec(value)?.[1]
  const first = value.split(/\s+/u).at(0)
  /* v8 ignore next -- `split` always yields a first item; `at` keeps its type honest for the compiler and the linter alike. */
  const path = quoted ?? named ?? first ?? value
  return path.startsWith('~') ? `${homedir()}${path.slice(1)}` : path
}

interface Target {
  readonly name: string
  readonly port: number
  readonly knownHosts: string
}

/**
 * What `ssh` would connect to, as it resolves the alias, the user and the port.
 * @param host - host spelling of a workspace.
 * @returns the host name `known_hosts` is keyed by, its port and the file, or undefined when the connection
 * goes through a proxy, whose host cannot be scanned directly.
 */
async function resolveTarget(host: string): Promise<Target | undefined> {
  const { stdout } = await capture('ssh', ['-G', ...sshDestinationArguments(host)], 10_000)
  const settings = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^(\S+)\s+(.*)$/u.exec(line.trim())
    if (match !== null && !settings.has(match[1] as string)) settings.set(match[1] as string, match[2] as string)
  }
  for (const proxy of ['proxyjump', 'proxycommand']) {
    const value = settings.get(proxy)
    if (value !== undefined && value !== 'none') return undefined
  }
  const name = settings.get('hostkeyalias') ?? settings.get('hostname')
  const port = Number(settings.get('port'))
  const knownHosts = settings.get('userknownhostsfile')
  if (name === undefined || !/^[^\s[\]]+$/u.test(name) || !Number.isInteger(port) || knownHosts === undefined) return undefined
  return { name, port, knownHosts: firstKnownHostsFile(knownHosts) }
}

/**
 * Read the key an unknown host presents, without authenticating or recording anything.
 * @param host - host spelling of a workspace.
 * @returns the preferred key with its fingerprint and the line that would trust it, or undefined when it cannot
 * be read safely: the host is behind a proxy, offers no key this module knows, or does not answer.
 */
export async function scanHostKey(host: string): Promise<ScannedHostKey | undefined> {
  let target: Target | undefined
  let scanned: Captured
  try {
    target = await resolveTarget(host)
    if (target === undefined) return undefined
    scanned = await capture('ssh-keyscan', ['-T', '10', '-t', 'ed25519,ecdsa,rsa', '-p', String(target.port), target.name], 20_000)
  } catch (_error: unknown) {
    // A missing client or a silent host means no key could be read; the caller falls back to its plain failure.
    return undefined
  }
  const offered = scanned.stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^\S+ (\S+) ([A-Za-z0-9+/]+={0,2})$/u.exec(line.trim())
    const type = KEY_TYPES.findIndex(([pattern]) => pattern.test(match?.[1] ?? ''))
    return match === null || type < 0 ? [] : [{ rank: type, keyType: match[1] as string, blob: match[2] as string }]
  }).sort((a, b) => a.rank - b.rank)[0]
  if (offered === undefined) return undefined
  const digest = createHash('sha256').update(Buffer.from(offered.blob, 'base64')).digest('base64').replace(/=+$/u, '')
  const place = target.port === 22 ? target.name : `[${target.name}]:${target.port}`
  return {
    type: (KEY_TYPES[offered.rank] as readonly [RegExp, string])[1],
    fingerprint: `SHA256:${digest}`,
    entry: `${place} ${offered.keyType} ${offered.blob}`,
    knownHosts: target.knownHosts,
  }
}

/**
 * Record the key a host presents in `known_hosts`, once the person confirmed its fingerprint.
 * The key is read again and must still match the confirmed fingerprint. A host that has a different key
 * recorded is refused, so a changed key is never accepted through this path.
 * @param host - host spelling of a workspace.
 * @param fingerprint - the `SHA256:` fingerprint the person saw and confirmed.
 * @throws {SshFailure} `host-key-changed` when the key differs from the confirmed one or from a recorded one,
 * and `host-key` when no key can be read safely.
 */
export async function trustHostKey(host: string, fingerprint: string): Promise<void> {
  const key = await scanHostKey(host)
  if (key === undefined) throw new SshFailure('host-key')
  if (key.fingerprint !== fingerprint) throw new SshFailure('host-key-changed')
  // A strict probe that needs no login: ssh reports a recorded key that differs before it asks for credentials.
  const probe = await capture('ssh', [
    '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'PreferredAuthentications=none',
    '-o', 'PubkeyAuthentication=no', '-o', 'ConnectTimeout=10', ...sshDestinationArguments(host), 'exit',
  ], 20_000)
  if (classifySshFailure(probe.stderr) === 'host-key-changed') throw new SshFailure('host-key-changed')
  const existing = await readFile(key.knownHosts, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  if (existing.split(/\r?\n/u).includes(key.entry)) return
  await mkdir(dirname(key.knownHosts), { recursive: true, mode: 0o700 })
  await appendFile(key.knownHosts, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${key.entry}\n`, { mode: 0o600 })
}
