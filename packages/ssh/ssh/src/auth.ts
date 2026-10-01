/**
 * OpenSSH destinations, password authentication and secret-free failure reports shared by every code path
 * that starts the system `ssh` client. A destination is an OpenSSH host alias or `user@host`, optionally
 * followed by `:port`. Key and agent authentication stay with OpenSSH. A saved password is supplied only
 * through `SSH_ASKPASS`; it never appears in an argument vector.
 * @module @deepseek-ai/dsh-ssh/auth
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, type CredentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'

/** Accepted spelling of one SSH host: an alias or `user@host`, with an optional decimal `:port`. */
export const SSH_HOST_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*(?::[0-9]{1,5})?$/u

/** Environment variable that carries the password to the askpass program of one ssh child. */
const SECRET_ENV = 'DSH_SSH_ASKPASS_SECRET'
const MAX_PASSWORD_LENGTH = 1024
const MAX_DETAIL_LENGTH = 300

/** Host name or alias with an optional explicit port. */
export interface SshDestination {
  /** Alias or `user@host`, without the port. */
  readonly host: string
  /** TCP port when the spelling carried one. */
  readonly port?: number
}

/**
 * Split an optional trailing `:port` from an SSH host. Spellings that are not a plain alias or `user@host`,
 * such as `ssh://user@host:port`, pass through unchanged because OpenSSH reads them itself.
 * @param value - host spelling stored on a workspace or environment.
 * @returns the host and, when present, its port.
 * @throws {TypeError} when a port is outside 1 through 65535.
 */
export function parseSshHost(value: string): SshDestination {
  const match = /^([a-zA-Z0-9][a-zA-Z0-9_.@-]*):([0-9]{1,5})$/u.exec(value)
  if (match === null) return { host: value }
  const port = Number(match[2])
  if (port < 1 || port > 65_535) throw new TypeError('SSH port must be between 1 and 65535')
  return { host: match[1] as string, port }
}

/**
 * Arguments that name the destination of one ssh invocation.
 * @param value - host spelling stored on a workspace or environment.
 * @returns `[host]`, or `['-p', port, host]` when the spelling carries a port.
 */
export function sshDestinationArguments(value: string): string[] {
  const { host, port } = parseSshHost(value)
  return port === undefined ? [host] : ['-p', String(port), host]
}

/** Why an ssh connection could not be used, as a stable discriminant for localized messages. */
export type SshFailureKind = 'auth' | 'unreachable' | 'host-key' | 'host-key-changed' | 'unsupported'

const FAILURE_KINDS: readonly SshFailureKind[] = ['auth', 'unreachable', 'host-key', 'host-key-changed', 'unsupported']

const FAILURE_MESSAGES: Readonly<Record<SshFailureKind, string>> = {
  auth: 'SSH authentication failed',
  unreachable: 'SSH host is unreachable',
  'host-key': 'SSH host key is not trusted yet',
  'host-key-changed': 'SSH host key has changed',
  unsupported: 'SSH password login is not available on this computer',
}

/** A classified ssh failure whose message never contains a password. */
export class SshFailure extends Error {
  override readonly name = 'SshFailure'

  /**
   * @param kind - the classified cause.
   * @param detail - last diagnostic line of ssh, already free of the password.
   */
  constructor(readonly kind: SshFailureKind, detail?: string) {
    super(detail === undefined || detail === '' ? FAILURE_MESSAGES[kind] : `${FAILURE_MESSAGES[kind]}: ${detail}`)
  }
}

/**
 * Read the classification of an error thrown by any copy of this module.
 * @param error - any caught value.
 * @returns its failure kind, or undefined when it is not an {@link SshFailure}.
 */
export function sshFailureOf(error: unknown): SshFailureKind | undefined {
  if (!(error instanceof Error) || error.name !== 'SshFailure') return undefined
  const kind = (error as { kind?: unknown }).kind
  return FAILURE_KINDS.find(candidate => candidate === kind)
}

