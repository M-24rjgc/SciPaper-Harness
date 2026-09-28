/** An example research's conversations keep an inert composer, whatever else raises or clears blocks. */
import { describe, expect, it } from 'vitest'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResearchView, SessionDirectories } from '../src/client/contract.ts'
import { guardExampleComposers } from '../src/client/examples.ts'

const REASON = 'This is an example research and can only be viewed.'

/** The composer's block registry as the conversation plugin keeps it: one block per session. */
function blockRegistry() {
  const stores = new Map<SessionId, SnapshotStore<ComposerBlock | undefined>>()
  const storeFor = (sessionId: SessionId): SnapshotStore<ComposerBlock | undefined> => {
    const existing = stores.get(sessionId)
    if (existing) return existing
    const created = createSnapshotStore<ComposerBlock | undefined>(undefined)
    stores.set(sessionId, created)
    return created
  }
  return {
    storeFor,
    set: (sessionId: SessionId, block: ComposerBlock | undefined) => { storeFor(sessionId).set(block) },
    reason: (sessionId: string) => storeFor(sessionId as SessionId).getSnapshot()?.reason,
  }
}

function project(fields: Record<string, unknown>): ResearchProject {
  return { id: 'p', root: 'C:\\home\\demo\\sparse', sessionId: undefined, ...fields } as ResearchProject
}

function bench(projects: ResearchProject[], directories: SessionDirectories) {
  const research = createSnapshotStore<ResearchView>({ snapshot: { projects } as never, tasks: [] })
  const dirs = createSnapshotStore<SessionDirectories>(directories)
  const blocks = blockRegistry()
  const stop = guardExampleComposers({ research, directories: dirs, blocks, reason: () => REASON })
  return { research, dirs, blocks, stop }
}

describe('the example guard', () => {
  it('blocks every conversation of an example, bound or by folder, and nothing else', () => {
    const { blocks } = bench(
      [
        project({ id: 'ex', example: true, sessionId: 'bound' }),
        project({ id: 'own', root: 'C:\\research\\mine', sessionId: 'mine' }),
      ],
      { inside: 'C:\\home\\demo\\sparse\\paper', mine: 'C:\\research\\mine', elsewhere: 'C:\\elsewhere' },
    )
    expect(blocks.reason('bound')).toBe(REASON)
    expect(blocks.reason('inside')).toBe(REASON)
    expect(blocks.storeFor('bound' as SessionId).getSnapshot()?.readOnly).toBe(true)
    expect(blocks.storeFor('inside' as SessionId).getSnapshot()?.readOnly).toBe(true)
    expect(blocks.reason('mine')).toBeUndefined()
    expect(blocks.reason('elsewhere')).toBeUndefined()
  })

  it('raises its block again when another plugin clears the session\'s block', () => {
    const { blocks } = bench([project({ example: true })], { inside: 'C:\\home\\demo\\sparse' })
    blocks.set('inside' as SessionId, undefined)
    expect(blocks.reason('inside')).toBe(REASON)
    blocks.set('inside' as SessionId, { reason: 'no model' })
    expect(blocks.reason('inside')).toBe(REASON)
    blocks.set('inside' as SessionId, { reason: REASON })
    expect(blocks.storeFor('inside' as SessionId).getSnapshot()?.readOnly).toBe(true)
  })

  it('lets go when a conversation leaves the example, or when no record is known', () => {
    const { dirs, research, blocks } = bench([project({ example: true })], { moved: 'C:\\home\\demo\\sparse', other: 'C:\\home\\demo\\sparse' })
    dirs.set({ moved: 'C:\\research\\mine', other: 'C:\\home\\demo\\sparse' })
    expect(blocks.reason('moved')).toBeUndefined()
    expect(blocks.reason('other')).toBe(REASON)
    research.set({ snapshot: null, tasks: [] })
    expect(blocks.reason('other')).toBeUndefined()
  })

  it('clears what it raised when it stops, and only that', () => {
    const { blocks, stop } = bench([project({ example: true })], { a: 'C:\\home\\demo\\sparse', b: 'C:\\home\\demo\\sparse' })
    const raisedFor = ['a', 'b'] as const
    expect(raisedFor.map(id => blocks.reason(id))).toEqual([REASON, REASON])
    stop()
    expect(raisedFor.map(id => blocks.reason(id))).toEqual([undefined, undefined])
  })

  it('keeps a block another plugin raised after its own was replaced', () => {
    const { blocks, research } = bench([project({ example: true })], { a: 'C:\\home\\demo\\sparse' })
    research.set({ snapshot: { projects: [project({ example: false })] } as never, tasks: [] })
    expect(blocks.reason('a')).toBeUndefined()
    blocks.set('a' as SessionId, { reason: 'no model' })
    research.set({ snapshot: { projects: [project({ example: false })] } as never, tasks: [] })
    expect(blocks.reason('a')).toBe('no model')
  })
})
