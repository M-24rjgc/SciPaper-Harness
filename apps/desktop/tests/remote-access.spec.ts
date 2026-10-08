import { describe, expect, it, vi } from 'vitest'
import { DesktopRemoteAccess, RemoteAccessError, type RemoteHost, type RemoteTunnel, type RemotePairing } from '../src/remote-access.ts'
import { appendDiagnostics, cloudflaredArtifact, cloudflaredEnvironment, openQuickTunnel, waitForPublicTunnel, type QuickTunnelOptions, type TunnelLauncher, type TunnelProcess } from '../src/remote-tunnel.ts'
import { proxyFromDecision, proxyTunnelFetch, type RouteClient } from '../src/remote-routes.ts'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { DesktopRemotePresentation } from '@deepseek-ai/dsh-client-ui-settings-general/types'

function fixture() {
  const closed = Promise.withResolvers<undefined>()
  const ready = Promise.withResolvers<RemoteTunnel>()
  const stop = vi.fn(async () => { closed.resolve(undefined) })
  const tunnel: RemoteTunnel = { origin: 'https://example.trycloudflare.com', closed: closed.promise, stop }
  const pairing: RemotePairing = { id: '1', url: `${tunnel.origin}/?pair=private`, expiresAt: Date.now() + 300_000 }
  const remote = vi.fn<RemoteHost['remoteAccess']>(async request => request.action === 'stop' ? undefined : pairing)
  const host: RemoteHost = { remoteAccess: remote }
  const open = vi.fn(async (signal: AbortSignal, connecting: () => void) => {
    connecting()
    signal.addEventListener('abort', () => { ready.reject(new RemoteAccessError('connection')) }, { once: true })
    return ready.promise
  })
  const qr = vi.fn(async () => 'data:image/png;base64,qr')
  const publish = vi.fn<(state: DesktopRemotePresentation) => void>()
  const access = new DesktopRemoteAccess({ host: () => host, openTunnel: open, qrCode: qr, publish })
  return { access, host, remote, open, ready, closed, qr, publish, tunnel, stop, pairing }
}

