/** Browser-session authentication for the Host Connection carrier. */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRemotePairing,
  ConnectionRemotePairingId,
  ConnectionTrustRequest,
} from './rpc.ts'
import { isLoopbackHostname } from './loopback-hostname.ts'

const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const TOKEN_QUERY = 'token'
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
const STORED_SECRET_VERSION = 1
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const PROCESS_LAUNCH_TOKENS = new WeakMap<object, string>()

interface StoredSecretPayload {
  readonly version: typeof STORED_SECRET_VERSION
  readonly secret: string
}

interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly remoteGrantId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function processLaunchToken(owner: object): string {
  const existing = PROCESS_LAUNCH_TOKENS.get(owner)
  if (existing !== undefined) return existing
  const created = encodeBase64Url(randomBytes(SECRET_BYTES))
  PROCESS_LAUNCH_TOKENS.set(owner, created)
  return created
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Canonical request authority used as the cookie name and signed audience. */
function requestAuthority(headers: ConnectionTrustRequest['headers']): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) return undefined
  return decoded
}

function storedSecret(record: CredentialRecord | undefined): Buffer | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)
    || record.payload.version !== STORED_SECRET_VERSION) {
    throw new Error('client-connection: browser-session credential record has an unsupported format')
  }
  const secret = canonicalSecret(record.payload.secret)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record has an invalid secret')
  }
  return secret
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(name: string, value: string, expiresAt: number, maxAgeSeconds: number, secure = false): string {
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function encodeCookie(payload: BrowserCookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): BrowserCookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || decoded.version !== COOKIE_PAYLOAD_VERSION
    || typeof decoded.authority !== 'string'
    || !Number.isSafeInteger(decoded.issuedAt)
    || !Number.isSafeInteger(decoded.expiresAt)
    || (decoded.remoteGrantId !== undefined && typeof decoded.remoteGrantId !== 'string')) return undefined
  return {
    version: COOKIE_PAYLOAD_VERSION,
    authority: decoded.authority,
    issuedAt: Number(decoded.issuedAt),
    expiresAt: Number(decoded.expiresAt),
    ...(typeof decoded.remoteGrantId === 'string' ? { remoteGrantId: decoded.remoteGrantId } : {}),
  }
}

function requestCookiePayload(request: ConnectionTrustRequest, secret: Buffer, cookieAuthority?: string): BrowserCookiePayload | undefined {
  const authority = cookieAuthority ?? requestAuthority(request.headers)
  const rawCookie = header(request.headers, 'cookie')
  if (authority === undefined || rawCookie === undefined) return undefined
  const value = cookieValue(rawCookie, cookieName(authority))
  return value === undefined ? undefined : decodeCookie(value, secret)
}

function validCookieInterval(payload: BrowserCookiePayload, maxAgeMilliseconds: number): boolean {
  const now = Date.now()
  return payload.issuedAt <= now
    && payload.expiresAt > now
    && payload.expiresAt > payload.issuedAt
    && payload.expiresAt - payload.issuedAt <= maxAgeMilliseconds
}

function cleanIndexRedirect(response: ConnectionIndexResponse, setCookie?: string): void {
  response.writeHead(303, {
    'cache-control': 'no-store',
    location: './',
    'referrer-policy': 'no-referrer',
    ...(setCookie === undefined ? {} : { 'set-cookie': setCookie }),
  })
  response.end()
}

async function initializeSecret(credentials: CredentialProvider): Promise<Buffer> {
  const generated: StoredSecretPayload = {
    version: STORED_SECRET_VERSION,
    secret: encodeBase64Url(randomBytes(SECRET_BYTES)),
  }
  const record = await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
    if (current !== undefined) {
      storedSecret(current)
      return Promise.resolve(undefined)
    }
    return Promise.resolve({ kind: 'grant', payload: generated })
  })
  const secret = storedSecret(record)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record was not created')
  }
  return secret
}

/**
 * Process launch-token exchange and persistent signed-cookie verification.
 * Connection loads the credential provider's signing secret during activation
 * and retains it for synchronous request authentication.
 */
export class BrowserAuth {
  private readonly launchToken: string
  private readonly maxAgeMilliseconds: number

