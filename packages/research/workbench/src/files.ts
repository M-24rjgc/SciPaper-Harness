/** Contained file access and immutable revisions for ordinary research files. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'

/** Resolve a project path and reject traversal through existing symlinks. */
export async function projectPath(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root)
  const target = resolve(canonicalRoot, path)
  const within = (candidate: string): boolean => {
    const rel = relative(canonicalRoot, candidate)
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  }
  if (!within(target)) throw new Error('The requested file is outside this research project')
  let parent = target
  while (true) {
    try {
      const canonical = await realpath(parent)
      if (!within(canonical)) throw new Error('A project symlink points outside the research project')
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // The walk ends at the canonical root at the latest, which exists.
      parent = dirname(parent)
    }
  }
}

/** Hash a file without loading large datasets into memory. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Hash a UTF-8 input or a byte array. */
export function hashBytes(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }

/** Atomically replace one file using a private sibling staging file. */
export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, data, { flag: 'wx', mode: 0o600 })
  await rename(temp, path)
}

/** Copy one immutable revision only once, rejecting unequal existing content. */
export async function keepRevision(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  try { await copyFile(source, destination, 1) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await hashFile(source) !== await hashFile(destination)) throw error
  }
}

/**
 * Create a file that must not exist yet, atomically with respect to other writers.
 * @returns false when the path already exists; other failures throw.
 */
export async function writeNew(path: string, content: Uint8Array): Promise<boolean> {
  try {
    await writeFile(path, content, { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/** Read a bounded text artifact; binary sources use dedicated extractors. */
export async function readText(path: string, limit: number): Promise<string> {
  if ((await stat(path)).size > limit) throw new Error(`Text exceeds the ${limit} byte limit: ${path}`)
  return readFile(path, 'utf8')
}

/** Case-fold a path where the platform's filesystem is case-insensitive. */
function foldCase(value: string, platform: NodeJS.Platform): string { return platform === 'win32' ? value.toLowerCase() : value }

/** The path module whose rules the platform's filesystem follows. */
function pathsOf(platform: NodeJS.Platform): typeof posix { return platform === 'win32' ? win32 : posix }

/** Compare two absolute directories after resolution, case-folded on Windows. */
export function sameDirectory(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = pathsOf(platform)
  return foldCase(paths.resolve(a), platform) === foldCase(paths.resolve(b), platform)
}

const WINDOWS_SYSTEM_DIRECTORIES = ['windows', 'program files', 'program files (x86)', 'programdata']
const POSIX_SYSTEM_PREFIXES = ['/root', '/tmp', '/usr', '/etc', '/var', '/bin', '/sbin', '/lib', '/opt', '/proc', '/sys', '/dev', '/boot', '/snap']

/**
 * Refuse project roots that make confinement meaningless or dangerous:
 * filesystem roots, the user home directory itself and system locations on
 * any drive. Mirrors the remote root floor enforced for SSH environments.
 * @param root - absolute candidate for a project root.
 * @param platform - whose path rules apply; the host's by default.
 * @param home - the user's home directory on that platform.
 */
export function assertUsableProjectRoot(root: string, platform: NodeJS.Platform = process.platform, home = homedir()): void {
  const paths = pathsOf(platform)
  const resolved = paths.resolve(root)
  const parsed = paths.parse(resolved)
  if (parsed.root === resolved) throw new Error('Choose a dedicated project directory, not a filesystem root')
  if (foldCase(resolved, platform) === foldCase(paths.resolve(home), platform)) {
    throw new Error('Choose a dedicated project directory, not the home directory')
  }
  const system = platform === 'win32'
    // split() always yields a first element, so String() never sees undefined.
    ? WINDOWS_SYSTEM_DIRECTORIES.includes(foldCase(String(paths.relative(parsed.root, resolved).split(paths.sep)[0]), platform))
    : POSIX_SYSTEM_PREFIXES.some(prefix => resolved === prefix || resolved.startsWith(`${prefix}/`))
  if (system) throw new Error('Choose a dedicated project directory outside system locations')
}

/**
 * Whether a project-relative path names the service-owned metadata directory.
 * Checked on the normalized path and case-folded, so `./.research`,
 * `paper/../.research` and `.RESEARCH` are all recognised.
 * @param relativePath - path relative to the project root, either separator.
 */
export function isMetadataPath(relativePath: string): boolean {
  const normalized = posix.normalize(relativePath.replaceAll('\\', '/')).replace(/^\.\//, '')
  return normalized.split('/')[0]?.toLowerCase() === '.research'
}

/** Whether an absolute path lies inside a root, compared after resolution and case-folded on Windows. */
export function isInside(root: string, path: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = pathsOf(platform)
  const rel = paths.relative(foldCase(paths.resolve(root), platform), foldCase(paths.resolve(path), platform))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel))
}

/**
 * Directories whose contents are credentials or keys. Nothing is imported from
 * them, whoever asks: an approval dialog is no place to notice that a path
 * leads into the harness's own credential store.
 * @param home - the product's data directory, holding its credential store.
 */
export function protectedDirectories(home: string): string[] {
  return [home, ...['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker'].map(name => join(homedir(), name))]
}

/** The message of a thrown value, whatever was thrown. */
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** Truncate text to a byte budget without splitting a multibyte character. */
export function truncateBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limit) return text
  const decoder = new TextDecoder('utf-8', { fatal: true })
  // Valid input can only break at the cut point, so at most three bytes go:
  // three bytes back from the limit is always a character boundary.
  const floor = Math.max(0, limit - 3)
  for (let end = limit; end > floor; end--) {
    try { return decoder.decode(bytes.subarray(0, end)) } catch { /* the byte cut lands inside a multibyte character */ }
  }
  return decoder.decode(bytes.subarray(0, floor))
}