describe('desktop mobile lease ownership', () => {
  it('publishes a paired connection only after the tunnel is ready, and revokes before process stop', async () => {
    const f = fixture()
    const start = f.access.start()
    expect(f.access.start()).toBe(start)
    expect(f.access.state.phase).toBe('connecting')
    expect(f.remote).not.toHaveBeenCalled()
    f.ready.resolve(f.tunnel)
    await start
    expect(f.access.state).toMatchObject({ phase: 'ready', pairingUrl: f.pairing.url })
    const revoke = Promise.withResolvers<RemotePairing | undefined>()
    f.remote.mockImplementationOnce(() => revoke.promise)
    const stopping = f.access.stop()
    await Promise.resolve()
    expect(f.access.state).toEqual({ phase: 'stopping' })
    expect(f.stop).not.toHaveBeenCalled()
    revoke.resolve(undefined)
    await stopping
    expect(f.remote).toHaveBeenLastCalledWith({ action: 'stop' })
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.access.state).toEqual({ phase: 'idle' })
  })

  it('cancels pending preparation without granting admission or exposing an error', async () => {
    const f = fixture()
    const starting = f.access.start()
    await f.access.stop()
    await starting
    expect(f.remote).not.toHaveBeenCalled()
    expect(f.access.state).toEqual({ phase: 'idle' })
  })

  it('waits for a late Host registration and QR before final revoke, with no late ready state', async () => {
    const f = fixture()
    const grant = Promise.withResolvers<RemotePairing | undefined>()
    f.remote.mockImplementationOnce(() => grant.promise)
    const starting = f.access.start()
    f.ready.resolve(f.tunnel)
    await vi.waitFor(() => { expect(f.remote).toHaveBeenCalledOnce() })
    const stopping = f.access.stop()
    grant.resolve(f.pairing)
    await Promise.all([starting, stopping])
    expect(f.publish.mock.calls.some(([state]) => state.phase === 'ready')).toBe(false)
    expect(f.remote).toHaveBeenLastCalledWith({ action: 'stop' })
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('revokes live sockets after tunnel exit and permits a new attempt', async () => {
    const f = fixture()
    const starting = f.access.start()
    f.ready.resolve(f.tunnel)
    await starting
    f.closed.resolve(undefined)
    await vi.waitFor(() => { expect(f.access.state).toEqual({ phase: 'error', failure: 'connection' }) })
    expect(f.remote).toHaveBeenLastCalledWith({ action: 'stop' })
    await f.access.start()
    expect(f.open).toHaveBeenCalledTimes(2)
    await f.access.stop()
  })

  it('coalesces invitation refresh and suppresses its late answer after stop', async () => {
    const f = fixture()
    const starting = f.access.start()
    f.ready.resolve(f.tunnel)
    await starting
    const refresh = Promise.withResolvers<RemotePairing | undefined>()
    f.remote.mockImplementationOnce(() => refresh.promise)
    const first = f.access.refresh()
    expect(f.access.refresh()).toBe(first)
    await f.access.stop()
    refresh.resolve({ ...f.pairing, id: '2', url: `${f.tunnel.origin}/?pair=next` })
    await first
    expect(f.access.state).toEqual({ phase: 'idle' })
  })

  it('reports classified failures and never publishes raw credentials or process errors', async () => {
    const f = fixture()
    const starting = f.access.start()
    f.ready.reject(new Error('private-token-stderr'))
    await starting
    expect(f.access.state).toEqual({ phase: 'error', failure: 'connection' })
    expect(JSON.stringify(f.publish.mock.calls)).not.toContain('private-token')
    const access = new DesktopRemoteAccess({ host: () => undefined, openTunnel: f.open, qrCode: f.qr, publish: f.publish })
    await access.start()
    expect(access.state).toEqual({ phase: 'error', failure: 'host' })
  })
})

it('pins supported carrier artifacts and rejects other platforms', () => {
  expect(cloudflaredArtifact('win32', 'x64').name).toBe('cloudflared-windows-amd64.exe')
  expect(cloudflaredArtifact('darwin', 'arm64').archive).toBe(true)
  expect(cloudflaredArtifact('darwin', 'x64').archive).toBe(true)
  expect(() => cloudflaredArtifact('linux', 'x64')).toThrow(RemoteAccessError)
})

it('gives the tunnel only OS paths, proxy and TLS settings without credentials or runtime hooks', () => {
  const environment = {
    PATH: 'system-path', SystemRoot: 'windows-root', TMPDIR: 'private-temp', LANG: 'zh_CN.UTF-8',
    https_proxy: 'https://proxy.example', NO_PROXY: 'localhost', SSL_CERT_FILE: 'trusted-ca.pem',
    DEEPSEEK_API_KEY: 'model-secret', AWS_SECRET_ACCESS_KEY: 'cloud-secret', GH_TOKEN: 'release-secret',
    DSH_LAUNCH_ENVIRONMENT: 'credential-snapshot', NODE_OPTIONS: '--require untrusted.js',
    NODE_PATH: 'untrusted-modules', TUNNEL_ORIGIN_CERT: 'untrusted-cert', CLOUDFLARED_CONFIG: 'untrusted-config',
  }
  const selected = cloudflaredEnvironment(environment)
  expect(selected).toEqual({ PATH: 'system-path', SystemRoot: 'windows-root', TMPDIR: 'private-temp', LANG: 'zh_CN.UTF-8',
    https_proxy: 'https://proxy.example', NO_PROXY: 'localhost', SSL_CERT_FILE: 'trusted-ca.pem' })
  selected.PATH = 'changed'
  expect(environment.PATH).toBe('system-path')
})

const ORIGIN = 'https://example.trycloudflare.com'
const clientOf = (name: string, fetcher: typeof fetch): RouteClient => ({ name, fetch: fetcher })

it('waits through relay provisioning, checks the Host fence, and sends no credentials', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('provisioning', { status: 503 }))
    .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
  await waitForPublicTunnel(ORIGIN, [clientOf('only', fetcher)], new AbortController().signal)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher).toHaveBeenLastCalledWith(`${ORIGIN}/api/remote-ready`,
    expect.objectContaining({ credentials: 'omit', redirect: 'manual', cache: 'no-store' }))
})

