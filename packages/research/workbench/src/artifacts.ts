/** Evidence extraction, editable artifact revisions, LaTeX, page rendering and submission export. */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { z } from 'zod'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ComponentManager, runtimeAsset } from './components.ts'
import { atomicWrite, errorText, hashFile, isInside, isMetadataPath, keepRevision, projectPath, protectedDirectories, readText } from './files.ts'
import { bibliographyFiles, findMainManuscript, flattenPaper, graphicReferences, listProjectFiles, paperDigest } from './latex.ts'
import { checked, runProcess } from './process.ts'
import { invalidate, validateLinks } from './project.ts'
import { locatorSchema } from './schema.ts'
import type { ArtifactId, ArtifactRecord, CheckReport, CompileRecord, EvidenceId, EvidenceRecord, ResearchCommand, ResearchProject, VisualReview } from './types.ts'

const SOURCE_EXTENSIONS = ['.pdf', '.docx', '.md', '.tex', '.bib', '.csv', '.json', '.txt', '.log', '.py', '.yaml', '.yml']
/** File types a journal or conference template legitimately ships. */
const TEMPLATE_EXTENSIONS = new Set([
  '.cls', '.sty', '.bst', '.bbx', '.cbx', '.lbx', '.dbx', '.cfg', '.def', '.clo', '.fd', '.ist', '.dtx', '.ins',
  '.tex', '.bib', '.ltx', '.txt', '.md', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg', '.otf', '.ttf', '.pfb', '.tfm', '.map', '.enc', '.vf',
])
const MAX_TEMPLATE_FILES = 400
/** Class, style and bibliography-style files a paper may load from anywhere on its search path. */
const TEX_SUPPORT = /\.(?:cls|sty|bst|bbx|cbx|clo|cfg|def)$/i
/** Top-level directories kept out of TeX's search path. */
const NON_SOURCE_DIRECTORIES = new Set(['.research', 'exports', 'node_modules', '.git', '.venv', 'venv', '__pycache__'])

/**
 * Refuse sources inside credential and key directories, whoever asks. Paths
 * outside the project are otherwise legitimate: the user picked them in the
 * desktop, or approved the agent's request through DSH's approval card.
 */
function assertImportable(source: string): void {
  if (protectedDirectories(resolveDshHome()).some(directory => isInside(directory, source))) {
    throw new Error(`Refusing to import from a credential or key directory: ${source}`)
  }
}

/** Resolve an import source: relative paths are the project's, absolute paths are taken as given. */
function importSource(project: ResearchProject, raw: string): string {
  const source = resolve(isAbsolute(raw) ? raw : join(project.root, raw))
  assertImportable(source)
  if (isInside(project.root, source) && isMetadataPath(relative(project.root, source))) {
    throw new Error('Import from the project files, not the platform metadata directory')
  }
  return source
}

/** Extract a source into immutable evidence, retaining its original location. */
export async function importEvidence(
  project: ResearchProject,
  rawSource: string,
  components: ComponentManager,
  signal: AbortSignal,
  limit: number,
  previous?: EvidenceRecord,
): Promise<EvidenceRecord> {
  const source = importSource(project, rawSource)
  const info = await stat(source)
  if (!info.isFile() || info.size > limit) throw new Error(`Source must be a file smaller than ${limit} bytes`)
  const extension = extname(source).toLowerCase()
  if (!SOURCE_EXTENSIONS.includes(extension)) throw new Error(`Unsupported research source: ${extension}`)
  const sha256 = await hashFile(source)
  if (previous?.sha256 === sha256) return previous
  const id = previous?.id ?? randomUUID() as EvidenceId
  const revision = (previous?.revision ?? 0) + 1
  const path = `.research/sources/${id}/${revision}${extension}`
  const target = await projectPath(project.root, path)
  await keepRevision(source, target)
  const chunks = await extractText(target, components, signal, limit)
  const data = ['.csv', '.json'].includes(extension)
  return {
    id, title: basename(source), kind: 'file', path, originalPath: source, sha256, revision,
    importedAt: new Date().toISOString(), chunks, coverage: data ? 'data' : 'full-text', verified: true, stale: false,
  }
}

