/** Exercise filtered Desktop native and HTML dependencies under its Electron Node runtime. */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve, toNamespacedPath } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtime = process.argv[2]
assert.ok(runtime, 'Pass the filtered resources/dsh directory')
const root = resolve(runtime)
const descriptor = JSON.parse(readFileSync(join(root, 'desktop-runtime.json'), 'utf8'))
assert.equal(process.versions.node, descriptor.release.nodeVersion, 'Run with the Electron Node runtime version')
assert.equal(process.platform, descriptor.platform)
assert.equal(process.arch, descriptor.arch)
const resourcesRuntime = process.argv[3] ?? join(dirname(root), 'runtime')
const requireRuntime = createRequire(join(root, 'package.json'))
const scratch = mkdtempSync(join(tmpdir(), 'dsh-runtime-payload-'))

/** Run a package script with only the shipped node launcher available on PATH. */
function checkPnpm() {
  const bin = join(resourcesRuntime, 'bin')
  const pnpm = join(resourcesRuntime, 'pnpm', 'bin', 'pnpm.mjs')
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({
    name: 'desktop-node-script-smoke', private: true, scripts: { check: 'node check.cjs' },
  }))
  writeFileSync(join(scratch, 'check.cjs'), `
const assert = require('node:assert/strict')
assert.equal(process.execPath, ${JSON.stringify(process.execPath)})
assert.ok(process.versions.electron)
assert.ok(process.execArgv.includes('--expose-internals'))
assert.equal(typeof require('internal/modules/esm/loader').getOrInitializeCascadedLoader, 'function')
console.log('desktop-node-script-ok')
`)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:systemroot|windir|comspec)$/iu.test(name)))
  const systemBin = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin'
  // This dependency-free fixture checks script launch, without pnpm's implicit install and update-network check.
  const output = execFileSync(process.execPath, ['--expose-internals', pnpm, 'run', 'check'], {
    cwd: scratch, encoding: 'utf8', timeout: 45_000,
    env: { ...environment, pnpm_config_verify_deps_before_run: 'false',
      ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
      PATH: `${bin}${delimiter}${systemBin}`, HOME: scratch, USERPROFILE: scratch, TMP: scratch, TEMP: scratch, TMPDIR: scratch },
  })
  assert.match(output, /desktop-node-script-ok/u)
}

/** Spawn only a fixed Node program and await the terminal's drained exit event. */
async function checkPty() {
  const pty = requireRuntime('node-pty')
  const script = join(scratch, 'pty.cjs')
  writeFileSync(script, "process.stdout.write('runtime-payload-pty-ok\\n')\n", { flag: 'wx', mode: 0o600 })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    /^(?:path|systemroot|windir|comspec|ELECTRON_RUN_AS_NODE)$/iu.test(name)
  )))
  Object.assign(env, { HOME: scratch, USERPROFILE: scratch, TMP: scratch, TEMP: scratch, TMPDIR: scratch })
  env.DSH_DESKTOP_NODE_EXECUTABLE = process.execPath
  env.PATH = `${join(resourcesRuntime, 'bin')}${delimiter}${env.PATH ?? env.Path ?? ''}`
  // A Windows GUI executable needs a console-owning shell when launched inside ConPTY.
  const executable = process.platform === 'win32' ? process.env.ComSpec : process.execPath
  const args = process.platform === 'win32' ? ['/d', '/c', 'node', script] : [script]
  const terminal = pty.spawn(executable, args, { cwd: scratch, env, cols: 80, rows: 24 })
  let output = ''
  let exited = false
  let timedOut = false
  let exitSubscription
  const exit = new Promise(resolveExit => {
    exitSubscription = terminal.onExit(event => {
      exited = true
      resolveExit(event)
    })
  })
  const dataSubscription = terminal.onData(data => { output += data })
  let timer
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error('Packaged PTY did not exit within 45 seconds'))
      }, 45_000)
    })
    const result = await Promise.race([exit, deadline])
    assert.equal(timedOut, false)
    assert.ok(result.signal === undefined || result.signal === 0, 'PTY exited without a signal')
    assert.equal(result.exitCode, 0)
    assert.match(output, /runtime-payload-pty-ok/u)
  } finally {
    clearTimeout(timer)
    dataSubscription.dispose()
    try {
      // node-pty's Windows natural-exit event closes output but leaves its ConPTY worker owned by kill().
      if (!exited || process.platform === 'win32') terminal.kill()
      await exit
    } finally {
      exitSubscription.dispose()
    }
  }
}

/** Exercise grep and glob operations with the search tool's resolved native executable. */
async function checkSearch() {
  const { resolveRgPath } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-tool-fs-search')).href)
  const executable = await resolveRgPath()
  const name = 'ripgrep-smoke.txt'
  const marker = 'desktop-ripgrep-smoke'
  writeFileSync(join(scratch, name), `${marker}\n`, { flag: 'wx', mode: 0o600 })
  const run = args => execFileSync(executable, ['--no-config', ...args], {
    cwd: scratch, encoding: 'utf8', timeout: 45_000, windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:systemroot|windir)$/iu.test(name))),
  }).trim().replaceAll('\\', '/')
  assert.equal(run(['--no-heading', '--no-filename', '--line-number', '--fixed-strings', '--', marker, name]), `1:${marker}`)
  assert.equal(run(['--files', '--glob', name, '.']), `./${name}`)
}

