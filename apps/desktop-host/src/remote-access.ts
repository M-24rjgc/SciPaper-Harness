/** Private Desktop control for revocable remote origins; no pairing secret enters the public API. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRemoteOrigin, ConnectionRemotePairing } from '@deepseek-ai/dsh-client-connection'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** Remote control fields accepted from the owning Electron process. */
export interface DesktopRemoteAccessRequest {
  readonly action: 'start' | 'refresh' | 'stop'
  readonly origin?: string
}

/** Serializes one Host's private remote-access lifecycle and revokes it on shutdown. */
export class DesktopRemoteAccess {
  private remote: ConnectionRemoteOrigin | undefined
  private operations = Promise.resolve()
  private closed = false

  /** @param ctx - running Host whose Connection owns every registered remote origin. */
  constructor(private readonly ctx: Context) {
    ctx.effect(() => () => this.dispose(), 'desktop remote: access control')
  }

  /**
   * Start or replace an origin, refresh its invitation, or revoke its entire lease.
   * @param request - private shell control request.
   * @returns private pairing link for start/refresh, or undefined after stop.
   */
  request(request: DesktopRemoteAccessRequest): Promise<ConnectionRemotePairing | undefined> {
    return this.enqueue(async () => {
      if (this.closed) throw new Error('desktop remote: Host is unavailable')
      switch (request.action) {
        case 'start': {
          if (request.origin === undefined) throw new Error('desktop remote: origin is required')
          await this.revoke()
          if (this.isClosed()) throw new Error('desktop remote: Host is unavailable')
          const remote = this.ctx.connection.registerRemoteOrigin(request.origin)
          this.remote = remote
          return remote.createPairingUrl()
        }
        case 'refresh':
          if (this.remote === undefined) throw new Error('desktop remote: access is not enabled')
          return this.remote.createPairingUrl()
        case 'stop':
          await this.revoke()
          return undefined
        default:
          return assertNever(request.action)
      }
    })
  }

  /** Refuse queued and new activation, revoke existing access, and await its teardown. */
  async dispose(): Promise<void> {
    this.closed = true
    await this.enqueue(() => this.revoke())
  }

  private async revoke(): Promise<void> {
    const remote = this.remote
    this.remote = undefined
    await remote?.dispose()
  }

  private isClosed(): boolean { return this.closed }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation)
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }
}
