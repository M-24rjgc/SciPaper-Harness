/** Bounded process calls and OpenSSH transport. Long experiments have independent supervisors. */
import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { planSshAuth, sshPasswordStoreOf } from '@deepseek-ai/dsh-ssh/auth'

/** Closed process result with UTF-8 output and exit code; a missing exit code is represented by -1. */
export interface ProcessResult { code: number; stdout: string; stderr: string }

/** Process input, environment overrides, cancellation and limits; output defaults to 8 MiB and timeout to 120 seconds. */
export interface ProcessOptions {
  cwd?: string
  signal?: AbortSignal
  input?: string | Uint8Array
  timeoutMs?: number
  maxBytes?: number
  env?: NodeJS.ProcessEnv
  /** Host platform whose process-tree kill applies; tests exercise both. */
  platform?: NodeJS.Platform
}

/**
 * Preserve executable lookup while enabling deeply installed Windows binaries.
 * @param command - local executable path or command name.
 * @param platform - operating system executing the command.
 * @returns extended Windows absolute path, or the unchanged command.
 */
export function localExecutable(command: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && win32.isAbsolute(command) ? win32.toNamespacedPath(command) : command
}

/**
 * Run an argument-vector command without a command shell or inherited model credentials.
 * @param command - executable path or name resolved on PATH.
 * @param args - arguments passed directly to the executable.
 * @param options - process limits and overrides; stdout and stderr share one byte ceiling.
 * @returns captured output after close, including nonzero exits; spawn, timeout, output-limit and cancellation failures reject.
 */
export function runProcess(command: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    const environment = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key))),
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    }
    const platform = options.platform ?? process.platform
    const child = spawn(localExecutable(command), [...args], {
      cwd: options.cwd,
      env: { ...environment, ...options.env },
      detached: platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let failure: Error | undefined
    const kill = (pid: number): void => {
      if (platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => { child.kill() })
      } else {
        try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }
    }
    const stop = (error: Error): void => {
      if (failure) return
      failure = error
      if (child.pid) kill(child.pid)
    }
    // A stop that lands before spawn leaves the child without a pid; kill it once it has one.
    child.once('spawn', () => { if (failure && child.pid) kill(child.pid) })
    const timer = setTimeout(() => { stop(new Error(`Process timed out: ${command}`)) }, options.timeoutMs ?? 120000)
    const abort = (): void => { stop(new Error('Operation cancelled')) }
    options.signal?.addEventListener('abort', abort, { once: true })
    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > (options.maxBytes ?? 8 * 1024 * 1024)) stop(new Error('Process output limit exceeded'))
      else target.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.on('error', (error) => { failure = error })
    // A child that exits without reading all its input (EPIPE on POSIX, EOF on Windows) is not a failure in
    // itself, and a write that failed for any reason shows up in the child's own result, which decides.
    child.stdin.on('error', () => {})
    child.on('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
    child.stdin.end(options.input)
  })
}

/**
 * Quote one argument for the POSIX login shell used by OpenSSH exec.
 * @param value - literal argument, including any shell metacharacters.
 * @returns a single-quoted shell word with embedded apostrophes escaped.
 */
export function shQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/** The context whose credential provider holds the SSH passwords remote runs may use. */
let sshPasswordSource: Context | undefined

/**
 * Let remote runs authenticate with the password saved for their host.
 * @param ctx - context with the credential provider, read at each SSH call so a changed password applies to the next one.
 * @returns a function that removes the source again.
 */
export function installSshPasswords(ctx: Context): () => void {
  sshPasswordSource = ctx
  return () => { if (sshPasswordSource === ctx) sshPasswordSource = undefined }
}

/**
 * Execute on an explicitly configured OpenSSH alias, `user@host[:port]` or ssh:// URI.
 * @param host - destination without leading options, whitespace or control characters.
 * @param args - remote argument vector quoted for the POSIX login shell.
 * @param options - limits, cancellation and input for the local SSH process.
 * @returns SSH exit status and captured output; authentication is noninteractive, with keys and agent unless a
 * password is saved for the host. Output never contains that password.
 */
export function ssh(host: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  if (!host || host.startsWith('-') || /[\x00-\x20]/.test(host)) throw new Error('Use an OpenSSH host alias, user@host[:port] or ssh://user@host:port URI')
  return sshWithAuth(host, args, options)
}

async function sshWithAuth(host: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  const plan = await planSshAuth(host, sshPasswordSource === undefined ? undefined : sshPasswordStoreOf(sshPasswordSource))
  const result = await runProcess('ssh', [
    ...plan.options, '-o', 'ConnectTimeout=15', ...plan.destination, args.map(shQuote).join(' '),
  ], plan.env === undefined ? options : { ...options, env: { ...options.env, ...plan.env } })
  return { ...result, stdout: plan.redact(result.stdout), stderr: plan.redact(result.stderr) }
}

/**
 * Raise a process failure with bounded diagnostic output.
 * @param result - completed process result.
 * @param operation - operation name included in failure diagnostics.
 * @returns trimmed stdout for a zero exit code; nonzero exits throw with output tails.
 */
export function checked(result: ProcessResult, operation: string): string {
  if (result.code !== 0) throw new Error(`${operation} failed (${result.code}): ${result.stderr.slice(-6000)} ${result.stdout.slice(-2000)}`)
  return result.stdout.trim()
}
