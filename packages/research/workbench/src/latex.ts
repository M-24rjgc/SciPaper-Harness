/** Read-only structure of a LaTeX paper as it exists on disk, shared by compilation and checks. */
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { extname, join, posix, relative } from 'node:path'
import { hashBytes, hashFile, isMetadataPath, projectPath, readText } from './files.ts'
import type { ResearchProject } from './types.ts'

/** Directories never searched for paper sources: service metadata, exports, dependencies and VCS data. */
const SKIPPED_DIRECTORIES = new Set(['.research', 'exports', 'node_modules', '.git', '.venv', 'venv', '__pycache__'])
const GRAPHIC_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg']

/** Where one line of the flattened paper came from. */
export interface SourceOrigin { file: string; line: number }

/** The main file with every `\input`/`\include` expanded, comments removed, line origins kept. */
export interface FlatPaper {
  main: string
  text: string
  origins: SourceOrigin[]
  files: string[]
  missingInputs: { name: string; origin: SourceOrigin }[]
}

/** Remove LaTeX comments from one line, keeping escaped percent signs. */
export function stripComment(line: string): string {
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== '%') continue
    let slashes = 0
    for (let back = index - 1; back >= 0 && line[back] === '\\'; back--) slashes++
    if (slashes % 2 === 0) return line.slice(0, index)
  }
  return line
}

/** Project-relative path with forward slashes. */
export function toProjectPath(root: string, absolute: string): string {
  return relative(root, absolute).replaceAll('\\', '/')
}

/**
 * List project files for discovery, skipping metadata, exports and dependency
 * directories. Depth-bounded so a stray dataset tree cannot stall a check.
 * @param root - canonical project root.
 * @param accept - predicate over the project-relative path.
 * @param depth - directory levels below the root to visit.
 */
export async function listProjectFiles(root: string, accept: (path: string) => boolean, depth = 4): Promise<string[]> {
  const found: string[] = []
  const walk = async (directory: string, level: number): Promise<void> => {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      const rel = toProjectPath(root, full)
      if (entry.isDirectory()) {
        if (level < depth && !SKIPPED_DIRECTORIES.has(entry.name.toLowerCase()) && !entry.name.startsWith('.')) await walk(full, level + 1)
      } else if (entry.isFile() && accept(rel)) {
        found.push(rel)
      }
    }
  }
  await walk(root, 0)
  return found.sort()
}

/**
 * Choose the paper's main file: the most recently updated registered
 * manuscript that declares `\documentclass`, else a discovered one, preferring
 * `paper/main.tex` and then the shortest path. Unregistered files count, so an
 * agent writing with ordinary file tools is checked like one that registers.
 * @param project - project whose root is searched.
 * @param limit - byte ceiling for any one source read.
 * @returns the project-relative main file, or undefined without one.
 */
export async function findMainManuscript(project: ResearchProject, limit: number): Promise<string | undefined> {
  const declares = async (path: string): Promise<boolean> => {
    try {
      return /\\documentclass\b/.test(await readText(await projectPath(project.root, path), limit))
    } catch { return false }
  }
  const registered = project.artifacts
    .filter(artifact => artifact.kind === 'manuscript' && artifact.path.endsWith('.tex'))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  for (const artifact of registered) if (await declares(artifact.path)) return artifact.path
  const candidates = await listProjectFiles(project.root, path => path.endsWith('.tex') && !path.startsWith('template/'))
  candidates.sort((a, b) => Number(b === 'paper/main.tex') - Number(a === 'paper/main.tex') || a.length - b.length || a.localeCompare(b))
  for (const candidate of candidates) if (await declares(candidate)) return candidate
  return undefined
}

const INPUT = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g

/**
 * Expand the main file's inputs in place. Inputs resolve against the main
 * file's directory, as TeX does, then against the including file. A missing
 * input is recorded rather than thrown so the check can report it.
 * @param root - canonical project root.
 * @param main - project-relative main file.
 * @param limit - byte ceiling for each file and four times it in total.
 */