it('rotates through the clients until one reaches the Host fence, noting each attempt', async () => {
  // The web server's own login page answers 401 at `/`; only the fenced `/api` route says 403 `forbidden`.
  const broken = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('net::ERR_CONNECTION_CLOSED'))
  const login = vi.fn<typeof fetch>().mockResolvedValue(new Response('dsh web authentication required', { status: 401 }))
  const good = vi.fn<typeof fetch>().mockResolvedValue(new Response('forbidden', { status: 403 }))
  const notes: string[] = []
  await waitForPublicTunnel(ORIGIN, [clientOf('system-proxy', broken), clientOf('login', login), clientOf('direct', good)],
    new AbortController().signal, line => notes.push(line))
  expect([broken.mock.calls.length, login.mock.calls.length, good.mock.calls.length]).toEqual([1, 1, 1])
  expect(notes).toEqual([
    expect.stringContaining('system-proxy: net::ERR_CONNECTION_CLOSED'),
    expect.stringContaining('login: unexpected answer HTTP 401'),
    expect.stringContaining('public route ready via direct on attempt 3'),
  ])
  expect(notes.join('\n')).not.toContain('trycloudflare')
}, 10_000)

it('names a failure without a message and gives up once every client has had its turns', async () => {
  const mute = vi.fn<typeof fetch>().mockRejectedValue('closed')
  const relay = vi.fn<typeof fetch>().mockResolvedValue(new Response('relay denied', { status: 403 }))
  const notes: string[] = []
  await expect(waitForPublicTunnel(ORIGIN, [clientOf('mute', mute), clientOf('relay', relay)], new AbortController().signal,
    line => notes.push(line))).rejects.toMatchObject({ kind: 'connection' })
  expect([mute.mock.calls.length, relay.mock.calls.length]).toEqual([2, 2])
  expect(notes[0]).toContain('mute: failed')
  await expect(waitForPublicTunnel(ORIGIN, [], new AbortController().signal)).rejects.toMatchObject({ kind: 'connection' })
}, 15_000)

it('permits cancelling the public check', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('relay denied', { status: 403 }))
  const abort = new AbortController()
  abort.abort()
  await expect(waitForPublicTunnel(ORIGIN, [clientOf('only', fetcher)], abort.signal)).rejects.toBeDefined()
  const midway = new AbortController()
  const hung = vi.fn<typeof fetch>().mockImplementation(async () => { midway.abort(); throw new TypeError('aborted') })
  await expect(waitForPublicTunnel(ORIGIN, [clientOf('hung', hung)], midway.signal)).rejects.toBeDefined()
})

it('keeps the newest diagnostics and never lets a write failure escape', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'diagnostics-'))
  try {
    const file = join(folder, 'diagnostics.log')
    await appendDiagnostics(file, 'first')
    await appendDiagnostics(file, 'second')
    expect(readFileSync(file, 'utf8').trimEnd().split('\n').map(line => line.slice(25))).toEqual(['first', 'second'])
    await appendDiagnostics(file, 'third', 60)
    expect(readFileSync(file, 'utf8').length).toBeLessThanOrEqual(60)
    expect(readFileSync(file, 'utf8')).toContain('third')
    await expect(appendDiagnostics(join(folder, 'missing', 'diagnostics.log'), 'lost')).resolves.toBeUndefined()
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

/** A stand-in cloudflared whose output and exit the test scripts. */
function fakeProcess(script: (child: TunnelProcess & { stderr: PassThrough; emit: EventEmitter['emit'] }) => void): TunnelProcess {
  const emitter = new EventEmitter()
  const child = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    once: (event: 'close' | 'error', listener: () => void) => emitter.once(event, listener),
    emit: emitter.emit.bind(emitter),
    kill: vi.fn(() => { queueMicrotask(() => emitter.emit('close', 0)); return true }),
  }
  queueMicrotask(() => { script(child) })
  return child
}

