import { expect, it, vi } from 'vitest'
import { DesktopRemoteSource } from '../src/client/desktop-remote-source.ts'
import type { DesktopRemotePresentation } from '../src/types.ts'

function fixture() {
  const status = Promise.withResolvers<DesktopRemotePresentation>()
  let listener!: (state: DesktopRemotePresentation) => void
  const unsubscribe = vi.fn()
  const start = vi.fn(async () => {})
  const stop = vi.fn(async () => {})
  const refresh = vi.fn(async () => {})
  const source = new DesktopRemoteSource({ status: () => status.promise, start, stop, refresh,
    subscribe: (next) => { listener = next; return unsubscribe } })
  return { source, status, start, stop, refresh, unsubscribe, emit: (state: DesktopRemotePresentation) => { listener(state) } }
}

it('keeps the newest event over a late initial status and permits cancellation during preparation', async () => {
  const f = fixture()
  f.emit({ phase: 'preparing' })
  f.status.resolve({ phase: 'idle' })
  await Promise.resolve()
  expect(f.source.store.getSnapshot().presentation.phase).toBe('preparing')
  f.source.run('stop')
  expect(f.stop).toHaveBeenCalledOnce()
  f.source.dispose()
})

it('coalesces refresh, exposes failures, and erases invitation data after disposal', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<undefined>()
  f.refresh.mockImplementationOnce(() => pending.promise)
  f.emit({ phase: 'ready', pairingUrl: 'https://example.com/?pair=private' })
  f.source.run('refresh')
  f.source.run('refresh')
  expect(f.refresh).toHaveBeenCalledOnce()
  pending.reject(new Error('unavailable'))
  await vi.waitFor(() => { expect(f.source.store.getSnapshot().failed).toBe(true) })
  f.source.dispose()
  f.emit({ phase: 'ready', pairingUrl: 'https://example.com/?pair=late' })
  f.status.resolve({ phase: 'ready', pairingUrl: 'https://example.com/?pair=late' })
  f.source.run('start')
  await Promise.resolve()
  expect(f.source.store.getSnapshot()).toEqual({ presentation: { phase: 'idle' }, failed: false, refreshing: false })
  expect(f.start).not.toHaveBeenCalled()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})
