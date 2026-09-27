/** Published workspace peers retain distinct product and upstream kernel identities. */
import { execFile } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { x } from 'tar'
import { expect, it, onTestFinished } from 'vitest'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '../src/plugin-compatibility.ts'

interface Manifest {
  name: string
  version: string
  scipaper?: { kernel: { name: string; version: string; revision: string } }
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const root = resolve(import.meta.dirname, '../../../..')
const pnpm = join(dirname(createRequire(import.meta.url).resolve('pnpm')), 'bin/pnpm.mjs')
const run = promisify(execFile)

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest
}

function writeManifest(directory: string, manifest: Manifest): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest)}\n`)
}

it('packs the actual research composition and tool manifests without rejecting their resolved product peers', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'scipaper-packed-peers-'))
  onTestFinished(() => { rmSync(temporary, { recursive: true, force: true }) })
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ name: 'pack-fixture', private: true }))
  writeFileSync(join(temporary, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
  const sources = ['packages/bundle/research-app', 'packages/research/workbench']
    .map(path => readManifest(join(root, path, 'package.json')))
  const workspace = new Map(globSync(['packages/*/*/package.json', 'vendor/*/package.json'], { cwd: root })
    .map(path => readManifest(join(root, path))).map(manifest => [manifest.name, manifest]))
  for (const [index, source] of sources.entries()) {
    const directory = join(temporary, 'packages', `source-${index}`)
    writeManifest(directory, source)
    for (const [name, range] of Object.entries({ ...source.dependencies, ...source.peerDependencies, ...source.devDependencies })) {
      if (!range.startsWith('workspace:')) continue
      const dependency = workspace.get(name)
      expect(dependency, name).toBeDefined()
      writeManifest(join(directory, 'node_modules', name), { name, version: dependency!.version })
    }
  }

  const packed: Manifest[] = []
  for (const [index, source] of sources.entries()) {
    const destination = join(temporary, `packed-${index}`)
    mkdirSync(destination)
    const outcome = await run(process.execPath, [pnpm, 'pack', '--config.ignore-scripts=true', '--pack-destination', destination], {
      cwd: join(temporary, 'packages', `source-${index}`), windowsHide: true, timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: '', npm_config_offline: 'true' },
    }).catch((error: unknown) => {
      const stdout = error !== null && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : ''
      throw new Error(`pnpm pack failed: ${stdout}`, { cause: error })
    })
    expect(outcome.stderr).not.toContain('ERR_PNPM')
    const archives = globSync('*.tgz', { cwd: destination })
    expect(archives).toHaveLength(1)
    await x({ file: join(destination, archives[0]!), cwd: destination })
    const manifest = readManifest(join(destination, 'package/package.json'))
    expect(manifest.scipaper).toEqual(source.scipaper)
    expect(manifest.version).toBe(source.version)
    expect(Object.values(manifest.peerDependencies ?? {}).some(range => range.startsWith('workspace:'))).toBe(false)
    expect(evaluatePluginCompatibility(manifest)).toBeUndefined()
    packed.push(manifest)
  }
  const tools = packed[1]!
  expect(tools.peerDependencies?.['@deepseek-ai/dsh-tools']).toBe(tools.version)
  expect(packed[0]!.dependencies?.['@deepseek-ai/dsh-research-workbench']).toBe(tools.version)
  const external = { name: 'external-plugin', version: '1.0.0' }
  expect(evaluatePluginCompatibility({ ...external, peerDependencies: { '@deepseek-ai/dsh-tools': getDshRuntimeVersion() } }))
    .toBeUndefined()
  expect(evaluatePluginCompatibility({ ...external, peerDependencies: { '@deepseek-ai/dsh-tools': '^0.2.0' } })?.peers)
    .toEqual({ '@deepseek-ai/dsh-tools': '^0.2.0' })
  expect(evaluatePluginCompatibility({ ...external, peerDependencies: { '@deepseek-ai/dsh-research-workbench': tools.version } }))
    .toBeUndefined()
  expect(evaluatePluginCompatibility({ ...external, peerDependencies: { '@deepseek-ai/dsh-research-workbench': getDshRuntimeVersion() } })?.peers)
    .toEqual({ '@deepseek-ai/dsh-research-workbench': getDshRuntimeVersion() })
}, 60_000)
