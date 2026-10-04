import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, win32 } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { ProcessResult } from '../src/process.ts'
import type { ResearchPreferences } from '../src/types.ts'
import type { ComponentHost } from '../src/components.ts'
import { newProject } from '../src/project.ts'
import { hashBytes } from '../src/files.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Every process the manager starts, answered by the current script. */
const scripted = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[]; env: Record<string, string | undefined> | undefined }[],
  answer: (_command: string, _args: string[]): ProcessResult | Promise<ProcessResult> => ({ code: 0, stdout: '', stderr: '' }),
}))
vi.mock('../src/process.ts', async (original) => {
  const actual = await original<typeof import('../src/process.ts')>()
  return {
    ...actual,
    runProcess: async (command: string, args: readonly string[], options: { env?: Record<string, string | undefined> } = {}) => {
      scripted.calls.push({ command, args: [...args], env: options.env })
      return scripted.answer(command, [...args])
    },
  }
})

const { COMPONENT_RELEASES, ComponentManager, downloadAsset, packageForFile, prepareManagedPython, runtimeAsset, tlmgrCommand } = await import('../src/components.ts')
const { compilePaper, missingTexFile, writeArtifact } = await import('../src/artifacts.ts')
type Host = ComponentHost

const signal = new AbortController().signal
const roots: string[] = []
function answer(command: string, args: string[]): ProcessResult {
  const engine = basename(command).replace(/\.exe$/, '')
  const banners: Record<string, string> = {
    pdflatex: 'pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026)',
    xelatex: 'XeTeX 3.141592653-2.6-0.999998 (TeX Live 2026)',
    lualatex: 'LuaHBTeX, Version 1.24.0 (TeX Live 2026)',
  }
  return { code: 0, stdout: args.includes('--version') ? banners[engine] ?? '' : '', stderr: '' }
}
beforeEach(() => { vi.stubEnv('PATH', ''); scripted.answer = answer })
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  scripted.calls.length = 0
  scripted.answer = () => ({ code: 0, stdout: '', stderr: '' })
  for (const root of roots.splice(0)) await rm(root, { recursive: true })
})

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'research-components-'))
  roots.push(root)
  return root
}
async function write(path: string, content = ''): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const archive = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])))
/** Answer downloads by URL; anything else is a 404. */
function serve(files: Record<string, Uint8Array>): string[] {
  const requested: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requested.push(url)
    const bytes = files[url]
    return bytes ? new Response(new Uint8Array(bytes)) : new Response('missing', { status: 404 })
  }))
  return requested
}
/** A Windows x64 host whose pinned releases are the given archives. */
function windows(assets: string, archives: Partial<Record<'uv' | 'drawio' | 'latex', Uint8Array>>): Host {
  const pin = (id: 'uv' | 'drawio' | 'latex') => ({ version: `${id}-test`, url: `https://downloads.test/${id}.zip`, sha256: archives[id] ? sha(archives[id]) : 'none' })
  return { platform: 'win32', arch: 'x64', asset: name => join(assets, name), releases: { uv: pin('uv'), drawio: pin('drawio'), latex: pin('latex') } }
}
const none = (): ResearchPreferences => ({})

describe('pinned downloads', () => {
  it('retries a failed download, verifies the checksum, and reuses a verified file', async () => {
    const root = await temporary()
    const bytes = strToU8('payload')
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async () => ++attempts === 1 ? new Response('busy', { status: 503 }) : new Response(new Uint8Array(bytes))))
    const destination = join(root, 'downloads', 'asset.zip')
    await downloadAsset('https://downloads.test/asset.zip', sha(bytes), destination, signal)
    expect(await readFile(destination, 'utf8')).toBe('payload')
    expect(existsSync(`${destination}.partial`)).toBe(false)
    await downloadAsset('https://downloads.test/asset.zip', sha(bytes), destination, signal)
    expect(attempts).toBe(2)
    await expect(downloadAsset('https://downloads.test/asset.zip', 'other', join(root, 'bad.zip'), signal)).rejects.toThrow(/checksum mismatch/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null)))
    await expect(downloadAsset('https://downloads.test/empty.zip', sha(bytes), join(root, 'empty.zip'), signal)).rejects.toThrow(/HTTP 200/)
  })

  it('stops at once when cancelled', async () => {
    const root = await temporary()
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(downloadAsset('https://downloads.test/a.zip', 'x', join(root, 'a.zip'), cancelled.signal)).rejects.toThrow()
    const during = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => { during.abort(); throw new Error('aborted') }))
    await expect(downloadAsset('https://downloads.test/b.zip', 'x', join(root, 'b.zip'), during.signal)).rejects.toThrow(/aborted/)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })
})