/**
 * Classify the diagnostics of a failed ssh client. The patterns are the client's own phrases and are
 * case-sensitive, so a remote command's error such as `EACCES: permission denied` is never taken for
 * a failed login.
 * @param text - standard error of the ssh process.
 * @returns the cause, or undefined when the text matches no known failure.
 */
export function classifySshFailure(text: string): SshFailureKind | undefined {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed and you have requested strict checking/u.test(text)) return 'host-key-changed'
  if (/Host key verification failed|host key is known for .* and you have requested strict checking/u.test(text)) return 'host-key'
  if (/Permission denied(?: \(|, please try again)|Too many authentication failures/u.test(text)) return 'auth'
  if (/Could not resolve hostname|ssh: connect to host |banner exchange: |kex_exchange_identification: |Connection timed out during banner exchange|Connection to \S+ port \d+ timed out|Connection closed by \S+ port \d+/u.test(text)) return 'unreachable'
  return undefined
}

/**
 * Turn the output of a failed ssh process into an error.
 * @param stderr - standard error of the process, already free of the password.
 * @param fallback - error for output that matches no known failure.
 * @returns an {@link SshFailure} with the last diagnostic line, or the fallback.
 */
export function sshFailureFrom(stderr: string, fallback: Error): Error {
  const kind = classifySshFailure(stderr)
  if (kind === undefined) return fallback
  // A classified text is not empty, so it has a last line.
  const last = stderr.trim().split(/\r?\n/u).at(-1) as string
  return new SshFailure(kind, last.trim().slice(0, MAX_DETAIL_LENGTH))
}

/** Credential operations the password store needs. */
export type PasswordRecords = Pick<CredentialProvider, 'readRecord' | 'modifyRecord' | 'deleteRecord'>

/** Read access to saved passwords. */
export interface SshPasswordLookup {
  /**
   * Find the saved password of one host.
   * @param host - host spelling of a workspace or environment.
   * @returns the password, or undefined when the host uses key authentication.
   */
  get(host: string): Promise<string | undefined>
}

/**
 * Credential address of one host's password. The address hashes the host, so the credential file does not
 * list the hosts a person uses.
 * @param host - host spelling of a workspace or environment.
 * @returns the credential record key.
 */
export function sshPasswordKey(host: string): CredentialKey {
  return credentialKey('ssh', `host-${createHash('sha256').update(host).digest('hex').slice(0, 32)}`)
}

/**
 * Reject a password that cannot be sent as one prompt answer.
 * @param password - candidate password.
 * @throws {TypeError} when it is empty, longer than 1024 characters or spans lines; the message omits the value.
 */
export function validateSshPassword(password: string): void {
  if (password === '' || password.length > MAX_PASSWORD_LENGTH || /[\0\r\n]/u.test(password)) {
    throw new TypeError('SSH password must be 1 to 1024 characters on one line')
  }
}

/**
 * Saved SSH passwords in the credential provider's record store. The store keeps them in the same file and
 * with the same protection as other credentials: the operating-system user's own file permissions, which
 * do not hide them from processes running as that user.
 */
export class SshPasswordStore implements SshPasswordLookup {
  /** @param records - the credential provider that keeps the records. */
  constructor(private readonly records: PasswordRecords) {}

  async get(host: string): Promise<string | undefined> {
    const record = await this.records.readRecord(sshPasswordKey(host))
    return record?.kind === 'api-key' && record.key !== undefined && record.key !== '' ? record.key : undefined
  }

  /**
   * Save or replace one host's password.
   * @param host - host spelling of a workspace or environment.
   * @param password - the password to save.
   */
  async set(host: string, password: string): Promise<void> {
    validateSshPassword(password)
    await this.records.modifyRecord(sshPasswordKey(host), () => Promise.resolve({ kind: 'api-key', key: password }))
  }

  /**
   * Forget one host's password; forgetting an absent one is a no-op.
   * @param host - host spelling of a workspace or environment.
   */
  async delete(host: string): Promise<void> {
    await this.records.deleteRecord(sshPasswordKey(host))
  }
}