/**
 * Extract a snapshot's text with locators a quote can be checked against:
 * pages and paragraphs for documents, keys for data, lines for plain text.
 */
export async function extractText(target: string, components: ComponentManager, signal: AbortSignal, limit: number): Promise<EvidenceRecord['chunks']> {
  let chunks: EvidenceRecord['chunks']
  if (['.pdf', '.docx', '.csv', '.json'].includes(extname(target).toLowerCase())) {
    const python = await components.python(signal)
    const output = checked(await runProcess(python, [runtimeAsset('documents.py'), 'extract', target], { signal, maxBytes: limit }), 'Source extraction')
    chunks = z.array(z.object({ text: z.string(), locator: locatorSchema })).parse(JSON.parse(output))
  } else {
    const lines = (await readText(target, limit)).split(/\r?\n/)
    chunks = []
    for (let i = 0; i < lines.length; i += 40) chunks.push({ text: lines.slice(i, i + 40).join('\n'), locator: { line: i + 1 } })
  }
  if (chunks.reduce((size, chunk) => size + Buffer.byteLength(chunk.text), 0) > limit) {
    throw new Error('Extracted source exceeds the configured text limit')
  }
  return chunks
}

/**
 * Copy journal or conference template files into the project's `template/`
 * directory. Directories are copied recursively with their inner structure;
 * hidden entries, file types a template never ships, and trees beyond the
 * file-count and size ceilings are refused before anything is written.
 */
export async function importTemplate(project: ResearchProject, paths: string[], limit: number): Promise<string[]> {
  const plan: { source: string; name: string }[] = []
  let total = 0
  const accept = async (source: string, name: string): Promise<void> => {
    if (!TEMPLATE_EXTENSIONS.has(extname(name).toLowerCase())) return
    const info = await stat(source)
    if (info.size > limit) throw new Error(`Template file exceeds the ${limit} byte limit: ${source}`)
    total += info.size
    plan.push({ source, name })
    if (plan.length > MAX_TEMPLATE_FILES) throw new Error(`A template holds at most ${MAX_TEMPLATE_FILES} files`)
    if (total > limit * 8) throw new Error('The template exceeds the configured size limit')
  }
  const walk = async (source: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(source, entry.name)
      if (entry.isDirectory()) await walk(full, name)
      else if (entry.isFile()) await accept(full, name)
    }
  }
  for (const raw of paths) {
    const source = importSource(project, raw)
    const info = await stat(source)
    if (info.isDirectory()) await walk(source, '')
    else if (info.isFile()) await accept(source, basename(source))
    else throw new Error(`Template source is neither a file nor a directory: ${source}`)
  }
  const copied: string[] = []
  for (const { source, name } of plan) {
    await atomicWrite(await projectPath(project.root, `template/${name}`), await readFile(source))
    copied.push(`template/${name}`)
  }
  return copied
}

/** Project-relative path of a file inside the project, refusing the metadata directory. */
async function artifactPath(project: ResearchProject, path: string): Promise<{ target: string; normalized: string }> {
  const target = await projectPath(project.root, path)
  const normalized = relative(project.root, target).replaceAll('\\', '/')
  if (isMetadataPath(normalized)) throw new Error('Artifacts belong outside the platform metadata directory')
  return { target, normalized }
}

/**
 * Record the file's current bytes as a new revision when they differ from the
 * registered ones — someone (the user, or the agent through ordinary file
 * tools) edited it outside the research tools. The previous revision stays in
 * `.research/history`, and dependents are marked out of date.
 * @returns true when a new revision was recorded.
 */
export async function adoptExternalEdit(project: ResearchProject, artifact: ArtifactRecord): Promise<boolean> {
  const target = await projectPath(project.root, artifact.path)
  if (!existsSync(target)) return false
  const sha256 = await hashFile(target)
  if (sha256 === artifact.sha256) return false
  const revision = artifact.revision + 1
  await keepRevision(target, await projectPath(project.root, `.research/history/${artifact.id}/${revision}${extname(target)}`))
  Object.assign(artifact, { revision, sha256, updatedAt: new Date().toISOString(), author: 'user', stale: false })
  invalidate(project, { artifactId: artifact.id })
  return true
}

