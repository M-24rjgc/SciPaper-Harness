/** Real Chromium guest operations, running against the built Desktop manager. */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const builtManager = join(repository, 'apps/desktop/lib/types/browser-guests.js')
const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

it.skipIf(!hasDisplay)('controls and captures the same Electron webview without crossing conversations', { retry: 0, timeout: 75_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-control-'))
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><html><body><h1>Browser control fixture</h1>
      <div id="visual-check" style="width:120px;height:120px;background:#ff0000"></div>
      <button id="run" onclick="document.querySelector('#count').textContent = String(Number(document.querySelector('#count').textContent) + 1)">Run</button>
      <span id="count">0</span><input id="entry"><input id="secret" type="password"></body></html>`)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture listener missing')
    if (!existsSync(builtManager)) throw new Error(`missing built Desktop manager ${builtManager}; run pnpm run build:lib:host`)
    const electron: unknown = require('electron')
    if (typeof electron !== 'string') throw new Error('Electron executable is unavailable')
    const fixture = fileURLToPath(new URL('./fixtures/browser-control-smoke.mjs', import.meta.url))
    const result = await execa(electron, [fixture, builtManager, root, `http://127.0.0.1:${String(address.port)}/`], {
      env: { ELECTRON_RUN_AS_NODE: undefined }, timeout: 65_000, forceKillAfterDelay: 3_000, reject: false,
    })
    if (result.exitCode !== 0) throw new Error(`Electron guest failed (exit=${String(result.exitCode)}, signal=${String(result.signal)}, timedOut=${String(result.timedOut)}): ${result.stdout}\n${result.stderr}`)
    const line = result.stdout.split('\n').find(value => value.startsWith('BROWSER_CONTROL_RESULT '))
    if (!line) throw new Error(`Missing browser-control result: ${result.stdout}\n${result.stderr}`)
    expect(JSON.parse(line.slice('BROWSER_CONTROL_RESULT '.length))).toMatchObject({
      inspected: true, clicked: true, typed: true, isolated: true,
    })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
      server.closeAllConnections()
    })
    await rm(root, { recursive: true })
  }
})