describe('managed tools on a Windows x64 host', () => {
  it('installs uv, draw.io, TeX and the platform Python from pinned archives, once each', async () => {
    const root = await temporary()
    const assets = await temporary()
    const archives = {
      uv: archive({ 'uv-x86_64/uv.exe': 'uv' }),
      drawio: archive({ 'index.html': '<html>', 'js/app.js': 'app' }),
      latex: archive({ 'TinyTeX/bin/windows/pdflatex.exe': 'tex', 'TinyTeX/readme.txt': 'x' }),
    }
    const requested = serve(Object.fromEntries(Object.entries(archives).map(([id, bytes]) => [`https://downloads.test/${id}.zip`, bytes])))
    const manager = new ComponentManager(root, none, windows(assets, archives))
    const [uv, again] = await Promise.all([manager.uv(signal), manager.uv(signal)])
    expect(uv).toBe(join(root, 'uv', 'uv-x86_64', 'uv.exe'))
    expect(again).toBe(uv)
    expect(requested.filter(url => url.endsWith('uv.zip'))).toHaveLength(1)
    expect(await manager.drawio(signal)).toBe(join(root, 'drawio'))
    expect(await manager.drawio(signal)).toBe(join(root, 'drawio'))
    const bin = join(root, 'latex', 'TinyTeX', 'bin', 'windows')
    expect(await manager.latex(signal)).toBe(bin)
    expect(await manager.latex(signal)).toBe(bin)
    const python = await manager.python(signal)
    expect(python).toBe(win32.toNamespacedPath(join(root, 'platform-python', 'Scripts/python.exe')))
    expect(scripted.calls.some(call => call.args.includes('venv') && call.args.includes('3.12'))).toBe(true)
    expect(await readFile(join(root, 'platform-python', '.research-ready'), 'utf8')).toMatch(/pypdf==6\.0\.0\n[\s\S]*svglib==2\.2\.0\nreportlab==5\.0\.1\nPyYAML==6\.0\.3\n$/)
    // A ready platform Python is reused; one whose environment exists but lacks the marker only gets its packages.
    await write(join(root, 'platform-python', 'Scripts/python.exe'))
    scripted.calls.length = 0
    expect(await manager.python(signal)).toBe(python)
    expect(scripted.calls).toEqual([])
    await rm(join(root, 'platform-python', '.research-ready'))
    await manager.python(signal)
    expect(scripted.calls.map(call => call.args[0])).toEqual(['pip'])
    // A marker from an older package list installs the current one.
    await write(join(root, 'platform-python', '.research-ready'), 'python=3.12\npypdf=6.0.0\n')
    scripted.calls.length = 0
    await manager.python(signal)
    expect(scripted.calls.map(call => call.args[0])).toEqual(['pip'])
    expect(scripted.calls[0]?.args).toEqual(expect.arrayContaining(['svglib==2.2.0', 'reportlab==5.0.1', 'PyYAML==6.0.3']))
    const statuses = await manager.status()
    expect(statuses.map(status => [status.id, status.installed, status.version])).toEqual([
      ['uv', true, 'uv-test'], ['python', true, '3.12'], ['latex', true, 'TeX Live 2026'], ['drawio', true, 'drawio-test'],
    ])
    // A check asks only for an installed Python, and never installs one.
    expect(await manager.installedPython()).toBe(python)
    scripted.calls.length = 0
    expect(await new ComponentManager(await temporary(), none, windows(await temporary(), {})).installedPython()).toBeUndefined()
    expect(scripted.calls).toEqual([])
  })

  it('creates the platform Python from a bundled interpreter when the app ships one', async () => {
    const root = await temporary()
    const assets = await temporary()
    await write(join(assets, 'components/uv/uv.exe'))
    await write(join(assets, 'components/python/cpython/python.exe'))
    const manager = new ComponentManager(root, none, windows(assets, {}))
    await manager.python(signal)
    expect(scripted.calls.find(call => call.args[0] === 'venv')?.args)
      .toContain(win32.toNamespacedPath(join(assets, 'components/python/cpython/python.exe')))
  })

  it('uses what the app bundles before downloading anything', async () => {
    const root = await temporary()
    const assets = await temporary()
    await write(join(assets, 'components/uv/uv.exe'))
    await write(join(assets, 'components/platform-python/Scripts/python.exe'))
    await write(join(assets, 'components/drawio/index.html'))
    const requested = serve({})
    const manager = new ComponentManager(root, none, windows(assets, {}))
    expect(await manager.uv(signal)).toBe(join(assets, 'components/uv/uv.exe'))
    expect(await manager.python(signal)).toBe(win32.toNamespacedPath(join(assets, 'components/platform-python/Scripts/python.exe')))
    expect(await manager.installedPython()).toBe(await manager.python(signal))
    expect((await manager.status()).find(status => status.id === 'python')?.path)
      .toBe(join(assets, 'components/platform-python/Scripts/python.exe'))
    expect(await manager.drawio(signal)).toBe(join(assets, 'components/drawio'))
    expect(requested).toEqual([])
    expect((await manager.status()).find(status => status.id === 'drawio')?.installed).toBe(true)
  })

  it('refuses archives that lack their executable or entry file', async () => {
    const assets = await temporary()
    const archives = { uv: archive({ 'readme.txt': 'x' }), drawio: archive({ 'notes.txt': 'x' }), latex: archive({ 'a/b/c/d/e/f/g/pdflatex.exe': 'deep' }) }
    serve(Object.fromEntries(Object.entries(archives).map(([id, bytes]) => [`https://downloads.test/${id}.zip`, bytes])))
    const manager = new ComponentManager(await temporary(), none, windows(assets, archives))
    await expect(manager.uv(signal)).rejects.toThrow(/did not contain its executable/)
    await expect(manager.drawio(signal)).rejects.toThrow(/missing its editor entry/)
    await expect(manager.latex(signal)).rejects.toThrow(/missing pdfLaTeX/)
  })

  it('installs a missing TeX package through the private distribution, by the package that ships the file', async () => {
    const root = await temporary()
    await write(join(root, 'latex', 'TinyTeX', 'bin', 'windows', 'pdflatex.exe'))
    await write(join(root, 'latex', '.complete'))
    const manager = new ComponentManager(root, none, windows(await temporary(), {}))
    serve({})
    scripted.answer = (command, args) => args.includes('--version') ? answer(command, args)
      : { code: 0, stdout: args.includes('search') ? 'tlmgr: package repository https://mirror\nacmart:\n\ttexmf-dist/tex/latex/acmart/acmart.cls\n' : '', stderr: '' }
    await manager.installTexPackage('acmart.cls', signal)
    const install = scripted.calls.find(call => call.args.includes('install'))!
    expect(install.args.at(-1)).toBe('acmart')
    expect(install.command).toBe(join(root, 'latex', 'TinyTeX', 'tlpkg', 'tlperl', 'bin', 'perl.exe'))
    expect(install.env?.PATH?.startsWith(join(root, 'latex', 'TinyTeX', 'bin', 'windows'))).toBe(true)
    scripted.answer = (command, args) => args.includes('--version') ? answer(command, args) : { code: 0, stdout: '', stderr: '' }
    await manager.installTexPackage('orphan.sty', signal)
    expect(scripted.calls.at(-1)?.args.at(-1)).toBe('orphan')
    await expect(manager.installTexPackage('../../evil.sty', signal)).rejects.toThrow(/Unsupported TeX dependency/)
    // A font or graphic no package lists is not guessed: nothing is installed.
    scripted.calls.length = 0
    expect(await manager.installTexPackage('example-image-plain.pdf', signal, false)).toBe(false)
    expect(scripted.calls.some(call => call.args.includes('install'))).toBe(false)
    scripted.answer = (command, args) => args.includes('--version') ? answer(command, args)
      : { code: 0, stdout: args.includes('search') ? 'mwe:\n\ttexmf-dist/tex/latex/mwe/example-image-plain.pdf\n' : '', stderr: '' }
    expect(await manager.installTexPackage('example-image-plain.pdf', signal, false)).toBe(true)
    expect(scripted.calls.at(-1)?.args.at(-1)).toBe('mwe')
    await expect(new ComponentManager(root, () => ({ texBin: 'C:/texlive/bin' }), windows(root, {})).installTexPackage('a.sty', signal)).rejects.toThrow(/configured TeX distribution/)
  })
})

