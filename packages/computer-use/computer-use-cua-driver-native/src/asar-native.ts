import { createRequire } from 'node:module'

interface LibraryResolver {
  resolveLibPath(options: unknown): string
}

const PATCHED = Symbol.for('dsh.cua-driver.asar-unpacked-resolver')

type PatchedResolver = LibraryResolver['resolveLibPath'] & { [PATCHED]?: boolean }

/** FFI opens native libraries through the OS, which cannot read inside app.asar.
 * @param path - library path returned by the generated SDK resolver.
 * @returns the corresponding unpacked path when the library lives in an Electron archive.
 */
export function unpackedAsarLibraryPath(path: string): string {
  return path.replace(/([\\/])app\.asar(?=[\\/])/iu, '$1app.asar.unpacked')
}

/** Redirect the SDK's native-library resolver once for Electron's unpacked archive.
 * @param resolver - mutable SDK resolver object.
 */
export function patchAsarLibraryResolver(resolver: LibraryResolver): void {
  if ((resolver.resolveLibPath as PatchedResolver)[PATCHED]) return
  const original = resolver.resolveLibPath.bind(resolver)
  const patched: PatchedResolver = options => unpackedAsarLibraryPath(original(options))
  patched[PATCHED] = true
  resolver.resolveLibPath = patched
}

/** Apply the FFI path correction before the generated SDK module is imported. */
export function preparePackagedCuaImport(): void {
  if (process.versions.electron === undefined || !/[\\/]app\.asar[\\/]/iu.test(import.meta.url)) return
  const sdkRequire = createRequire(import.meta.resolve('@trycua/cua-driver'))
  const resolver = sdkRequire('@ubjs/node/typescript/dist/resolve-lib.js') as LibraryResolver
  patchAsarLibraryResolver(resolver)
}