/**
 * Register or save a file. An unregistered or externally edited file is
 * adopted as a revision first, so nothing is lost and nothing dead-ends. A
 * supplied `expectedRevision` protects an editor's unsaved view: a mismatch
 * says which revision is current so the caller can re-read and merge.
 */
export async function writeArtifact(
  project: ResearchProject,
  request: Extract<ResearchCommand, { action: 'save-artifact' | 'register-artifact' }>,
  author: ArtifactRecord['author'],
  limit: number,
): Promise<ArtifactRecord> {
  const { target, normalized } = await artifactPath(project, request.path)
  let previous = project.artifacts.find(a => a.path === normalized)
  validateLinks(project, request.evidence)
  for (const input of request.inputArtifacts) {
    if (!project.artifacts.some(a => a.id === input.id)) throw new Error(`Unknown input artifact: ${input.id}`)
  }
  for (const claimId of request.claimIds) if (!project.claims.some(c => c.id === claimId)) throw new Error(`Unknown claim: ${claimId}`)
  if (request.action === 'save-artifact') {
    if (Buffer.byteLength(request.content) > limit) throw new Error('Artifact text exceeds the configured limit')
    if (previous) await adoptExternalEdit(project, previous)
    else if (existsSync(target)) {
      // An existing unregistered file becomes revision 1 before it is replaced.
      previous = await recordRevision(project, normalized, request.kind, [], [], [], author, target, undefined)
    }
    if (request.expectedRevision !== undefined && request.expectedRevision !== (previous?.revision ?? 0)) {
      throw new Error(`Revision conflict: the file is at revision ${previous?.revision ?? 0}, not ${request.expectedRevision}. Read it again and merge your changes`)
    }
    await atomicWrite(target, request.content)
  } else if (!existsSync(target)) {
    throw new Error(`File not found: ${normalized}`)
  }
  const { kind, evidence, claimIds, inputArtifacts } = request
  if (previous && await hashFile(target) === previous.sha256) {
    Object.assign(previous, { kind, evidence, claimIds, inputArtifacts })
    return previous
  }
  return recordRevision(project, normalized, kind, evidence, claimIds, inputArtifacts, author, target, previous)
}

async function recordRevision(
  project: ResearchProject,
  path: string,
  kind: ArtifactRecord['kind'],
  evidence: ArtifactRecord['evidence'],
  claimIds: string[],
  inputArtifacts: ArtifactRecord['inputArtifacts'],
  author: ArtifactRecord['author'],
  target: string,
  previous: ArtifactRecord | undefined,
): Promise<ArtifactRecord> {
  const id = previous?.id ?? randomUUID() as ArtifactId
  const result: ArtifactRecord = {
    id, path, kind, revision: (previous?.revision ?? 0) + 1, sha256: await hashFile(target),
    evidence, claimIds, inputArtifacts, stale: false, updatedAt: new Date().toISOString(), author,
  }
  await keepRevision(target, await projectPath(project.root, `.research/history/${id}/${result.revision}${extname(target)}`))
  if (previous) invalidate(project, { artifactId: id })
  project.artifacts = [...project.artifacts.filter(a => a.id !== id), result]
  return result
}

/** What to compile: a registered artifact, a path, or (neither) the paper's main file. */
export interface CompileTarget { artifactId?: ArtifactId | undefined; path?: string | undefined }

/** Resolve which manuscript to compile: an artifact, a path (registered on the way), or the paper's main file. */
async function manuscriptFor(project: ResearchProject, target: CompileTarget, limit: number): Promise<ArtifactRecord> {
  if (target.artifactId !== undefined) {
    const artifact = project.artifacts.find(a => a.id === target.artifactId)
    if (!artifact || !artifact.path.endsWith('.tex')) throw new Error('Select a LaTeX manuscript')
    return artifact
  }
  const path = target.path ?? await findMainManuscript(project, limit)
  if (path === undefined) throw new Error('No LaTeX manuscript found; pass the path of the .tex file to compile')
  const { normalized } = await artifactPath(project, path)
  if (!normalized.endsWith('.tex')) throw new Error('Select a LaTeX manuscript')
  const existing = project.artifacts.find(a => a.path === normalized)
  if (existing) return existing
  return writeArtifact(project, { action: 'register-artifact', projectId: project.id, path: normalized, kind: 'manuscript', evidence: [], claimIds: [], inputArtifacts: [] }, 'agent', limit)
}

