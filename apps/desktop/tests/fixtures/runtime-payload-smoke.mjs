/** Exercise Desktop dependencies under bundled Node or Electron with an explicit expected version. */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const runtime = process.argv[2]
assert.ok(runtime, 'Pass the filtered resources/dsh directory')
const root = resolve(runtime)
const descriptor = JSON.parse(readFileSync(join(root, 'desktop-runtime.json'), 'utf8'))
if (process.argv[3] === undefined) {
  assert.equal(process.versions.node, descriptor.release.nodeVersion, 'Run with the bundled Node version')
} else {
  assert.equal(process.versions.electron, process.argv[3], 'Run with the packaged Electron version')
}
assert.equal(process.platform, descriptor.platform)
assert.equal(process.arch, descriptor.arch)
const requireRuntime = createRequire(join(root, 'package.json'))
const scratch = mkdtempSync(join(tmpdir(), 'dsh-runtime-payload-'))

/** Spawn only a fixed Node program and await the terminal's drained exit event. */
async function checkPty() {
  const pty = requireRuntime('node-pty')
  const script = join(scratch, 'pty.cjs')
  writeFileSync(script, "process.stdout.write('runtime-payload-pty-ok\\n')\n", { flag: 'wx', mode: 0o600 })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    /^(?:path|systemroot|windir|comspec)$/iu.test(name)
  )))
  Object.assign(env, { HOME: scratch, USERPROFILE: scratch, TMP: scratch, TEMP: scratch, TMPDIR: scratch })
  // The GUI-subsystem Electron executable does not expose console stdout through Windows ConPTY.
  const executable = process.versions.electron === undefined ? process.execPath
    : resolve(root, '../../runtime/node', process.platform === 'win32' ? 'node.exe' : 'node')
  const terminal = pty.spawn(executable, [script], { cwd: scratch, env, cols: 80, rows: 24 })
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

/** fs-ext implements seek on Windows through SetFilePointerEx and on POSIX through lseek. */
function checkFsExt() {
  let fsExt
  try {
    fsExt = requireRuntime('fs-ext')
  } catch (error) {
    // fs-ext is an optional POSIX locking/seek accelerator. Windows builds can
    // use the native fallback when the optional native addon is unavailable.
    if (process.platform === 'win32' && error?.code === 'MODULE_NOT_FOUND'
      && /Cannot find module 'fs-ext'/u.test(error.message)) return false
    throw error
  }
  const file = join(scratch, 'seek.txt')
  writeFileSync(file, 'abcdef', { flag: 'wx', mode: 0o600 })
  const fd = openSync(file, 'r')
  try {
    assert.equal(fsExt.seekSync(fd, 2, fsExt.constants.SEEK_SET), 2)
    const bytes = Buffer.alloc(4)
    assert.equal(readSync(fd, bytes, 0, bytes.length, null), 4)
    assert.equal(bytes.toString(), 'cdef')
  } finally {
    closeSync(fd)
  }
  return true
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

/** Exercise Domino parsing through the HTML converter and GFM plugin used by web_fetch. */
function checkHtml() {
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
}

/** Import native document libraries from the copied interpreter and render files. */
function checkResearchPython() {
  const pythonRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh-research-workbench', 'runtime', 'components', 'platform-python')
    .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  const output = execFileSync(join(pythonRoot, 'python.exe'), ['-I', '-B', '-c', [
    'import os, sys, pathlib, pypdf, docx, matplotlib, pypdfium2',
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

let fsExt = false
try {
  fsExt = checkFsExt()
  checkKoffi()
  await checkSharp()
  checkHtml()
  if (process.platform === 'win32') checkResearchPython()
  await checkPty()
} finally {
  // This private tree contains only fixture files; Windows may release handles after terminal exit.
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}

// Natural event-loop drain includes node-pty's worker and console-list helper teardown.
process.once('beforeExit', () => {
  console.log(JSON.stringify({ node: process.versions.node, platform: process.platform, arch: process.arch,
    fsExt, koffi: true, sharp: true, html: true, pty: true }))
})
