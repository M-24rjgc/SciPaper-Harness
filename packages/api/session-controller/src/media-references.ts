/**
 * Authenticated GET/HEAD /api/file reads bounded file responses through
 * the composed filesystem provider. Paths and MIME types do not restrict access;
 * the connection service authenticates requests before this handler.
 * @module @deepseek-ai/dsh-api-session-controller/media-references
 */

import { isAbsolute, posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-attachment'
import { FsError, type FileSystem } from '@deepseek-ai/dsh-fs'
import { SessionId } from '@deepseek-ai/dsh-session'
import mime from 'mime-types'

const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  // HTML and SVG files may be opened directly on the authenticated API origin.
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

async function serveFile(request: Request, fs: FileSystem, maxBytes: number, remote = false): Promise<Response> {
  const fail = (status: number, text: string): Response =>
    new Response(request.method === 'HEAD' ? null : text, { status, headers: BASE_HEADERS })
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path.length === 0) return fail(400, 'missing path')
  if (path.includes('\0') || !(remote ? posix.isAbsolute(path) : isAbsolute(path))) return fail(400, 'absolute path required')
  try {
    const target = await fs.resolve(path, { signal: request.signal })
    const mediaType = mime.lookup(target.displayPath) || 'application/octet-stream'
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': mediaType,
    }
    if (request.method === 'HEAD') {
      const info = await fs.stat(target, request.signal)
      if (info === undefined) return fail(404, 'not found')
      if (info.type !== 'file') return fail(403, 'not a regular file')
      if (info.size !== undefined) {
        if (info.size > maxBytes) return fail(413, 'file exceeds byte limit')
        headers['Content-Length'] = String(info.size)
      }
      return new Response(null, { headers })
    }
    const bytes = await fs.readBytes(target, request.signal, maxBytes)
    headers['Content-Length'] = String(bytes.byteLength)
    return new Response(bytes.slice(), { headers })
  } catch (error: unknown) {
    if (!(error instanceof FsError)) throw error
    const statuses: Partial<Record<FsError['code'], number>> = {
      FS_NOT_FOUND: 404,
      FS_NOT_REGULAR_FILE: 403,
      FS_PERMISSION_DENIED: 403,
      FS_SANDBOX_DENIED: 403,
      FS_TOO_LARGE: 413,
      FS_ABORTED: 499,
    }
    return fail(statuses[error.code] ?? 500, error.code)
  }
}

/**
 * File-display contribution. The connection service supplies authentication;
 * `ctx.fs` supplies the execution world's paths, reads, and access policy.
 */
export const SessionMediaReferences = {
  inject: ['connection', 'fs', 'attachments'],
  apply(ctx: Context): void {
    const maxBytes = ctx.attachments.imageLimits.maxImageBytes
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/file',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const sessionId = new URL(request.url).searchParams.get('sessionId')
        if (sessionId === null) return serveFile(request, ctx.fs, maxBytes)
        const services: { get(name: string): unknown } = ctx
        const id = SessionId(sessionId)
        const sessions = services.get('sessions') as
          | { get(id: SessionId): { header: { execution?: { kind: 'local' } | { kind: 'ssh'; host: string } } } | undefined }
          | undefined
        const persistence = services.get('sessionPersistence') as
          | { stat(id: SessionId): Promise<{ header: { execution?: { kind: 'local' } | { kind: 'ssh'; host: string } } } | undefined> }
          | undefined
        const liveHeader = sessions?.get(id)?.header
        const header = liveHeader ?? (await persistence?.stat(id))?.header
        if (header !== undefined && header.execution?.kind !== 'ssh') return serveFile(request, ctx.fs, maxBytes)
        const controller = services.get('sessionController') as
          | { resolveAgent(id: SessionId): Promise<{ agent: { ctx: Context; session: { header: { execution?: { kind: 'local' } | { kind: 'ssh'; host: string } } } } } | { error: Error }> }
          | undefined
        const presets = services.get('agentPresets') as
          | { serviceFor(agent: { ctx: Context }, name: 'fs'): FileSystem | undefined }
          | undefined
        if (controller === undefined) return new Response('Session service unavailable', { status: 503, headers: BASE_HEADERS })
        const result = await controller.resolveAgent(id)
        if ('error' in result) return new Response('Session unavailable', { status: 404, headers: BASE_HEADERS })
        const remote = result.agent.session.header.execution?.kind === 'ssh'
        if (!remote) return serveFile(request, ctx.fs, maxBytes)
        const fs = presets?.serviceFor(result.agent, 'fs')
        if (fs === undefined || fs === ctx.fs) return new Response('SSH file provider unavailable', { status: 503, headers: BASE_HEADERS })
        return serveFile(request, fs, maxBytes, true)
      },
    }), 'session-controller: /api/file')
  },
}