/**
 * Record what a compile is about to read: the manuscript (registered if it
 * was not) and every edit made outside the research tools. This is the only
 * part of a compile that changes the project record.
 * @returns the manuscript to build.
 */
export async function compileTarget(project: ResearchProject, target: CompileTarget, limit: number): Promise<ArtifactRecord> {
  const artifact = await manuscriptFor(project, target, limit)
  for (const registered of project.artifacts) await adoptExternalEdit(project, registered)
  artifact.kind = 'manuscript'
  return structuredClone(artifact)
}

/** A TeX program in a distribution's binary directory; Windows names carry .exe. */
export function texExecutable(bin: string, name: string, platform: NodeJS.Platform = process.platform): string {
  return join(bin, platform === 'win32' ? `${name}.exe` : name)
}

/** Distinct files a compile may install before it gives up; a venue class such as acmart pulls in several. */
const MAX_TEX_INSTALLS = 12

/**
 * The TeX file one pass reported missing: a style, class or bibliography
 * style; the metric file of a font the distribution lacks; or a graphic a
 * class draws from a TeX package (the LIPIcs placeholder logos). Only the
 * first kind may be guessed to live in a package of its own name; the others
 * are installed only when the distribution names the package that ships them,
 * so a missing figure of the paper's own stays a plain LaTeX error.
 * @param output - the pass's console output.
 * @returns the file name and whether its package may be guessed, or undefined when nothing was missing.
 */
export function missingTexFile(output: string): { file: string; guess: boolean } | undefined {
  const file = /File [`']([^'`]+\.(?:sty|cls|bst|clo|def|fd))['`] not found/.exec(output)?.[1]
  if (file) return { file, guess: true }
  const font = /Font \\[^=\s]+=([A-Za-z0-9_.-]+)(?: at [^ ]+)? not loadable: Metric \(TFM\) file not found/.exec(output)?.[1]
    ?? /\(file ([A-Za-z0-9_.-]+)\): Font \1 at \d+ not found/.exec(output)?.[1]
  if (font) return { file: `${font}.tfm`, guess: false }
  const graphic = /LaTeX Error: File `([A-Za-z0-9_-]+)' not found/.exec(output)?.[1]
  return graphic ? { file: `${graphic}.pdf`, guess: false } : undefined
}

/** TeX search path entries for each top-level source directory, relative to a working directory. */
async function searchPath(project: ResearchProject, from: string): Promise<string> {
  const base = relative(from, project.root).replaceAll('\\', '/') || '.'
  const entries = [`${base}/`]
  for (const entry of await readdir(project.root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && !NON_SOURCE_DIRECTORIES.has(entry.name.toLowerCase())) entries.push(`${base}/${entry.name}//`)
  }
  return `${entries.join(delimiter)}${delimiter}`
}

/**
 * Compile a manuscript and its bibliography in an isolated build directory.
 * The compile succeeded when it produced a PDF; unresolved references and
 * citations are reported in its diagnostics and by the checks. Reads the
 * project and changes nothing in it, so it runs without holding the project.
 */
