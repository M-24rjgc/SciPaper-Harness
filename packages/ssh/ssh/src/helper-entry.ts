/** Private OpenSSH process entry; the helper module owns request and cleanup behavior. */
/* v8 ignore file -- launched through plain Node in SSH acceptance; helper behavior is exercised through its explicit streams. */
import { fileURLToPath } from 'node:url'
import { runSshHelper, runSshStreamBridge } from './helper.ts'

const controller = new AbortController()
const stop = (): void => { controller.abort(new Error('SSH helper process terminated')) }
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.once(signal, stop)
try {
  const entryPath = fileURLToPath(import.meta.url)
  if (process.argv.length === 2) {
    await runSshHelper({ input: process.stdin, output: process.stdout, entryPath, signal: controller.signal })
  } else if (process.argv.length === 5 && process.argv[2] === '--stream') {
    await runSshStreamBridge({
      input: process.stdin, output: process.stdout, entryPath,
      path: process.argv[3] as string, helperHash: process.argv[4] as string,
      signal: controller.signal,
    })
  } else throw new Error('SSH helper received unsupported command arguments')
} catch (error) {
  process.stderr.write(`dsh-ssh-sandbox: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 127
} finally {
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.off(signal, stop)
}
