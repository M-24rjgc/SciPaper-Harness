/** The product-owned Python hook coexists with upstream startup customizations. */
import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installResearchPythonPaths } from '../scripts/research-components.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('installs the early path hook idempotently and preserves existing sitecustomize bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-python-paths-'))
  roots.push(root)
  const site = join(root, 'Lib', 'site-packages')
  await mkdir(site, { recursive: true })
  const existing = '# upstream startup\r\nvalue = 7\r\n'
  await writeFile(join(site, 'sitecustomize.py'), existing)
  await installResearchPythonPaths(root)
  await installResearchPythonPaths(root)
  expect(await readFile(join(site, 'sitecustomize.py'), 'utf8')).toBe(existing)
  expect(await readFile(join(site, '00_scipaper_python_paths.pth'), 'utf8')).toBe('import _scipaper_python_paths\n')
  expect(await readFile(join(site, '_scipaper_python_paths.py'), 'utf8')).toContain('ntpath.normpath')
})

it.each(['_scipaper_python_paths.py', '00_scipaper_python_paths.pth'])('refuses to replace a conflicting %s', async (name) => {
  const root = await mkdtemp(join(tmpdir(), 'research-python-paths-'))
  roots.push(root)
  const site = join(root, 'Lib', 'site-packages')
  await mkdir(site, { recursive: true })
  await writeFile(join(site, name), 'existing unrelated payload\n')
  await expect(installResearchPythonPaths(root)).rejects.toThrow('bootstrap conflicts')
  expect(await readFile(join(site, name), 'utf8')).toBe('existing unrelated payload\n')
})
