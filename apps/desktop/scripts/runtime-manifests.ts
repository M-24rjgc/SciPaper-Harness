/** Apply electron-builder's package metadata cleanup before runtime integrity sealing. */

import { readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// The installed builder omits internal functions from its declaration files.
const { createTransformer } = createRequire(import.meta.url)('app-builder-lib/out/fileTransformer.js') as {
  createTransformer(root: string, config: object): (file: string) => Promise<string | null | undefined> | null
}

/**
 * Normalize production manifests with the same transformer used by ASAR packaging.
 * @param root - Materialized runtime directory; source packages remain untouched.
 */
export async function normalizeRuntimeManifests(root: string): Promise<void> {
  const transform = createTransformer(root, {})
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name === 'package.json') {
        const content = await transform(path)
        if (content != null) await writeFile(path, content)
      }
    }
  }
  await visit(join(root, 'node_modules'))
}
