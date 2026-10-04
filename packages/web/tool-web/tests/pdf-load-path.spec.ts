/** Shipped Loader registration, real HTTP PDF bytes, parser Worker and tool pagination together. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolRuntime from '@deepseek-ai/dsh-tools'
import * as WebRuntime from '@deepseek-ai/dsh-web'
import * as HttpFetch from '@deepseek-ai/dsh-web-fetch-http'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { publicHttpNetwork } from '../../web-fetch-http/src/network.ts'
import { pdf } from '../../web-fetch-http/tests/pdf-fixture.ts'

it('fetches and continues a PDF through the real Loader composition without dropping rendered text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pdf-loader-'))
  const ctx = new Context()
  const bytes = pdf('Complete offline PDF fixture suffix')
  const html = '<h2>HTML title</h2><p>A &amp; B</p><script>hidden()</script><p>Complete HTML fixture suffix</p>'
  const server = createServer((request, response) => {
    if (request.url === '/page.html') {
      response.writeHead(200, { 'content-type': 'text/html' }).end(html)
      return
    }
    response.writeHead(200, { 'content-type': 'application/pdf' }).end(bytes)
  })
  const resolution = vi.spyOn(publicHttpNetwork, 'resolve').mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/paper.pdf`
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, `
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
- id: tools
  name: '@deepseek-ai/dsh-tools'
- id: web
  name: '@deepseek-ai/dsh-web'
- id: fetch
  name: '@deepseek-ai/dsh-web-fetch-http'
- id: web-tools
  name: '@deepseek-ai/dsh-tool-web'
  config:
    search: false
    fetchMaxOutputChars: 1000
`)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, object>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-web', WebRuntime], ['@deepseek-ai/dsh-web-fetch-http', HttpFetch],
      ['@deepseek-ai/dsh-tool-web', ToolWeb],
    ])
    const unsupportedHmrOperation = (): never => { throw new Error('PDF Loader fixture does not use HMR') }
    ctx.loader.internal = {
      version: 'v2', loadCache: new Map(), register: unsupportedHmrOperation,
      getOrCreateModuleJob: unsupportedHmrOperation, resolveSync: unsupportedHmrOperation, load: unsupportedHmrOperation,
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`Unexpected PDF Loader import: ${specifier}`)
        return module
      },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    let offset = 0
    let retrieved = ''
    for (let page = 0; page < 10; page++) {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId(`pdf-page-${page}`), name: 'web_fetch',
        arguments: { url, offset, max_chars: 20 },
      })
      expect(result.isError).toBe(false)
      const value = result.value as { offset: number; nextOffset?: number; body: { content: string }; truncated: boolean }
      expect(value.offset).toBe(offset)
      const rendered = result.content.map(block => block.type === 'text' ? block.text : '').join('')
      expect(rendered).toContain(value.body.content)
      expect(rendered.length).toBeLessThanOrEqual(1000)
      retrieved += value.body.content
      if (value.nextOffset === undefined) { expect(value.truncated).toBe(false); break }
      expect(value.nextOffset).toBe(offset + value.body.content.length)
      expect(rendered).toContain(`offset=${value.nextOffset}`)
      offset = value.nextOffset
    }
    expect(retrieved).toContain('[Page 1]')
    expect(retrieved).toContain('Complete offline PDF fixture suffix')
    let htmlOffset = 0
    let htmlRetrieved = ''
    for (let page = 0; page < 10; page++) {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId(`html-page-${page}`), name: 'web_fetch',
        arguments: { url: `http://127.0.0.1:${port}/page.html`, offset: htmlOffset, max_chars: 20 },
      })
      expect(result.isError).toBe(false)
      const value = result.value as { nextOffset?: number; body: { kind: string; content: string }; truncated: boolean }
      expect(value.body.kind).toBe('text')
      htmlRetrieved += value.body.content
      if (value.nextOffset === undefined) { expect(value.truncated).toBe(false); break }
      htmlOffset = value.nextOffset
    }
    expect(htmlRetrieved).toBe('## HTML title\n\nA & B\n\nComplete HTML fixture suffix')
  } finally {
    try { await ctx.fiber.dispose() } finally {
      resolution.mockRestore()
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => { if (error === undefined) resolve(); else reject(error) }))
      }
      await rm(root, { recursive: true })
    }
  }
})
