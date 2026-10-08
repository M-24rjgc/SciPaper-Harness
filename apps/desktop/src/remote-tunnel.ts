/** Pinned, integrity-checked Cloudflare Quick Tunnel, owned by the Desktop carrier. */
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, unlink, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { RemoteAccessError, type RemoteTunnel } from './remote-access.ts'
import type { RouteClient } from './remote-routes.ts'

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

/** Probes made through each client before the check gives up. */
const PROBES_PER_CLIENT = 2

/**
 * Wait for the public route's unauthenticated Host fence before offering pairing.
 *
 * The check rotates through the given clients, one per attempt, because no single way of reaching
 * the address works on every machine: Chromium's HTTP/2 client behind a local proxy (reproduced with
 * Mihomo/Clash) fails with `net::ERR_CONNECTION_CLOSED` on a route that answers normally over HTTP/1.1,
 * a direct connection fails where only the proxy reaches the internet, and the reverse.
 * @param origin - the public tunnel origin.
 * @param clients - the ways to reach it, most faithful to the system's own settings first.
 * @param signal - cancels the check.
 * @param note - receives one short diagnostic line per attempt, never an address.
 */
export async function waitForPublicTunnel(origin: string, clients: readonly RouteClient[], signal: AbortSignal,
  note: (line: string) => void = () => {}): Promise<void> {
  const attempts = Math.max(1, clients.length) * PROBES_PER_CLIENT
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal.throwIfAborted()
    const client = clients[attempt % clients.length]
    if (client === undefined) break
    const started = Date.now()
    try {
      const response = await client.fetch(`${origin}${PUBLIC_PROBE_PATH}`, { credentials: 'omit', redirect: 'manual', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) })
      signal.throwIfAborted()
      // No origin is admitted yet: this exact response comes from our Host fence.
      // A relay error page or redirect must not be presented as a ready connection.
      if (response.status === 403 && await response.text() === 'forbidden') {
        note(`public route ready via ${client.name} on attempt ${String(attempt + 1)} (${String(Date.now() - started)} ms)`)
        return
      }
      note(`${client.name}: unexpected answer HTTP ${String(response.status)} (${String(Date.now() - started)} ms)`)
      await response.body?.cancel().catch(() => undefined)
    } catch (error) {
      signal.throwIfAborted()
      note(`${client.name}: ${error instanceof Error ? error.message : 'failed'} (${String(Date.now() - started)} ms)`)
    }
    if (attempt < attempts - 1) await delay(1000, undefined, { signal })
  }
  throw new RemoteAccessError('connection')
}
/**
 * Append one line to the local connection diagnostics, keeping only the newest bytes. The carrier
 * never logs tunnel output, so this is the only record of which route or plan worked; it holds timings
 * and error names, never an address or a credential, and its failure never affects the connection.
 * @param file - the log path.
 * @param line - one short diagnostic line.
 * @param limit - the most bytes kept.
 */
export async function appendDiagnostics(file: string, line: string, limit = 65_536): Promise<void> {
  try {
    const previous = await readFile(file, 'utf8').catch(() => '')
    await writeFile(file, `${previous}${new Date().toISOString()} ${line}\n`.slice(-limit), { mode: 0o600 })
  } catch { /* diagnostics are best effort */ }
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

/** One way of asking cloudflared to reach Cloudflare's edge. */
interface TunnelPlan {
  readonly protocol: 'http2' | 'quic'
  readonly ipVersion: '4' | 'auto'
}

/**
 * Edge connection plans tried in order. HTTP/2 over IPv4 is what works behind most proxies and TUN
 * setups; QUIC (UDP) reaches the edge where TCP 7844 is filtered; the last lets cloudflared choose the
 * address family for networks whose IPv4 path is the broken one.
 */
const TUNNEL_PLANS: readonly TunnelPlan[] = [
  { protocol: 'http2', ipVersion: '4' },
  { protocol: 'quic', ipVersion: '4' },
  { protocol: 'http2', ipVersion: 'auto' },
]

/** Registration normally takes seconds; a plan that has not registered by now is replaced by the next one. */
const PLAN_TIMEOUT_MS = 30_000

/** Options for {@link openQuickTunnel}. */
export interface QuickTunnelOptions {
  binary: string
  cache: string
  hostUrl: string
  signal: AbortSignal
  /** Receives one short diagnostic line per plan; never an address or a credential. */
  note?: (line: string) => void
  /** Process launcher, replaceable in tests. */
  spawnProcess?: typeof spawn
  /** Per-plan registration limit, replaceable in tests. */
  planTimeoutMs?: number
}

/** Keeps the Host bound to loopback and preserves the public Host header for authorization. */
export async function openQuickTunnel(options: QuickTunnelOptions): Promise<RemoteTunnel> {
  const local = new URL(options.hostUrl)
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.port === '') throw new RemoteAccessError('host')
  const note = options.note ?? (() => {})
  let failure: unknown = new RemoteAccessError('connection')
  for (const plan of TUNNEL_PLANS) {
    if (options.signal.aborted) break
    const started = Date.now()
    try {
      const tunnel = await openTunnelOnce(options, local.origin, plan)
      note(`tunnel registered with ${plan.protocol}/ip${plan.ipVersion} (${String(Date.now() - started)} ms)`)
      return tunnel
    } catch (error) {
      failure = error
      note(`tunnel ${plan.protocol}/ip${plan.ipVersion} did not register (${String(Date.now() - started)} ms)`)
    }
  }
  throw failure
}

async function openTunnelOnce(options: QuickTunnelOptions, origin: string, plan: TunnelPlan): Promise<RemoteTunnel> {
  const run = await mkdtemp(join(options.cache, 'lease-'))
  const config = join(run, 'config.yml')
  await writeFile(config, '{}\n', { flag: 'wx', mode: 0o600 })
  const env = cloudflaredEnvironment(process.env)
  const child = (options.spawnProcess ?? spawn)(options.binary, ['tunnel', '--config', config, '--no-autoupdate', '--protocol', plan.protocol,
    '--edge-ip-version', plan.ipVersion, '--loglevel', 'info', '--metrics', '127.0.0.1:0',
    '--url', origin], { cwd: run, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
    const publicOrigin = await new Promise<string>((resolve, reject) => {
      let found: string | undefined
      let connected = false
      let tail = ''
      const accept = (chunk: Buffer): void => {
        tail = (tail + chunk.toString('utf8')).slice(-16_384)
        const match = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com)(?![a-z0-9.-])/i.exec(tail)
        if (match !== null) found = `https://${match[1]}`
        if (tail.includes('Registered tunnel connection')) connected = true
        if (connected && found !== undefined) resolve(found)
      }
      child.stdout.on('data', accept)
      child.stderr.on('data', accept)
      child.once('error', () => { reject(new RemoteAccessError('connection')) })
      child.once('close', () => { reject(new RemoteAccessError('connection')) })
      timer = setTimeout(() => { reject(new RemoteAccessError('connection')) }, options.planTimeoutMs ?? PLAN_TIMEOUT_MS)
      abort = () => { reject(new RemoteAccessError('connection')) }
      options.signal.addEventListener('abort', abort, { once: true })
      if (options.signal.aborted) abort()
    })
    options.signal.throwIfAborted()
    return { origin: publicOrigin, closed, stop }
  } catch (error) { await stop(); throw error } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
  }
}
