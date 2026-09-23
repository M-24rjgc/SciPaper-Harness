/** Versioned tool provisioning in product-owned directories. */
import { existsSync, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename } from 'node:fs/promises'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import extract from 'extract-zip'
import { hashFile, atomicWrite } from './files.ts'
import { checked, runProcess } from './process.ts'
import type { ComponentStatus, ResearchPreferences } from './types.ts'

/** One pinned download: what it is, where it comes from, and the checksum it must match. */
export interface ComponentRelease { version: string; url: string; sha256: string }

/** Release assets and checksums verified against the publishers' release manifests. */
export const COMPONENT_RELEASES: Record<'uv' | 'drawio' | 'latex', ComponentRelease> = {
  uv: {
    version: '0.12.15',
    url: 'https://github.com/astral-sh/uv/releases/download/0.12.15/uv-x86_64-pc-windows-msvc.zip',
    sha256: '477bd99a84e34891f2bd4c9152ddeb74e971accccbc59c0f0301f11f08a32d46',
  },
  drawio: {
    version: '31.4.5',
    url: 'https://github.com/jgraph/drawio/releases/download/v31.4.5/draw.war',
    sha256: '6ee1ce19242bbabf348c52e41e1fe17057d57236e731acf48d7a3710ca50c375',
  },
  latex: {
    version: '2026.09',
    url: 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.09/TinyTeX-v2026.09.zip',
    sha256: 'e82d8b78fcf5740639f10ac8518f0c83c9202830e6bba364c70104601c12c6be',
  },
}

/**
 * The platform Python's libraries: documents and page renders (pypdf, python-docx, pypdfium2),
 * plots (matplotlib), SVG figures to vector PDF (svglib, reportlab) and the YAML that mode packs'
 * gates read (PyYAML). The desktop build bundles the same list.
 */
export const PLATFORM_PYTHON_PACKAGES: readonly string[] = [
  'pypdf==6.0.0', 'python-docx==1.2.0', 'matplotlib==3.10.6', 'pypdfium2==4.30.0', 'svglib==2.2.0', 'reportlab==5.0.1',
  'PyYAML==6.0.3',
]
/** The modules that prove the platform Python has those libraries. */
export const PLATFORM_PYTHON_IMPORTS: readonly string[] = ['pypdf', 'docx', 'matplotlib', 'pypdfium2', 'svglib', 'reportlab', 'yaml']
/** What the ready marker holds: the interpreter and the package list it was installed with. */
const PLATFORM_PYTHON_MARKER = `python=3.12\n${PLATFORM_PYTHON_PACKAGES.join('\n')}\n`

/** The host a manager provisions for: its platform, the bundled runtime assets, and the pinned releases. */
export interface ComponentHost {
  platform: NodeJS.Platform
  arch: string
  asset: (name: string) => string
  releases: Record<'uv' | 'drawio' | 'latex', ComponentRelease>
}

/** Resolve an installed package runtime asset from source or bundled JavaScript. */
export function runtimeAsset(name: string): string {
  return fileURLToPath(new URL(`../runtime/${name}`, import.meta.url)).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

/** Download a checksum-pinned asset. Interrupted temporary files never become installed assets. */
export async function downloadAsset(url: string, sha256: string, destination: string, signal: AbortSignal): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  if (existsSync(destination) && await hashFile(destination) === sha256) return
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted()
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]) })
      if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
      const partial = `${destination}.partial`
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
        createWriteStream(partial),
        { signal },
      )
      if (await hashFile(partial) !== sha256) throw new Error('Downloaded component checksum mismatch')
      await rename(partial, destination)
      return
    } catch (error) { last = error; if (signal.aborted) throw error }
  }
  throw last
}

async function findFile(root: string, name: string, depth = 5): Promise<string | undefined> {
  if (!existsSync(root)) return undefined
  if (existsSync(join(root, name))) return join(root, name)
  if (depth <= 0) return undefined
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const found = await findFile(join(root, entry.name), name, depth - 1)
    if (found) return found
  }
  return undefined
}

/** Manages app tooling independently of all experiment environments. */
export class ComponentManager {
  private readonly pending = new Map<string, Promise<string>>()
  constructor(
    readonly root: string,
    private readonly preferences: () => ResearchPreferences,
    private readonly host: ComponentHost = {
      platform: process.platform, arch: process.arch, asset: runtimeAsset, releases: COMPONENT_RELEASES,
    },
  ) {}

  private async once(id: string, work: () => Promise<string>): Promise<string> {
    const running = this.pending.get(id)
    if (running) return running
    const result = work().finally(() => { this.pending.delete(id) })
    this.pending.set(id, result)
    return result
  }