export async function compilePaper(
  project: ResearchProject,
  artifact: ArtifactRecord,
  engine: CompileRecord['engine'],
  components: ComponentManager,
  signal: AbortSignal,
  limit: number,
): Promise<CompileRecord> {
  const source = await projectPath(project.root, artifact.path)
  const digest = await paperDigest(project.root, await flattenPaper(project.root, artifact.path, limit))
  const build = await projectPath(project.root, `.research/build/${artifact.id}/${artifact.revision}/${digest.slice(0, 16)}`)
  await mkdir(build, { recursive: true })
  const bin = await components.latex(signal)
  // TeX Live's Windows environment conversion rejects some Unicode absolute paths.
  // Keep TeX arguments relative to the working directory; Node still owns absolute paths.
  const bibPath = await searchPath(project, build)
  const env = {
    PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
    TEXINPUTS: `.${delimiter}${await searchPath(project, dirname(source))}`,
    BIBINPUTS: bibPath,
    BSTINPUTS: bibPath,
  }
  const outputDirectory = relative(dirname(source), build).replaceAll('\\', '/')
  const args = ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', `-output-directory=${outputDirectory}`, basename(source)]
  const pdf = join(build, `${basename(source, '.tex')}.pdf`)
  // A PDF left by an earlier compile of the same inputs must not pass for this one.
  await rm(pdf, { force: true })
  let log = ''
  const installed = new Set<string>()
  for (let attempt = 0; attempt <= MAX_TEX_INSTALLS; attempt++) {
    const first = await runProcess(texExecutable(bin, engine), args, { cwd: dirname(source), env, signal, timeoutMs: 180000 })
    log += first.stdout + first.stderr
    if (first.code !== 0) {
      // Only this pass's output: an earlier pass's missing file is installed already.
      const missing = missingTexFile(first.stdout + first.stderr)
      if (missing && !installed.has(missing.file) && attempt < MAX_TEX_INSTALLS) {
        installed.add(missing.file)
        if (await components.installTexPackage(missing.file, signal, missing.guess)) continue
      }
      break
    }
    const stem = basename(source, '.tex')
    const auxPath = join(build, `${stem}.aux`)
    if (existsSync(join(build, `${stem}.bcf`))) {
      const result = await runProcess(texExecutable(bin, 'biber'), [stem], { cwd: build, env, signal, timeoutMs: 180000 })
      log += result.stdout + result.stderr
    } else if (existsSync(auxPath) && (await readFile(auxPath, 'utf8')).includes('\\bibdata')) {
      const bibtex = (): Promise<{ stdout: string; stderr: string }> => runProcess(texExecutable(bin, 'bibtex'), [stem], { cwd: build, env, signal, timeoutMs: 180000 })
      let result = await bibtex()
      // A venue's bibliography style may be one the distribution installs on request.
      const style = /I couldn't open style file ([A-Za-z0-9_-][A-Za-z0-9_.-]*\.bst)/.exec(result.stdout)?.[1]
      if (style && !installed.has(style)) {
        installed.add(style)
        try {
          await components.installTexPackage(style, signal)
          result = await bibtex()
        } catch (error) { log += `\nCould not install ${style}: ${errorText(error)}\n` }
      }
      log += result.stdout + result.stderr
    }
    for (let round = 0; round < 2; round++) {
      const result = await runProcess(texExecutable(bin, engine), args, { cwd: dirname(source), env, signal, timeoutMs: 180000 })
      log += result.stdout + result.stderr
      if (result.code !== 0) break
    }
    break
  }
  const logPath = join(build, 'compile.log')
  await atomicWrite(logPath, log)
  const finalLogPath = join(build, `${basename(source, '.tex')}.log`)
  const finalLog = existsSync(finalLogPath) ? await readText(finalLogPath, 8 * 1024 * 1024) : log
  const diagnostics = finalLog.split(/\r?\n/)
    .filter(line => /(^!|LaTeX Warning|undefined|Overfull|Emergency stop|fatal:|Error:)/i.test(line))
    .slice(0, 100)
  return {
    artifactId: artifact.id, artifactRevision: artifact.revision, inputDigest: digest, engine,
    status: existsSync(pdf) ? 'completed' : 'failed',
    pdfPath: relative(project.root, pdf).replaceAll('\\', '/'),
    logPath: relative(project.root, logPath).replaceAll('\\', '/'),
    diagnostics, createdAt: new Date().toISOString(),
  }
}

/**
 * Render the latest successfully compiled pages to PNG so the main model can
 * look at them with its own image reader. The returned review records the
 * render against the compiled source digest, which is what the `visual` check
 * asks for; the caller stores it.
 */
