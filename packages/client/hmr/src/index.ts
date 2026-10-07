/**
 * Host transport for Web client graph changes and rebuilt bundles. One interval
 * stat-polls every graph row's client bundle (polling by design: network mounts
 * deliver no inotify events), reports changes through
 * `clientModules.rebuilt(id)`, and serves the `/plugins/events` SSE channel
 * broadcasting graph/rebuilt frames to the browser half (src/client/).
 * The Web composition mounts this transport for live graph updates;
 * a development rebuild watcher also supplies bundle changes.
 */
import { statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type imports carry the clientModules/webServer Context merges.
import type { ClientArtifactBaseline } from '@deepseek-ai/dsh-client-modules'
import type { PeerAdmission } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PluginsEventFrame } from './events.ts'
import { EVENTS_ENDPOINT } from './events.ts'

export type { PluginsEventFrame } from './events.ts'
export { EVENTS_ENDPOINT } from './events.ts'

/** Cordis plugin name. */
export const name = 'client-hmr'

/** Required services: the client graph and Web route registry. */
export const inject = ['clientModules', 'webServer', 'connection']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Bundle stat-poll interval in milliseconds (default 500, the build-side watcher's polling default). */
  pollIntervalMs?: number
}

export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().step(1).min(1).default(500),
})

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  'connection': 'keep-alive',
}

/** Serialize one frame as an SSE data line. */
function sseData(frame: PluginsEventFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

/** One admitted graph subscriber, retaining at most the latest snapshot behind backpressure. */
class GraphSubscriber {
  private pending: string | undefined
  private blocked = false
  private closed = false
  private releasePeer: (() => Promise<void>) | undefined
  private readonly finished = Promise.withResolvers<undefined>()

  constructor(private readonly response: ServerResponse, private readonly removed: () => void) {
    response.once('close', this.onClose)
    response.on('error', this.onError)
    response.on('drain', this.onDrain)
  }

  bind(peer: Extract<PeerAdmission, { readonly peer: object }>['peer']): void {
    this.releasePeer = peer.ctx.effect(() => () => this.close(), 'client-hmr: admitted graph subscriber')
  }

  send(line: string, latestGraph: string): void {
    if (this.closed) return
    if (this.blocked) {
      this.pending = latestGraph
      return
    }
    try { this.blocked = !this.response.write(line) }
    catch { void this.close() }
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.pending = undefined
      this.response.off('drain', this.onDrain)
      this.removed()
      this.response.destroy()
    }
    return this.finished.promise.then(() => undefined)
  }

  private readonly onDrain = (): void => {
    if (this.closed) return
    this.blocked = false
    const line = this.pending
    this.pending = undefined
    if (line !== undefined) this.send(line, line)
  }

  private readonly onError = (): void => { void this.close() }

  private readonly onClose = (): void => {
    this.closed = true
    this.pending = undefined
    this.response.off('drain', this.onDrain)
    this.response.off('error', this.onError)
    this.removed()
    this.finished.resolve(undefined)
    void this.releasePeer?.()
  }
}

type WatchedBundleStat = Omit<ClientArtifactBaseline, 'path'>

type WatchedBundle = {
  -readonly [K in keyof ClientArtifactBaseline]: ClientArtifactBaseline[K]
} & { dirty: boolean }

/** Snapshot the executable bundle metadata that drives reloads. */
function bundleStat(path: string): WatchedBundleStat {
  const bundle = statSync(path)
  return { mtimeMs: bundle.mtimeMs, ctimeMs: bundle.ctimeMs, size: bundle.size }
}

/** Whether the executable bundle metadata is unchanged since its last publication. */
function sameBundleStat(left: WatchedBundleStat, right: WatchedBundleStat): boolean {
  return left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.size === right.size
}

