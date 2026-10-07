/** Native main-frame proof for authenticated Desktop Host forwarding. */
import { randomBytes } from 'node:crypto'
import { SCHEME } from './ipc.ts'

/** Private carrier header, removed before a request reaches the Host. */
export const DESKTOP_REQUEST_AUTH_HEADER = 'x-dsh-desktop-frame'

const PACKAGE = '(?:@[a-z0-9._-]+/)?[a-z0-9._-]+'
const COMBO = new RegExp(`^\\?\\?${PACKAGE}/client\\.js(?:\\.map)?(?:,${PACKAGE}/client\\.js(?:\\.map)?)*&rev=[a-f0-9]{12}$`, 'u')
const CHUNK = new RegExp(`^/plugins/${PACKAGE}/client\\.[A-Za-z0-9][A-Za-z0-9._-]*\\.js(?:\\.map)?$`, 'u')

/** Only immutable client code and the managed offline editor can be fetched without a main-frame proof. */
function readOnlyAsset(request: Request, url: URL): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  if (url.pathname.startsWith('/api/research/drawio/')) return true
  return (url.pathname === '/plugins/' && COMBO.test(url.search))
    || (CHUNK.test(url.pathname) && /^\?rev=[a-f0-9]{12}$/u.test(url.search))
}

/** Authenticate custom-protocol HTTP forwarding without granting opaque frames or Workers dynamic Host access. */
export class DesktopWebRequestAuthorization {
  private readonly key = randomBytes(32).toString('hex')

  /**
   * Replace renderer-supplied proof headers with native main-frame authorization.
   * @param incoming - Chromium's request headers at the native webRequest callback.
   * @param ownedMainFrame - whether Electron identified the current trusted application main frame.
   * @returns detached headers, with a private proof only for the owned main frame.
   */
  authorizeHeaders(incoming: Record<string, string>, ownedMainFrame: boolean): Record<string, string> {
    const headers = Object.fromEntries(Object.entries(incoming)
      .filter(([name]) => name.toLowerCase() !== DESKTOP_REQUEST_AUTH_HEADER))
    if (ownedMainFrame) headers[DESKTOP_REQUEST_AUTH_HEADER] = this.key
    return headers
  }

  /**
   * Admit native main-frame requests or exact read-only asset URLs, stripping the private proof.
   * @param request - custom-protocol request; its Origin and Fetch Metadata can be absent even for opaque frames.
   * @returns a forwarding request without the proof, or undefined when dynamic Host access is refused.
   */
  admit(request: Request): Request | undefined {
    const url = new URL(request.url)
    if (url.protocol !== `${SCHEME}:` || url.hostname !== 'app' || url.username !== '' || url.password !== '' || url.port !== '') return undefined
    if (request.headers.get(DESKTOP_REQUEST_AUTH_HEADER) !== this.key && !readOnlyAsset(request, url)) return undefined
    const headers = new Headers(request.headers)
    headers.delete(DESKTOP_REQUEST_AUTH_HEADER)
    return new Request(request, { headers })
  }
}