export async function renderPages(
  project: ResearchProject,
  artifactId: ArtifactId | undefined,
  maxPages: number,
  components: ComponentManager,
  signal: AbortSignal,
): Promise<{ paths: string[]; review: VisualReview }> {
  const compiled = [...project.compilations].reverse().find(c => c.status === 'completed'
    && (artifactId === undefined || c.artifactId === artifactId) && existsSync(join(project.root, c.pdfPath)))
  if (!compiled) throw new Error('Nothing has compiled to a PDF yet; compile first')
  const pdf = await projectPath(project.root, compiled.pdfPath)
  const python = await components.python(signal)
  const destination = await projectPath(project.root, `.research/pages/${compiled.artifactId}/${compiled.inputDigest.slice(0, 16)}`)
  const output = checked(await runProcess(
    python,
    [runtimeAsset('documents.py'), 'render', pdf, '--output', destination, '--max-pages', String(maxPages)],
    { signal, timeoutMs: 180000 },
  ), 'PDF rendering')
  const paths = z.array(z.string()).parse(JSON.parse(output))
  return {
    paths,
    review: {
      artifactId: compiled.artifactId, artifactRevision: compiled.artifactRevision, status: 'rendered', inputDigest: compiled.inputDigest,
      findings: `${paths.length} page(s) rendered for inspection`, createdAt: new Date().toISOString(),
    },
  }
}

/**
 * Export portable paper sources and reproducibility files. Export always
 * runs; the check report travels inside the archive, and the archive is named
 * a submission only when that report is clean.
 */
export async function exportPaper(project: ResearchProject, limit: number, report: CheckReport): Promise<{ path: string; final: boolean }> {
  const files: Record<string, Uint8Array> = {}
  let size = 0
  const add = async (relativePath: string): Promise<void> => {
    const key = relativePath.replaceAll('\\', '/')
    if (key in files) return
    const path = await projectPath(project.root, key)
    if (!existsSync(path)) return
    size += (await stat(path)).size
    if (size > limit * 8) throw new Error('Submission archive exceeds the configured export size limit')
    files[key] = await readFile(path)
  }
  for (const artifact of project.artifacts) await add(artifact.path)
  const main = await findMainManuscript(project, limit)
  const paper = main === undefined ? undefined : await flattenPaper(project.root, main, limit)
  // Registered or not, every source the paper reads travels with it, along with the venue template and style files.
  const read = paper === undefined ? [] : [
    ...paper.files,
    ...await bibliographyFiles(project.root, paper),
    ...(await graphicReferences(project.root, paper)).flatMap(reference => reference.resolved === undefined ? [] : [reference.resolved]),
  ]
  const styles = await listProjectFiles(project.root, path => path.startsWith('template/') || TEX_SUPPORT.test(path), 6)
  for (const file of [...read, ...styles]) await add(file)
  const current = paper === undefined ? undefined : await paperDigest(project.root, paper)
  const compilation = [...project.compilations].reverse()
    .find(c => c.status === 'completed' && c.inputDigest === current && existsSync(join(project.root, c.pdfPath)))
  if (compilation) files['paper.pdf'] = await readFile(await projectPath(project.root, compilation.pdfPath))
  const final = report.clean && compilation !== undefined
  // This manifest is part of the user's reproducibility output, not a development report.
  const manifest = {
    schema: 2, title: project.title, final, mode: project.mode, route: project.route, venue: project.venue,
    artifacts: project.artifacts, claims: project.claims, decisions: project.decisions,
    sources: project.evidence.map(({ chunks: _chunks, originalPath: _original, ...source }) => source),
    experiments: project.experiments, check: report,
  }
  files['research-manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  for (const run of project.experiments.filter(r => r.collected)) {
    const directory = await projectPath(project.root, `.research/runs/${run.id}`)
    for (const name of ['inputs.json', 'metrics.json', 'environment.json']) {
      if (existsSync(join(directory, name))) files[`experiments/${run.id}/${name}`] = await readFile(join(directory, name))
    }
  }
  const path = await projectPath(project.root, `exports/${final ? 'submission' : 'draft'}-${Date.now()}.zip`)
  await atomicWrite(path, zipSync(files, { level: 6 }))
  return { path, final }
}
