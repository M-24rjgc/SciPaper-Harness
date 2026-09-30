/**
 * Path canonicalization for workspace identity.
 * @module @deepseek-ai/dsh-workspace/src/paths
 */

import { realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { WorkspaceLocation } from './types.ts'

/**
 * Stable identity for a canonical location, without delimiter collisions.
 * @param location - Canonical local or SSH Workspace location.
 * @returns A stable key that includes the execution host.
 */
export function workspaceLocationKey(location: WorkspaceLocation): string {
  return JSON.stringify(location.kind === 'local'
    ? ['local', location.path]
    : ['ssh', location.host, location.path])
}

/**
 * Validate and normalize a POSIX directory without consulting the Windows Host filesystem.
 * @param path - Remote directory path to validate.
 * @returns The canonical absolute POSIX path.
 */
export function normalizeSshWorkspacePath(path: string): string {
  if (typeof path !== 'string' || !posix.isAbsolute(path) || path.includes('\0')) {
    throw new TypeError(`SSH Workspace path must be absolute POSIX: '${path}'`)
  }
  return posix.normalize(path).replace(/\/+$/, '') || '/'
}

/**
 * Build a canonical SSH workspace identity from an SSH config host key and path.
 * @param host - SSH config host key.
 * @param path - Absolute remote directory path.
 * @returns The normalized SSH Workspace location.
 */
export function sshWorkspaceLocation(host: string, path: string): WorkspaceLocation {
  if (typeof host !== 'string' || host.trim() === '') throw new TypeError('SSH Workspace host is required')
  return { kind: 'ssh', host, path: normalizeSshWorkspacePath(path) }
}

/**
 * Check whether a path names one fixed Host location without process cwd or
 * current-drive resolution.
 * @param path - Candidate Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns Whether the path is fully qualified on that platform.
 */
export function fullyQualifiedWorkspacePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return posix.isAbsolute(path)
  const root = win32.parse(path).root
  return win32.isAbsolute(path) && root !== '\\' && root !== '/'
}

/**
 * Derive a non-empty default title from a canonical Workspace path.
 * @param path - Canonical Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns The final segment when present, otherwise the complete root spelling.
 */
export function defaultWorkspaceTitle(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' ? win32 : posix
  return pathApi.basename(path) || pathApi.parse(path).root
}

/**
 * Canonicalize a fully qualified directory path via `fs.realpath`: trailing
 * slashes, `..` segments, and symlinks are all resolved. This is the ONE
 * uniqueness canon of the package — workspace paths are stored canonicalized,
 * uniqueness is string equality of canonicalized paths (a symlink to an
 * existing workspace's directory collides), and attach-time session `cwd`
 * checks go through the same canon. Relative paths reject before `realpath` can
 * resolve them from the Host cwd or current Windows drive. A path that does not
 * exist rejects with the original `ENOENT` — this is `create`'s reject path (a
 * workspace must point at an existing directory).
 * @param path - The path to canonicalize.
 * @returns the canonical absolute path.
 */
export async function realpathNormalize(path: string): Promise<string> {
  if (!fullyQualifiedWorkspacePath(path)) {
    throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
  }
  return await realpath(path)
}
