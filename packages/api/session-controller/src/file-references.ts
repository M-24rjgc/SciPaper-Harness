/** Session Controller adapter for Agent-scoped file-reference discovery. */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-file-reference'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

const MAX_REMOTE_RESULTS = 20
const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target', '.next', '.nuxt',
  '.turbo', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle',
])

/** List one remote directory without following symlinked parents or leaving the SSH workspace. */
async function remoteCandidates(fs: FileSystem, root: string, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
  signal.throwIfAborted()
  if (!posix.isAbsolute(root) || query.length > 4096 || /[\0\r\n]/u.test(query)) return []
  const normalized = query.replaceAll('\\', '/')
  const slash = normalized.lastIndexOf('/')
  const directory = slash < 0 ? '' : normalized.slice(0, slash + 1)
  const fragment = slash < 0 ? normalized : normalized.slice(slash + 1)
  const workspace = posix.normalize(root)
  const absolute = posix.resolve(workspace, directory || '.')
  const relative = posix.relative(workspace, absolute)
  if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) return []
  if (relative.split('/').some(segment => EXCLUDED_DIRECTORIES.has(segment))) return []

  const rootTarget = await fs.resolve(workspace, { signal })
  let prefix = workspace
  for (const segment of relative.split('/').filter(Boolean)) {
    signal.throwIfAborted()
    prefix = posix.join(prefix, segment)
    const info = await fs.lstat(prefix, { cwd: workspace }, signal).catch(() => {
      signal.throwIfAborted()
      return undefined
    })
    if (info?.type !== 'directory') return []
  }
  const target = await fs.resolve(absolute, { signal })
  if (!fs.contains(rootTarget, target)) return []
  const entries = await fs.listDir(target, signal).catch((error: unknown) => {
    signal.throwIfAborted()
    if (relative === '') throw error
    return []
  })
  signal.throwIfAborted()
  const needle = fragment.toLowerCase()
  return entries.flatMap((entry): FileReferenceCandidate[] => {
    if (entry.type !== 'file' && entry.type !== 'directory') return []
    if (entry.name.startsWith('.') && !fragment.startsWith('.')) return []
    if (entry.type === 'directory' && EXCLUDED_DIRECTORIES.has(entry.name)) return []
    if (!entry.name.toLowerCase().includes(needle)) return []
    return [{ path: `${directory}${entry.name}`, kind: entry.type }]
  }).sort((left, right) => {
    const rank = (candidate: FileReferenceCandidate): number => {
      const name = candidate.path.slice(directory.length).toLowerCase()
      return (name === needle ? 2 : name.startsWith(needle) ? 1 : 0) * 2 + (candidate.kind === 'directory' ? 1 : 0)
    }
    return rank(right) - rank(left) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  }).slice(0, MAX_REMOTE_RESULTS)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `fileReferences` Remote namespace. */
    sessionFileReferences: SessionFileReferences
  }
}

/** Host Remote adapter over the composed file-reference provider. */
export class SessionFileReferences extends TypertRemoteService {
  static inject = ['fileReferences', 'typert']

  /** @param ctx - Host context carrying the selected file-reference provider. */
  constructor(ctx: Context) {
    super(ctx, 'sessionFileReferences', { namespace: 'fileReferences' })
  }

  /**
   * List file and directory candidates for one Agent's working directory.
   * @param agent - target Agent resolved from the Session identity on the wire.
   * @param query - path text following `@` or `@"`.
   * @param signal - caller cancellation.
   * @returns deterministic path-only candidates from the composed provider.
   */
  @Remote
  list(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    if (agent.session.header.execution?.kind === 'ssh') {
      const services: { get(name: string): unknown } = this.ctx
      const presets = services.get('agentPresets') as
        | { serviceFor(owner: { ctx: Context }, name: 'fs'): FileSystem | undefined }
        | undefined
      const fs = presets?.serviceFor(agent, 'fs')
      const root = agent.session.header.cwd
      if (fs === undefined || fs === services.get('fs') || root === undefined) {
        throw new RemoteError('gateway/internal', 'SSH file-reference provider is unavailable', {})
      }
      return remoteCandidates(fs, root, query, signal)
    }
    return this.ctx.fileReferences.list(agent, query, signal)
  }
}

export default SessionFileReferences
