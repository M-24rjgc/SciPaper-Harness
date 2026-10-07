/** Observes the desktop-only remote lease without persisting pairing secrets. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopRemoteBridge, DesktopRemotePresentation } from '../types.ts'

/** Carrier presentation plus a local failed action and refresh state. */
export interface DesktopRemoteView {
  readonly presentation: DesktopRemotePresentation
  readonly failed: boolean
  readonly refreshing: boolean
}

/** Detaches subscriptions and ignores late asynchronous answers after disposal. */
export class DesktopRemoteSource {
  readonly store = createSnapshotStore<DesktopRemoteView>({ presentation: { phase: 'idle' }, failed: false, refreshing: false })
  private live = true
  private received = false
  private readonly unsubscribe: () => void

  constructor(private readonly bridge: DesktopRemoteBridge) {
    this.unsubscribe = bridge.subscribe((presentation) => {
      if (!this.live) return
      this.received = true
      this.store.set({ ...this.store.getSnapshot(), presentation, failed: false })
    })
    void bridge.status().then((presentation) => {
      if (this.live && !this.received) this.store.set({ ...this.store.getSnapshot(), presentation })
    }, () => { if (this.live && !this.received) this.store.set({ ...this.store.getSnapshot(), failed: true }) })
  }

  /** Cancel stays available during startup; the main process serializes ownership. */
  run(action: 'start' | 'refresh' | 'stop'): void {
    if (!this.live || (action === 'refresh' && this.store.getSnapshot().refreshing)) return
    this.store.set({ ...this.store.getSnapshot(), failed: false, refreshing: action === 'refresh' })
    void this.bridge[action]().catch(() => {
      if (this.live) this.store.set({ ...this.store.getSnapshot(), failed: true })
    }).finally(() => {
      if (this.live && action === 'refresh') this.store.set({ ...this.store.getSnapshot(), refreshing: false })
    })
  }

  /** Remove all references to invitation material on feature teardown. */
  dispose(): void {
    this.live = false
    this.unsubscribe()
    this.store.set({ presentation: { phase: 'idle' }, failed: false, refreshing: false })
  }
}
