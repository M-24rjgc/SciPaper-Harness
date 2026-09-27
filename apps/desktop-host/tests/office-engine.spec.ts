import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire, type ModuleHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { installOfficeEngineResolution } from '../src/office-engine.ts'

const roots: string[] = []
const hooks: Pick<ModuleHooks, 'deregister'>[] = []
afterEach(() => {
  for (const hook of hooks.splice(0)) hook.deregister()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(runtimeName = 'dsh') {
  const root = mkdtempSync(join(tmpdir(), 'desktop-office-resolution-'))
  roots.push(root)
  const runtime = join(root, 'app.asar', runtimeName)
  const manifest = 'node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/package.json'
  for (const base of [runtime, join(root, 'app.asar.unpacked', runtimeName)]) {
    const path = join(base, manifest)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-darwin-arm64', path: realpathSync(dirname(path)) }))
  }
  const api = join(runtime, 'node_modules/@deepseek-ai/libreoffice-kit/package.json')
  mkdirSync(dirname(api), { recursive: true })
  writeFileSync(api, '{"name":"@deepseek-ai/libreoffice-kit"}')
  const require: (specifier: string) => unknown = createRequire(join(runtime, 'package.json'))
  const hook = installOfficeEngineResolution(runtime)!
  hooks.push(hook)
  return { root, runtime, manifest, require }
}

it('resolves engine manifests to physical directories and leaves unrelated modules alone', () => {
  const f = fixture()
  // Node 24.13 require.resolve bypasses hooks; Electron's require.resolve is covered by packaged Office smoke.
  expect(f.require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json'))
    .toMatchObject({ path: realpathSync(dirname(join(f.root, 'app.asar.unpacked', 'dsh', f.manifest))) })
  expect((f.require('node:fs') as typeof import('node:fs')).realpathSync).toBe(realpathSync)
  expect(f.require('@deepseek-ai/libreoffice-kit/package.json')).toEqual({ name: '@deepseek-ai/libreoffice-kit' })
})

it('rejects an engine missing from the unpacked tree instead of using its archived copy', () => {
  const f = fixture()
  rmSync(join(f.root, 'app.asar.unpacked'), { recursive: true })
  expect(() => { f.require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json') }).toThrow()
})

it('installs Windows native path handling for prepared runtimes', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-office-prepared-'))
  roots.push(root)
  const runtime = join(root, 'dsh')
  mkdirSync(runtime)
  const hook = installOfficeEngineResolution(runtime)
  if (process.platform === 'win32') {
    expect(hook).toBeDefined()
    hooks.push(hook!)
  } else expect(hook).toBeUndefined()
})

it('preserves a renamed runtime directory when locating the unpacked engine', () => {
  const f = fixture('alternate-runtime')
  expect(f.require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json'))
    .toMatchObject({ path: realpathSync(dirname(join(f.root, 'app.asar.unpacked', 'alternate-runtime', f.manifest))) })
})

it('resolves an engine through a directory alias', () => {
  const f = fixture()
  const alias = join(f.root, 'alias')
  symlinkSync(join(f.root, 'app.asar'), alias, 'junction')
  const require: (specifier: string) => unknown = createRequire(join(alias, 'dsh', 'package.json'))
  expect(require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json'))
    .toMatchObject({ path: realpathSync(dirname(join(f.root, 'app.asar.unpacked', 'dsh', f.manifest))) })
})

it('rejects an engine resolved elsewhere inside the archive', () => {
  const f = fixture()
  const other = join(f.root, 'app.asar', 'other', f.manifest)
  mkdirSync(dirname(other), { recursive: true })
  writeFileSync(other, '{}')
  const require = createRequire(join(f.root, 'app.asar', 'other', 'package.json'))
  expect(() => { require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json') })
    .toThrow('outside the runtime package directory')
})

it('leaves external engines and the archived WASM engine at their own locations', () => {
  const f = fixture()
  const external = join(f.root, 'external', f.manifest)
  const wasm = join(f.runtime, 'node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json')
  for (const path of [external, wasm]) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ path: realpathSync(dirname(path)) }))
  }
  const require: (specifier: string) => unknown = createRequire(join(f.root, 'external', 'package.json'))
  expect(require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json'))
    .toMatchObject({ path: realpathSync(dirname(external)) })
  expect(f.require('@deepseek-ai/libreoffice-kit-wasm/package.json'))
    .toMatchObject({ path: realpathSync(dirname(wasm)) })
})

function ownedAlias(engine: string): string {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('scipaper-office-')) continue
    const path = join(tmpdir(), name, 'engine')
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() && realpathSync(path) === engine) return path
  }
  throw new Error('expected a private Office engine alias')
}

it.skipIf(process.platform !== 'win32')('shortens deep native resource paths and removes only the owned alias', () => {
  const f = fixture('runtime-'.repeat(18))
  const engine = realpathSync(dirname(join(f.root, 'app.asar.unpacked', 'runtime-'.repeat(18), f.manifest)))
  f.require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json')
  const alias = ownedAlias(engine)
  expect(join(alias, 'program', 'program', 'services', 'services.rdb').length).toBeLessThan(248)
  hooks.pop()!.deregister()
  expect(existsSync(dirname(alias))).toBe(false)
  expect(existsSync(join(engine, 'package.json'))).toBe(true)
})

it.skipIf(process.platform !== 'win32').each(['directory', 'link', 'same-target-link', 'parent'] as const)(
  'preserves a replacement %s during engine alias teardown', (replacement) => {
    const name = 'runtime-'.repeat(18)
    const f = fixture(name)
    const engine = realpathSync(dirname(join(f.root, 'app.asar.unpacked', name, f.manifest)))
    f.require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json')
    const alias = ownedAlias(engine)
    const parent = dirname(alias)
    const moved = `${parent}-moved`
    if (replacement === 'parent') {
      renameSync(parent, moved)
      mkdirSync(parent)
      writeFileSync(join(parent, 'sentinel'), 'preserved')
    } else {
      if (replacement === 'same-target-link') renameSync(alias, `${alias}-old`)
      else unlinkSync(alias)
      if (replacement === 'same-target-link') symlinkSync(engine, alias, 'junction')
      else if (replacement === 'link') symlinkSync(f.root, alias, 'junction')
      else { mkdirSync(alias); writeFileSync(join(alias, 'sentinel'), 'preserved') }
    }
    try {
      hooks.pop()!.deregister()
      if (replacement === 'link') expect(realpathSync(alias)).toBe(realpathSync(f.root))
      else if (replacement === 'same-target-link') expect(realpathSync(alias)).toBe(engine)
      else expect(readFileSync(join(replacement === 'parent' ? parent : alias, 'sentinel'), 'utf8')).toBe('preserved')
    } finally {
      if (replacement === 'parent') { unlinkSync(join(moved, 'engine')); rmdirSync(moved); unlinkSync(join(parent, 'sentinel')) }
      else if (replacement === 'link') unlinkSync(alias)
      else if (replacement === 'same-target-link') { unlinkSync(alias); unlinkSync(`${alias}-old`) }
      else { unlinkSync(join(alias, 'sentinel')); rmdirSync(alias) }
      rmdirSync(parent)
    }
  },
)

it('rejects an unpacked engine redirected outside its package', () => {
  const f = fixture()
  const engine = dirname(join(f.root, 'app.asar.unpacked', 'dsh', f.manifest))
  const moved = join(f.root, 'replaced-engine')
  renameSync(engine, moved)
  symlinkSync(moved, engine, 'junction')
  try {
    expect(() => { f.require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json') })
      .toThrow('outside its unpacked package directory')
  } finally { unlinkSync(engine) }
})
