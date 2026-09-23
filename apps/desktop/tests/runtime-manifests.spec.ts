import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { normalizeRuntimeManifests } from '../scripts/runtime-manifests.ts'
import { verifyDesktopRuntime, writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

it('keeps the sealed dependency inventory intact through repeated builder manifest cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-manifests-'))
  try {
    const descriptor = runtimeFixture(root)
    const manifest = join(writePackage(join(root, 'node_modules'), 'production-dependency', {
      scripts: { prepare: 'node build.js' }, keywords: ['example'], _resolved: 'build-machine',
      bugs: 'https://example.com/issues', dependencies: { helper: '1.0.0' },
      bin: { example: './index.js' }, dsh: { bundle: { patch: 'bundle.yml' } },
    }), 'package.json')
    await normalizeRuntimeManifests(root)
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual({
      name: 'production-dependency', version: '1.0.0', type: 'module', exports: './index.js',
      dependencies: { helper: '1.0.0' }, bin: { example: './index.js' }, dsh: { bundle: { patch: 'bundle.yml' } },
    })
    const sealed = writeDesktopRuntime(root, descriptor.release, descriptor.sharedPackages.map(item => item.name))
    await normalizeRuntimeManifests(root)
    expect(await verifyDesktopRuntime(root, descriptor.release.version)).toEqual(sealed)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
