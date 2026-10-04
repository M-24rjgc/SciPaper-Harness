/** Real TypeScript emit and Host bundling preserve the published HTML assets and Worker lifecycle. */
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { build, type TsdownBundle } from 'tsdown'
import { expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = resolve(packageRoot, '../../..')
const execute = promisify(execFile)

it('bundles lib/types input and executes complete HTML pagination and cancellation from the published lib/assets layout', async () => {
  const fixture = await mkdtemp(join(packageRoot, '.html-built-'))
  let bundles: TsdownBundle[] = []
  try {
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'html-built-fixture', type: 'module' }))
    await execute(process.execPath, [join(repositoryRoot, 'node_modules/typescript/bin/tsc'),
      '-p', join(packageRoot, 'tsconfig.json'), '--outDir', join(fixture, 'lib/types'),
      '--tsBuildInfoFile', join(fixture, 'compiler.tsbuildinfo'), '--pretty', 'false',
    ], { cwd: repositoryRoot, timeout: 30_000, windowsHide: true })
    bundles = await build({
      cwd: packageRoot, config: false, tsconfig: false, entry: { index: join(fixture, 'lib/types/index.js') },
      outDir: join(fixture, 'lib'), format: ['esm'], platform: 'node', target: 'es2024',
      deps: { neverBundle: [/^@deepseek-ai\//, /^@joplin\//, /^turndown$/, /^node:/] }, fixedExtension: false,
      dts: false, clean: false, exports: false, report: false, logLevel: 'silent',
    })
    // The publication ships sibling assets, never a copy under lib/assets or lib/types.
    await cp(join(packageRoot, 'assets'), join(fixture, 'assets'), { recursive: true, filter: path => !path.endsWith('.d.cts') })
    const output = await readFile(join(fixture, 'lib/index.js'), 'utf8')
    expect(output).not.toContain('import converter from "../assets/html-converter.cjs"')
    const probe = `
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Web from '@deepseek-ai/dsh-web'
import * as ToolWeb from './lib/index.js'
const body = 'complete '.repeat(30000) + 'UNIQUE-BUILT-SUFFIX'
const url = 'https://fixture.test/page'
assert.match(ToolWeb.formatFetchOutput({ url, statusCode: 200, body: { kind: 'html', content: '<p>Legacy &amp; render</p>' }, truncated: false }, 200000), /Legacy & render/)
const ctx = new Context()
let heartbeat, timer
const original = Worker.prototype.terminate
let stopped
Worker.prototype.terminate = function () { stopped = this; return original.call(this) }
try {
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Web)
  ctx.web.registerFetchProvider({ id: 'built', available: () => true,
    fetch: async request => ({ url: request.url, statusCode: 200, truncated: false,
      body: { kind: 'html', content: request.url.endsWith('/large') ? '<p>text</p>'.repeat(100000) : '<p>' + body + '</p>' } }) })
  await ctx.plugin(ToolWeb, { search: false })
  const first = await ctx.tools.execute({ callId: 'built-first', name: 'web_fetch', arguments: { url, max_chars: 150000 }, signal: new AbortController().signal })
  assert.equal(first.isError, false); assert.equal(first.value.sourceTruncated, false)
  assert.equal(first.value.totalChars, body.length); assert.ok(first.value.nextOffset > 0)
  const next = await ctx.tools.execute({ callId: 'built-next', name: 'web_fetch', arguments: { url, offset: first.value.nextOffset, max_chars: 150000 }, signal: new AbortController().signal })
  assert.equal(next.isError, false); assert.equal(next.value.truncated, false)
  assert.equal(first.value.body.content + next.value.body.content, body)
  const controller = new AbortController(); let beats = 0
  heartbeat = setInterval(() => { beats++ }, 20)
  timer = setTimeout(() => controller.abort(new Error('built HTML cancelled')), 250)
  const cancelled = await ctx.tools.execute({ callId: 'built-cancel', name: 'web_fetch', arguments: { url: 'https://fixture.test/large' }, signal: controller.signal })
  assert.equal(cancelled.isError, true); assert.ok(beats > 1)
  assert.ok(stopped); assert.equal(stopped.threadId, -1)
  console.log('built-html-assets-pagination-cancel-ok')
} finally {
  clearInterval(heartbeat); clearTimeout(timer); Worker.prototype.terminate = original; await ctx.fiber.dispose()
}
`
    await writeFile(join(fixture, 'probe.mjs'), probe)
    const result = await execute(process.execPath, [join(fixture, 'probe.mjs')], {
      cwd: fixture, timeout: 30_000, windowsHide: true,
    })
    expect(result.stdout).toContain('built-html-assets-pagination-cancel-ok')
  } finally {
    for (const bundle of bundles) await bundle[Symbol.asyncDispose]()
    await rm(fixture, { recursive: true })
  }
}, 45_000)
