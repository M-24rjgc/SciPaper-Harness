import { describe, expect, it, vi } from 'vitest'
import { DesktopRemoteAccess, RemoteAccessError, type RemoteHost, type RemoteTunnel, type RemotePairing } from '../src/remote-access.ts'
import { cloudflaredArtifact, cloudflaredEnvironment, waitForPublicTunnel } from '../src/remote-tunnel.ts'
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

it('waits through relay provisioning, checks the Host fence, and sends no credentials', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('provisioning', { status: 503 }))
    .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
  const pending = waitForPublicTunnel('https://example.trycloudflare.com', fetcher, new AbortController().signal)
  await pending
  expect(fetcher).toHaveBeenLastCalledWith('https://example.trycloudflare.com/',
    expect.objectContaining({ credentials: 'omit', redirect: 'manual', cache: 'no-store' }))
})

it('refuses a relay error page as readiness and permits cancelling the public check', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('relay denied', { status: 403 }))
  const rejected = expect(waitForPublicTunnel('https://example.trycloudflare.com', fetcher, new AbortController().signal))
    .rejects.toMatchObject({ kind: 'connection' })
  await rejected
  const abort = new AbortController()
  abort.abort()
  await expect(waitForPublicTunnel('https://example.trycloudflare.com', fetcher, abort.signal)).rejects.toBeDefined()
}, 10_000)