/**
 * The password store over a context's credential provider.
 * @param ctx - context that may provide `credentials`.
 * @returns the store, or undefined when no credential provider is composed.
 */
export function sshPasswordStoreOf(ctx: Context): SshPasswordStore | undefined {
  const credentials = ctx.get('credentials')
  return credentials === undefined ? undefined : new SshPasswordStore(credentials)
}

/** Everything one ssh invocation needs to authenticate, apart from its fixed options. */
export interface SshAuthPlan {
  /** Authentication options; they come first among the `-o` options. */
  readonly options: readonly string[]
  /** Environment variables to add to the ssh child; absent for key and agent authentication. */
  readonly env: Readonly<Record<string, string>> | undefined
  /** Destination arguments: `[host]` or `['-p', port, host]`. */
  readonly destination: readonly string[]
  /**
   * Remove the password from text that may reach an error, a log or a tool result.
   * @param text - diagnostics from the ssh child.
   * @returns the text with every occurrence of the password replaced.
   */
  redact(text: string): string
}

interface Askpass {
  readonly program: string
  readonly directory: string
}

const ASKPASS_SH = `#!/bin/sh
[ "$SSH_ASKPASS_PROMPT" = confirm ] && exit 1
[ -n "\${${SECRET_ENV}+x}" ] || exit 1
printf '%s\\n' "$${SECRET_ENV}"
`

// UTF-8 bytes are written directly: the console code page would change non-ASCII passwords.
const ASKPASS_PS1 = `if ($env:SSH_ASKPASS_PROMPT -eq 'confirm' -or $null -eq $env:${SECRET_ENV}) { exit 1 }
$bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($env:${SECRET_ENV} + "\`n")
$out = [Console]::OpenStandardOutput()
$out.Write($bytes, 0, $bytes.Length)
$out.Flush()
`

// The secret never passes through cmd.exe, whose parsing of & | ^ % ! would change it.
const ASKPASS_CMD = [
  '@echo off',
  '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0askpass.ps1" <nul',
  '',
].join('\r\n')

let askpass: Promise<Askpass> | undefined
let askpassSupport: Promise<boolean> | undefined
/** Removes the askpass directory when the process exits. */
let exitCleanup: (() => void) | undefined

/**
 * Directories that may hold the askpass program, in order of preference. The Windows OpenSSH client cannot
 * start a program whose path has non-ASCII characters, so only ASCII directories qualify there.
 * @param platform - operating system running the Harness.
 * @param environment - process environment.
 * @param temporary - the operating system's temporary directory.
 * @returns candidate parent directories.
 */
function askpassParents(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv, temporary: string): string[] {
  if (platform !== 'win32') return [temporary]
  const ascii = (path: string | undefined): path is string => path !== undefined && /^[\x20-\x7e]+$/u.test(path)
  const candidates = [temporary, environment['ProgramData'], join(environment['SystemDrive'] ?? 'C:', 'Users', 'Public')]
  return candidates.filter(ascii)
}

/**
 * Create the private directory and scripts that answer ssh password prompts. The scripts hold no secret.
 * @param platform - operating system running the Harness.
 * @param environment - process environment.
 * @param temporary - the operating system's temporary directory.
 * @returns the program to name in `SSH_ASKPASS` and its directory.
 * @throws {SshFailure} `unsupported` when no usable directory can be created.
 */
async function createAskpass(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv, temporary: string): Promise<Askpass> {
  for (const parent of askpassParents(platform, environment, temporary)) {
    let directory: string
    // A parent that cannot be written, such as a read-only temporary directory, only moves on to the next one.
    try { directory = await mkdtemp(join(parent, 'dsh-askpass-')) } catch (_error: unknown) { continue }
    if (platform === 'win32') {
      await writeFile(join(directory, 'askpass.ps1'), ASKPASS_PS1, { mode: 0o600 })
      await writeFile(join(directory, 'askpass.cmd'), ASKPASS_CMD, { mode: 0o700 })
      return { program: join(directory, 'askpass.cmd'), directory }
    }
    await writeFile(join(directory, 'askpass.sh'), ASKPASS_SH, { mode: 0o700 })
    return { program: join(directory, 'askpass.sh'), directory }
  }
  throw new SshFailure('unsupported')
}

