import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'

const SESSION = 'blocked-session' as SessionId

describe('ComposerBlockRegistry', () => {
  it('republishes only when the copy changes', () => {
    const registry = new ComposerBlockRegistry()
    const listener = vi.fn()
    const store = registry.storeFor(SESSION)
    store.subscribe(listener)

    registry.set(SESSION, { reason: 'select a model first' })
    expect(store.getSnapshot()).toEqual({ reason: 'select a model first' })
    expect(listener).toHaveBeenCalledTimes(1)

    // Identical copy: no publication at all.
    registry.set(SESSION, { reason: 'select a model first' })
    expect(listener).toHaveBeenCalledTimes(1)

    registry.set(SESSION, undefined)
    expect(store.getSnapshot()).toBeUndefined()

    registry.forget(SESSION)
    expect(registry.storeFor(SESSION).getSnapshot()).toBeUndefined()
  })

  it('publishes read-only changes even when the localized reason stays the same', () => {
    const registry = new ComposerBlockRegistry()
    const store = registry.storeFor(SESSION)
    const listener = vi.fn()
    store.subscribe(listener)
    registry.set(SESSION, { reason: 'view only' })
    registry.set(SESSION, { reason: 'view only', readOnly: true })
    expect(store.getSnapshot()?.readOnly).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
    registry.set(SESSION, { reason: 'view only', readOnly: true })
    expect(listener).toHaveBeenCalledTimes(2)
    registry.set(SESSION, { reason: 'view only' })
    expect(store.getSnapshot()?.readOnly).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
