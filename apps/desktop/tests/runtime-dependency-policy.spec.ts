import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareRuntimeDependencyPolicy } from '../scripts/runtime-dependency-policy.ts'

const roots: string[] = []

function setup(policy: object): { repository: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-policy-'))
  roots.push(root)
  const repository = join(root, 'repository')
  const project = join(root, 'staging')
  mkdirSync(repository)
  mkdirSync(project)
  writeFileSync(join(repository, 'pnpm-workspace.yaml'), yaml.dump(policy))
  writeFileSync(join(project, 'pnpm-workspace.yaml'), yaml.dump({
    packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false,
    overrides: { '@deepseek-ai/dsh': 'file:./desktop-packages/dsh.tgz', '@deepseek-ai/cosmokit': 'file:./desktop-packages/cosmokit.tgz' },
    allowBuilds: { 'node-pty': true, '@google/genai': false },
  }))
  return { repository, project }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('isolated Desktop dependency policy', () => {
  it('retains external safety overrides and exact patch bytes without replacing verified core tarballs', () => {
    const { repository, project } = setup({
      overrides: { 'undici@>=8 <8.10.2': '8.10.2', 'extract-zip>yauzl': '3.4.0', '@deepseek-ai/cosmokit': 'link:vendor/cosmokit' },
      patchedDependencies: { 'extract-zip@2.0.1': 'patches/extract-zip.patch', 'dev-tool@1.0.0': 'patches/dev-tool.patch' },
    })
    mkdirSync(join(repository, 'patches'))
    writeFileSync(join(repository, 'patches/extract-zip.patch'), 'reviewed archive fix\r\n')
    writeFileSync(join(repository, 'patches/dev-tool.patch'), 'reviewed build fix\n')
    prepareRuntimeDependencyPolicy(project, repository)
    expect(yaml.load(readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8'))).toEqual({
      packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false,
      overrides: { 'undici@>=8 <8.10.2': '8.10.2', 'extract-zip>yauzl': '3.4.0',
        '@deepseek-ai/dsh': 'file:./desktop-packages/dsh.tgz', '@deepseek-ai/cosmokit': 'file:./desktop-packages/cosmokit.tgz' },
      allowBuilds: { 'node-pty': true, '@google/genai': false },
      patchedDependencies: { 'extract-zip@2.0.1': 'patches/extract-zip.patch', 'dev-tool@1.0.0': 'patches/dev-tool.patch' },
      allowUnusedPatches: true,
    })
    expect(readFileSync(join(project, 'patches/extract-zip.patch'))).toEqual(readFileSync(join(repository, 'patches/extract-zip.patch')))
    expect(readFileSync(join(project, 'patches/dev-tool.patch'))).toEqual(readFileSync(join(repository, 'patches/dev-tool.patch')))
  })

  it('refuses missing patches before committing a new workspace policy', () => {
    const { repository, project } = setup({ patchedDependencies: { 'package@1.0.0': 'patches/missing.patch' } })
    const before = readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8')
    expect(() => { prepareRuntimeDependencyPolicy(project, repository) }).toThrow(/ENOENT/u)
    expect(readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8')).toBe(before)
  })

  it.each(['../outside.patch', '/outside.patch'])('refuses patch path %s outside repository ownership', (path) => {
    const { repository, project } = setup({ patchedDependencies: { 'package@1.0.0': path } })
    expect(() => { prepareRuntimeDependencyPolicy(project, repository) }).toThrow(/repository-relative/u)
  })

  it('rejects malformed override and patch policies instead of silently omitting dependency fixes', () => {
    const { repository, project } = setup({ overrides: { unsafe: 123 } })
    expect(() => { prepareRuntimeDependencyPolicy(project, repository) }).toThrow(/invalid overrides/u)
    writeFileSync(join(repository, 'pnpm-workspace.yaml'), 'patchedDependencies: []\n')
    expect(() => { prepareRuntimeDependencyPolicy(project, repository) }).toThrow(/invalid patchedDependencies/u)
  })

  it('refuses patch files reached through a repository junction to an external directory', () => {
    const { repository, project } = setup({ patchedDependencies: { 'package@1.0.0': 'patches/external.patch' } })
    writeFileSync(join(project, 'external.patch'), 'unreviewed bytes')
    symlinkSync(project, join(repository, 'patches'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => { prepareRuntimeDependencyPolicy(project, repository) }).toThrow(/resolves outside/u)
  })
})