export async function flattenPaper(root: string, main: string, limit: number): Promise<FlatPaper> {
  const lines: string[] = []
  const origins: SourceOrigin[] = []
  const files: string[] = []
  const missingInputs: FlatPaper['missingInputs'] = []
  const mainDirectory = posix.dirname(main)
  let total = 0
  // As TeX does: a name with its own suffix is tried as given and then with .tex (build/intro.proc is build/intro.proc.tex).
  const resolveInput = (name: string, from: string): string | undefined => {
    const spellings = !extname(name) ? [`${name}.tex`] : extname(name) === '.tex' ? [name] : [name, `${name}.tex`]
    for (const base of [mainDirectory, posix.dirname(from)]) {
      for (const spelling of spellings) {
        const candidate = posix.normalize(posix.join(base, spelling))
        if (!candidate.startsWith('../') && !isMetadataPath(candidate) && existsSync(join(root, candidate))) return candidate
      }
    }
    return undefined
  }
  const expand = async (file: string, stack: string[]): Promise<void> => {
    const text = await readText(await projectPath(root, file), limit)
    total += text.length
    if (total > limit * 4) throw new Error('The manuscript and its inputs exceed the configured text limit')
    files.push(file)
    const source = text.split(/\r?\n/)
    for (const [index, raw] of source.entries()) {
      const line = stripComment(raw)
      const origin = { file, line: index + 1 }
      let cursor = 0
      for (const match of line.matchAll(INPUT)) {
        const name = String(match[1]).trim()
        const target = resolveInput(name, file)
        if (target === undefined || stack.includes(target) || stack.length > 10) {
          if (target === undefined) missingInputs.push({ name, origin })
          continue
        }
        lines.push(line.slice(cursor, match.index)); origins.push(origin)
        await expand(target, [...stack, target])
        cursor = match.index + match[0].length
      }
      lines.push(line.slice(cursor)); origins.push(origin)
    }
  }
  await expand(main, [main])
  return { main, text: lines.join('\n'), origins, files, missingInputs }
}

/** Origin of a character offset in a flattened paper. */
export function originAt(paper: FlatPaper, offset: number): SourceOrigin {
  let line = 0
  for (let index = 0; index < offset && index < paper.text.length; index++) if (paper.text[index] === '\n') line++
  return paper.origins[line] ?? { file: paper.main, line: 1 }
}

/**
 * Bibliography files named by `\bibliography`/`\addbibresource`, resolved
 * beside the main file and then, as BibTeX's search path allows, anywhere
 * under the project's source directories.
 */
export async function bibliographyFiles(root: string, paper: FlatPaper): Promise<string[]> {
  const names: string[] = []
  // Every pattern's first group is mandatory, so it is always a string when the pattern matches.
  for (const match of paper.text.matchAll(/\\bibliography\s*\{([^}]+)\}/g)) names.push(...String(match[1]).split(','))
  for (const match of paper.text.matchAll(/\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) names.push(String(match[1]))
  let searchable: Promise<string[]> | undefined
  const elsewhere = async (name: string): Promise<string | undefined> => {
    searchable ??= listProjectFiles(root, path => path.endsWith('.bib'), 6)
    return (await searchable).find(path => path === name || path.endsWith(`/${name}`))
  }
  const wanted = names.map(name => name.trim()).filter(Boolean)
    .map(name => posix.normalize(name.endsWith('.bib') ? name : `${name}.bib`))
    .filter(name => !name.startsWith('../'))
  const resolved = await Promise.all(wanted.map(async (name) => {
    const beside = posix.normalize(posix.join(posix.dirname(paper.main), name))
    return existsSync(join(root, beside)) ? beside : elsewhere(name)
  }))
  return [...new Set(resolved.filter((path): path is string => path !== undefined))]
}

/** One `\includegraphics` target and where it was referenced. */
export interface GraphicReference { name: string; resolved?: string | undefined; offset: number }

/**
 * Resolve every graphic the paper includes the way the compile will: against
 * the main directory and `\graphicspath` first, then anywhere under the
 * project's source directories, which the compile puts on TeX's search path.
 */
export async function graphicReferences(root: string, paper: FlatPaper): Promise<GraphicReference[]> {
  const base = posix.dirname(paper.main)
  const searchDirectories = [base]
  for (const match of paper.text.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/g)) {
    for (const directory of String(match[1]).matchAll(/\{([^}]*)\}/g)) searchDirectories.push(posix.join(base, String(directory[1])))
  }
  let searchable: string[] | undefined
  const references: GraphicReference[] = []
  for (const match of paper.text.matchAll(/\\(?:includegraphics|includesvg)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    const name = String(match[1]).trim()
    const spellings = (stem: string): string[] => extname(name) ? [stem] : GRAPHIC_EXTENSIONS.map(extension => `${stem}${extension}`)
    let resolved: string | undefined
    for (const directory of searchDirectories) {
      const stem = posix.normalize(posix.join(directory, name))
      if (stem.startsWith('../') || isMetadataPath(stem)) continue
      resolved = spellings(stem).find(candidate => existsSync(join(root, candidate)))
      if (resolved) break
    }
    if (!resolved && !posix.normalize(name).startsWith('../')) {
      searchable ??= await listProjectFiles(root, path => GRAPHIC_EXTENSIONS.includes(extname(path).toLowerCase()), 6)
      const wanted = spellings(posix.normalize(name))
      resolved = searchable.find(path => wanted.some(candidate => path.endsWith(`/${candidate}`)))
    }
    references.push({ name, resolved, offset: match.index })
  }
  return references
}

