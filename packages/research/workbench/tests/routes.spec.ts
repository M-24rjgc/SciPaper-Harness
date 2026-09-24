import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { ResearchWorkbench } from '../src/index.ts'
import { registerResearchRoutes } from '../src/routes.ts'

let root: string | undefined
let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); if (root) await rm(root, { recursive: true, force: true }) })

it('serves previews without a Web server, registers newly installed editor files and removes routes on disposal', async () => {
  root = await mkdtemp(join(tmpdir(), 'research-routes-'))
  const projectRoot = join(root, '中文 project'), editorRoot = join(root, 'drawio')
  await mkdir(projectRoot)
  await writeFile(join(projectRoot, 'main.pdf'), '%PDF-test')
  const routes = new Map<string, ConnectionFetchRoute>()
  ctx = new Context()
  ctx.provide('connection', { fetch: { register(route: ConnectionFetchRoute) {
    routes.set(route.path, route)
    return async () => { routes.delete(route.path) }
  } } } as Context['connection'])
  let installed = false
  let refresh!: () => Promise<void>
  await writeFile(join(root, 'figure.jpg'), 'jpeg')
  const asked: string[] = []
  const gallery = {
    image: async (id: string) => {
      asked.push(id)
      if (id !== 'neurips2024-1') throw new Error(`The figure gallery has no figure ${id}`)
      return { file: join(root!, 'figure.jpg') }
    },
  }
  const service = { config: { maxSourceBytes: 1024 }, gallery, getProject: () => ({ root: projectRoot }), components: { status: async () => [{ id: 'drawio', installed, path: join(editorRoot, 'index.html') }] } } as unknown as ResearchWorkbench
  const fiber = await ctx.plugin({ apply(c: Context) { refresh = registerResearchRoutes(c, service) } })
  await ctx.fiber.await()
  const preview = routes.get('/api/research/file')!
  const response = await preview.fetch(new Request('https://app/api/research/file?projectId=test&path=main.pdf'))
  expect(response.headers.get('content-type')).toBe('application/pdf')
  expect(await response.text()).toBe('%PDF-test')
  expect((await preview.fetch(new Request('https://app/api/research/file?projectId=test&path=../secret'))).status).toBe(400)
  // Gallery figures come from the gallery's cache, by id.
  const figures = routes.get('/api/research/gallery/image')!
  const figure = await figures.fetch(new Request('https://app/api/research/gallery/image?id=neurips2024-1'))
  expect([figure.headers.get('content-type'), await figure.text()]).toEqual(['image/jpeg', 'jpeg'])
  expect((await figures.fetch(new Request('https://app/api/research/gallery/image'))).status).toBe(400)
  expect(asked).toEqual(['neurips2024-1', ''])
  await mkdir(join(editorRoot, 'js'), { recursive: true })
  await writeFile(join(editorRoot, 'index.html'), '<script src="js/app.js"></script>')
  await writeFile(join(editorRoot, 'js/app.js'), 'editor()')
  installed = true
  await refresh()
  const editor = routes.get('/api/research/drawio/js/app.js')!
  expect(await (await editor.fetch(new Request('https://app/api/research/drawio/js/app.js'))).text()).toBe('editor()')
  await refresh()
  expect(routes.size).toBe(4)
  await fiber.dispose()
  expect(routes.size).toBe(0)
  // After disposal a refresh (a component installed later) registers nothing.
  await refresh()
  expect(routes.size).toBe(0)
})

it('previews sources as inert text, answers HEAD without a body, and refuses directories', async () => {
  root = await mkdtemp(join(tmpdir(), 'research-previews-'))
  const projectRoot = join(root, 'project'), editorRoot = join(root, 'drawio')
  await mkdir(join(projectRoot, 'paper'), { recursive: true })
  await writeFile(join(projectRoot, 'paper/main.tex'), '\\documentclass{article}')
  await writeFile(join(projectRoot, 'paper/blob.bin'), 'bytes')
  await mkdir(editorRoot)
  await writeFile(join(editorRoot, 'index.html'), '<html></html>')
  // A link inside the editor directory is neither a file nor a directory to the walk.
  await symlink(await mkdtemp(join(root, 'linked-')), join(editorRoot, 'linked'), 'junction')
  const routes = new Map<string, ConnectionFetchRoute>()
  ctx = new Context()
  ctx.provide('connection', { fetch: { register(route: ConnectionFetchRoute) {
    routes.set(route.path, route)
    return async () => { routes.delete(route.path) }
  } } } as Context['connection'])
  let components: { id: string; installed: boolean; path: string }[] = []
  let refresh!: () => Promise<void>
  const service = {
    config: { maxSourceBytes: 1024 }, getProject: () => ({ root: projectRoot }), components: { status: async () => components },
  } as unknown as ResearchWorkbench
  const fiber = await ctx.plugin({ apply(c: Context) { refresh = registerResearchRoutes(c, service) } })
  await ctx.fiber.await()
  const preview = routes.get('/api/research/file')!
  const source = await preview.fetch(new Request('https://app/api/research/file?projectId=p&path=paper/main.tex'))
  expect(source.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(source.headers.get('content-security-policy')).toMatch(/^sandbox/)
  expect((await preview.fetch(new Request('https://app/api/research/file?projectId=p&path=paper/blob.bin'))).headers.get('content-type')).toBe('application/octet-stream')
  const head = await preview.fetch(new Request('https://app/api/research/file?projectId=p&path=paper/main.tex', { method: 'HEAD' }))
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
  const directory = await preview.fetch(new Request('https://app/api/research/file'))
  expect(directory.status).toBe(400)
  expect(await directory.text()).toMatch(/configured limit/)

  // No editor, then an editor that is not installed, register nothing; an installed one registers its files.
  await refresh()
  components = [{ id: 'drawio', installed: false, path: join(editorRoot, 'index.html') }]
  await refresh()
  expect(routes.size).toBe(2)
  components = [{ id: 'drawio', installed: true, path: join(editorRoot, 'index.html') }]
  await refresh()
  expect([...routes.keys()].sort()).toEqual(['/api/research/drawio/index.html', '/api/research/file', '/api/research/gallery/image'])
  // A refresh still reading component status when the carrier goes away registers nothing afterwards.
  const late = refresh()
  await fiber.dispose()
  await late
  expect(routes.size).toBe(0)
})
