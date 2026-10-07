/** Private remote-control requests use the real Connection authentication and lifetime owner. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject, type ConnectionIndexResponse } from '@deepseek-ai/dsh-client-connection'
import { provideBrowserCredentials } from '../../../packages/client/connection/tests/browser-credentials.ts'
import { DesktopRemoteAccess } from '../src/remote-access.ts'

async function mounted(): Promise<{ ctx: Context; control: DesktopRemoteAccess }> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  provideBrowserCredentials(ctx)
  const connection = ctx.plugin({ apply, inject })
  await connection.await()
  return { ctx, control: new DesktopRemoteAccess(ctx) }
}

function exchange(ctx: Context, link: string): { status: number; cookie: string } {
  let status = 0
  let cookie = ''
  const response: ConnectionIndexResponse = {
    writeHead(code, headers) { status = code; cookie = headers?.['set-cookie']?.split(';', 1)[0] ?? '' },
    end() {},
  }
  const url = new URL(link)
  ctx.connection.authorizeIndex({ method: 'GET', url: `/${url.search}`, headers: { host: url.host, origin: url.origin } }, response)
  return { status, cookie }
}

it('refreshes a pending invitation, serializes origin replacement and stop, and rejects refresh after stop', async () => {
  const { ctx, control } = await mounted()
  const first = await control.request({ action: 'start', origin: 'https://first.example' })
  expect(first).toBeDefined()
  const refreshed = await control.request({ action: 'refresh' })
  expect(refreshed).toBeDefined()
  expect(exchange(ctx, first!.url).status).toBe(401)
  const { status, cookie } = exchange(ctx, refreshed!.url)
  expect(status).toBe(303)
  const original = { headers: { host: 'first.example', origin: 'https://first.example', cookie } }
  expect(ctx.connection.requestRejection(original)).toBeUndefined()
  const replacing = control.request({ action: 'start', origin: 'https://second.example' })
  const stopping = control.request({ action: 'stop' })
  expect(await replacing).toBeDefined()
  expect(await stopping).toBeUndefined()
  expect(ctx.connection.requestRejection(original)).toBe(403)
  await expect(control.request({ action: 'refresh' })).rejects.toThrow('not enabled')
  const restarted = await control.request({ action: 'start', origin: 'https://first.example' })
  expect(restarted).toBeDefined()
  expect(ctx.connection.requestRejection(original)).toBe(401)
  await control.dispose()
  expect(ctx.connection.requestRejection(original)).toBe(403)
})

it('refuses queued activation and new invitations as soon as Host teardown begins', async () => {
  const { ctx, control } = await mounted()
  const register = vi.spyOn(ctx.connection, 'registerRemoteOrigin')
  const queued = control.request({ action: 'start', origin: 'https://first.example' })
  const stopping = control.dispose()
  await expect(queued).rejects.toThrow('Host is unavailable')
  await stopping
  expect(register).not.toHaveBeenCalled()
  await expect(control.request({ action: 'refresh' })).rejects.toThrow('Host is unavailable')
})