  private constructor(
    processOwner: object,
    private readonly secret: Buffer,
    maxAgeDays: number,
  ) {
    this.launchToken = processLaunchToken(processOwner)
    this.maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS
    if (!Number.isSafeInteger(this.maxAgeMilliseconds)
      || !Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)) {
      throw new Error('client-connection: cookieMaxAgeDays exceeds the safe timestamp range')
    }
  }

  /**
   * Initialize browser authentication and create its durable signing secret
   * when this Harness home has none.
   * @param processOwner - root application context retaining one token across Connection reloads.
   * @param credentials - persistent credential provider for the Web profile.
   * @param maxAgeDays - positive absolute browser-cookie lifetime in days.
   * @returns initialized authentication owner with the process owner's launch token.
   */
  static async create(
    processOwner: object,
    credentials: CredentialProvider,
    maxAgeDays: number,
  ): Promise<BrowserAuth> {
    return new BrowserAuth(processOwner, await initializeSecret(credentials), maxAgeDays)
  }

  /**
   * Add this process's launch token to the caller's application URL.
   * @param baseUrl - clean browser URL whose authority and mount are preserved.
   * @returns the same URL carrying the process token as its sole authentication input.
   */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.searchParams.set(TOKEN_QUERY, this.launchToken)
    return url.href
  }

  /**
   * Create authentication for one explicitly enabled HTTPS tunnel origin.
   * @param origin - HTTPS root origin with no URL credentials or mount.
   * @param pairingMaxAgeSeconds - positive lifetime of a single-use invitation.
   * @returns process-scoped remote authentication sharing the durable signing secret.
   */
  createRemoteOrigin(origin: string, pairingMaxAgeSeconds: number): RemoteBrowserAuth {
    return new RemoteBrowserAuth(origin, this.secret, this.maxAgeMilliseconds, pairingMaxAgeSeconds)
  }

  /**
   * Authenticate an index request. A valid root query token mints the cookie
   * and redirects to the directory-relative clean `./`; a valid cookie lets
   * the caller serve the index; every other request receives the same minimal
   * 401 response.
   * @param req - incoming root or configured-index request.
   * @param res - response owned when this method returns false.
   * @returns true only when the caller may serve index.html.
   */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse): boolean {
    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    if (tokens.length > 0) {
      const authority = requestAuthority(req.headers)
      if (req.method === 'GET' && url.pathname === '/' && tokens.length === 1
        && authority !== undefined && tokenMatches(tokens.join(''), this.launchToken)) {
        const issuedAt = Date.now()
        const expiresAt = issuedAt + this.maxAgeMilliseconds
        const value = encodeCookie({
          version: COOKIE_PAYLOAD_VERSION,
          authority,
          issuedAt,
          expiresAt,
        }, this.secret)
        cleanIndexRedirect(res, sessionCookie(
          cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000),
        ))
        return false
      }
      if (req.method === 'GET' && url.pathname === '/' && this.isAuthenticated(req)) {
        cleanIndexRedirect(res)
        return false
      }
      this.writeUnauthorized(req, res)
      return false
    }
    if (this.isAuthenticated(req)) return true
    this.writeUnauthorized(req, res)
    return false
  }

  /**
   * Verify the authority-bound browser cookie on a Host request.
   * @param request - request headers carrying Host and Cookie.
   * @returns true only for an unexpired cookie signed by this activation's loaded secret.
   */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    const authority = requestAuthority(request.headers)
    const payload = requestCookiePayload(request, this.secret)
    return payload !== undefined && payload.authority === authority
      && payload.remoteGrantId === undefined && validCookieInterval(payload, this.maxAgeMilliseconds)
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
  }
}

interface PendingRemotePairing {
  readonly id: ConnectionRemotePairingId
  readonly token: string
  readonly expiresAt: number
}

/** Single-use pairing and signed Secure cookies for one process-scoped HTTPS origin. */
export class RemoteBrowserAuth {
  readonly origin: string
  readonly authority: string
  private readonly grantId = encodeBase64Url(randomBytes(SECRET_BYTES))
  private pending: PendingRemotePairing | undefined
  private revoked = false

