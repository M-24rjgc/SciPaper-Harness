/** Real local HTTP regressions for anonymous redirects and bounded PDF parser cancellation. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { HttpFetchProvider, type HttpFetchLimits } from '../src/provider.ts'
import { resolvePublicAddresses } from '../src/network.ts'
import { pdf } from './pdf-fixture.ts'

const limits: HttpFetchLimits = {
  maxResponseBytes: 1_000_000, maxBodyChars: 1000, timeoutMs: 5000,
  maxRedirects: 5, userAgent: 'anonymous-compatibility-fixture',
  allowFakeIpDns: false, allowCrossOriginRedirects: true,
}
let handler: (request: IncomingMessage, response: ServerResponse) => void
const receipts: IncomingMessage['headers'][] = []
const source = createServer((request, response) => { receipts.push(request.headers); handler(request, response) })
const target = createServer((request, response) => {
  receipts.push(request.headers)
  response.writeHead(200, { 'content-type': 'text/plain' }).end('anonymous target fixture')
})
let sourceUrl: string
let targetUrl: string

async function listen(server: Server, host: string): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://${host}:${port}`
}

beforeAll(async () => {
  sourceUrl = await listen(source, 'entry.test')
  targetUrl = await listen(target, 'destination.test')
})
beforeEach(() => {
  receipts.length = 0
  handler = (_request, response) => {
    const bytes = pdf('Offline provider PDF fixture')
    response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.byteLength }).end(bytes)
  }
})
afterAll(async () => {
  await Promise.all([source, target].map(server => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })))
})

function provider(overrides: Partial<HttpFetchLimits> = {}): HttpFetchProvider {
  return new HttpFetchProvider({ ...limits, ...overrides }, async (host, signal) => {
    if (host === 'entry.test' || host === 'destination.test') return [{ address: '127.0.0.1', family: 4 }]
    return await resolvePublicAddresses(host, signal)
  })
}

describe('anonymous redirects across real HTTP origins', () => {
  it('does not carry cookies, authorization or API keys to either request', async () => {
    handler = (_request, response) => response.writeHead(302, {
      location: `${targetUrl}/final`, 'set-cookie': 'fixture-session=private-cookie; Path=/',
      'www-authenticate': 'Basic realm="fixture"',
    }).end()
    await expect(provider().fetch({ url: sourceUrl })).resolves.toMatchObject({ body: { content: 'anonymous target fixture' } })
    expect(receipts).toHaveLength(2)
    for (const headers of receipts) {
      for (const name of ['authorization', 'cookie', 'x-api-key', 'x-dsh-auth-token', 'proxy-authorization']) expect(headers[name]).toBeUndefined()
    }
  })

  it('rejects a private redirect before contacting the real listening target', async () => {
    handler = (_request, response) => response.writeHead(302, { location: `${targetUrl.replace('destination.test', '127.0.0.1')}/private` }).end()
    await expect(provider().fetch({ url: sourceUrl })).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    expect(receipts).toHaveLength(1)
  })
})

describe('PDF retrieval through the real provider', () => {
  it('extracts an offline PDF and applies the response byte cap before parsing', async () => {
    const result = await provider().fetch({ url: sourceUrl })
    expect(result).toMatchObject({ body: { kind: 'text' }, truncated: false })
    expect(result.body.content).toContain('Offline provider PDF fixture')
    await expect(provider({ maxResponseBytes: 64 }).fetch({ url: sourceUrl })).rejects.toMatchObject({ code: 'WEB_FETCH_TOO_LARGE' })
  })

  it('maps a deadline while PDF parsing is pending to WEB_FETCH_TIMEOUT', async () => {
    await expect(provider({ timeoutMs: 50 }).fetch({ url: sourceUrl })).rejects.toMatchObject({ code: 'WEB_FETCH_TIMEOUT' })
  })

  it('maps caller cancellation while PDF parsing is pending to WEB_ABORTED', async () => {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    handler = (_request, response) => {
      const bytes = pdf('a'.repeat(3_000_000), true)
      response.once('finish', () => {
        timeout = setTimeout(() => { controller.abort(new Error('caller PDF cancellation fixture')) }, 50)
      })
      response.writeHead(200, { 'content-type': 'application/pdf' }).end(bytes)
    }
    try {
      await expect(provider().fetch({ url: sourceUrl }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
      expect(receipts).toHaveLength(1)
    } finally { clearTimeout(timeout) }
  })
})
