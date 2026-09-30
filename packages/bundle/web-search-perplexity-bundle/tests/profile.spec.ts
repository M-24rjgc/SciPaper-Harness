import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches, OPTIONAL_BUNDLES, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

const root = fileURLToPath(new URL('..', import.meta.url))
const name = '@deepseek-ai/dsh-web-search-perplexity-bundle'

describe('optional Perplexity search bundle', () => {
  it('is offered in Plugins but off in every shipped profile', () => {
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
    expect(manifest.dependencies).toMatchObject({ '@deepseek-ai/dsh-web-search-perplexity': 'workspace:*' })
  })

  it('selects Perplexity and mounts its provider as one optional layer', () => {
    const base = fileURLToPath(new URL('../../base/cordis.patch.yml', import.meta.url))
    const entries = composeEntries([
      loadOverlayPatches('base spec', base),
      loadOverlayPatches('Perplexity bundle spec', join(root, 'cordis.patch.yml')),
    ])
    expect(entries.find(entry => entry.id === 'web')).toMatchObject({
      config: { searchProvider: 'perplexity', fetchProvider: 'http' },
    })
    expect(entries.find(entry => entry.id === 'web-search-perplexity')).toMatchObject({
      name: '@deepseek-ai/dsh-web-search-perplexity',
    })
  })
})