  /** The interpreter inside a virtual environment created on this host. */
  venvPython(directory: string): string {
    return join(directory, this.host.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  }

  /** Describe installed components without downloading or executing them. */
  async status(): Promise<ComponentStatus[]> {
    const preferences = this.preferences()
    const platformPython = this.host.platform === 'win32' ? 'python.exe' : 'python'
    const paths: Record<ComponentStatus['id'], string | undefined> = {
      uv: preferences.uv
        || await findFile(join(this.root, 'uv'), 'uv.exe')
        || await findFile(this.host.asset('components/uv'), 'uv.exe'),
      python: preferences.python
        || await findFile(this.host.asset('components/platform-python'), 'python.exe', 3)
        || await findFile(this.host.asset('components/python'), 'python.exe', 3)
        || await findFile(join(this.root, 'platform-python'), platformPython),
      latex: preferences.texBin || await findFile(join(this.root, 'latex'), 'pdflatex.exe'),
      drawio: await findFile(this.host.asset('components/drawio'), 'index.html', 1)
        || await findFile(join(this.root, 'drawio'), 'index.html', 1),
    }
    return (['uv', 'python', 'latex', 'drawio'] as const).map(id => ({
      id,
      installed: paths[id] !== undefined && existsSync(paths[id]),
      path: paths[id] ?? '',
      version: id === 'python' ? '3.12' : this.host.releases[id].version,
    }))
  }

  /**
   * The platform Python when it is already installed or configured; never
   * installs anything, so a check that needs it stays quick.
   * @returns the interpreter path, or undefined without one.
   */
  async installedPython(): Promise<string | undefined> {
    const python = (await this.status()).find(item => item.id === 'python')
    return python?.installed ? python.path : undefined
  }

  /** Resolve or provision uv without relying on the user's package manager. */
  async uv(signal: AbortSignal): Promise<string> {
    return this.once('uv', async () => {
      const configured = this.preferences().uv
      if (configured) { checked(await runProcess(configured, ['--version'], { signal }), 'uv check'); return configured }
      const existing = await findFile(join(this.root, 'uv'), 'uv.exe') || await findFile(this.host.asset('components/uv'), 'uv.exe')
      if (existing) return existing
      if (this.host.platform !== 'win32' || this.host.arch !== 'x64') {
        throw new Error('Automatic local tool installation currently targets Windows x64; bind an existing uv executable on this platform')
      }
      const release = this.host.releases.uv
      const archive = join(this.root, 'downloads', `uv-${release.version}.zip`)
      await downloadAsset(release.url, release.sha256, archive, signal)
      await extract(archive, { dir: resolve(this.root, 'uv') })
      const binary = await findFile(join(this.root, 'uv'), 'uv.exe')
      if (!binary) throw new Error('uv archive did not contain its executable')
      checked(await runProcess(binary, ['--version'], { signal }), 'uv verification')
      return binary
    })
  }

  /** Resolve a private platform Python environment with document and plotting dependencies. */
  async python(signal: AbortSignal): Promise<string> {
    return this.once('python', async () => {
      const configured = this.preferences().python
      if (configured) {
        checked(await runProcess(configured, ['-c', `import ${PLATFORM_PYTHON_IMPORTS.join(', ')}; print("ready")`], { signal }), 'Platform Python check')
        return configured
      }
      const bundledPython = await findFile(this.host.asset('components/platform-python'), 'python.exe', 3)
      if (bundledPython) return bundledPython
      const target = join(this.root, 'platform-python')
      const python = this.venvPython(target)
      const marker = join(target, '.research-ready')
      // The marker names the packages installed; a changed list installs again.
      if (existsSync(python) && existsSync(marker) && await readFile(marker, 'utf8') === PLATFORM_PYTHON_MARKER) return python
      const uv = await this.uv(signal)
      const bundled = await findFile(this.host.asset('components/python'), 'python.exe', 3)
      const pythonInstall = join(this.root, 'interpreters')
      if (!existsSync(python)) {
        checked(await runProcess(uv, ['venv', '--python', bundled ?? '3.12', '--managed-python', target], {
          signal, timeoutMs: 600000, env: { UV_PYTHON_INSTALL_DIR: pythonInstall },
        }), 'Platform Python creation')
      }
      checked(await runProcess(uv, ['pip', 'install', '--python', python, ...PLATFORM_PYTHON_PACKAGES], { signal, timeoutMs: 600000 }), 'Research document dependencies')
      await atomicWrite(marker, PLATFORM_PYTHON_MARKER)
      return python
    })
  }

  /** Install the offline draw.io editor and retain its upstream notices. */
  async drawio(signal: AbortSignal): Promise<string> {
    return this.once('drawio', async () => {
      const bundled = this.host.asset('components/drawio')
      if (existsSync(join(bundled, 'index.html'))) return bundled
      const target = join(this.root, 'drawio')
      if (existsSync(join(target, '.complete'))) return target
      const release = this.host.releases.drawio
      const archive = join(this.root, 'downloads', `drawio-${release.version}.war`)
      await downloadAsset(release.url, release.sha256, archive, signal)
      await extract(archive, { dir: resolve(target) })
      if (!existsSync(join(target, 'index.html'))) throw new Error('draw.io component is missing its editor entry')
      await atomicWrite(join(target, '.complete'), release.sha256)
      return target
    })
  }

  /** Install a relocatable TeX Live distribution or use an explicitly bound binary directory. */
  async latex(signal: AbortSignal): Promise<string> {
    return this.once('latex', async () => {
      const configured = this.preferences().texBin
      if (configured) return configured
      const target = join(this.root, 'latex')
      const existing = await findFile(target, 'pdflatex.exe')
      if (existing && existsSync(join(target, '.complete'))) return dirname(existing)
      if (this.host.platform !== 'win32') throw new Error('Configure the TeX binary directory on this platform')
      const release = this.host.releases.latex
      const archive = join(this.root, 'downloads', `tinytex-${release.version}.zip`)
      await downloadAsset(release.url, release.sha256, archive, signal)
      await extract(archive, { dir: resolve(target) })
      const binary = await findFile(target, 'pdflatex.exe')
      if (!binary) throw new Error('TeX Live component is missing pdfLaTeX')
      checked(await runProcess(binary, ['--version'], { signal }), 'TeX Live verification')
      await atomicWrite(join(target, '.complete'), release.sha256)
      return dirname(binary)
    })
  }

  /**
   * Install the TeX package that ships a missing file, into the private distribution only.
   * @param file - the missing file's name.
   * @param signal - cancellation.
   * @param guess - whether a file the distribution does not list may be tried as a package of its own name.
   * @returns whether a package was installed; false when the file is in no known package and may not be guessed.
   */
  async installTexPackage(file: string, signal: AbortSignal, guess: boolean = true): Promise<boolean> {
    if (this.preferences().texBin) {
      throw new Error(`Install ${file} in your configured TeX distribution, or select the managed distribution`)
    }
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(sty|cls|bst|clo|def|fd|tfm|pdf)$/.test(file)) throw new Error('Unsupported TeX dependency name')
    const bin = await this.latex(signal)
    const tlmgr = tlmgrCommand(bin, this.host.platform)
    // tlmgr locates its installation through the first kpsewhich on PATH; another TeX (MiKTeX) must not win.
    const options = { signal, timeoutMs: 600000, env: { PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter) } }
    // The file's package is looked up because many files ship in a package of another name.
    const search = await runProcess(tlmgr.command, [...tlmgr.args, 'search', '--global', '--file', `/${file}`], options)
    const found = packageForFile(search.stdout, file)
    if (found === undefined && !guess) return false
    const packageName = found ?? basename(file).replace(/\.[a-z]+$/, '')
    checked(await runProcess(tlmgr.command, [...tlmgr.args, 'install', packageName], options), `TeX package ${packageName}`)
    return true
  }
}

