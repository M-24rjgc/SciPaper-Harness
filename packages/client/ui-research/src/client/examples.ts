/**
 * Example researches are shipped for the tutorial and are read-only: the
 * composer of every conversation inside one stays inert, with the reason in
 * the person's language. The host refuses anything recorded into an example
 * whatever the composer does; this only keeps the conversation from starting.
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ComposerBlocks } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionProject, type ResearchView, type SessionDirectories } from './contract.ts'

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
      const raise = (): void => { if (store.getSnapshot()?.reason !== reason) blocks.set(sessionId, { reason }) }
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
