import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { ProcessResult } from '../src/process.ts'
import type { ResearchPreferences } from '../src/types.ts'
import type { ComponentHost } from '../src/components.ts'

/** Every process the manager starts, answered by the current script. */
const scripted = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[]; env: Record<string, string | undefined> | undefined }[],
  answer: (_command: string, _args: string[]): ProcessResult => ({ code: 0, stdout: '', stderr: '' }),
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

const { COMPONENT_RELEASES, ComponentManager, downloadAsset, packageForFile, runtimeAsset, tlmgrCommand } = await import('../src/components.ts')
type Host = ComponentHost

const signal = new AbortController().signal
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  scripted.calls.length = 0
  scripted.answer = () => ({ code: 0, stdout: '', stderr: '' })
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
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
    expect(python).toBe(join(root, 'platform-python', 'Scripts/python.exe'))
    expect(scripted.calls.some(call => call.args.includes('venv') && call.args.includes('3.12'))).toBe(true)
    expect(await readFile(join(root, 'platform-python', '.research-ready'), 'utf8')).toMatch(/pypdf=6.0.0/)
    // A ready platform Python is reused; one whose environment exists but lacks the marker only gets its packages.
    await write(python)
    expect(await manager.python(signal)).toBe(python)
    await rm(join(root, 'platform-python', '.research-ready'))
    scripted.calls.length = 0
    await manager.python(signal)
    expect(scripted.calls.map(call => call.args[0])).toEqual(['pip'])
    const statuses = await manager.status()
    expect(statuses.map(status => [status.id, status.installed, status.version])).toEqual([
      ['uv', true, 'uv-test'], ['python', true, '3.12'], ['latex', true, 'latex-test'], ['drawio', true, 'drawio-test'],
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
    expect(scripted.calls.find(call => call.args[0] === 'venv')?.args).toContain(join(assets, 'components/python/cpython/python.exe'))
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
    expect(await manager.python(signal)).toBe(join(assets, 'components/platform-python/Scripts/python.exe'))
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
    scripted.answer = (_command, args) => ({ code: 0, stdout: args.includes('search') ? 'tlmgr: package repository https://mirror\nacmart:\n\ttexmf-dist/tex/latex/acmart/acmart.cls\n' : '', stderr: '' })
    await manager.installTexPackage('acmart.cls', signal)
    const install = scripted.calls.find(call => call.args.includes('install'))!
    expect(install.args.at(-1)).toBe('acmart')
    expect(install.command).toBe(join(root, 'latex', 'TinyTeX', 'tlpkg', 'tlperl', 'bin', 'perl.exe'))
    expect(install.env?.PATH?.startsWith(join(root, 'latex', 'TinyTeX', 'bin', 'windows'))).toBe(true)
    scripted.answer = () => ({ code: 0, stdout: '', stderr: '' })
    await manager.installTexPackage('orphan.sty', signal)
    expect(scripted.calls.at(-1)?.args.at(-1)).toBe('orphan')
    await expect(manager.installTexPackage('../../evil.sty', signal)).rejects.toThrow(/Unsupported TeX dependency/)
    await expect(new ComponentManager(root, () => ({ texBin: 'C:/texlive/bin' }), windows(root, {})).installTexPackage('a.sty', signal)).rejects.toThrow(/configured TeX distribution/)
  })
})

describe('configured and unsupported hosts', () => {
  it('uses tools the user bound, after checking them', async () => {
    const root = await temporary()
    const manager = new ComponentManager(root, () => ({ uv: 'C:/tools/uv.exe', python: 'C:/py/python.exe', texBin: 'C:/texlive/bin' }), windows(await temporary(), {}))
    expect(await manager.uv(signal)).toBe('C:/tools/uv.exe')
    expect(await manager.python(signal)).toBe('C:/py/python.exe')
    expect(await manager.latex(signal)).toBe('C:/texlive/bin')
    expect(scripted.calls.map(call => call.command)).toEqual(['C:/tools/uv.exe', 'C:/py/python.exe'])
    const statuses = await manager.status()
    expect(statuses.every(status => !status.installed)).toBe(true)
    expect(statuses.map(status => status.path)).toEqual(['C:/tools/uv.exe', 'C:/py/python.exe', 'C:/texlive/bin', ''])
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
    expect(runtimeAsset('documents.py')).toMatch(/runtime[\\/]documents\.py$/)
    expect(COMPONENT_RELEASES.uv.url).toMatch(/^https:\/\//)
    expect(new ComponentManager('root', none).root).toBe('root')
  })
})
