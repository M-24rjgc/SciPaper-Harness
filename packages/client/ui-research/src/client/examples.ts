/**
 * Example researches are shipped for the tutorial and are read-only: the
 * composer of every conversation inside one stays inert, with the reason in
 * the person's language. The host refuses anything recorded into an example
 * whatever the composer does; this only keeps the conversation from starting.
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ComposerBlocks } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import { sessionProject, type ResearchView, type SessionDirectories } from './contract.ts'

// These three files ship in each v1 example but do not appear in its research
// evidence or artifact ledger. All other previewable paths come from that ledger.
const EXAMPLE_COMPANION_FILES = new Set(['README.md', 'README.zh.md', 'experiments/design.md'])

/**
 * Whether this exact project-relative file belongs to a shipped example.
 * @param project - research record containing the example file index.
 * @param path - candidate path relative to the example root.
 * @returns true only for a shipped companion or indexed file.
 */
export function knownExampleFile(project: ResearchProject | undefined, path: string): boolean {
  if (project?.example !== true || !String(project.id).startsWith('example-v1-')) return false
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(path)
    || path.split('/').some(part => part === '.' || part === '..')) return false
  return EXAMPLE_COMPANION_FILES.has(path)
    || project.evidence.some(source => source.path === path)
    || project.artifacts.some(artifact => artifact.path === path)
}

/** What the guard reads and where it raises its blocks. */
export interface ExampleGuardSources {
  research: ObservableSnapshot<ResearchView>
  directories: ObservableSnapshot<SessionDirectories>
  blocks: Pick<ComposerBlocks, 'set' | 'storeFor'>
  /** The block's placeholder, localized when a block is raised. */
  reason: () => string
}

/**
 * Keep the composer of every conversation inside an example research inert.
 * The composer holds one block per session and other plugins clear theirs, so
 * the guard raises its block again whenever it is cleared while the
 * conversation is still an example's.
 * @param sources - the research record, session directories, the composer's blocks and the reason.
 * @returns a disposer that stops watching and clears every block the guard raised.
 */
export function guardExampleComposers(sources: ExampleGuardSources): () => void {
  const { research, directories, blocks } = sources
  /**
   * Blocked sessions, each with the watcher that keeps its block raised. While
   * a session is held its block is always the guard's, so releasing it clears
   * the block; another plugin raises its own again on its next change.
   */
  const held = new Map<SessionId, () => void>()
  const release = (sessionId: SessionId, stop: () => void): void => {
    stop()
    held.delete(sessionId)
    blocks.set(sessionId, undefined)
  }
  const sync = (): void => {
    const projects = research.getSnapshot().snapshot?.projects ?? []
    const dirs = directories.getSnapshot()
    const bound = projects.flatMap(project => project.sessionId === undefined ? [] : [project.sessionId])
    const candidates = new Set([...Object.keys(dirs), ...bound])
    const wanted = new Set([...candidates].filter(id => sessionProject(projects, id, dirs)?.example === true) as SessionId[])
    for (const [sessionId, stop] of [...held]) if (!wanted.has(sessionId)) release(sessionId, stop)
    for (const sessionId of wanted) {
      if (held.has(sessionId)) continue
      const reason = sources.reason()
      const store = blocks.storeFor(sessionId)
      const raise = (): void => {
        const current = store.getSnapshot()
        if (current?.reason !== reason || current.readOnly !== true) blocks.set(sessionId, { reason, readOnly: true })
      }
      raise()
      held.set(sessionId, store.subscribe(raise))
    }
  }
  sync()
  const stops = [research.subscribe(sync), directories.subscribe(sync)]
  return () => {
    for (const stop of stops) stop()
    for (const [sessionId, stop] of [...held]) release(sessionId, stop)
  }
}
