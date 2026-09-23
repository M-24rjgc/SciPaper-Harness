/** Bounded process calls and OpenSSH transport. Long experiments have independent supervisors. */
import { spawn } from 'node:child_process'

export interface ProcessResult { code: number; stdout: string; stderr: string }

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

/** Run an argument-vector command without a command shell or model credentials. */
export function runProcess(command: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    const environment = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key))),
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    }
    const platform = options.platform ?? process.platform
    const child = spawn(command, [...args], {
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

/** Quote one argument for the POSIX login shell used by OpenSSH exec. */
export function shQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/** Execute on an explicitly configured OpenSSH alias or ssh:// URI. */
export function ssh(host: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  if (!host || host.startsWith('-') || /[\x00-\x20]/.test(host)) throw new Error('Use an OpenSSH host alias or ssh://user@host:port URI')
  return runProcess('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, args.map(shQuote).join(' ')], options)
}

/** Raise a process failure with bounded diagnostic output. */
export function checked(result: ProcessResult, operation: string): string {
  if (result.code !== 0) throw new Error(`${operation} failed (${result.code}): ${result.stderr.slice(-6000)} ${result.stdout.slice(-2000)}`)
  return result.stdout.trim()
}
