/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import {
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from './rpc.ts'
import { clientRequestSchema } from './rpc-schema.ts'
import { bridge } from './http-bridge.ts'
import { isTrustedApiRequest } from './api-request-trust.ts'
import { API_PATH } from './api-path.ts'
import type { BrowserAuth, RemoteBrowserAuth } from './browser-auth.ts'
import { OperatorPeer } from './operator-peer.ts'
import type {
  PeerAdmission,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionFetchRoute,
  ConnectionFetchHandler,
  HostConnectionFetch,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcResult,
  ConnectionRequestRejection,
  ConnectionRemoteOrigin,
  ConnectionTrustRequest,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly handler: ConnectionRpcHandler
}

interface RemoteOriginRegistration {
  readonly auth: RemoteBrowserAuth
  readonly peer: OperatorPeer
}

interface RegisteredFetchRoute {
  readonly methods: ReadonlySet<string>
  readonly requestBody: ConnectionFetchRoute['requestBody']
  readonly fetch: ConnectionFetchRoute['fetch']
}

interface ConnectionServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  /** The operator Peer every admitted request speaks for. */
  readonly operator: PeerScope
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly fetchRoutes = new Map<string, RegisteredFetchRoute>()
  private readonly remoteOrigins = new Map<string, RemoteOriginRegistration>()

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by the Host/Origin fence.
   * @param browserAuth - process token and persistent browser-session owner.
   * @param remotePairingMaxAgeSeconds - lifetime of each single-use remote invitation.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly browserAuth: BrowserAuth,
    private readonly remotePairingMaxAgeSeconds = 300,
  ) {
    super(ctx, 'connection')
    this.operator = new OperatorPeer(ctx)
    ctx.effect(() => () => this.operator.dispose(), 'client-connection: operator Peer')
    ctx.effect(() => async () => {
      const remotes = [...this.remoteOrigins.values()]
      this.remoteOrigins.clear()
      for (const remote of remotes) remote.auth.revoke()
      await Promise.all(remotes.map(remote => remote.peer.dispose()))
    }, 'client-connection: remote Peers')
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) =>
        this.registerInterceptor(owner, channel, matches, handler),
    }
  }

  /** Exact Fetch-route registry scoped to the Context reading this service. */
  get fetch(): HostConnectionFetch {
    const owner = this.ctx
    return {
      register: route => this.registerFetchRoute(owner, route),
    }
  }

  /** Apply the configured Host/Origin fence, then browser authentication. */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    const remote = this.remoteOriginFor(request)
    if (remote !== undefined) {
      if (!isTrustedApiRequest(request, [remote.auth.authority]) || !remote.auth.acceptsOrigin(request)) return 403
      return remote.auth.isAuthenticated(request) ? undefined : 401
    }
    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
    return this.browserAuth.isAuthenticated(request) ? undefined : 401
  }

  /** A request that passes the fence and authentication speaks for the operator. */
  admit(request: ConnectionTrustRequest): PeerAdmission {
    const rejection = this.requestRejection(request)
    return rejection === undefined ? { peer: this.remoteOriginFor(request)?.peer ?? this.operator } : { rejection }
  }

  /** Authenticate an index request through the process-token exchange or cookie. */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    const remote = this.remoteOriginFor(request)
    if (remote !== undefined) {
      if (!isTrustedApiRequest(request, [remote.auth.authority]) || !remote.auth.acceptsOrigin(request)) {
        response.writeHead(403, { 'cache-control': 'no-store' })
        response.end('forbidden')
        return false
      }
      return remote.auth.authorizeIndex(request, response)
    }
    return this.browserAuth.authorizeIndex(request, response)
  }

  /** @inheritdoc */
  registerRemoteOrigin(origin: string): ConnectionRemoteOrigin {
    const auth = this.browserAuth.createRemoteOrigin(origin, this.remotePairingMaxAgeSeconds)
    if (this.remoteOrigins.has(auth.authority)) {
      throw new Error('client-connection: remote origin is already registered')
    }
    const peer = new OperatorPeer(this.ctx)
    const registration: RemoteOriginRegistration = { auth, peer }
    const dispose = this.ctx.effect(() => {
      this.remoteOrigins.set(auth.authority, registration)
      return async () => {
        auth.revoke()
        if (this.remoteOrigins.get(auth.authority) === registration) this.remoteOrigins.delete(auth.authority)
        await peer.dispose()
      }
    }, 'client-connection: remote origin')
    return {
      origin: auth.origin,
      createPairingUrl: () => auth.createPairingUrl(),
      revokePairing: (id) => { auth.revokePairing(id) },
      dispose: async () => {
        auth.revoke()
        if (this.remoteOrigins.get(auth.authority) === registration) this.remoteOrigins.delete(auth.authority)
        await dispose()
      },
    }
  }

  private remoteOriginFor(request: ConnectionTrustRequest): RemoteOriginRegistration | undefined {
    return [...this.remoteOrigins.values()].find(remote => remote.auth.matches(request))
  }

  /** Add this process's launch token to the clean application URL. */
  authenticatedUrl(baseUrl: string): string {
    return this.browserAuth.authenticatedUrl(baseUrl)
  }

  /**
   * Compose one shared-channel Fetch handler from exact routes and its interceptor.
   * @param channel - shared channel mounted by Connection.
   * @param peer - already admitted Peer; local owned carriers default to the operator.
   * @returns Fetch handler that selects one owner or returns 404.
   */
  createSharedFetchHandler(
    channel: '/api',
    peer: PeerScope = this.operator,
  ): ConnectionFetchHandler {
    return {
      requestBodyMode: ({ method, url }) => {
        const route = this.fetchRoutes.get(url.pathname)
        return route?.methods.has(method) === true ? route.requestBody : 'buffered'
      },
      fetch: (request) => {
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) return route.fetch(request)
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return rpcFetchHandler(channel, interceptor.handler, peer).fetch(request)
      },
    }
  }

  private registerFetchRoute(
    owner: Context,
    route: ConnectionFetchRoute,
  ): () => Promise<void> {
    assertFetchRoute(route)
    const registered: RegisteredFetchRoute = {
      methods: new Set(route.methods),
      requestBody: route.requestBody,
      fetch: route.fetch,
    }
    return owner.effect(() => {
      if (this.fetchRoutes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      }
      this.fetchRoutes.set(route.path, registered)
      return () => { this.fetchRoutes.delete(route.path) }
    }, `client-connection: ${route.path} Fetch route`)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    assertChannel(channel)
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const admission = this.admit(req)
        if ('rejection' in admission) {
          res.writeHead(admission.rejection)
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await bridge(req, res, rpcFetchHandler(channel, handler, admission.peer))
      },
    }
    return owner.effect(
      () => owner.webServer.register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      handler,
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
  peer: PeerScope,
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      try {
        const result = await handler(endpoint, message.payload, request.signal, peer)
        return fullResponse(message.rpcId, result)
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: readonly object[]): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'gateway/bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: ConnectionRpcFailure): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: Awaited<ReturnType<ConnectionRpcHandler>>): Response {
  if (!result.ok) {
    const body: ConnectionServerResponse = { type: 'server-response', rpcId, result }
    return Response.json(body)
  }
  const { attachments, ...success } = result
  const body: ConnectionServerResponse = { type: 'server-response', rpcId, result: success }
  if (attachments === undefined || attachments.length === 0) return Response.json(body)
  const parts = new FormData()
  const attachmentMetadata = attachments.map((attachment, index) => {
    const part = `bytes-${index}`
    // FileSystem bytes may have SharedArrayBuffer backing, which BlobPart excludes.
    parts.set(part, new Blob([new Uint8Array(attachment.bytes)]))
    return { path: [...attachment.path], codec: 'bytes' as const, part }
  })
  parts.set('metadata', JSON.stringify({ ...body, attachments: attachmentMetadata }))
  return new Response(parts)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

function assertFetchRoute(route: ConnectionFetchRoute): void {
  // Fetch assets may have percent-encoded names; RPC endpoint identifiers remain
  // restricted by endpointFromPath. Reject aliases that URL parsing normalizes.
  let valid = false
  try {
    valid = route.path.startsWith(`${API_PATH}/`)
      && new URL(route.path, 'https://connection.invalid').pathname === route.path
      && !/[?#\\]|\s|[\x00-\x1f]/u.test(route.path)
      && route.path.slice(API_PATH.length + 1).split('/').every((segment) => {
        const decoded = decodeURIComponent(segment)
        return decoded !== '' && decoded !== '.' && decoded !== '..' && !/[/\\\x00-\x1f]/u.test(decoded)
      })
  } catch { valid = false }
  if (!valid) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  const methods = new Set(route.methods)
  if (methods.size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
}
