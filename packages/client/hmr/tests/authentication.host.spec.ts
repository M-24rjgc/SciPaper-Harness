import { Context } from '@deepseek-ai/cordis'
import { request } from 'node:http'
import { Readable } from 'node:stream'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import * as Hmr from '../src/index.ts'

describe('Authenticated graph subscription', () => {
  it('refuses anonymous streams and revokes only the matching admitted Peer', async () => {
    const ctx = new Context()
    const records = new Map<unknown, unknown>()
    const changed = new Set<() => void>()
    let revision = 'initial'
    ctx.provide('credentials', {
      async modifyRecord(key: unknown, mutate: (record: unknown) => Promise<unknown>): Promise<unknown> {
        const previous = records.get(key)
        const next = await mutate(previous)
        if (next !== undefined) records.set(key, next)
        return next ?? previous
      },
    } as never)
    ctx.provide('clientModules', {
      graph: () => ({ rev: revision, entries: [], batches: [] }),
      onGraphChanged: (listener: () => void) => { changed.add(listener); return () => { changed.delete(listener) } },
      onRebuilt: () => () => {},
    } as never)
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
    try {
      await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await ctx.plugin(Connection)
      const hmr = await ctx.plugin(Hmr, { pollIntervalMs: 500 })
      const localOrigin = `http://127.0.0.1:${String(ctx.webServer.port)}`
      const endpoint = `${localOrigin}/plugins/events`
      const first = ctx.connection.registerRemoteOrigin('https://mobile-first.invalid')
      const second = ctx.connection.registerRemoteOrigin('https://mobile-second.invalid')
      const firstHeaders = pair(ctx, first.createPairingUrl().url)
      const secondHeaders = pair(ctx, second.createPairingUrl().url)

      const anonymous = await hostRequest(endpoint, { headers: { host: firstHeaders.host, origin: firstHeaders.origin } })
      expect(anonymous.status).toBe(401)
      expect(await anonymous.text()).toBe('unauthorized')
      const crossSite = await hostRequest(endpoint, { headers: { ...firstHeaders, origin: 'https://attacker.invalid' } })
      expect(crossSite.status).toBe(403)
      expect(await crossSite.text()).toBe('forbidden')
      const unknownHost = await hostRequest(endpoint, { headers: { host: 'attacker.invalid' } })
      expect(unknownHost.status).toBe(403)
      await unknownHost.arrayBuffer()
      const head = await hostRequest(endpoint, { method: 'HEAD', headers: firstHeaders })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')

      const firstResponse = await hostRequest(endpoint, { headers: firstHeaders })
      const secondResponse = await hostRequest(endpoint, { headers: secondHeaders })
      expect(firstResponse.status).toBe(200)
      expect(secondResponse.status).toBe(200)
      const firstReader = firstResponse.body!.getReader()
      const secondReader = secondResponse.body!.getReader()
      readers.push(firstReader, secondReader)
      expect(await graphFrame(firstReader)).toMatchObject({ type: 'graph', graph: { rev: 'initial' } })
      expect(await graphFrame(secondReader)).toMatchObject({ type: 'graph', graph: { rev: 'initial' } })

      const firstStopped = firstReader.read().then(value => value.done, () => true)
      await first.dispose()
      expect(await firstStopped).toBe(true)
      revision = 'second-still-live'
      for (const notify of changed) notify()
      expect(await graphFrame(secondReader)).toMatchObject({ graph: { rev: 'second-still-live' } })
      const deniedAgain = await hostRequest(endpoint, { headers: firstHeaders })
      expect(deniedAgain.status).toBe(403)
      await deniedAgain.arrayBuffer()

      const secondStopped = secondReader.read().then(value => value.done, () => true)
      await hmr.dispose()
      expect(await secondStopped).toBe(true)
    } finally {
      await Promise.all(readers.map(reader => reader.cancel().catch(() => undefined)))
      await ctx.fiber.dispose()
    }
  })
})

function pair(ctx: Context, invitation: string): { host: string; origin: string; cookie: string } {
  const url = new URL(invitation)
  let setCookie: string | undefined
  ctx.connection.authorizeIndex({ method: 'GET', url: `${url.pathname}${url.search}`, headers: { host: url.host } }, {
    writeHead(_status, headers) { setCookie = headers?.['set-cookie'] },
    end() {},
  })
  if (setCookie === undefined) throw new Error('fixture pairing returned no cookie')
  return { host: url.host, origin: url.origin, cookie: setCookie.split(';', 1)[0]! }
}

async function graphFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<object> {
  let text = ''
  while (true) {
    const next = await reader.read()
    if (next.done) throw new Error('fixture graph subscription ended before its frame')
    text += new TextDecoder().decode(next.value)
    const data = /^data: (.+)$/mu.exec(text)?.[1]
    if (data !== undefined) return JSON.parse(data) as object
  }
}

/** node:http preserves the public Host supplied by the owned loopback tunnel. */
function hostRequest(url: string, init: { method?: string; headers: Record<string, string> }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, init, (incoming) => {
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') headers.set(key, value)
      }
      resolve(new Response(init.method === 'HEAD' ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
        status: incoming.statusCode!,
        headers,
      }))
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}
