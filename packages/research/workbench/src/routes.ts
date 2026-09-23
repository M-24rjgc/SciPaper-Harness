/** Read-only project previews and offline editor assets on the shared desktop/Web carrier. */
import { dirname, extname } from 'node:path'
import { readFile, readdir, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ResearchWorkbench } from './index.ts'
import type { ProjectId } from './types.ts'
import { errorText, projectPath } from './files.ts'

const mime: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.xml': 'application/xml', '.json': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  // Paper sources and records preview as text, never as something the browser would run.
  ...Object.fromEntries(['.tex', '.bib', '.md', '.csv', '.tsv', '.log', '.py', '.yaml', '.yml', '.drawio', '.sty', '.cls', '.bst']
    .map(extension => [extension, 'text/plain; charset=utf-8'])),
}

/** Register authenticated resources; refresh editor routes after a component installation. */
export function registerResearchRoutes(ctx: Context, service: ResearchWorkbench): () => Promise<void> {
  let refresh = async (): Promise<void> => {}
  ctx.inject(['connection'], async (carrier) => {
    const registered = new Set<string>()
    let disposed = false
    carrier.effect(() => () => { disposed = true; refresh = async () => {} }, 'research.resource-lifetime')
    const serve = async (request: Request, file: string, preview: boolean): Promise<Response> => {
      const info = await stat(file)
      if (!info.isFile() || info.size > service.config.maxSourceBytes) {
        throw new Error('Preview file exceeds the configured limit')
      }
      const headers: Record<string, string> = {
        'Content-Type': mime[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      }
      // A sandboxed document cannot host the browser's PDF viewer, so PDFs are served
      // unsandboxed; everything else previews with no script or network permission.
      if (preview && extname(file).toLowerCase() !== '.pdf') {
        headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"
      }
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(await readFile(file)), { headers })
    }
    const register = (path: string, resolveFile: (request: Request) => Promise<string>, preview: boolean): void => {
      if (disposed || registered.has(path)) return
      carrier.effect(() => carrier.connection.fetch.register({
        path,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try { return await serve(request, await resolveFile(request), preview) }
          catch (error) {
            return new Response(errorText(error), { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
          }
        },
      }), `research.resource:${path}`)
      registered.add(path)
    }
    register('/api/research/file', async (request) => {
      const url = new URL(request.url)
      const project = service.getProject((url.searchParams.get('projectId') ?? '') as ProjectId)
      return projectPath(project.root, url.searchParams.get('path') ?? '')
    }, true)
    refresh = async () => {
      const status = (await service.components.status()).find(item => item.id === 'drawio')
      if (!status?.installed || disposed) return
      const root = dirname(status.path)
      const visit = async (relative: string): Promise<void> => {
        const directory = await projectPath(root, relative || '.')
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const name = relative ? `${relative}/${entry.name}` : entry.name
          if (entry.isDirectory()) await visit(name)
          else if (entry.isFile()) {
            register(`/api/research/drawio/${name.split('/').map(encodeURIComponent).join('/')}`, () => projectPath(root, name), false)
          }
        }
      }
      await visit('')
    }
    await refresh()
  })
  return () => refresh()
}