/** A heading and the text range it governs. */
export interface Section { title: string; start: number; end: number }

/** Top-level sections (`\section`/`\chapter`) with the offsets each one spans. */
export function sections(paper: FlatPaper): Section[] {
  const headings = [...paper.text.matchAll(/\\(?:section|chapter)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)]
  return headings.map((match, index) => ({
    title: String(match[1]).trim(),
    start: match.index,
    end: headings[index + 1]?.index ?? paper.text.length,
  }))
}

/**
 * Digest of every file the compiled paper depends on: the main file, its
 * inputs, bibliographies and included graphics. A compile is current exactly
 * when this digest matches the one recorded with it.
 */
export async function paperDigest(root: string, paper: FlatPaper): Promise<string> {
  const graphics = (await graphicReferences(root, paper)).flatMap(ref => ref.resolved ? [ref.resolved] : [])
  const files = [...paper.files, ...await bibliographyFiles(root, paper), ...graphics]
  const entries: string[][] = []
  for (const file of [...new Set(files)].sort()) entries.push([file, await hashFile(join(root, file))])
  return hashBytes(JSON.stringify(entries))
}

/** Latest modification time across the paper's own sources, in epoch milliseconds. */
export async function paperModifiedAt(root: string, paper: FlatPaper): Promise<number> {
  let latest = 0
  for (const file of paper.files) latest = Math.max(latest, (await stat(join(root, file))).mtimeMs)
  return latest
}

/** Parsed BibTeX entry: key, type, which fields are present and the identifiers used for verification. */
export interface BibEntry {
  key: string
  type: string
  fields: Set<string>
  doi?: string | undefined
  eprint?: string | undefined
  raw: string
  file: string
  line: number
}

/** Parse BibTeX entries by brace matching; `@string`, `@comment` and `@preamble` are skipped. */
export function parseBibliography(text: string, file: string): BibEntry[] {
  const entries: BibEntry[] = []
  const start = /@([A-Za-z]+)\s*[{(]/g
  let match: RegExpExecArray | null
  while ((match = start.exec(text)) !== null) {
    const type = String(match[1]).toLowerCase()
    let depth = 1
    let index = start.lastIndex
    while (index < text.length && depth > 0) {
      const character = text[index]
      if (character === '{' || character === '(') depth++
      else if (character === '}' || character === ')') depth--
      index++
    }
    const body = text.slice(start.lastIndex, index - 1)
    start.lastIndex = index
    if (['string', 'comment', 'preamble'].includes(type)) continue
    const key = /^\s*([^,\s]+)\s*,/.exec(body)?.[1]
    if (!key) continue
    const fields = new Set([...body.matchAll(/(?:^|,)\s*([A-Za-z_-]+)\s*=/g)].map(field => String(field[1]).toLowerCase()))
    const value = (name: string): string | undefined => new RegExp(`\\b${name}\\s*=\\s*[{"]([^}"]+)`, 'i').exec(body)?.[1]?.trim()
    entries.push({
      key, type, fields, doi: value('doi')?.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, ''), eprint: value('eprint'),
      raw: text.slice(match.index, index), file, line: text.slice(0, match.index).split('\n').length,
    })
  }
  return entries
}

/** Every citation key with the offset of the command that cites it. */
export function citations(paper: FlatPaper): { key: string; offset: number }[] {
  const found: { key: string; offset: number }[] = []
  const command = /\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}/g
  for (const match of paper.text.matchAll(command)) {
    for (const key of String(match[1]).split(',').map(item => item.trim()).filter(item => item && item !== '*')) {
      found.push({ key, offset: match.index })
    }
  }
  return found
}

/** Declared document class, used to tell a venue template from the generic classes. */
export function documentClass(paper: FlatPaper): string | undefined {
  return /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(paper.text)?.[1]?.trim()
}