/**
 * Mount bundle watches and graph/rebuilt SSE delivery.
 * @param ctx - host plugin context carrying clientModules and webServer.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the field is set after validation.
  const pollIntervalMs = config.pollIntervalMs as number

  // --- bundle watch: one HMR-owned stat poll ------------------------------
  const watched = new Map<string, WatchedBundle>()

  const publish = (id: string, watch: WatchedBundle, current: WatchedBundleStat): void => {
    try {
      ctx.clientModules.rebuilt(id)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        watch.dirty = true
        return
      }
      ctx.logger.warn(error)
    }
    watch.mtimeMs = current.mtimeMs
    watch.ctimeMs = current.ctimeMs
    watch.size = current.size
    watch.dirty = false
  }

  const watchRow = (id: string, baseline: ClientArtifactBaseline): void => {
    const watch: WatchedBundle = { ...baseline, dirty: false }
    watched.set(id, watch)
    let current: WatchedBundleStat
    try {
      current = bundleStat(baseline.path)
    } catch (error) {
      watch.dirty = true
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.warn(error)
      return
    }
    // The module host captured its baseline before reading the bytes in the
    // startup batch. Only a mismatch crosses into generation publication.
    if (!sameBundleStat(current, watch)) publish(id, watch, current)
  }

  const pollWatches = (): void => {
    for (const [id, watch] of watched) {
      let current: WatchedBundleStat
      try {
        current = bundleStat(watch.path)
      } catch (error) {
        watch.dirty = true
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.logger.warn(error)
        continue
      }
      if (!watch.dirty && sameBundleStat(current, watch)) continue
      // Stat-before-publication preserves a detectable older baseline for
      // writes that land during the read. The preset stamps the entry after
      // sibling chunks, so a completed build supplies the final stat change.
      publish(id, watch, current)
    }
  }

  // Diff the watch set against the current graph: drop watches for removed
  // rows (or rows whose bundle path moved), add watches for new rows.
  const syncWatches = (): void => {
    const rows = new Map<string, ClientArtifactBaseline>()
    for (const row of ctx.clientModules.graph().entries) {
      const watch = ctx.clientModules.artifactBaseline(row.id)
      if (watch !== undefined) rows.set(row.id, watch)
    }
    for (const [id, watch] of watched) {
      if (rows.get(id)?.path === watch.path) continue
      watched.delete(id)
    }
    for (const [id, watch] of rows) {
      if (!watched.has(id)) watchRow(id, watch)
    }
  }

  ctx.effect(() => {
    // Initial sync covers rows already in the graph; the subscription covers
    // rows arriving later (boot-window activations, including this plugin's
    // own row; bootstrap revisions also reach page diagnostics).
    syncWatches()
    const unsubscribe = ctx.clientModules.onGraphChanged(syncWatches)
    const timer = setInterval(pollWatches, pollIntervalMs)
    timer.unref()
    return () => {
      unsubscribe()
      clearInterval(timer)
      watched.clear()
    }
  }, 'client-hmr: bundle watches')

  // --- /plugins/events SSE channel ----------------------------------------
  const connections = new Set<GraphSubscriber>()
  const currentGraph = (): string => sseData({ type: 'graph', graph: ctx.clientModules.graph() })

  const publishGraph = (): void => {
    const line = currentGraph()
    for (const client of connections) client.send(line, line)
  }

  const connect = (res: ServerResponse, peer: Extract<PeerAdmission, { readonly peer: object }>['peer']): void => {
    const client = new GraphSubscriber(res, () => { connections.delete(client) })
    try { client.bind(peer) }
    catch { void client.close(); return }
    connections.add(client)
    res.writeHead(200, SSE_HEADERS)
    // Comment line on open so clients/proxies see a live channel even when
    // no rebuild ever happens; EventSource frame parsing skips it naturally.
    const graph = currentGraph()
    client.send(': connected\n\n', graph)
    client.send(graph, graph)
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: EVENTS_ENDPOINT,
      handler: (req, res) => {
        const admission = ctx.connection.admit(req)
        if ('rejection' in admission) {
          res.writeHead(admission.rejection, { 'cache-control': 'no-store' })
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        // Named routes match ahead of the carrier's method gate; keep the old
        // global 405 semantics for non-GET hits on this endpoint.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, SSE_HEADERS)
          res.end()
          return
        }
        connect(res, admission.peer)
      },
    })
    const unsubscribeGraph = ctx.clientModules.onGraphChanged(publishGraph)
    const unsubscribe = ctx.clientModules.onRebuilt((id, rev) => {
      const line = sseData({ type: 'rebuilt', id, rev })
      const graph = currentGraph()
      for (const client of connections) client.send(line, graph)
    })
    return async () => {
      unsubscribeGraph()
      unsubscribe()
      disposeRoute()
      await Promise.all([...connections].map(client => client.close()))
      connections.clear()
    }
  }, 'client-hmr: /plugins/events channel')
}
