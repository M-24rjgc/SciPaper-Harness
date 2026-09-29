/** Preserve the former built-in graph capability as a one-time optional-bundle selection. */
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/**
 * Select the graph bundle once; subsequent explicit disablement survives every restart.
 * @param profileDir - research profile directory.
 */
export async function migrateResearchKnowledge(profileDir: string): Promise<void> {
  const marker = join(profileDir, 'knowledge-plugin-v1.migrated')
  try { await readFile(marker); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const path = join(profileDir, 'package.json')
  const source = await readFile(path, 'utf8')
  const manifest = JSON.parse(source) as { dsh?: { profile?: { bundles?: string[] } } }
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes('@deepseek-ai/dsh-research-app')) return
  const name = '@deepseek-ai/dsh-research-knowledge-bundle'
  if (!bundles.includes(name)) {
    try { await writeFile(join(profileDir, 'package.before-knowledge-plugin.json'), source, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    bundles.push(name)
    const temporary = join(profileDir, `knowledge-profile-${randomUUID()}.tmp`)
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    try { await rename(temporary, path) } catch (error) { await unlink(temporary); throw error }
  }
  await writeFile(marker, '1\n', { mode: 0o600 })
}
