/** Run the bundled Office CLI with the same native engine resolution as the Desktop Host. */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installOfficeEngineResolution } from './office-engine.ts'

const manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))
const runtime = resolve(dirname(manifest), '../../..')
const hook = installOfficeEngineResolution(runtime)
try {
  await import(pathToFileURL(fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/cli'))).href)
} finally {
  hook?.deregister()
}
