/** Resolve packaged Office engine manifests from their complete, unpacked resource directories. */
import { registerHooks, type ModuleHooks } from 'node:module'
import { lstatSync, mkdtempSync, realpathSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Locate the archive containing a packaged runtime.
 * @param runtimeDir - Prepared or ASAR-contained runtime directory.
 * @returns Parent archive path, or undefined for a prepared directory.
 */
export function runtimeArchivePath(runtimeDir: string): string | undefined {
  const parent = dirname(runtimeDir)
  return basename(parent) === 'app.asar' ? parent : undefined
}

/**
 * Keep engine executable and resource paths usable by native child processes outside Electron.
 * Hooks apply only to this thread; worker threads must install their own resolver.
 * @param runtimeDir - Prepared or ASAR-contained dsh runtime directory.
 * Windows native engines use private short junctions to keep their resource paths within the native engine's limit.
 * Deregistration and process exit remove only the owned junctions and their empty temporary directories.
 * @returns Installed resolver for the Host lifetime, or undefined for a non-ASAR, non-Windows runtime.
 */
export function installOfficeEngineResolution(runtimeDir: string): Pick<ModuleHooks, 'deregister'> | undefined {
  const archived = runtimeArchivePath(runtimeDir) !== undefined
  if (!archived && process.platform !== 'win32') return undefined
  const root = realpathSync(runtimeDir)
  const archive = dirname(root)
  const source = pathToFileURL(join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit-')).href
  const destination = pathToFileURL(join(`${archive}.unpacked`, relative(archive, root), 'node_modules', '@deepseek-ai', 'libreoffice-kit-')).href
  const aliases = new Map<string, { directory: string; path: string; dev: number; ino: number; linkDev: number; linkIno: number }>()
  function shorten(manifest: string): string {
    const engine = dirname(manifest)
    if (process.platform !== 'win32') return manifest
    let alias = aliases.get(engine)
    if (alias === undefined) {
      const directory = mkdtempSync(join(tmpdir(), 'scipaper-office-'))
      const identity = lstatSync(directory)
      const path = join(directory, 'engine')
      // The pinned engine's longest relative resource path is 85 characters; reserve room for it and native suffixes.
      if (path.length + 96 >= 248) {
        rmdirSync(directory)
        throw new Error('desktop Office: the temporary directory is too long for the native engine')
      }
      try { symlinkSync(engine, path, 'junction') } catch (error) { rmdirSync(directory); throw error }
      const link = lstatSync(path)
      alias = { directory, path, dev: identity.dev, ino: identity.ino, linkDev: link.dev, linkIno: link.ino }
      aliases.set(engine, alias)
    }
    return join(alias.path, basename(manifest))
  }
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      if (!/^@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-[^/]+\/package\.json$/u.test(specifier)) return resolved
      const canonical = pathToFileURL(realpathSync(fileURLToPath(resolved.url))).href
      if (!canonical.startsWith(source)) {
        if (archived && canonical.startsWith(pathToFileURL(archive + '/').href)) {
          throw new Error(`desktop Office engine resolved outside the runtime package directory: ${resolved.url}`)
        }
        return resolved
      }
      const physical = archived ? realpathSync(fileURLToPath(destination + canonical.slice(source.length)))
        : fileURLToPath(canonical)
      if (archived) {
        const expected = fileURLToPath(destination + canonical.slice(source.length))
        const parent = realpathSync(dirname(dirname(expected)))
        if (physical !== join(parent, basename(dirname(expected)), basename(expected))) {
          throw new Error('desktop Office engine resolved outside its unpacked package directory')
        }
      }
      return { ...resolved, url: pathToFileURL(shorten(physical)).href }
    },
  })
  const deregister = hook.deregister.bind(hook)
  let disposed = false
  const cleanup = (): void => {
    if (disposed) return
    disposed = true
    deregister()
    process.removeListener('exit', cleanup)
    for (const [engine, alias] of aliases) {
      try {
        const directory = lstatSync(alias.directory, { throwIfNoEntry: false })
        if (!directory?.isDirectory() || directory.isSymbolicLink() || directory.dev !== alias.dev || directory.ino !== alias.ino) continue
        // Never recurse into a junction or remove a replacement directory/link during teardown.
        const link = lstatSync(alias.path, { throwIfNoEntry: false })
        if (link !== undefined) {
          if (!link.isSymbolicLink() || link.dev !== alias.linkDev || link.ino !== alias.linkIno
            || realpathSync(alias.path) !== engine) continue
          unlinkSync(alias.path)
        }
        rmdirSync(alias.directory)
      } catch (error) {
        console.error('desktop Office: could not remove an owned engine alias', error)
      }
    }
    aliases.clear()
  }
  process.once('exit', cleanup)
  return { deregister: cleanup }
}
