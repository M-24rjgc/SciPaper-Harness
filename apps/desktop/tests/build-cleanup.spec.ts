import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { assertOwnedBuildPath, removeOwnedBuildDirectory, removeOwnedBuildFile } from '../scripts/build-cleanup.ts'
import { removeOwnedDirectory } from '../src/owned-directory.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readdirSync: vi.fn(actual.readdirSync), unlinkSync: vi.fn(actual.unlinkSync) }
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeOwnedDirectory(root)
  vi.clearAllMocks()
})

function fixture(): { root: string; owner: string; external: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), '科研 打包清理-'))
  roots.push(root)
  const owner = join(root, '.desktop-build'), external = join(root, '保留项目')
  mkdirSync(owner)
  mkdirSync(external)
  writeFileSync(join(external, 'paper.txt'), 'preserved')
  return { root, owner, external }
}

function directoryLink(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

it('removes only the selected tree and file in Chinese and spaced paths', () => {
  const { owner, external } = fixture()
  const output = join(owner, 'targets', 'win-x64', '准备 runtime')
  mkdirSync(join(output, 'nested'), { recursive: true })
  writeFileSync(join(output, 'nested', 'file.txt'), 'output')
  writeFileSync(join(owner, 'keep.txt'), 'cache')
  removeOwnedBuildDirectory(output, owner)
  expect(existsSync(output)).toBe(false)
  expect(readFileSync(join(owner, 'keep.txt'), 'utf8')).toBe('cache')
  const record = join(owner, 'release.json')
  writeFileSync(record, '{}')
  removeOwnedBuildFile(record, owner)
  expect(existsSync(record)).toBe(false)
  expect(readFileSync(join(external, 'paper.txt'), 'utf8')).toBe('preserved')
})

it('accepts absent owned outputs and records without masking invalid paths', () => {
  const { owner } = fixture()
  expect(() => { removeOwnedBuildDirectory(join(owner, 'not-created', 'runtime'), owner) }).not.toThrow()
  expect(() => { removeOwnedBuildFile(join(owner, 'not-created', 'record.json'), owner) }).not.toThrow()
  expect(() => { removeOwnedBuildDirectory(join(owner, '..', 'absent'), owner) }).toThrow('outside the owned directory')
})

it('refuses the owner itself, relative paths, siblings and traversal before deletion', () => {
  const { owner, external } = fixture()
  for (const path of [owner, external, `${owner}-sibling`, join(owner, '..', '保留项目')]) {
    expect(() => { removeOwnedBuildDirectory(path, owner) }).toThrow('outside the owned directory')
  }
  expect(() => { assertOwnedBuildPath('relative', owner) }).toThrow('paths must be absolute')
  expect(() => { assertOwnedBuildPath(join(owner, 'child'), 'relative') }).toThrow('paths must be absolute')
  expect(readFileSync(join(external, 'paper.txt'), 'utf8')).toBe('preserved')
})

it('unlinks root, nested and broken junctions while preserving external projects', () => {
  const { root, owner, external } = fixture()
  const output = join(owner, 'runtime')
  mkdirSync(output)
  directoryLink(external, join(output, 'source-project'))
  directoryLink(join(root, 'absent-target'), join(output, 'broken'))
  removeOwnedBuildDirectory(output, owner)
  const rootLink = join(owner, 'staging')
  directoryLink(external, rootLink)
  removeOwnedBuildDirectory(rootLink, owner)
  expect(existsSync(output)).toBe(false)
  expect(existsSync(rootLink)).toBe(false)
  expect(readFileSync(join(external, 'paper.txt'), 'utf8')).toBe('preserved')
})

it('rejects linked ancestors including a replaced owner and preserves their targets', () => {
  const { root, owner, external } = fixture()
  const ancestor = join(owner, 'targets')
  directoryLink(external, ancestor)
  expect(() => { removeOwnedBuildDirectory(join(ancestor, 'paper.txt'), owner) }).toThrow('linked ancestor')
  const linkedOwner = join(root, '.desktop-build-alias')
  directoryLink(external, linkedOwner)
  expect(() => { removeOwnedBuildFile(join(linkedOwner, 'paper.txt'), linkedOwner) }).toThrow('linked ancestor')
  expect(readFileSync(join(external, 'paper.txt'), 'utf8')).toBe('preserved')
})

it('propagates ordinary file and directory deletion failures', () => {
  const { owner } = fixture()
  const record = join(owner, 'record.json'), output = join(owner, 'runtime')
  writeFileSync(record, '{}')
  mkdirSync(output)
  const permission = Object.assign(new Error('file permission denied'), { code: 'EACCES' })
  vi.mocked(unlinkSync).mockImplementationOnce(() => { throw permission })
  expect(() => { removeOwnedBuildFile(record, owner) }).toThrow(permission)
  expect(existsSync(record)).toBe(true)
  const busy = Object.assign(new Error('directory busy'), { code: 'EBUSY' })
  vi.mocked(readdirSync).mockImplementationOnce(() => { throw busy })
  expect(() => { removeOwnedBuildDirectory(output, owner) }).toThrow(busy)
  expect(existsSync(output)).toBe(true)
  const missingChild = Object.assign(new Error('child disappeared'), { code: 'ENOENT' })
  vi.mocked(readdirSync).mockImplementationOnce(() => { throw missingChild })
  expect(() => { removeOwnedBuildDirectory(output, owner) }).toThrow(missingChild)
})

it('refuses an existing non-directory output and does not treat ENOTDIR as absence', () => {
  const { owner } = fixture()
  const file = join(owner, 'not-directory')
  writeFileSync(file, 'keep')
  expect(() => { removeOwnedBuildDirectory(file, owner) }).toThrow('not a directory')
  expect(() => { removeOwnedBuildFile(join(file, 'record.json'), owner) }).toThrow()
  expect(readFileSync(file, 'utf8')).toBe('keep')
})