/** Resolve one system function through Koffi's packaged native module. */
function checkKoffi() {
  const koffi = requireRuntime('koffi')
  const library = koffi.load(process.platform === 'win32' ? 'kernel32.dll' : null)
  try {
    const getPid = process.platform === 'win32'
      ? library.func('uint32_t __stdcall GetCurrentProcessId(void)')
      : library.func('int getpid(void)')
    assert.equal(getPid(), process.pid)
  } finally {
    library.unload()
  }
}

/** Encode and decode a pixel through the packaged libvips binary. */
async function checkSharp() {
  const sharp = requireRuntime('sharp')
  const pixel = Buffer.from([17, 103, 231])
  const png = await sharp(pixel, { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer()
  const decoded = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  assert.equal(decoded.info.width, 1)
  assert.equal(decoded.info.height, 1)
  assert.equal(decoded.info.channels, 3)
  assert.deepEqual(decoded.data, pixel)
}

/** Exercise Domino and the installed tool's package-owned HTML Worker, including ASAR dependency reads. */
async function checkHtml() {
  const Turndown = requireRuntime('turndown')
  const { gfm } = requireRuntime('@joplin/turndown-plugin-gfm')
  const converter = new Turndown({ bulletListMarker: '-' })
  converter.use(gfm)
  const markdown = converter.turndown('<p>A &amp; B &copy;</p><ul><li>first</li><li>second</li></ul>'
    + '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>x</td><td>7</td></tr></tbody></table>')
  assert.match(markdown, /A & B ©/u)
  assert.match(markdown, /-\s+first\n-\s+second/u)
  assert.match(markdown, /\| Name \| Value \|/u)
  assert.match(markdown, /\| x\s+\| 7\s+\|/u)
  const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
  const [{ Context }, { default: SystemPrompt }, { default: Tools }, { default: Web }, ToolWeb] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
    load('@deepseek-ai/dsh-web'), load('@deepseek-ai/dsh-tool-web'),
  ])
  const ctx = new Context()
  let heartbeat
  let cancellation
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Web)
    ctx.web.registerFetchProvider({ id: 'desktop-html-fixture', available: () => true,
      fetch: async request => ({ url: request.url, statusCode: 200, truncated: false,
        body: { kind: 'html', content: request.url.endsWith('/large') ? '<p>text</p>'.repeat(100000)
          : '<h2>Packaged HTML title</h2><p>A &amp; B</p><script>hidden()</script><p>HTML suffix</p>' } }) })
    await ctx.plugin(ToolWeb, { search: false, fetchMaxOutputChars: 1000 })
    let offset = 0
    let content = ''
    for (let page = 0; page < 10; page++) {
      const result = await ctx.tools.execute({ callId: `desktop-html-${page}`, name: 'web_fetch',
        arguments: { url: 'https://desktop-fixture.test/html', offset, max_chars: 20 }, signal: new AbortController().signal })
      assert.equal(result.isError, false)
      assert.equal(result.value.body.kind, 'text')
      content += result.value.body.content
      if (result.value.nextOffset === undefined) { assert.equal(result.value.truncated, false); break }
      offset = result.value.nextOffset
    }
    assert.equal(content, '## Packaged HTML title\n\nA & B\n\nHTML suffix')
    const controller = new AbortController()
    let beats = 0
    heartbeat = setInterval(() => { beats++ }, 20)
    cancellation = setTimeout(() => { controller.abort(new Error('desktop HTML cancelled')) }, 250)
    const cancelled = await ctx.tools.execute({ callId: 'desktop-html-cancel', name: 'web_fetch',
      arguments: { url: 'https://desktop-fixture.test/large' }, signal: controller.signal })
    assert.equal(cancelled.isError, true)
    assert.ok(beats > 1, 'Host heartbeat continues while the large HTML parser is running')
  } finally {
    clearInterval(heartbeat)
    clearTimeout(cancellation)
    await ctx.fiber.dispose()
  }
}

/** Build offline text PDFs whose CJK variant requires the packaged binary CMaps in the parser Worker. */
function pdfFixture(cjk = false) {
  const stream = cjk ? 'BT /F1 12 Tf 30 100 Td <6587> Tj ET' : 'BT /F1 12 Tf 30 100 Td (Packaged PDF text) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    cjk
      ? '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UTF16-H /DescendantFonts [6 0 R] >>'
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  if (cjk) objects.push(
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo '
      + '<< /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /DW 1000 /FontDescriptor 7 0 R >>',
    '<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 6 /FontBBox [0 -200 1000 900] '
      + '/ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 800 /StemV 80 >>',
  )
  let body = '%PDF-1.7\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const start = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(body)
}

