import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches, OPTIONAL_BUNDLES, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

const root = fileURLToPath(new URL('..', import.meta.url))
const name = '@deepseek-ai/dsh-computer-use-cua-bundle'

describe('optional desktop control bundle', () => {
  it('is available to the plugin manager but off in every shipped profile', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      icon?: string
      exports?: Record<string, unknown>
      dsh?: { bundle?: { patch?: string } }
      dependencies?: Record<string, string>
    }
    expect(OPTIONAL_BUNDLES).toContain(name)
    for (const template of Object.values(PROFILE_TEMPLATES)) expect(template.bundles).not.toContain(name)
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.exports?.['./locale/*.json']).toBeDefined()
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-computer-use': 'workspace:*',
      '@deepseek-ai/dsh-computer-use-cua-driver-native': 'workspace:*',
    })
  })

  it('enables the registry and native provider together as one bundle', () => {
    const entries = composeEntries([loadOverlayPatches('computer-use-cua-bundle spec', join(root, 'cordis.patch.yml'))])
    expect(entries.map(entry => [entry.id, entry.name, entry.disabled])).toEqual([
      ['computer-use', '@deepseek-ai/dsh-computer-use', undefined],
      ['computer-use-cua-native', '@deepseek-ai/dsh-computer-use-cua-driver-native', undefined],
    ])
  })
})