describe('TeX distribution selection', () => {
  it('records initialization failures against the manuscript instead of losing its compile result', async () => {
    const root = await temporary()
    vi.stubEnv('DSH_HOME', join(root, 'data-home'))
    const bin = join(root, 'latex', 'TinyTeX', 'bin', 'windows')
    await write(join(bin, 'xelatex.exe'))
    await write(join(root, 'latex', '.complete'))
    const manager = new ComponentManager(root, none, windows(await temporary(), {}))
    scripted.answer = (command, args) => args.includes('--version') ? answer(command, args)
      : { code: 1, stdout: '', stderr: 'format initialization failed' }
    const project = newProject({ title: 'Typesetting', root: join(root, 'project'), brief: '' }, 'workspace' as WorkspaceId)
    await mkdir(project.root)
    const artifact = await writeArtifact(project, { action: 'save-artifact', projectId: project.id, path: 'paper/main.tex', kind: 'manuscript',
      content: '\\documentclass{article}\\begin{document}Text.\\end{document}', evidence: [], claimIds: [], inputArtifacts: [] }, 'user', 100000)
    const result = await compilePaper(project, artifact, 'xelatex', manager, signal, 100000)
    expect(result.status).toBe('failed')
    expect(result.diagnostics.join('\n')).toMatch(/Managed TeX xelatex format initialization failed/)
    expect(await readFile(join(project.root, result.logPath), 'utf8')).toContain('format initialization failed')
  })

  it('initializes managed formats once in writable engine-specific directories and retries a failed initialization', async () => {
    const root = await temporary()
    const bin = join(root, 'latex', 'TinyTeX', 'bin', 'windows')
    vi.stubEnv('DSH_HOME', join(root, 'data-home'))
    const cache = join(root, 'data-home', 'research', 'cache', 'latex', hashBytes(bin).slice(0, 16), 'xelatex')
    await write(join(bin, 'xelatex.exe'))
    await write(join(root, 'latex', '.complete'))
    const manager = new ComponentManager(root, none, windows(await temporary(), {}))
    scripted.answer = (command, args) => args.includes('--version') ? answer(command, args)
      : { code: 1, stdout: '', stderr: 'format initialization failed' }
    await expect(manager.latexRuntime(signal, 'xelatex')).rejects.toThrow(/format initialization failed/)
    scripted.answer = async (command, args) => {
      if (args.includes('--version')) return answer(command, args)
      await write(join(cache, 'texmf-var', 'web2c', 'xetex', 'xelatex.fmt'), 'format')
      return { code: 0, stdout: 'format initialized', stderr: '' }
    }
    const runtime = await manager.latexRuntime(signal, 'xelatex')
    expect(runtime.env.TEXMFVAR).toBe(join(cache, 'texmf-var'))
    expect(runtime.env.TEXMFCACHE).toBe(cache)
    expect(runtime.compilerArgs).toEqual([])
    await manager.latexRuntime(signal, 'xelatex')
    const formats = scripted.calls.filter(call => call.args.includes('--byfmt'))
    expect(formats).toHaveLength(2)
    expect(formats[1]?.command).toBe(join(bin, 'fmtutil-sys.exe'))
    expect(formats[1]?.args).toEqual(['--byfmt', 'xelatex'])
    expect(formats[1]?.env?.PATH?.startsWith(bin)).toBe(true)
  })

  it('reports no TeX without probing arbitrary commands or downloading', async () => {
    const requested = serve({})
    const manager = new ComponentManager(await temporary(), none, windows(await temporary(), {}))
    expect((await manager.status()).find(status => status.id === 'latex'))
      .toEqual({ id: 'latex', installed: false, path: '', version: '', engines: [] })
    expect(scripted.calls).toEqual([])
    expect(requested).toEqual([])
  })

  it('uses the same detected system distribution for status and each compiler without a download', async () => {
    const bin = await temporary()
    for (const engine of ['pdflatex', 'xelatex', 'lualatex']) await write(join(bin, `${engine}.exe`))
    vi.stubEnv('PATH', `"${bin}"`)
    scripted.answer = command => ({ code: 0, stderr: '', stdout: ({
      'pdflatex.exe': 'MiKTeX-pdfTeX 4.23 (MiKTeX 25.12)',
      'xelatex.exe': 'MiKTeX-XeTeX 4.16 (MiKTeX 25.12)',
      'lualatex.exe': 'MiKTeX-LuaHBTeX 1.22 (MiKTeX 25.12)',
    })[basename(command)] ?? '' })
    const requested = serve({})
    const root = await temporary()
    const manager = new ComponentManager(root, none, windows(await temporary(), {}))
    expect((await manager.status()).find(status => status.id === 'latex')).toEqual({
      id: 'latex', installed: true, source: 'system', path: bin, version: 'MiKTeX 25.12',
      engines: ['pdflatex', 'xelatex', 'lualatex'],
    })
    for (const engine of ['pdflatex', 'xelatex', 'lualatex'] as const) expect(await manager.latex(signal, engine)).toBe(bin)
    expect(scripted.calls).toHaveLength(12)
    await expect(manager.installTexPackage('acmart.cls', signal)).rejects.toThrow(/system TeX distribution/)
    expect(scripted.calls.some(call => call.args.includes('search') || call.args.includes('install'))).toBe(false)
    expect(requested).toEqual([])
    expect(existsSync(join(root, 'latex'))).toBe(false)
  })

  it('prefers an explicit binding, then an installed managed distribution, then the system', async () => {
    const root = await temporary()
    const system = await temporary()
    const configured = await temporary()
    const managed = join(root, 'latex', 'TinyTeX', 'bin', 'windows')
    for (const bin of [system, configured, managed]) await write(join(bin, 'pdflatex.exe'))
    await write(join(root, 'latex', '.complete'))
    vi.stubEnv('PATH', system)
    const preferences: ResearchPreferences = { texBin: configured }
    const manager = new ComponentManager(root, () => preferences, windows(await temporary(), {}))
    expect((await manager.status()).find(status => status.id === 'latex')).toMatchObject({ path: configured, source: 'configured' })
    expect(await manager.latex(signal, 'pdflatex')).toBe(configured)
    delete preferences.texBin
    expect((await manager.status()).find(status => status.id === 'latex')).toMatchObject({ path: managed, source: 'managed' })
    expect(await manager.latex(signal, 'pdflatex')).toBe(managed)
    await rm(join(root, 'latex', '.complete'))
    expect((await manager.status()).find(status => status.id === 'latex')).toMatchObject({ path: system, source: 'system' })
  })

  it('reports a missing explicit compiler and refuses to silently use the available system', async () => {
    const configured = await temporary()
    const system = await temporary()
    await write(join(system, 'pdflatex.exe'))
    vi.stubEnv('PATH', system)
    const requested = serve({})
    const manager = new ComponentManager(await temporary(), () => ({ texBin: configured }), windows(await temporary(), {}))
    expect((await manager.status()).find(status => status.id === 'latex')).toMatchObject({
      installed: false, source: 'configured', problem: 'missing-executable', path: configured, version: '', engines: [],
    })
    await expect(manager.latex(signal)).rejects.toThrow(/Configured TeX directory/)
    expect(scripted.calls).toEqual([])
    expect(requested).toEqual([])
  })

  it.each(['wrong-banner', 'nonzero', 'spawn-error'] as const)('rejects an unusable explicitly bound engine: %s', async (failure) => {
    const bin = await temporary()
    await write(join(bin, 'pdflatex.exe'))
    scripted.answer = () => {
      if (failure === 'spawn-error') throw new Error('Invalid executable image')
      return { code: failure === 'nonzero' ? 1 : 0, stdout: 'Python 3.12', stderr: '' }
    }
    const requested = serve({})
    const manager = new ComponentManager(await temporary(), () => ({ texBin: bin }), windows(await temporary(), {}))
    expect((await manager.status()).find(status => status.id === 'latex')).toMatchObject({
      installed: false, source: 'configured', problem: 'invalid-executable', version: '', engines: [],
    })
    await expect(manager.latex(signal)).rejects.toThrow(/Configured TeX directory/)
    expect(requested).toEqual([])
  })

  it('skips a broken managed distribution and broken PATH candidate for a runnable system engine', async () => {
    const root = await temporary()
    const managed = join(root, 'latex', 'TinyTeX', 'bin', 'windows')
    const broken = await temporary()
    const valid = await temporary()
    for (const bin of [managed, broken, valid]) await write(join(bin, 'pdflatex.exe'))
    await write(join(root, 'latex', '.complete'))
    vi.stubEnv('PATH', [broken, valid].join(';'))
    scripted.answer = (command, args) => command === join(valid, 'pdflatex.exe')
      ? answer(command, args) : { code: 1, stdout: '', stderr: 'failed to load' }
    const manager = new ComponentManager(root, none, windows(await temporary(), {}))
    expect((await manager.status()).find(status => status.id === 'latex')).toMatchObject({ installed: true, source: 'system', path: valid })
    expect(await manager.latex(signal, 'pdflatex')).toBe(valid)
  })

  it('does not claim a missing XeLaTeX engine or install another distribution for it', async () => {
    const bin = await temporary()
    await write(join(bin, 'pdflatex.exe'))
    vi.stubEnv('PATH', bin)
    const requested = serve({})
    const manager = new ComponentManager(await temporary(), none, windows(await temporary(), {}))
    expect((await manager.status()).find(status => status.id === 'latex')?.engines).toEqual(['pdflatex'])
    await expect(manager.latex(signal, 'xelatex')).rejects.toThrow(/does not provide a usable xelatex/)
    expect(await manager.latex(signal, 'pdflatex')).toBe(bin)
    expect(requested).toEqual([])
  })

  it.each([true, false])('reselects a changed binding while an earlier managed download is pending: usable=%s', async (usable) => {
    const root = await temporary()
    const bin = await temporary()
    if (usable) await write(join(bin, 'pdflatex.exe'))
    const preferences: ResearchPreferences = {}
    const bytes = archive({ 'TinyTeX/bin/windows/pdflatex.exe': 'managed compiler' })
    const started = Promise.withResolvers<boolean>()
    const release = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn(() => { started.resolve(true); return release.promise }))
    const manager = new ComponentManager(root, () => preferences, windows(await temporary(), { latex: bytes }))
    const earlier = manager.latex(signal, 'pdflatex')
    // Attach both outcomes before changing the binding; no rejected background promise goes unobserved.
    const outcome = earlier.then(value => ({ value }), (error: unknown) => ({ error }))
    await started.promise
    preferences.texBin = bin
    const current = manager.latex(signal, 'pdflatex')
    if (usable) expect(await current).toBe(bin)
    else await expect(current).rejects.toThrow(/Configured TeX directory/)
    expect((await manager.status()).find(status => status.id === 'latex')).toMatchObject({ source: 'configured', path: bin, installed: usable })
    release.resolve(new Response(new Uint8Array(bytes)))
    const result = await outcome
    if (usable) expect(result).toEqual({ value: bin })
    else expect('error' in result && result.error instanceof Error ? result.error.message : '').toMatch(/Configured TeX directory/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('revalidates a replaced compiler and reports its actual installed version', async () => {
    const bin = await temporary()
    const executable = join(bin, 'pdflatex.exe')
    await write(executable, 'first')
    const manager = new ComponentManager(await temporary(), () => ({ texBin: bin }), windows(await temporary(), {}))
    expect((await manager.status()).find(status => status.id === 'latex')?.version).toBe('TeX Live 2026')
    await manager.status()
    expect(scripted.calls).toHaveLength(2)
    await write(executable, 'replacement compiler')
    scripted.answer = () => ({ code: 0, stdout: 'pdfTeX 3.141592653-2.6-1.40.30 (TeX Live 2027)', stderr: '' })
    expect((await manager.status()).find(status => status.id === 'latex')?.version).toBe('TeX Live 2027')
    expect(scripted.calls).toHaveLength(3)
  })

  it('rechecks a compiler that becomes unusable without changing its executable file', async () => {
    const bin = await temporary()
    await write(join(bin, 'pdflatex.exe'))
    const manager = new ComponentManager(await temporary(), () => ({ texBin: bin }), windows(await temporary(), {}))
    expect((await manager.status()).find(status => status.id === 'latex')?.installed).toBe(true)
    scripted.answer = () => ({ code: 1, stdout: '', stderr: 'supporting library missing' })
    await expect(manager.latex(signal, 'pdflatex')).rejects.toThrow(/Configured TeX directory/)
    expect((await manager.status()).find(status => status.id === 'latex')).toMatchObject({ installed: false, problem: 'invalid-executable' })
  })

  it('finds an installed Python without running any TeX probes', async () => {
    const assets = await temporary()
    const python = join(assets, 'components/platform-python/python.exe')
    await write(python)
    const texBin = await temporary()
    await write(join(texBin, 'pdflatex.exe'))
    const manager = new ComponentManager(await temporary(), () => ({ texBin }), windows(assets, {}))
    expect(await manager.installedPython()).toBe(win32.toNamespacedPath(python))
    expect(scripted.calls).toEqual([])
  })

  it('uses each verified engine distribution to choose its supported compiler arguments', async () => {
    const bin = await temporary()
    for (const program of ['pdflatex', 'xelatex']) await write(join(bin, `${program}.exe`))
    scripted.answer = (command, args) => basename(command) === 'pdflatex.exe'
      ? { code: 0, stdout: 'MiKTeX-pdfTeX 4.23 (MiKTeX 25.12)', stderr: '' } : answer(command, args)
    const manager = new ComponentManager(await temporary(), () => ({ texBin: bin }), windows(bin, {}))
    expect((await manager.latexRuntime(signal, 'pdflatex')).compilerArgs).toEqual(['--disable-installer'])
    expect((await manager.latexRuntime(signal, 'xelatex')).compilerArgs).toEqual([])
  })

  it('does not run an unverified external BibTeX or pass its installer arguments to Biber', async () => {
    const bin = await temporary()
    await write(join(bin, 'pdflatex.exe'))
    await write(join(bin, 'bibtex.exe'))
    const manager = new ComponentManager(await temporary(), () => ({ texBin: bin }), windows(bin, {}))
    const runtime = await manager.latexRuntime(signal, 'pdflatex')
    expect(await runtime.bibliographyArgs('biber')).toEqual([])
    expect(scripted.calls.some(call => basename(call.command) === 'biber.exe')).toBe(false)
    await expect(runtime.bibliographyArgs('bibtex')).rejects.toThrow(/did not report a usable BibTeX/)
    expect(scripted.calls.filter(call => basename(call.command) === 'bibtex.exe')).toHaveLength(1)
  })

  it.each([
    ['miktex', 'pdflatex', 'bibtex', 'system'],
    ['miktex', 'xelatex', 'biber', 'system'],
    ['miktex', 'lualatex', 'bibtex', 'configured'],
    ['texlive', 'xelatex', 'bibtex', 'configured'],
  ] as const)('compiles with supported installer arguments: %s / %s / %s / %s', async (distribution, engine, bibliography, source) => {
    const root = await temporary()
    const bin = await temporary()
    for (const program of ['pdflatex', 'xelatex', 'lualatex', 'bibtex', 'biber']) await write(join(bin, `${program}.exe`))
    vi.stubEnv('PATH', bin)
    const requested = serve({})
    scripted.answer = async (command, args) => {
      const program = basename(command, '.exe')
      if (args.includes('--version')) {
        const names: Record<string, string> = { pdflatex: 'pdfTeX', xelatex: 'XeTeX', lualatex: 'LuaHBTeX', bibtex: 'BibTeX' }
        return { code: 0, stdout: distribution === 'miktex'
          ? `MiKTeX-${names[program]} 4.23 (MiKTeX 25.12)` : `${names[program]} 4.23 (TeX Live 2026)`, stderr: '' }
      }
      const output = args.find(value => value.startsWith('-output-directory='))
      if (output) {
        const build = resolve(root, 'paper', output.slice('-output-directory='.length))
        await mkdir(build, { recursive: true })
        await writeFile(join(build, 'main.pdf'), '%PDF-1.7\n%%EOF\n')
        await writeFile(join(build, `main.${bibliography === 'bibtex' ? 'aux' : 'bcf'}`), bibliography === 'bibtex' ? '\\bibdata{refs}' : 'bcf')
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const components = new ComponentManager(join(root, 'components'), () => source === 'configured' ? { texBin: bin } : {}, windows(bin, {}))
    const project = newProject({ root, title: 'Compiler options', brief: 'Typeset a formula' }, 'test-workspace' as WorkspaceId)
    const artifact = await writeArtifact(project, {
      action: 'save-artifact', projectId: project.id, kind: 'manuscript', path: 'paper/main.tex',
      content: '\\documentclass{article}\\begin{document}Formula $E=mc^2$.\\end{document}',
      evidence: [], claimIds: [], inputArtifacts: [],
    }, 'user', 10000)
    const result = await compilePaper(project, artifact, engine, components, signal, 10000)
    expect(result.status).toBe('completed')
    const compilerCalls = scripted.calls.filter(call => call.args.some(arg => arg.startsWith('-output-directory=')))
    expect(compilerCalls).toHaveLength(3)
    expect(compilerCalls.every(call => call.args.includes('--disable-installer') === (distribution === 'miktex'))).toBe(true)
    const bibliographyCall = scripted.calls.find(call => basename(call.command, '.exe') === bibliography && !call.args.includes('--version'))!
    expect(bibliographyCall.args.includes('--disable-installer')).toBe(distribution === 'miktex' && bibliography === 'bibtex')
    expect(requested).toEqual([])
  })

  it('accepts a configured Unix engine and preserves cancellation', async () => {
    const root = await temporary()
    const bin = await temporary()
    await write(join(bin, 'xelatex'))
    const manager = new ComponentManager(root, () => ({ texBin: bin }), { ...windows(root, {}), platform: 'linux' })
    expect((await manager.status()).find(status => status.id === 'latex')).toMatchObject({ installed: true, engines: ['xelatex'] })
    expect(await manager.latex(signal, 'xelatex')).toBe(bin)
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(manager.latex(cancelled.signal, 'xelatex')).rejects.toThrow()
  })
})

describe('compile completion', () => {
  async function fixture() {
    const root = await temporary()
    const bin = await temporary()
    for (const program of ['pdflatex', 'bibtex', 'biber']) await write(join(bin, `${program}.exe`))
    const components = new ComponentManager(join(root, 'components'), () => ({ texBin: bin }), windows(bin, {}))
    const project = newProject({ root, title: 'Compile outcome', brief: 'Typeset a formula' }, 'test-workspace' as WorkspaceId)
    const artifact = await writeArtifact(project, {
      action: 'save-artifact', projectId: project.id, kind: 'manuscript', path: 'paper/main.tex',
      content: '\\documentclass{article}\\begin{document}Formula $E=mc^2$.\\end{document}',
      evidence: [], claimIds: [], inputArtifacts: [],
    }, 'user', 10000)
    serve({})
    return { root, components, project, artifact }
  }

  it.each([1, 2, 3])('rejects a partial PDF when compiler pass %s exits unsuccessfully', async (failureRound) => {
    const { root, components, project, artifact } = await fixture()
    let rounds = 0
    scripted.answer = async (command, args) => {
      if (args.includes('--version')) return answer(command, args)
      const output = args.find(value => value.startsWith('-output-directory='))!
      const build = resolve(root, 'paper', output.slice('-output-directory='.length))
      await mkdir(build, { recursive: true })
      await writeFile(join(build, 'main.pdf'), '%PDF-1.7\npartial output\n%%EOF\n')
      await writeFile(join(build, 'main.log'), 'A file was written')
      return ++rounds === failureRound
        ? { code: 1, stdout: '', stderr: '! Undefined control sequence.\n' } : { code: 0, stdout: '', stderr: '' }
    }
    const result = await compilePaper(project, artifact, 'pdflatex', components, signal, 10000)
    expect(result.status).toBe('failed')
    expect(rounds).toBe(failureRound)
    expect(result.diagnostics).toContain(`Error: pdflatex pass ${failureRound} failed (exit code 1)`)
    expect(result.diagnostics).toContain('! Undefined control sequence.')
    expect(await readFile(join(root, result.logPath), 'utf8')).toContain('! Undefined control sequence.')
    expect(existsSync(join(root, result.pdfPath))).toBe(true)
  })

  it.each(['bibtex', 'biber'] as const)('rejects the first-pass PDF when %s fails and preserves its diagnostics', async (program) => {
    const { root, components, project, artifact } = await fixture()
    scripted.answer = async (command, args) => {
      if (args.includes('--version')) return basename(command, '.exe') === 'bibtex'
        ? { code: 0, stdout: 'BibTeX 0.99d (TeX Live 2026)', stderr: '' } : answer(command, args)
      if (basename(command, '.exe') === program) return { code: 2, stdout: '', stderr: 'Error: bibliography input unavailable\n' }
      const output = args.find(value => value.startsWith('-output-directory='))!
      const build = resolve(root, 'paper', output.slice('-output-directory='.length))
      await mkdir(build, { recursive: true })
      await writeFile(join(build, 'main.pdf'), '%PDF-1.7\nfirst pass\n%%EOF\n')
      await writeFile(join(build, program === 'bibtex' ? 'main.aux' : 'main.bcf'), program === 'bibtex' ? '\\bibdata{refs}' : 'bcf')
      await writeFile(join(build, 'main.log'), 'First pass completed')
      return { code: 0, stdout: '', stderr: '' }
    }
    const result = await compilePaper(project, artifact, 'pdflatex', components, signal, 10000)
    expect(result.status).toBe('failed')
    expect(scripted.calls.filter(call => call.args.some(arg => arg.startsWith('-output-directory=')))).toHaveLength(1)
    expect(result.diagnostics).toContain(`Error: ${program === 'bibtex' ? 'BibTeX' : 'Biber'} failed (exit code 2)`)
    expect(result.diagnostics).toContain('Error: bibliography input unavailable')
    expect(await readFile(join(root, result.logPath), 'utf8')).toContain('Error: bibliography input unavailable')
  })

  it.each(['', 'not a PDF', '%PDF-1.7'])('rejects empty or invalid PDF output despite successful processes: %j', async (content) => {
    const { root, components, project, artifact } = await fixture()
    scripted.answer = async (command, args) => {
      if (args.includes('--version')) return answer(command, args)
      const output = args.find(value => value.startsWith('-output-directory='))!
      const build = resolve(root, 'paper', output.slice('-output-directory='.length))
      await mkdir(build, { recursive: true })
      await writeFile(join(build, 'main.pdf'), content)
      return { code: 0, stdout: '', stderr: '' }
    }
    const result = await compilePaper(project, artifact, 'pdflatex', components, signal, 10000)
    expect(result.status).toBe('failed')
    expect(result.diagnostics).toContain('Error: Compilation did not produce a valid non-empty PDF')
  })
})

describe('configured and unsupported hosts', () => {
  it.skipIf(process.platform !== 'win32')('copies the real long-base interpreter into a newly created Windows venv', async () => {
    const root = await temporary()
    let base = join(root, 'base')
    while (join(base, 'python.exe').length < 270) base = join(base, 'deep-install-directory')
    await write(join(base, 'python.exe'), 'real interpreter')
    await write(join(base, 'python312.dll'), 'matching runtime')
    const env = join(root, 'venv')
    await write(join(env, 'Scripts/python.exe'), 'redirector')
    await write(join(env, 'pyvenv.cfg'), `home = ${base}\r\ninclude-system-site-packages = false\r\n`)
    await prepareManagedPython(env)
    expect(await readFile(join(env, 'Scripts/python.exe'), 'utf8')).toBe('real interpreter')
    expect(await readFile(join(env, 'Scripts/python312.dll'), 'utf8')).toBe('matching runtime')
    expect(await readFile(join(env, 'pyvenv.cfg'), 'utf8'))
      .toBe(`home = ${win32.toNamespacedPath(base)}\r\ninclude-system-site-packages = false\r\n`)
  })

  it.skipIf(process.platform !== 'win32')('retains a short-base Windows venv redirector and its package isolation', async () => {
    const root = await temporary()
    const base = join(root, 'base')
    await write(join(base, 'python.exe'), 'real interpreter')
    const env = join(root, 'venv')
    await write(join(env, 'Scripts/python.exe'), 'redirector')
    await write(join(env, 'pyvenv.cfg'), `home = ${base}\ninclude-system-site-packages = false\n`)
    await prepareManagedPython(env)
    expect(await readFile(join(env, 'Scripts/python.exe'), 'utf8')).toBe('redirector')
    expect(await readFile(join(env, 'pyvenv.cfg'), 'utf8')).toBe(`home = ${base}\ninclude-system-site-packages = false\n`)
    expect(await readFile(join(env, 'Lib/site-packages/00_scipaper_python_paths.pth'), 'utf8'))
      .toBe('import _scipaper_python_paths\n')
  })

  it('uses tools the user bound, after checking them', async () => {
    const root = await temporary()
    const texBin = join(root, 'tex')
    await write(join(texBin, 'pdflatex.exe'))
    const manager = new ComponentManager(root, () => ({ uv: 'C:/tools/uv.exe', python: 'C:/py/python.exe', texBin }), windows(await temporary(), {}))
    expect(await manager.uv(signal)).toBe('C:/tools/uv.exe')
    expect(await manager.python(signal)).toBe('\\\\?\\C:\\py\\python.exe')
    expect(await manager.latex(signal)).toBe(texBin)
    expect(scripted.calls.map(call => call.command)).toEqual(['C:/tools/uv.exe', '\\\\?\\C:\\py\\python.exe', join(texBin, 'pdflatex.exe')])
    const statuses = await manager.status()
    expect(statuses.filter(status => status.id !== 'latex').every(status => !status.installed)).toBe(true)
    expect(statuses.map(status => status.path)).toEqual(['C:/tools/uv.exe', 'C:/py/python.exe', texBin, ''])
    expect(statuses.find(status => status.id === 'latex')).toMatchObject({ installed: true, source: 'configured', version: 'TeX Live 2026' })
  })

  it.each([
    ['win32', '\\\\server\\share\\python.exe', '\\\\?\\UNC\\server\\share\\python.exe'],
    ['win32', '\\\\?\\C:\\tools\\python.exe', '\\\\?\\C:\\tools\\python.exe'],
    ['win32', 'python', 'python'],
    ['win32', '.\\tools\\python.exe', '.\\tools\\python.exe'],
    ['linux', '/opt/python/bin/python', '/opt/python/bin/python'],
  ] as const)('preserves Python command lookup and configured display on %s: %s', async (platform, python, expected) => {
    const root = await temporary()
    const preferences = { python }
    const manager = new ComponentManager(root, () => preferences, { ...windows(root, {}), platform })
    expect(await manager.python(signal)).toBe(expected)
    expect(scripted.calls[0]?.command).toBe(expected)
    expect((await manager.status()).find(status => status.id === 'python')?.path).toBe(python)
    expect(preferences.python).toBe(python)
  })

  it('asks for bound tools where automatic installation does not reach', async () => {
    const assets = await temporary()
    const linux = new ComponentManager(await temporary(), none, { ...windows(assets, {}), platform: 'linux' })
    await expect(linux.uv(signal)).rejects.toThrow(/targets Windows x64/)
    await expect(linux.latex(signal)).rejects.toThrow(/Configure the TeX binary directory/)
    const arm = new ComponentManager(await temporary(), none, { ...windows(assets, {}), arch: 'arm64' })
    await expect(arm.uv(signal)).rejects.toThrow(/targets Windows x64/)
    const root = await temporary()
    await write(join(root, 'platform-python', 'python'))
    expect((await new ComponentManager(root, none, { ...windows(assets, {}), platform: 'linux' }).status()).find(status => status.id === 'python')?.installed).toBe(true)
    expect(new ComponentManager(root, none, { ...windows(assets, {}), platform: 'linux' }).venvPython('env')).toBe(join('env', 'bin/python'))
  })

  it('knows how each platform runs tlmgr and reads its search output', () => {
    expect(tlmgrCommand(join('tex', 'bin'), 'linux')).toEqual({ command: join('tex', 'bin', 'tlmgr'), args: [] })
    expect(tlmgrCommand(join('TinyTeX', 'bin', 'windows'), 'win32').args[0]).toMatch(/tlmgr\.pl$/)
    expect(packageForFile('booktabs:\n  texmf-dist/tex/latex/booktabs/booktabs.sty\nother:\n  x/other.sty', 'booktabs.sty')).toBe('booktabs')
    expect(packageForFile('  stray/booktabs.sty\n', 'booktabs.sty')).toBeUndefined()
    // Another package's example copy under doc/ loses to the installed file, and is used only when it is all there is.
    const ieee = 'confproc:\n\ttexmf-dist/doc/latex/confproc/example/IEEEtran.bst\nieeetran:\n\ttexmf-dist/bibtex/bst/ieeetran/IEEEtran.bst\n'
    expect(packageForFile(ieee, 'IEEEtran.bst')).toBe('ieeetran')
    expect(packageForFile('confproc:\n\ttexmf-dist/doc/latex/confproc/example/IEEEtran.bst\n', 'IEEEtran.bst')).toBe('confproc')
    expect(runtimeAsset('documents.py')).toMatch(/runtime[\\/]documents\.py$/)
    // What one compile pass reported missing, and whether its package may be guessed from its name.
    expect(missingTexFile('! LaTeX Error: File `acmart.cls\' not found.')).toEqual({ file: 'acmart.cls', guess: true })
    expect(missingTexFile('! Font \\T1/LinBiolinumT-TLF/m/n/10=LinBiolinumT-tlf-t1 at 10.0pt not loadable: Metric (TFM) file not found.'))
      .toEqual({ file: 'LinBiolinumT-tlf-t1.tfm', guess: false })
    expect(missingTexFile('!pdfTeX error: pdflatex.exe (file LinBiolinumT-tlf-t1--base): Font LinBiolinumT-tlf-t1--base at 600 not found'))
      .toEqual({ file: 'LinBiolinumT-tlf-t1--base.tfm', guess: false })
    expect(missingTexFile('./main.tex:27: LaTeX Error: File `example-image-plain\' not found.')).toEqual({ file: 'example-image-plain.pdf', guess: false })
    expect(missingTexFile('! Undefined control sequence.')).toBeUndefined()
    expect(COMPONENT_RELEASES.uv.url).toMatch(/^https:\/\//)
    expect(new ComponentManager('root', none).root).toBe('root')
  })
})