/** Fetch local fixture bytes through the installed provider, including Worker imports and CMap/font ASAR reads. */
async function checkPdf() {
  const entry = requireRuntime.resolve('@deepseek-ai/dsh-web-fetch-http')
  const { HttpFetchProvider } = await import(pathToFileURL(entry).href)
  const requireFetch = createRequire(entry)
  const pdfRoot = dirname(requireFetch.resolve('pdfjs-dist/package.json'))
  assert.ok(readFileSync(join(pdfRoot, 'cmaps', 'UniJIS-UTF16-H.bcmap')).byteLength > 0)
  assert.ok(readFileSync(join(pdfRoot, 'standard_fonts', 'LiberationSans-Regular.ttf')).byteLength > 0)
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/pdf' }).end(pdfFixture(request.url === '/cjk'))
  })
  try {
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const origin = `http://127.0.0.1:${server.address().port}`
    const provider = new HttpFetchProvider({ maxResponseBytes: 100_000, maxBodyChars: 1000, timeoutMs: 15_000,
      maxRedirects: 0, userAgent: 'desktop-pdf-smoke', allowFakeIpDns: false },
    async () => [{ address: '127.0.0.1', family: 4 }])
    for (const [path, expected] of [['/text', 'Packaged PDF text'], ['/cjk', '文']]) {
      const result = await provider.fetch({ url: `${origin}${path}` })
      assert.equal(result.body.kind, 'text')
      assert.ok(result.body.content.includes(expected), `Packaged PDF ${path} text must survive the parser Worker`)
      assert.equal(result.truncated, false)
    }
  } finally {
    if (server.listening) await new Promise((resolveClose, reject) => server.close((error) => {
      if (error === undefined) resolveClose(); else reject(error)
    }))
  }
}

/** Import native document libraries from the copied interpreter and render files. */
function checkResearchPython() {
  const pythonRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh-research-workbench', 'runtime', 'components', 'platform-python')
    .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  const output = execFileSync(toNamespacedPath(join(pythonRoot, 'python.exe')), ['-I', '-B', '-c', [
    'import os, sys, pathlib, pyexpat, _ssl, _sqlite3, pypdf, docx, matplotlib, pypdfium2, svglib, reportlab, yaml',
    'assert all(m.__file__.startswith(chr(92) * 2 + "?" + chr(92)) for m in (pyexpat, _ssl, _sqlite3))',
    'root = pathlib.Path(sys.executable).resolve().parent',
    'assert all(pathlib.Path(m.__file__).resolve().is_relative_to(root) for m in (pypdf, docx, matplotlib, pypdfium2))',
    'out = pathlib.Path(sys.argv[1])',
    'writer = pypdf.PdfWriter(); writer.add_blank_page(width=72, height=72)',
    'writer.write(str(out / "document.pdf"))',
    'pdf = pypdfium2.PdfDocument(out / "document.pdf")',
    'page = pdf[0]; bitmap = page.render(); bitmap.to_pil().save(out / "page.png")',
    'bitmap.close(); page.close(); pdf.close()',
    'document = docx.Document(); document.add_paragraph("Research document"); document.save(out / "document.docx")',
    'matplotlib.use("Agg")',
    'from matplotlib import pyplot',
    'pyplot.plot([0, 1], [0, 1]); pyplot.savefig(out / "plot.png"); pyplot.close()',
    'print("research-python-ok")',
  ].join('\n'), scratch], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  assert.match(output, /research-python-ok/u)
  assert.equal(readFileSync(join(scratch, 'document.pdf')).subarray(0, 4).toString(), '%PDF')
  assert.equal(readFileSync(join(scratch, 'document.docx')).subarray(0, 2).toString(), 'PK')
  assert.equal(readFileSync(join(scratch, 'page.png'))[0], 137)
  assert.equal(readFileSync(join(scratch, 'plot.png'))[0], 137)
}


try {
  const builtin = requireRuntime('node-addon-require-builtin')
  assert.equal(typeof builtin.requireBuiltin('internal/modules/esm/loader').getOrInitializeCascadedLoader, 'function')
  checkPnpm()
  checkKoffi()
  await checkSharp()
  await checkHtml()
  await checkPdf()
  if (process.platform === 'win32') checkResearchPython()
  await checkPty()
  await checkSearch()
} finally {
  // This private tree contains only fixture files; Windows may release handles after terminal exit.
  await rm(scratch, { recursive: true, maxRetries: 20, retryDelay: 50 })
}

// Natural event-loop drain includes node-pty's worker and console-list helper teardown.
process.once('beforeExit', () => {
  console.log(JSON.stringify({ node: process.versions.node, platform: process.platform, arch: process.arch,
    koffi: true, sharp: true, html: true, pdf: true, pty: true, pnpm: true, grep: true, glob: true }))
})
