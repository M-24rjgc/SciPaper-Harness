import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const root = fileURLToPath(new URL('..', import.meta.url))
const workbenchRoot = join(root, '..', '..', 'research', 'workbench')
const workbench = '@deepseek-ai/dsh-research-workbench'

describe('optional research knowledge bundle', () => {
  const entries = composeEntries([loadOverlayPatches('research-knowledge-bundle spec', join(root, 'cordis.patch.yml'))])

  it('inserts the graph engine, the domain map and the evidence graph as three rows, each switched on its own', () => {
    expect(entries.map(entry => [entry.id, entry.name, entry.disabled])).toEqual([
      ['research-knowledge-provider', `${workbench}/knowledge-plugin`, undefined],
      ['research-knowledge-map', `${workbench}/knowledge-map-plugin`, undefined],
      ['research-knowledge-evidence', `${workbench}/knowledge-evidence-plugin`, undefined],
    ])
  })

  it('names and describes every row in English and Chinese from the locale files its module exports', () => {
    const manifest = JSON.parse(readFileSync(join(workbenchRoot, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
    for (const entry of entries) {
      const subpath = entry.name.slice(workbench.length)
      expect(manifest.exports[`.${subpath}`], entry.name).toBeDefined()
      expect(manifest.exports[`.${subpath}/locale/*.json`], entry.name).toBe(`./locale${subpath}/*.json`)
      for (const language of ['en', 'zh']) {
        const { meta } = JSON.parse(readFileSync(join(workbenchRoot, 'locale', subpath, `${language}.json`), 'utf8')) as {
          meta: { title: string; description: string }
        }
        expect(meta.title, `${entry.id} ${language} title`).not.toBe('')
        expect(meta.description, `${entry.id} ${language} description`).not.toBe('')
      }
    }
  })
})
