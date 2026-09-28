/** Versioned tool provisioning in product-owned directories. */
import { existsSync, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import extract from 'extract-zip'
import { hashFile, atomicWrite } from './files.ts'
import { checked, localExecutable, runProcess } from './process.ts'
import type { CompileRecord, ComponentStatus, ResearchPreferences } from './types.ts'

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

/**
 * Resolve an installed package runtime asset from source or bundled JavaScript.
 * @param name - path relative to the package's runtime directory.
 * @returns absolute path, redirected to the unpacked directory for Electron ASAR builds.
 */
export function runtimeAsset(name: string): string {
  return fileURLToPath(new URL(`../runtime/${name}`, import.meta.url)).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

/**
 * Install an import-path hook in a product-owned interpreter, preserving sitecustomize.
 * @param directory - standalone Python or newly created virtual environment root.
 */
export async function installPythonPathHook(directory: string): Promise<void> {
  const site = join(directory, 'Lib', 'site-packages')
  await mkdir(site, { recursive: true })
  const files = [
    ['_scipaper_python_paths.py', await readFile(runtimeAsset('_scipaper_python_paths.py'), 'utf8')],
    ['00_scipaper_python_paths.pth', 'import _scipaper_python_paths\n'],
  ] as const
  for (const [name, content] of files) {
    const target = join(site, name)
    if (existsSync(target)) {
      if (await readFile(target, 'utf8') !== content) throw new Error(`Research Python bootstrap conflicts with ${target}`)
    } else {
      await writeFile(target, content, { flag: 'wx' })
    }
  }
}

/**
 * Prepare a newly created, product-owned Windows venv for native imports from a deep base installation.
 * @param directory - the environment just created by the product; never an adopted environment.
 * @param platform - operating system owning the environment.
 */
export async function prepareManagedPython(directory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== 'win32') return
  await installPythonPathHook(directory)
  const configPath = join(directory, 'pyvenv.cfg')
  if (!existsSync(configPath)) return
  const config = await readFile(configPath, 'utf8')
  const home = /^home\s*=\s*([^\r\n]+)$/m.exec(config)?.[1]?.trim()
  if (home === undefined || !win32.isAbsolute(home)) return
  const base = localExecutable(home, platform)
  const ordinary = base.slice(0, 8).toUpperCase() === '\\\\?\\UNC\\' ? `\\\\${base.slice(8)}` : base.slice(4)
  // The Windows venv redirector cannot launch a base executable beyond MAX_PATH.
  if (win32.join(ordinary, 'python.exe').length >= 260) {
    const scripts = join(directory, 'Scripts')
    for (const name of await readdir(base)) {
      const lower = name.toLowerCase()
      if (lower === 'python.exe' || lower === 'pythonw.exe' || lower.endsWith('.dll')) {
        await copyFile(join(base, name), join(scripts, name))
      }
    }
    const normalized = config.replace(/^home\s*=\s*[^\r\n]+/m, () => `home = ${base}`)
    if (normalized !== config) await atomicWrite(configPath, normalized)
  }
}

/**
 * Download a checksum-pinned asset. Interrupted temporary files never become installed assets.
 * @param url - upstream download URL.
 * @param sha256 - expected hexadecimal SHA-256 digest.
 * @param destination - installed asset path; matching existing content is reused.
 * @param signal - cancellation shared by downloads and retries.
 */
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

const TEX_ENGINES = ['pdflatex', 'xelatex', 'lualatex'] as const

interface TexInstallation {
  status: ComponentStatus
  miktexEngines: CompileRecord['engine'][]
}

/** One selected compilation runtime; bibliography arguments are resolved only when used. */
export interface LatexRuntime {
  bin: string
  compilerArgs: readonly string[]
  /** Prefix arguments for a bibliography program from this same distribution. */
  bibliographyArgs: (program: 'bibtex' | 'biber') => Promise<readonly string[]>
}

/** Read the distribution label from a successful engine's own version output. */
function texVersion(output: string, engine: CompileRecord['engine']): { label: string; miktex: boolean } | undefined {
  const banner = output.split(/\r?\n/).find(line => line.trim()) ?? ''
  const names = { pdflatex: /\bpdfTeX\b/i, xelatex: /\bXeTeX\b/i, lualatex: /\bLua(?:HB)?TeX\b/i }
  if (!names[engine].test(banner)) return undefined
  const miktex = /\bMiKTeX\s+(\d[\w.-]*)/i.exec(banner)
  if (miktex) return { label: `MiKTeX ${miktex[1]}`, miktex: true }
  const texlive = /\bTeX Live\s+(\d{4})\b/i.exec(banner)
  if (texlive) return { label: `TeX Live ${texlive[1]}`, miktex: false }
  const version = /\b(pdfTeX|XeTeX|Lua(?:HB)?TeX)[ ,]+(?:Version\s+)?(\d[\w.-]*)/i.exec(banner)
  return version ? { label: `${version[1]} ${version[2]}`, miktex: false } : undefined
}

/** Manages app tooling independently of all experiment environments. */
export class ComponentManager {
  private readonly pending = new Map<string, Promise<string>>()
  private readonly pendingTex = new Map<string | undefined, Promise<TexInstallation>>()
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

  /**
   * The interpreter inside a virtual environment created on this host.
   * @param directory - virtual environment root.
   * @returns interpreter path using the host platform's environment layout.
   */
  venvPython(directory: string): string {
    return join(directory, this.host.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  }

  private pythonCommand(python: string): string {
    return localExecutable(python, this.host.platform)
  }

  private async pythonPath(): Promise<string | undefined> {
    return this.preferences().python
      || await findFile(this.host.asset('components/platform-python'), 'python.exe', 3)
      || await findFile(this.host.asset('components/python'), 'python.exe', 3)
      || await findFile(join(this.root, 'platform-python'), this.host.platform === 'win32' ? 'python.exe' : 'python')
  }

  private texExecutable(bin: string, engine: CompileRecord['engine'] | 'bibtex' | 'biber'): string {
    return join(bin, `${engine}${this.host.platform === 'win32' ? '.exe' : ''}`)
  }

  private async probeTex(
    bin: string, source: NonNullable<ComponentStatus['source']>, signal?: AbortSignal,
  ): Promise<TexInstallation> {
    signal?.throwIfAborted()
    const detected = await Promise.all(TEX_ENGINES.map(async (engine) => {
      const executable = this.texExecutable(bin, engine)
      let info: Awaited<ReturnType<typeof stat>>
      try { info = await stat(executable) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined
        return { engine, version: undefined }
      }
      if (!info.isFile()) return { engine, version: undefined }
      let version: ReturnType<typeof texVersion>
      try {
        const result = await runProcess(executable, ['--version'], { signal, timeoutMs: 5000, maxBytes: 65536 })
        if (result.code === 0) version = texVersion(result.stdout, engine)
      } catch (error) {
        // Failed process probes are unavailable tools; cancellation remains an operation failure.
        signal?.throwIfAborted()
        if (error instanceof Error && error.name === 'AbortError') throw error
      }
      if (!version) return { engine, version: undefined }
      return { engine, version }
    }))
    const usable = detected.flatMap(value => value?.version ? [{ engine: value.engine, version: value.version }] : [])
    const present = detected.some(value => value !== undefined)
    return { status: {
      id: 'latex', installed: usable.length > 0, path: bin, version: usable[0]?.version.label ?? '', source,
      engines: usable.map(value => value.engine),
      ...usable.length > 0 ? {} : { problem: present ? 'invalid-executable' : 'missing-executable' },
    }, miktexEngines: usable.filter(value => value.version.miktex).map(value => value.engine) }
  }

  private async detectedTex(signal?: AbortSignal): Promise<TexInstallation> {
    const configured = this.preferences().texBin
    if (configured) return this.probeTex(configured, 'configured', signal)
    const managedRoot = join(this.root, 'latex')
    let unavailable: TexInstallation | undefined
    if (existsSync(join(managedRoot, '.complete'))) {
      for (const engine of TEX_ENGINES) {
        const executable = await findFile(managedRoot, `${engine}${this.host.platform === 'win32' ? '.exe' : ''}`)
        if (!executable) continue
        const managed = await this.probeTex(dirname(executable), 'managed', signal)
        if (managed.status.installed) return managed
        unavailable = managed
        break
      }
    }
    const separator = this.host.platform === 'win32' ? ';' : ':'
    const directories = new Set((process.env.PATH ?? '').split(separator).filter(Boolean).map(value => resolve(value.replace(/^"|"$/g, ''))))
    for (const bin of directories) {
      if (!TEX_ENGINES.some(engine => existsSync(this.texExecutable(bin, engine)))) continue
      const system = await this.probeTex(bin, 'system', signal)
      if (system.status.installed) return system
      unavailable ??= system
    }
    return unavailable ?? { status: { id: 'latex', installed: false, path: '', version: '', engines: [] }, miktexEngines: [] }
  }

  /**
   * Describe available components without downloading; TeX engines are verified with bounded version commands.
   * @returns component paths and versions, including the selected TeX distribution's source and available engines.
   */
  async status(): Promise<ComponentStatus[]> {
    const preferences = this.preferences()
    const paths: Record<ComponentStatus['id'], string | undefined> = {
      uv: preferences.uv
        || await findFile(join(this.root, 'uv'), 'uv.exe')
        || await findFile(this.host.asset('components/uv'), 'uv.exe'),
      python: await this.pythonPath(),
      latex: undefined,
      drawio: await findFile(this.host.asset('components/drawio'), 'index.html', 1)
        || await findFile(join(this.root, 'drawio'), 'index.html', 1),
    }
    const latex = (await this.detectedTex()).status
    return (['uv', 'python', 'latex', 'drawio'] as const).map(id => id === 'latex' ? latex : ({
      id,
      installed: paths[id] !== undefined && existsSync(paths[id]),
      path: paths[id] ?? '',
      version: id === 'python' ? '3.12' : this.host.releases[id].version,
    }))
  }

  /**
   * The platform Python when it is already installed or configured; never
   * installs anything, so a check that needs it stays quick.
   * @returns the interpreter command, with Windows absolute paths in extended-length form, or undefined without one.
   */
  async installedPython(): Promise<string | undefined> {
    const python = await this.pythonPath()
    return python && existsSync(python) ? this.pythonCommand(python) : undefined
  }

  /**
   * Resolve or provision uv without relying on the user's package manager.
   * @param signal - cancellation for verification and downloads.
   * @returns executable path; automatic installation rejects unsupported hosts.
   */
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

  /**
   * Resolve a private platform Python environment with document and plotting dependencies.
   * @param signal - cancellation for interpreter and dependency preparation.
   * @returns configured, bundled or privately provisioned command, with Windows absolute paths in extended-length form.
   */
  async python(signal: AbortSignal): Promise<string> {
    return this.once('python', async () => {
      const preference = this.preferences().python
      const configured = preference === undefined ? undefined : this.pythonCommand(preference)
      if (configured) {
        checked(await runProcess(configured, ['-c', `import ${PLATFORM_PYTHON_IMPORTS.join(', ')}; print("ready")`], { signal }), 'Platform Python check')
        return configured
      }
      const bundledPython = await findFile(this.host.asset('components/platform-python'), 'python.exe', 3)
      if (bundledPython) return this.pythonCommand(bundledPython)
      const target = join(this.root, 'platform-python')
      const python = this.venvPython(target)
      const marker = join(target, '.research-ready')
      // The marker names the packages installed; a changed list installs again.
      if (existsSync(python) && existsSync(marker) && await readFile(marker, 'utf8') === PLATFORM_PYTHON_MARKER) return this.pythonCommand(python)
      const uv = await this.uv(signal)
      const bundled = await findFile(this.host.asset('components/python'), 'python.exe', 3)
      const pythonInstall = join(this.root, 'interpreters')
      if (!existsSync(python)) {
        checked(await runProcess(uv, ['venv', '--python', bundled === undefined ? '3.12' : localExecutable(bundled, this.host.platform), '--managed-python', target], {
          signal, timeoutMs: 600000, env: { UV_PYTHON_INSTALL_DIR: pythonInstall },
        }), 'Platform Python creation')
        await prepareManagedPython(target, this.host.platform)
      }
      checked(await runProcess(uv, ['pip', 'install', '--python', python, ...PLATFORM_PYTHON_PACKAGES], { signal, timeoutMs: 600000 }), 'Research document dependencies')
      await atomicWrite(marker, PLATFORM_PYTHON_MARKER)
      return this.pythonCommand(python)
    })
  }

  /**
   * Install the offline draw.io editor and retain its upstream notices.
   * @param signal - cancellation for the editor download.
   * @returns directory containing the bundled or installed editor entry page.
   */
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

  /**
   * Use the configured, managed or system TeX distribution, installing private TeX only when none is usable.
   * @param signal - cancellation for distribution download and verification.
   * @param engine - compiler required by this operation; absence does not switch distributions or trigger a download.
   * @returns verified TeX binary directory; unusable explicit bindings are rejected.
   */
  async latex(signal: AbortSignal, engine?: CompileRecord['engine']): Promise<string> {
    const selected = await this.selectedTex(signal)
    if (engine) this.requireTexEngine(selected, engine)
    return selected.status.path
  }

  private async selectedTex(signal: AbortSignal): Promise<TexInstallation> {
    signal.throwIfAborted()
    const configured = this.preferences().texBin
    let pending = this.pendingTex.get(configured)
    if (!pending) {
      pending = this.resolveTex(signal).finally(() => { this.pendingTex.delete(configured) })
      this.pendingTex.set(configured, pending)
    }
    let selected: TexInstallation
    try { selected = await pending } catch (error) {
      signal.throwIfAborted()
      if (this.preferences().texBin !== configured) return this.selectedTex(signal)
      throw error
    }
    signal.throwIfAborted()
    if (this.preferences().texBin !== configured) return this.selectedTex(signal)
    return selected
  }

  private requireTexEngine(selected: TexInstallation, engine: CompileRecord['engine']): void {
    if (!selected.status.engines?.includes(engine)) {
      throw new Error(`Selected TeX distribution does not provide a usable ${engine}: ${selected.status.path}`)
    }
  }

  private async resolveTex(signal: AbortSignal): Promise<TexInstallation> {
    const selected = await this.detectedTex(signal)
    if (selected.status.installed) return selected
    if (selected.status.source === 'configured') throw new Error(`Configured TeX directory has no usable compiler: ${selected.status.path}`)
    const target = join(this.root, 'latex')
    if (this.host.platform !== 'win32') throw new Error('Configure the TeX binary directory on this platform')
    const release = this.host.releases.latex
    const archive = join(this.root, 'downloads', `tinytex-${release.version}.zip`)
    await downloadAsset(release.url, release.sha256, archive, signal)
    await extract(archive, { dir: resolve(target) })
    const binary = await findFile(target, 'pdflatex.exe')
    if (!binary) throw new Error('TeX Live component is missing pdfLaTeX')
    const verified = await this.probeTex(dirname(binary), 'managed', signal)
    if (!verified.status.installed) throw new Error('TeX Live component has no usable compiler')
    await atomicWrite(join(target, '.complete'), release.sha256)
    return verified
  }

  /**
   * Select and verify a compiler, disabling implicit package installation for external MiKTeX programs.
   * @param signal - cancellation for selection, provisioning and bibliography verification.
   * @param engine - the requested compiler; a missing engine rejects without switching distributions.
   * @returns one binary directory and supported argument prefixes; no bibliography process runs until requested.
   */
  async latexRuntime(signal: AbortSignal, engine: CompileRecord['engine']): Promise<LatexRuntime> {
    const selected = await this.selectedTex(signal)
    this.requireTexEngine(selected, engine)
    const bin = selected.status.path
    const external = selected.status.source === 'configured' || selected.status.source === 'system'
    let bibliography: Promise<readonly string[]> | undefined
    return {
      bin, compilerArgs: external && selected.miktexEngines.includes(engine) ? ['--disable-installer'] : [],
      bibliographyArgs: (program) => {
        // Biber is a Perl application; it has no MiKTeX installer switch.
        if (!external || program === 'biber') return Promise.resolve([])
        bibliography ??= runProcess(this.texExecutable(bin, 'bibtex'), ['--version'], { signal, timeoutMs: 5000, maxBytes: 65536 })
          .then((result) => {
            const output = checked(result, 'BibTeX verification')
            if (!/\bBibTeX\b/i.test(output)) throw new Error('Selected bibliography program did not report a usable BibTeX')
            return /^MiKTeX-BibTeX\b.*\bMiKTeX\s+\d/m.test(output) ? ['--disable-installer'] : []
          })
        return bibliography
      },
    }
  }

  /**
   * Install the TeX package that ships a missing file, into the private distribution only.
   * @param file - the missing file's name.
   * @param signal - cancellation.
   * @param guess - whether a file the distribution does not list may be tried as a package of its own name.
   * @returns whether a package was installed; false when the file is in no known package and may not be guessed.
   */
  async installTexPackage(file: string, signal: AbortSignal, guess: boolean = true): Promise<boolean> {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(sty|cls|bst|clo|def|fd|tfm|pdf)$/.test(file)) throw new Error('Unsupported TeX dependency name')
    const selected = (await this.detectedTex(signal)).status
    if (selected.source === 'configured' || selected.source === 'system') {
      throw new Error(`Install ${file} in your ${selected.source === 'configured' ? 'configured' : 'system'} TeX distribution, or select the managed distribution`)
    }
    const bin = await this.latex(signal)
    const current = (await this.detectedTex(signal)).status
    if (current.source !== 'managed' || current.path !== bin) throw new Error('TeX package installation requires the selected managed distribution')
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
 * @returns executable and argument prefix to prepend to the requested tlmgr arguments.
 */
export function tlmgrCommand(bin: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform !== 'win32') return { command: join(bin, 'tlmgr'), args: [] }
  const root = resolve(bin, '..', '..')
  return { command: join(root, 'tlpkg', 'tlperl', 'bin', 'perl.exe'), args: [join(root, 'texmf-dist', 'scripts', 'texlive', 'tlmgr.pl')] }
}

/**
 * Read the package providing a file out of `tlmgr search --file` output, where
 * each package name ends in a colon on its own line and its files follow indented.
 * @param output - stdout from tlmgr's global file search.
 * @param file - exact missing filename to locate.
 * @returns matching package, preferring a non-documentation copy, or undefined without a match.
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
