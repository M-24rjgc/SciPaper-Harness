/** Match an SSH conversation to a local research ledger through a configured remote environment. */
import { posix } from 'node:path'
import type { ResearchProject } from './types.ts'

/** The two coordinates recorded by a conversation; absent execution means legacy local. */
export interface ResearchSessionCoordinate {
  readonly cwd?: string | undefined
  readonly execution?: { readonly kind: 'local' } | { readonly kind: 'ssh'; readonly host: string } | undefined
}

/** Ambiguous remote bindings must never select an arbitrary local ledger. */
export type RemoteResearchMatch =
  | { readonly kind: 'none' }
  | { readonly kind: 'project'; readonly project: ResearchProject }
  | { readonly kind: 'ambiguous' }

/** A POSIX directory is the root itself or a descendant, never a sibling with a common prefix. */
function contains(root: string, directory: string): boolean {
  const relative = posix.relative(root, directory)
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
}

/**
 * An SSH environment explicitly binds its host and remoteRoot to one local research.
 * Two different projects claiming the same remote directory are ambiguous even when
 * one configured root is nested in another; no local filesystem lookup is attempted.
 * @param projects - Local research ledgers with configured SSH environments.
 * @param coordinate - Session execution identity and working directory to match.
 * @returns the unique matching ledger, ambiguity, or no match.
 */
export function remoteResearchAt(
  projects: readonly ResearchProject[], coordinate: ResearchSessionCoordinate,
): RemoteResearchMatch {
  if (coordinate.execution?.kind !== 'ssh' || coordinate.execution.host === ''
    || coordinate.cwd === undefined || !posix.isAbsolute(coordinate.cwd)) return { kind: 'none' }
  const host = coordinate.execution.host
  const directory = posix.normalize(coordinate.cwd)
  const matching = projects.filter(project => project.environments.some((environment) => {
    if (environment.target !== 'ssh' || environment.status !== 'ready'
      || environment.sshHost !== host || environment.remoteRoot === undefined
      || !posix.isAbsolute(environment.remoteRoot)) return false
    const root = posix.normalize(environment.remoteRoot)
    return root !== '/' && contains(root, directory)
  }))
  if (matching.length > 1) return { kind: 'ambiguous' }
  const project = matching[0]
  return project === undefined ? { kind: 'none' } : { kind: 'project', project }
}
