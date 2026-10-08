/** Independent ways to reach the public tunnel address from this computer, tried in rotation. */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'

/** One named client the readiness check can reach the public tunnel address with. */
export interface RouteClient {
  readonly name: string
  readonly fetch: typeof fetch
}

/**
 * Pick the proxy a Chromium proxy decision names, e.g. `PROXY 127.0.0.1:7897; DIRECT`.
 * @param decision - the string `app.resolveProxy` answers, which already applies system rules and PAC scripts.
 * @returns the first proxy's host and port, or undefined when the decision is direct or unusable.
 */
export function proxyFromDecision(decision: string): { host: string; port: number } | undefined {
  for (const part of decision.split(';')) {
    const match = /^\s*(?:PROXY|HTTPS)\s+(?<host>\[[0-9a-f:]+\]|[^\s:]+):(?<port>\d{1,5})\s*$/iu.exec(part)
    const port = Number(match?.groups?.['port'])
    if (match?.groups?.['host'] !== undefined && port > 0 && port < 65536) {
      return { host: match.groups['host'].replace(/^\[|\]$/gu, ''), port }
    }
  }
  return undefined
}

/**
 * A fetch that reaches an https address through the system's proxy over plain HTTP/1.1, by asking the
 * proxy for a CONNECT tunnel and speaking TLS through it. It follows the same proxy rules Chromium would
 * (system settings, rule lists, PAC) but avoids Chromium's HTTP/2 client, which some local proxies close.
 * Only GET and HEAD to https addresses are supported.
 * @param resolveProxy - answers the Chromium proxy decision for an address.
 * @returns a fetch-shaped client; it throws when the decision is direct.
 */
export function proxyTunnelFetch(resolveProxy: (url: string) => Promise<string>): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.protocol !== 'https:') throw new TypeError('proxy tunnel: https only')
    const proxy = proxyFromDecision(await resolveProxy(url.href))
    if (proxy === undefined) throw new TypeError('proxy tunnel: no proxy for this address')
    const signal = init?.signal ?? undefined
    const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
      const connectRequest = httpRequest({ host: proxy.host, port: proxy.port, method: 'CONNECT',
        path: `${url.hostname}:${url.port === '' ? '443' : url.port}`, headers: { host: url.host },
        ...signal === undefined ? {} : { signal } })
      connectRequest.once('connect', (response, tunnel) => {
        if (response.statusCode === 200) { resolve(tunnel); return }
        tunnel.destroy()
        reject(new Error(`proxy tunnel: CONNECT answered ${String(response.statusCode)}`))
      })
      connectRequest.once('error', reject)
      connectRequest.end()
    })
    return await new Promise<Response>((resolve, reject) => {
      const secure = httpsRequest({ host: url.hostname, path: `${url.pathname}${url.search}`, method: init?.method ?? 'GET',
        headers: { accept: '*/*', 'user-agent': 'scipaper-harness', connection: 'close' }, agent: false,
        createConnection: () => tlsConnect({ socket, servername: url.hostname, ALPNProtocols: ['http/1.1'] }),
        ...signal === undefined ? {} : { signal } }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.once('error', reject)
        response.once('end', () => {
          const headers = new Headers()
          for (const [name, value] of Object.entries(response.headers)) {
            for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item)
          }
          const status = response.statusCode ?? 0
          // A Response cannot carry a body for these statuses.
          const empty = status === 204 || status === 205 || status === 304 || init?.method === 'HEAD'
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers }))
        })
      })
      secure.once('error', (error) => { socket.destroy(); reject(error) })
      secure.end()
    })
  }
}