/**
 * How to run tlmgr without a command shell. On Windows `tlmgr.bat` is a batch
 * file, which Node refuses to spawn directly since 22.19 (EINVAL); TeX Live's
 * bundled Perl runs the underlying script instead.
 * @param bin - the TeX Live binary directory.
 * @param platform - the host platform.
 */
export function tlmgrCommand(bin: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform !== 'win32') return { command: join(bin, 'tlmgr'), args: [] }
  const root = resolve(bin, '..', '..')
  return { command: join(root, 'tlpkg', 'tlperl', 'bin', 'perl.exe'), args: [join(root, 'texmf-dist', 'scripts', 'texlive', 'tlmgr.pl')] }
}

/**
 * Read the package providing a file out of `tlmgr search --file` output, where
 * each package name ends in a colon on its own line and its files follow indented.
 */
export function packageForFile(output: string, file: string): string | undefined {
  let current: string | undefined
  let example: string | undefined
  for (const line of output.split(/\r?\n/)) {
    const header = /^([A-Za-z0-9_.-]+):\s*$/.exec(line)
    if (header) { current = header[1]; continue }
    if (!current || !/^\s/.test(line) || !line.trim().endsWith(`/${file}`)) continue
    // A copy under doc/ is some other package's example (confproc ships an IEEEtran.bst); the installed one wins.
    if (!line.includes('/doc/')) return current
    example ??= current
  }
  return example
}
