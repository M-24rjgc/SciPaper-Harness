/** Remote pairing, real HTTP RPC, and Peer-owned WebSocket revocation through the shipped Web tree. */
import { once } from 'node:events'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import WebSocket from 'ws'
import type {} from '@deepseek-ai/dsh-client-connection'
import { launchWebScaffold } from './scaffold.ts'
import { openQuickTunnel } from '../../desktop/src/remote-tunnel.ts'

interface HttpReply {
  readonly status: number
  readonly cookie?: string
  readonly body: string
}

function call(port: number, path: string, headers: Record<string, string>, body?: string): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST',
      headers, agent: false }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.once('error', reject)
      response.once('end', () => {
        const cookie = response.headers['set-cookie']?.[0]
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString(),
          ...(cookie === undefined ? {} : { cookie }) })
      })
    })
    outgoing.once('error', reject)
    outgoing.end(body)
  })
}

async function callPublic(
  origin: string, path: string, headers: Record<string, string>, body?: string, replacePairing?: () => string,
): Promise<HttpReply> {
  let target = path
  const publicHeaders = new Headers(headers)
  publicHeaders.delete('host')
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(new URL(target, origin), {
        method: body === undefined ? 'GET' : 'POST', headers: publicHeaders,
        ...(body === undefined ? {} : { body }), redirect: 'manual', signal: AbortSignal.timeout(10_000),
      })
      const cookie = response.headers.get('set-cookie')
      return { status: response.status, body: await response.text(), ...(cookie === null ? {} : { cookie }) }
    } catch (error) {
      if (attempt === 7) {
        const cause: unknown = error instanceof Error ? error.cause : undefined
        const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : 'unknown'
        throw new Error(`remote smoke: public HTTPS request failed (${code})`)
      }
      if (replacePairing !== undefined) target = replacePairing()
      await new Promise<void>((resolve) => { setTimeout(resolve, 2_000) })
    }
  }
  throw new Error('remote smoke: public HTTPS request did not complete')
}

it('pairs a remote origin through HTTP, preserves RPC and stream authentication, and revokes live streams', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const connection = scaffold.ctx.connection
  const port = scaffold.ctx.webServer.port
  const signal = new AbortController()
  const cache = join(tmpdir(), 'scipaper-mobile-tunnel-smoke')
  const tunnel = process.env.SCIPAPER_REMOTE_TUNNEL_SMOKE === '1'
    ? await openQuickTunnel({ binary: join(cache, '2026.10.0-cloudflared-windows-amd64.exe'),
      cache, hostUrl: `http://127.0.0.1:${String(port)}`, signal: signal.signal })
    : undefined
  onTestFinished(async () => { signal.abort(); await tunnel?.stop() })
  const lease = connection.registerRemoteOrigin(tunnel?.origin ?? 'https://research.example')
  onTestFinished(() => lease.dispose())
  const headers = { host: new URL(lease.origin).host, origin: lease.origin }
  const requestRemote = (path: string, requestHeaders: Record<string, string>, body?: string): Promise<HttpReply> =>
    tunnel === undefined ? call(port, path, requestHeaders, body) : callPublic(lease.origin, path, requestHeaders, body)
  const pending = lease.createPairingUrl()
  const withdrawn = lease.createPairingUrl()
  expect((await requestRemote(`/${new URL(pending.url).search}`, headers)).status).toBe(401)
  lease.revokePairing(withdrawn.id)
  expect((await requestRemote(`/${new URL(withdrawn.url).search}`, headers)).status).toBe(401)
  const invitation = lease.createPairingUrl()
  const pairPath = `/${new URL(invitation.url).search}`
  expect((await requestRemote(pairPath, { ...headers, origin: 'https://attacker.example' })).status).toBe(403)
  const paired = tunnel === undefined ? await requestRemote(pairPath, headers)
    : await callPublic(lease.origin, pairPath, headers, undefined,
      () => `/${new URL(lease.createPairingUrl().url).search}`)
  expect(paired.status).toBe(303)
  expect(paired.cookie).toMatch(/; HttpOnly; SameSite=Strict; Secure$/u)
  expect((await requestRemote(pairPath, headers)).status).toBe(401)
  const cookie = paired.cookie?.split(';', 1)[0] ?? ''
  const authorized = { ...headers, cookie }
  expect((await requestRemote('/', authorized)).status).toBe(200)
  expect((await requestRemote('/api/llm/listProviders', headers)).status).toBe(401)
  expect((await requestRemote('/api/llm/listProviders', { ...authorized, origin: lease.origin.replace('https:', 'http:') })).status).toBe(403)
  expect((await call(port, '/api/llm/listProviders', { ...authorized, host: 'attacker.example' })).status).toBe(403)
  const rpc = await requestRemote('/api/llm/listProviders', { ...authorized, 'content-type': 'application/json' },
    JSON.stringify({ type: 'client-request', rpcId: 'mobile-list-providers', method: 'llm/listProviders', payload: { args: {} } }))
  expect(rpc.status).toBe(200)
  expect(JSON.parse(rpc.body)).toMatchObject({ type: 'server-response', rpcId: 'mobile-list-providers', result: { ok: true } })
  const socket = new WebSocket(tunnel === undefined ? `ws://127.0.0.1:${String(port)}/api/remote.mux`
    : `${lease.origin.replace('https:', 'wss:')}/api/remote.mux`, { headers: authorized, handshakeTimeout: 30_000 })
  onTestFinished(() => { socket.terminate() })
  await once(socket, 'open')
  const message = once(socket, 'message')
  socket.send(JSON.stringify({ type: 'open', streamId: 'mobile-events', endpoint: '$events', payload: { args: {} } }))
  const frames: unknown[] = await message
  expect(JSON.parse(String(frames[0]))).toMatchObject({ type: 'item', streamId: 'mobile-events', value: { type: 'ready' } })
  const closed = once(socket, 'close')
  await lease.dispose()
  expect((await closed)[0]).toBe(1001)
  expect((await requestRemote('/api/llm/listProviders', authorized)).status).toBe(403)
  const replacement = connection.registerRemoteOrigin(lease.origin)
  onTestFinished(() => replacement.dispose())
  expect((await requestRemote('/api/llm/listProviders', authorized)).status).toBe(401)
})