describe('quick tunnel plans', () => {
  const registered = (child: { stderr: PassThrough }): void => {
    child.stderr.write('INF https://quiet-fox-9.trycloudflare.com\nINF Registered tunnel connection connIndex=0\n')
  }
  const closesAtOnce = (child: { emit: EventEmitter['emit'] }): void => { child.emit('close', 1) }
  /** A launcher handing out the given processes in order, then silent ones, and recording each command line. */
  const launcherOf = (processes: TunnelProcess[]): { launch: TunnelLauncher; commands: string[] } => {
    const commands: string[] = []
    return { commands, launch: (_command, args) => { commands.push(args.join(' ')); return processes.shift() ?? fakeProcess(() => {}) } }
  }
  const options = (cache: string, launch: TunnelLauncher, extra: Partial<QuickTunnelOptions> = {}): QuickTunnelOptions =>
    ({ binary: 'cloudflared', cache, hostUrl: 'http://127.0.0.1:4321', signal: new AbortController().signal, launch,
      planTimeoutMs: 40, ...extra })

  it('moves to the next plan when one cannot register, and reports which plan worked', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'plans-'))
    try {
      const { launch, commands } = launcherOf([fakeProcess(closesAtOnce), fakeProcess(registered)])
      const notes: string[] = []
      const tunnel = await openQuickTunnel(options(cache, launch, { note: line => notes.push(line) }))
      expect(tunnel.origin).toBe('https://quiet-fox-9.trycloudflare.com')
      expect(commands[0]).toContain('--protocol http2 --edge-ip-version 4')
      expect(commands[1]).toContain('--protocol quic --edge-ip-version 4')
      expect(notes).toEqual([expect.stringContaining('http2/ip4 did not register'), expect.stringContaining('registered with quic/ip4')])
      await tunnel.stop()
    } finally { rmSync(cache, { recursive: true, force: true }) }
  })

  it('tries the automatic address family last, and fails after every plan has had its turn', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'plans-'))
    try {
      const { launch, commands } = launcherOf([])
      await expect(openQuickTunnel(options(cache, launch))).rejects.toMatchObject({ kind: 'connection' })
      expect(commands).toHaveLength(3)
      expect(commands[2]).toContain('--protocol http2 --edge-ip-version auto')
    } finally { rmSync(cache, { recursive: true, force: true }) }
  })

  it('stops at once when cancelled, and refuses a Host that is not loopback', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'plans-'))
    try {
      const { launch, commands } = launcherOf([])
      const abort = new AbortController()
      abort.abort()
      await expect(openQuickTunnel(options(cache, launch, { signal: abort.signal }))).rejects.toMatchObject({ kind: 'connection' })
      await expect(openQuickTunnel(options(cache, launch, { hostUrl: 'http://example.test:80' }))).rejects.toMatchObject({ kind: 'host' })
      expect(commands).toHaveLength(0)
    } finally { rmSync(cache, { recursive: true, force: true }) }
  })
})
describe('proxy tunnel client', () => {
  it('reads the first usable proxy from a Chromium proxy decision', () => {
    expect(proxyFromDecision('PROXY 127.0.0.1:7897; DIRECT')).toEqual({ host: '127.0.0.1', port: 7897 })
    expect(proxyFromDecision('DIRECT; HTTPS proxy.example:8443')).toEqual({ host: 'proxy.example', port: 8443 })
    expect(proxyFromDecision('PROXY [::1]:3128')).toEqual({ host: '::1', port: 3128 })
    expect(proxyFromDecision('DIRECT')).toBeUndefined()
    expect(proxyFromDecision('SOCKS5 127.0.0.1:1080')).toBeUndefined()
    expect(proxyFromDecision('PROXY host:99999')).toBeUndefined()
  })

  it('refuses addresses and decisions it cannot relay', async () => {
    const direct = proxyTunnelFetch(async () => 'DIRECT')
    await expect(direct('https://example.test/')).rejects.toThrow('no proxy')
    await expect(direct(new URL('https://example.test/'))).rejects.toThrow('no proxy')
    await expect(direct(new Request('https://example.test/'))).rejects.toThrow('no proxy')
    await expect(proxyTunnelFetch(async () => 'PROXY 127.0.0.1:1')('http://example.test/')).rejects.toThrow('https only')
  })

  it('reports a proxy that refuses the tunnel, or is not listening', async () => {
    const refusing = createServer()
    refusing.on('connect', (_request, socket) => { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
    await new Promise<void>(resolve => refusing.listen(0, '127.0.0.1', resolve))
    try {
      const port = (refusing.address() as AddressInfo).port
      await expect(proxyTunnelFetch(async () => `PROXY 127.0.0.1:${String(port)}`)('https://example.test/'))
        .rejects.toThrow('CONNECT answered 502')
      const idle = createServer()
      await new Promise<void>(resolve => idle.listen(0, '127.0.0.1', resolve))
      const free = (idle.address() as AddressInfo).port
      await new Promise<void>(resolve => idle.close(() => { resolve() }))
      await expect(proxyTunnelFetch(async () => `PROXY 127.0.0.1:${String(free)}`)('https://example.test/',
        { signal: new AbortController().signal })).rejects.toBeDefined()
    } finally { await new Promise<void>(resolve => refusing.close(() => { resolve() })) }
  })
})