/**
 * The program that prints a password from the environment of the ssh child that runs it. It is created once
 * per process and removed when the process exits.
 * @param platform - operating system running the Harness.
 * @param environment - process environment.
 * @param temporary - the operating system's temporary directory.
 * @returns the path to set in `SSH_ASKPASS`.
 * @throws {SshFailure} `unsupported` when no usable directory can be created.
 */
export async function askpassProgram(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  temporary: string = tmpdir(),
): Promise<string> {
  if (askpass === undefined) {
    const creating = createAskpass(platform, environment, temporary)
    askpass = creating
    creating.then(({ directory }) => {
      exitCleanup = () => { rmSync(directory, { recursive: true, force: true }) }
      process.once('exit', exitCleanup)
    }, () => { askpass = undefined })
  }
  return (await askpass).program
}

/**
 * Remove the askpass program and forget the cached OpenSSH version check; the next password use recreates them.
 * @returns when the directory is gone.
 */
export async function disposeAskpass(): Promise<void> {
  const current = askpass
  askpass = undefined
  askpassSupport = undefined
  if (exitCleanup !== undefined) process.off('exit', exitCleanup)
  exitCleanup = undefined
  if (current !== undefined) await rm((await current).directory, { recursive: true, force: true })
}

/**
 * Whether the installed ssh honors `SSH_ASKPASS_REQUIRE`, which OpenSSH 8.4 introduced. An older client
 * could instead prompt on the terminal of the Harness, so an unrecognized banner counts as unsupported.
 * @returns true when the client is OpenSSH 8.4 or newer, or when `ssh -V` cannot run so the real start reports the problem.
 */
function opensshSupportsAskpass(): Promise<boolean> {
  askpassSupport ??= new Promise<boolean>((resolve) => {
    execFile('ssh', ['-V'], { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null && (error as { code?: unknown }).code === 'ENOENT') { resolve(true); return }
      const match = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/u.exec(`${stdout}${stderr}`)
      if (match === null) { resolve(false); return }
      const major = Number(match[1])
      resolve(major > 8 || (major === 8 && Number(match[2]) >= 4))
    })
  })
  return askpassSupport
}

/**
 * Decide how one ssh invocation authenticates.
 * @param host - host spelling stored on a workspace or environment.
 * @param passwords - saved passwords; omitted or without an entry for the host selects key and agent authentication.
 * @param password - a password to use instead of a saved one, for verifying it before it is saved.
 * @returns the options, environment and destination to build the invocation from.
 * @throws {SshFailure} `unsupported` when a password is set but this computer's OpenSSH cannot use it.
 */
export async function planSshAuth(host: string, passwords?: SshPasswordLookup, password?: string): Promise<SshAuthPlan> {
  const destination = sshDestinationArguments(host)
  if (password !== undefined) validateSshPassword(password)
  const secret = password ?? await passwords?.get(host)
  if (secret === undefined) {
    return { options: ['-o', 'BatchMode=yes'], env: undefined, destination, redact: text => text }
  }
  if (!await opensshSupportsAskpass()) throw new SshFailure('unsupported')
  const program = await askpassProgram()
  return {
    // One attempt and password methods only: a wrong password fails at once instead of waiting on a prompt
    // nobody answers, and a key passphrase prompt cannot be answered with the login password.
    options: [
      '-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'PubkeyAuthentication=no',
      '-o', 'PreferredAuthentications=password,keyboard-interactive',
    ],
    env: { SSH_ASKPASS: program, SSH_ASKPASS_REQUIRE: 'force', [SECRET_ENV]: secret },
    destination,
    redact: text => text.split(secret).join('***'),
  }
}
