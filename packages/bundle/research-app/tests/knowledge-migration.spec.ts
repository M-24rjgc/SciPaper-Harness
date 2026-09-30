import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateResearchKnowledge } from '../src/knowledge-migration.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true }) })
const research = '@deepseek-ai/dsh-research-app'
const graph = '@deepseek-ai/dsh-research-knowledge-bundle'
it('preserves existing graph access once, keeps a backup, and respects a later disable across restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-migration-')); roots.push(root)
  const path = join(root, 'package.json')
  const original = JSON.stringify({ name: 'existing', dsh: { profile: { bundles: [research] } } })
  await writeFile(path, original)
  await migrateResearchKnowledge(root)
  const upgraded = JSON.parse(await readFile(path, 'utf8'))
  expect(upgraded.dsh.profile.bundles).toEqual([research, graph])
  expect(await readFile(join(root, 'package.before-knowledge-plugin.json'), 'utf8')).toBe(original)
  upgraded.dsh.profile.bundles = [research]
  await writeFile(path, JSON.stringify(upgraded))
  await migrateResearchKnowledge(root)
  expect(JSON.parse(await readFile(path, 'utf8')).dsh.profile.bundles).toEqual([research])
})
it('does not opt a non-research profile into the graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-nonresearch-')); roots.push(root)
  const path = join(root, 'package.json'), original = JSON.stringify({ dsh: { profile: { bundles: [] } } })
  await writeFile(path, original); await migrateResearchKnowledge(root)
  expect(await readFile(path, 'utf8')).toBe(original)
})
