/** Remote pairing, real HTTP RPC, and Peer-owned WebSocket revocation through the shipped Web tree. */
import { once } from 'node:events'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import WebSocket from 'ws'
import { chromium } from 'playwright'
import type { ConnectionRemoteOrigin } from '@deepseek-ai/dsh-client-connection'
import { launchWebScaffold } from './scaffold.ts'
import { openQuickTunnel } from '../../desktop/src/remote-tunnel.ts'

interface HttpReply {
  readonly status: number
  readonly cookie?: string
  readonly body: string
}

function call(port: number, path: string, headers: Record<string, string>, body?: string, method?: 'HEAD'): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, method: method ?? (body === undefined ? 'GET' : 'POST'),
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

async function publicBrowserSmoke(lease: ConnectionRemoteOrigin): Promise<void> {
  const proxy = process.env.HTTPS_PROXY
  const browser = await chromium.launch({ ...(proxy === undefined ? {} : { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } }) })
  onTestFinished(() => browser.close())
  const context = await browser.newContext()
  const page = await context.newPage()
  const exchanges: number[] = []
  page.on('response', (response) => {
    if (response.request().isNavigationRequest() && new URL(response.url()).searchParams.has('pair')) exchanges.push(response.status())
  })
  let loaded = false
  const navigationStates: { status: number | undefined; sameOrigin: boolean; pairingQuery: boolean }[] = []
  const navigationFailures: string[] = []
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await page.goto(lease.createPairingUrl().url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      const current = new URL(page.url())
      navigationStates.push({ status: response?.status(), sameOrigin: current.origin === lease.origin, pairingQuery: current.searchParams.has('pair') })
      if (response?.status() === 200 && current.origin === lease.origin && !current.searchParams.has('pair')) { loaded = true; break }
    } catch (error) {
      navigationFailures.push(error instanceof Error ? (error.message.match(/net::[A-Z_]+/u)?.[0] ?? error.name) : 'unknown')
      // A missing navigation response can follow a consumed token; the next attempt always mints a new one.
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 2_000) })
  }
  if (!loaded) console.info('remote navigation state', { navigationStates, navigationFailures, exchanges })
  expect(loaded).toBe(true)
  expect(exchanges).toContain(303)
  const cookie = (await context.cookies(lease.origin)).find(candidate => candidate.name.startsWith('dsh-auth-'))
  expect(cookie?.secure).toBe(true)
  expect(cookie?.httpOnly).toBe(true)
  expect(cookie?.sameSite).toBe('Strict')
  await page.locator('[data-slot="root"]').waitFor({ state: 'visible', timeout: 30_000 })
  try {
    await page.locator('[data-composer-input][contenteditable="true"], [data-content-phase="hero"] [data-composer-input]').first()
      .waitFor({ state: 'visible', timeout: 30_000 })
  } catch (error) {
    console.info('remote frontend state', {
      phases: await page.locator('[data-content-phase]').evaluateAll(elements => elements.map(element => element.getAttribute('data-content-phase'))),
      headings: await page.locator('h1').allTextContents(), composers: await page.locator('[data-composer-input]').count(),
    })
    throw error
  }
  const center = await page.locator('[data-layout-center]').boundingBox()
  expect(center?.width).toBeGreaterThan(0)
  expect(center?.height).toBeGreaterThan(0)
  const rpc = await page.evaluate(async () => {
    const response = await fetch('/api/session/modelCatalog', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'public-mobile-models', method: 'session/modelCatalog', payload: { args: {} } }) })
    const value: unknown = await response.json()
    return { status: response.status, value }
  })
  expect(rpc.status).toBe(200)
  expect(rpc.value).toMatchObject({ type: 'server-response', rpcId: 'public-mobile-models', result: { ok: true } })
  const socket = await page.evaluateHandle(origin => new globalThis.WebSocket(`${origin.replace('https:', 'wss:')}/api/remote.mux`), lease.origin)
  const ready = await socket.evaluate(ws => new Promise<boolean>((resolve, reject) => {
    const deadline = setTimeout(() => { reject(new Error('remote smoke: stream readiness timed out')) }, 20_000)
    ws.addEventListener('error', () => { clearTimeout(deadline); reject(new Error('remote smoke: stream transport failed')) }, { once: true })
    ws.addEventListener('message', (event) => {
      const frame: unknown = JSON.parse(String(event.data))
      if (typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'item'
        && 'value' in frame && typeof frame.value === 'object' && frame.value !== null
        && 'type' in frame.value && frame.value.type === 'ready') {
        clearTimeout(deadline)
        resolve(true)
      }
    })
    const send = (): void => { ws.send(JSON.stringify({ type: 'open', streamId: 'public-mobile-events', endpoint: '$events', payload: { args: {} } })) }
    if (ws.readyState === globalThis.WebSocket.OPEN) send()
    else ws.addEventListener('open', send, { once: true })
  }))
  expect(ready).toBe(true)
  const observation = await socket.evaluateHandle(ws => ({ closed: new Promise<number>((resolve) => {
    ws.addEventListener('close', (event) => { resolve(event.code) }, { once: true })
  }) }))
  await lease.dispose()
  expect(await observation.evaluate(state => state.closed)).toBe(1001)
  const rejected = await page.evaluate(async () => (await fetch('/api/llm/listProviders')).status)
  expect(rejected).toBe(403)
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
  if (tunnel !== undefined) { await publicBrowserSmoke(lease); return }
  const headers = { host: new URL(lease.origin).host, origin: lease.origin }
  const requestRemote = (path: string, requestHeaders: Record<string, string>, body?: string): Promise<HttpReply> =>
    call(port, path, requestHeaders, body)
  const pending = lease.createPairingUrl()
  const withdrawn = lease.createPairingUrl()
  expect((await requestRemote(`/${new URL(pending.url).search}`, headers)).status).toBe(401)
  lease.revokePairing(withdrawn.id)
  expect((await requestRemote(`/${new URL(withdrawn.url).search}`, headers)).status).toBe(401)
  const invitation = lease.createPairingUrl()
  const pairPath = `/${new URL(invitation.url).search}`
  expect((await requestRemote(pairPath, { ...headers, origin: 'https://attacker.example' })).status).toBe(403)
  const paired = await requestRemote(pairPath, headers)
  expect(paired.status).toBe(303)
  expect(paired.cookie).toMatch(/; HttpOnly; SameSite=Strict; Secure$/u)
  expect((await requestRemote(pairPath, headers)).status).toBe(401)
  const cookie = paired.cookie?.split(';', 1)[0] ?? ''
  const authorized = { ...headers, cookie }
  expect((await requestRemote('/', authorized)).status).toBe(200)
  expect((await requestRemote('/api/llm/listProviders', headers)).status).toBe(401)
  expect((await requestRemote('/plugins/events', headers)).status).toBe(401)
  expect((await call(port, '/plugins/events', authorized, undefined, 'HEAD')).status).toBe(200)
  expect((await requestRemote('/api/llm/listProviders', { ...authorized, origin: lease.origin.replace('https:', 'http:') })).status).toBe(403)
  expect((await call(port, '/api/llm/listProviders', { ...authorized, host: 'attacker.example' })).status).toBe(403)
  const rpc = await requestRemote('/api/llm/listProviders', { ...authorized, 'content-type': 'application/json' },
    JSON.stringify({ type: 'client-request', rpcId: 'mobile-list-providers', method: 'llm/listProviders', payload: { args: {} } }))
  expect(rpc.status).toBe(200)
  expect(JSON.parse(rpc.body)).toMatchObject({ type: 'server-response', rpcId: 'mobile-list-providers', result: { ok: true } })
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/remote.mux`, { headers: authorized, handshakeTimeout: 30_000 })
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
  expect((await requestRemote('/plugins/events', authorized)).status).toBe(403)
  const replacement = connection.registerRemoteOrigin(lease.origin)
  onTestFinished(() => replacement.dispose())
  expect((await requestRemote('/api/llm/listProviders', authorized)).status).toBe(401)
})
