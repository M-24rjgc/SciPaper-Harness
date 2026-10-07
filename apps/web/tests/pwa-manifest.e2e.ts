import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  expect(manifest).toEqual({
    name: 'SciPaper Harness',
    short_name: 'SPH',
    start_url: './',
    scope: './',
    display: 'standalone',
    theme_color: '#f5f2ec',
    background_color: '#f5f2ec',
    icons: [{
      src: 'favicon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    }, {
      src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any',
    }, {
      src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any',
    }],
  })
})

it('ships the SciPaper brand icon and safe-area mobile viewport', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" />')
  expect(index).toContain('viewport-fit=cover')
  expect(index).toContain('interactive-widget=resizes-content')
  const light = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  expect(light).not.toContain('<style>')
  expect(light).toContain('<title>SciPaper Harness</title>')
  expect(light).toContain('fill="#15635f"')
  for (const name of ['icon-192.png', 'icon-512.png']) {
    const icon = await readFile(join(DIST_ROOT, name))
    expect(icon.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  }
})
