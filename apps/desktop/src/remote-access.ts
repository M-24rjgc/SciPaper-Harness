/** Owns an outbound tunnel and its Host authorization as one cancellable lease. */
import type { DesktopRemotePresentation } from '@deepseek-ai/dsh-client-ui-settings-general/types'

/** Host-issued, one-use invitation. Never persisted or included in diagnostics. */
export interface RemotePairing {
  readonly id: string
  readonly url: string
  readonly expiresAt: number
}

/** One owned outbound process, with a verified public HTTPS origin. */
export interface RemoteTunnel {
  readonly origin: string
  readonly closed: Promise<void>
  stop(): Promise<void>
}

/** Private Host control captured at the beginning of an attempt. */
export interface RemoteHost {
  remoteAccess(request: { action: 'start' | 'refresh' | 'stop'; origin?: string }): Promise<RemotePairing | undefined>
}

/** Only classified failures cross into the product UI. */
export class RemoteAccessError extends Error {
  constructor(readonly kind: NonNullable<DesktopRemotePresentation['failure']>) { super(`remote access: ${kind}`) }
}

interface Attempt {
  readonly abort: AbortController
  readonly host: RemoteHost
  tunnel?: RemoteTunnel
  authorized: boolean
  cleanup?: Promise<void>
}

/** Dependencies provide the carrier-owned process and private QR generation. */
export interface RemoteAccessDependencies {
  host(): RemoteHost | undefined
  openTunnel(signal: AbortSignal, connecting: () => void): Promise<RemoteTunnel>
  qrCode(url: string): Promise<string>
  publish(state: DesktopRemotePresentation): void
}

/** Cancels pending downloads and prevents late pairing publication after revoke. */
export class DesktopRemoteAccess {
  private current: DesktopRemotePresentation = { phase: 'idle' }
  private attempt: Attempt | undefined
  private pending: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private refreshing: Promise<void> | undefined

  constructor(private readonly dependencies: RemoteAccessDependencies) {}

  /** Snapshot is returned only to the owned Desktop top frame. */
  get state(): DesktopRemotePresentation { return this.current }

  /** Start on an explicit desktop action, sharing concurrent clicks. */
  start(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping.then(() => this.start())
    if (this.pending !== undefined) return this.pending
    if (this.current.phase === 'ready') return Promise.resolve()
    const host = this.dependencies.host()
    if (host === undefined) { this.update({ phase: 'error', failure: 'host' }); return Promise.resolve() }
    const attempt: Attempt = { host, abort: new AbortController(), authorized: false }
    this.attempt = attempt
    this.update({ phase: 'preparing' })
    const pending = (async () => {
      try {
        attempt.tunnel = await this.dependencies.openTunnel(attempt.abort.signal, () => {
          if (this.live(attempt)) this.update({ phase: 'connecting' })
        })
        if (!this.live(attempt)) { await this.cleanup(attempt); return }
        // Mark before awaiting: stop must revoke even if the registration's answer is late.
        attempt.authorized = true
        const pairing = await host.remoteAccess({ action: 'start', origin: attempt.tunnel.origin })
        if (pairing === undefined) throw new RemoteAccessError('host')
        const qrCode = await this.dependencies.qrCode(pairing.url)
        if (!this.live(attempt)) { await this.cleanup(attempt); return }
        this.update({ phase: 'ready', origin: attempt.tunnel.origin, pairingUrl: pairing.url, expiresAt: pairing.expiresAt, qrCode })
        void attempt.tunnel.closed.then(async () => {
          if (!this.live(attempt)) return
          attempt.abort.abort()
          await this.cleanup(attempt)
          if (this.attempt === attempt) {
            this.attempt = undefined
            this.update({ phase: 'error', failure: 'connection' })
          }
        }).catch(() => { /* State contains classified errors, never subprocess output. */ })
      } catch (error) {
        const cancelled = attempt.abort.signal.aborted
        attempt.abort.abort()
        await this.cleanup(attempt)
        if (this.attempt === attempt && !cancelled) {
          this.attempt = undefined
          this.update({ phase: 'error', failure: error instanceof RemoteAccessError ? error.kind : 'connection' })
        }
      }
    })().finally(() => { if (this.pending === pending) this.pending = undefined })
    this.pending = pending
    return pending
  }

  /** Replaces just the invitation; existing authorized phones keep their session. */
  refresh(): Promise<void> {
    if (this.refreshing !== undefined) return this.refreshing
    const attempt = this.attempt
    if (attempt === undefined || this.current.phase !== 'ready' || !this.live(attempt)) return Promise.resolve()
    const refreshing = (async () => {
      try {
        const pairing = await attempt.host.remoteAccess({ action: 'refresh' })
        if (pairing === undefined) throw new RemoteAccessError('host')
        const qrCode = await this.dependencies.qrCode(pairing.url)
        if (this.live(attempt)) this.update({ phase: 'ready', ...(attempt.tunnel === undefined ? {} : { origin: attempt.tunnel.origin }),
          pairingUrl: pairing.url, expiresAt: pairing.expiresAt, qrCode })
      } catch {
        if (this.live(attempt)) {
          await this.stop()
          this.update({ phase: 'error', failure: 'host' })
        }
      }
    })().finally(() => { if (this.refreshing === refreshing) this.refreshing = undefined })
    this.refreshing = refreshing
    return refreshing
  }

  /** Revokes admission before stopping the process, including during startup. */
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    const attempt = this.attempt
    if (attempt === undefined && this.pending === undefined) { this.update({ phase: 'idle' }); return Promise.resolve() }
    attempt?.abort.abort()
    this.update({ phase: 'stopping' })
    const pending = this.pending
    const stopping = (async () => {
      // Start owns incomplete registration: wait before sending the final revoke.
      await pending
      if (attempt !== undefined) await this.cleanup(attempt)
      if (this.attempt === attempt) this.attempt = undefined
      this.update({ phase: 'idle' })
    })().finally(() => { if (this.stopping === stopping) this.stopping = undefined })
    this.stopping = stopping
    return stopping
  }

  private live(attempt: Attempt): boolean { return this.attempt === attempt && !attempt.abort.signal.aborted }

  private cleanup(attempt: Attempt): Promise<void> {
    return attempt.cleanup ??= (async () => {
      try {
        if (attempt.authorized) await attempt.host.remoteAccess({ action: 'stop' }).catch(() => undefined)
      } finally { await attempt.tunnel?.stop() }
    })()
  }

  private update(state: DesktopRemotePresentation): void {
    this.current = state
    this.dependencies.publish(state)
  }
}
