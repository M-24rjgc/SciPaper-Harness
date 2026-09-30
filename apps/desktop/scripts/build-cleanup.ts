/** Ordinary cleanup restricted to a build-owned directory, without following directory links. */

import { lstatSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { removeOwnedDirectory } from '../src/owned-directory.ts'

/**
 * Verify a strict child of an explicit build root and reject linked ancestors.
 * @param path - Absolute build output or unique staging path.
 * @param ownerRoot - Absolute directory owning the output.
 */
export function assertOwnedBuildPath(path: string, ownerRoot: string): void {
  if (!isAbsolute(path) || !isAbsolute(ownerRoot)) throw new Error('build cleanup: paths must be absolute')
  const child = relative(resolve(ownerRoot), resolve(path))
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`build cleanup: path is outside the owned directory: ${path}`)
  }
  // A lexical child through a junction could otherwise enter the source project or another installation.
  for (let parent = dirname(resolve(path)); ; parent = dirname(parent)) {
    const stat = lstatSync(parent, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) throw new Error(`build cleanup: linked ancestor: ${parent}`)
    if (stat !== undefined && !stat.isDirectory()) throw new Error(`build cleanup: ancestor is not a directory: ${parent}`)
    if (dirname(parent) === parent) break
  }
}

/**
 * Remove an owned output tree, unlinking root and nested junctions without visiting their targets.
 * @param path - Absolute build output or unique staging directory.
 * @param ownerRoot - Absolute directory owning the output.
 */
export function removeOwnedBuildDirectory(path: string, ownerRoot: string): void {
  assertOwnedBuildPath(path, ownerRoot)
  try { removeOwnedDirectory(path) } catch (error) {
    // Ignore only a root that disappeared; a failed child deletion must remain visible.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || lstatSync(path, { throwIfNoEntry: false }) !== undefined) throw error
  }
}

/**
 * Unlink one build record without force or recursive deletion.
 * @param path - Absolute build record path.
 * @param ownerRoot - Absolute directory owning the record.
 */
export function removeOwnedBuildFile(path: string, ownerRoot: string): void {
  assertOwnedBuildPath(path, ownerRoot)
  try { unlinkSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
