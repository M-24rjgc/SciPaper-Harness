/** Pinned, integrity-checked Cloudflare Quick Tunnel, owned by the Desktop carrier. */
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, unlink, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { RemoteAccessError, type RemoteTunnel } from './remote-access.ts'

const VERSION = '2026.10.0'
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024
const runFile = promisify(execFile)
const TUNNEL_ENVIRONMENT_NAMES = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
])

/**
 * Give the tunnel OS, proxy and TLS trust settings without Harness credentials or runtime hooks.
 * @param environment - Desktop process environment.
 * @returns a detached environment containing only the tunnel's supported infrastructure settings.
 */
export function cloudflaredEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => TUNNEL_ENVIRONMENT_NAMES.has(name.toUpperCase())))
}

/**
 * The fenced API route probed for readiness. Connection's `/api` prefix route
 * answers an unadmitted Host with 403 `forbidden` before any routing; `/` is
 * behind the web server's own authentication page, which answers 401 and so
 * could never be told apart from a relay page by this check.
 */
const PUBLIC_PROBE_PATH = '/api/remote-ready'

/** Wait for the public route's unauthenticated Host fence before offering pairing. */
export async function waitForPublicTunnel(origin: string, fetcher: typeof fetch, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    signal.throwIfAborted()
    try {
      const response = await fetcher(`${origin}${PUBLIC_PROBE_PATH}`, { credentials: 'omit', redirect: 'manual', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) })
      signal.throwIfAborted()
      // No origin is admitted yet: this exact response comes from our Host fence.
      // A relay error page or redirect must not be presented as a ready connection.
      if (response.status === 403 && await response.text() === 'forbidden') return
      await response.body?.cancel().catch(() => undefined)
    } catch { signal.throwIfAborted() }
    if (attempt < 5) await delay(1000, undefined, { signal })
  }
  throw new RemoteAccessError('connection')
}

/** Release artifact selected by the carrier, never by a product document. */
export function cloudflaredArtifact(platform = process.platform, arch = process.arch): { name: string; sha256: string; archive: boolean } {
  if (platform === 'win32' && arch === 'x64') return {
    name: 'cloudflared-windows-amd64.exe', sha256: '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c', archive: false,
  }
  if (platform === 'darwin' && arch === 'x64') return {
    name: 'cloudflared-darwin-amd64.tgz', sha256: '903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f', archive: true,
  }
  if (platform === 'darwin' && arch === 'arm64') return {
    name: 'cloudflared-darwin-arm64.tgz', sha256: 'a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70', archive: true,
  }
  throw new RemoteAccessError('unsupported')
}

/** Existing cached bytes are verified on every launch. */
async function verified(path: string, sha256: string): Promise<boolean> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DOWNLOAD_BYTES) return false
    return createHash('sha256').update(await readFile(path)).digest('hex') === sha256
  } catch { return false }
}

/** Downloads use Electron net.fetch, which follows the desktop system proxy. */
export async function prepareCloudflared(cache: string, fetcher: typeof fetch, signal: AbortSignal): Promise<{
  path: string
  dispose(): Promise<void>
}> {
  const artifact = cloudflaredArtifact()
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const folder = await lstat(cache)
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new RemoteAccessError('download')
  const target = join(cache, `${VERSION}-${artifact.name}`)
  if (!await verified(target, artifact.sha256)) {
    const temporary = join(cache, `.download-${randomUUID()}`)
    try {
      signal.throwIfAborted()
      const response = await fetcher(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${artifact.name}`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), redirect: 'follow' })
      if (!response.ok || response.body === null) throw new RemoteAccessError('download')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          signal.throwIfAborted()
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > MAX_DOWNLOAD_BYTES) throw new RemoteAccessError('download')
          chunks.push(next.value)
        }
      } finally { await reader.cancel().catch(() => undefined) }
      const bytes = Buffer.concat(chunks)
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new RemoteAccessError('download')
      signal.throwIfAborted()
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o700 })
      await rename(temporary, target)
    } catch {
      throw new RemoteAccessError('download')
    } finally { await unlink(temporary).catch(() => undefined) }
  }
  signal.throwIfAborted()
  if (!artifact.archive) return { path: target, dispose: async () => {} }
  // Extract one known member from verified bytes into a private launch directory.
  const extracted = await mkdtemp(join(cache, 'binary-'))
  const binary = join(extracted, 'cloudflared')
  const dispose = async (): Promise<void> => {
    await unlink(binary).catch(() => undefined)
    await rmdir(extracted).catch(() => undefined)
  }
  try {
    await runFile('/usr/bin/tar', ['-xzf', target, '-C', extracted, 'cloudflared'], { signal, timeout: 15_000 })
    const stat = await lstat(binary)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new RemoteAccessError('download')
    await chmod(binary, 0o700)
    return { path: binary, dispose }
  } catch (error) { await dispose(); throw error }
}

/** Keeps the Host bound to loopback and preserves the public Host header for authorization. */
export async function openQuickTunnel(options: {
  binary: string
  cache: string
  hostUrl: string
  signal: AbortSignal
}): Promise<RemoteTunnel> {
  const local = new URL(options.hostUrl)
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.port === '') throw new RemoteAccessError('host')
  const run = await mkdtemp(join(options.cache, 'lease-'))
  const config = join(run, 'config.yml')
  await writeFile(config, '{}\n', { flag: 'wx', mode: 0o600 })
  const env = cloudflaredEnvironment(process.env)
  const child = spawn(options.binary, ['tunnel', '--config', config, '--no-autoupdate', '--protocol', 'http2',
    '--edge-ip-version', '4', '--loglevel', 'info', '--metrics', '127.0.0.1:0',
    '--url', local.origin], { cwd: run, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let exited = false
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => { exited = true; resolve() })
  })
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    if (!exited) child.kill('SIGTERM')
    const timeout = setTimeout(() => { if (!exited) child.kill('SIGKILL') }, 5_000)
    try { await closed } finally {
      clearTimeout(timeout)
      await unlink(config).catch(() => undefined)
      await rmdir(run).catch(() => undefined)
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = (): void => {}
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      let publicOrigin: string | undefined
      let connected = false
      let tail = ''
      const accept = (chunk: Buffer): void => {
        tail = (tail + chunk.toString('utf8')).slice(-16_384)
        const match = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com)(?![a-z0-9.-])/i.exec(tail)
        if (match !== null) publicOrigin = `https://${match[1]}`
        if (tail.includes('Registered tunnel connection')) connected = true
        if (connected && publicOrigin !== undefined) resolve(publicOrigin)
      }
      child.stdout.on('data', accept)
      child.stderr.on('data', accept)
      child.once('error', () => { reject(new RemoteAccessError('connection')) })
      child.once('close', () => { reject(new RemoteAccessError('connection')) })
      timer = setTimeout(() => { reject(new RemoteAccessError('connection')) }, 75_000)
      abort = () => { reject(new RemoteAccessError('connection')) }
      options.signal.addEventListener('abort', abort, { once: true })
      if (options.signal.aborted) abort()
    })
    options.signal.throwIfAborted()
    return { origin, closed, stop }
  } catch (error) { await stop(); throw error } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
  }
}