  /**
   * @param origin - explicit HTTPS root origin behind the owned loopback tunnel.
   * @param secret - browser-cookie signing secret, never transported to the client.
   * @param maxAgeMilliseconds - absolute cookie lifetime.
   * @param pairingMaxAgeSeconds - positive single-use invitation lifetime.
   */
  constructor(
    origin: string,
    private readonly secret: Buffer,
    private readonly maxAgeMilliseconds: number,
    private readonly pairingMaxAgeSeconds: number,
  ) {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
      || url.pathname !== '/' || url.search !== '' || url.hash !== ''
      || isLoopbackHostname(url.hostname)) {
      throw new Error('client-connection: remote origin must be a non-loopback HTTPS root origin')
    }
    if (!Number.isSafeInteger(pairingMaxAgeSeconds) || pairingMaxAgeSeconds < 1
      || pairingMaxAgeSeconds > 3600) {
      throw new Error('client-connection: remote pairing lifetime must be between 1 and 3600 seconds')
    }
    this.origin = url.origin
    this.authority = url.host
  }

  /**
   * Match the exact configured authority; forwarded headers never select an origin.
   * @param request - actual Host request facts.
   * @returns whether the Host names this enabled origin.
   */
  matches(request: ConnectionTrustRequest): boolean {
    const host = header(request.headers, 'host')
    if (host === undefined) return false
    try { return new URL(`https://${host}`).host === this.authority }
    catch { return false }
  }

  /**
   * Require an attached Origin to be the exact HTTPS origin, including its scheme.
   * @param request - actual Host request facts.
   * @returns whether the browser origin is absent or exactly this HTTPS origin.
   */
  acceptsOrigin(request: ConnectionTrustRequest): boolean {
    const origin = header(request.headers, 'origin')
    return origin === undefined || origin === this.origin
  }

  /**
   * Replace the pending invitation.
   * @returns its private, single-use URL and absolute expiry time.
   */
  createPairingUrl(): ConnectionRemotePairing {
    if (this.revoked) throw new Error('client-connection: remote origin was revoked')
    const pending: PendingRemotePairing = {
      id: randomUUID() as ConnectionRemotePairingId,
      token: encodeBase64Url(randomBytes(SECRET_BYTES)),
      expiresAt: Date.now() + this.pairingMaxAgeSeconds * 1000,
    }
    this.pending = pending
    const url = new URL(this.origin)
    url.searchParams.set('pair', pending.token)
    return { id: pending.id, url: url.href, expiresAt: pending.expiresAt }
  }

  /** @param id - pending invitation identity to withdraw. */
  revokePairing(id: ConnectionRemotePairingId): void {
    if (this.pending?.id === id) this.pending = undefined
  }

  /** Invalidate every invitation and remote cookie synchronously. */
  revoke(): void {
    this.revoked = true
    this.pending = undefined
  }

  /**
   * Verify a signed remote cookie against this live origin's generation.
   * @param request - request carrying the authority-bound browser cookie.
   * @returns whether the cookie belongs to this active origin and remains unexpired.
   */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    const payload = requestCookiePayload(request, this.secret, this.authority)
    return !this.revoked && this.matches(request) && payload !== undefined
      && payload.authority === this.authority && payload.remoteGrantId === this.grantId
      && validCookieInterval(payload, this.maxAgeMilliseconds)
  }

  /**
   * Exchange one invitation for a Secure cookie; the ordinary launch token grants no remote access.
   * @param request - trusted root/index request.
   * @param response - response owned for an exchange, redirect, or refusal.
   * @returns whether the authenticated frontend index may be served.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    const tokens = url.searchParams.getAll('pair')
    const pending = this.pending
    if (!this.revoked && request.method === 'GET' && url.pathname === '/' && tokens.length === 1
      && pending !== undefined && pending.expiresAt > Date.now()
      && tokenMatches(tokens.join(''), pending.token)) {
      this.pending = undefined
      const issuedAt = Date.now()
      const expiresAt = issuedAt + this.maxAgeMilliseconds
      const value = encodeCookie({
        version: COOKIE_PAYLOAD_VERSION, authority: this.authority,
        issuedAt, expiresAt, remoteGrantId: this.grantId,
      }, this.secret)
      cleanIndexRedirect(response, sessionCookie(
        cookieName(this.authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000), true,
      ))
      return false
    }
    if (this.isAuthenticated(request)) {
      if (url.search !== '') { cleanIndexRedirect(response); return false }
      return true
    }
    response.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    response.end(request.method === 'HEAD' ? undefined : 'SciPaper remote pairing required.\n')
    return false
  }
}
