import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildRemoteLspArchive } from '../src/provision.ts'

function message(body: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(body))
  return Buffer.concat([Buffer.from(`Content-Length: ${json.length}\r\n\r\n`), json])
}

describe('bundled offline TypeScript LSP', () => {
  it('starts from the archived dependency tree and completes LSP initialize', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scipaper-lsp-'))
    try {
      const { bytes, hash } = await buildRemoteLspArchive()
      expect(hash).toMatch(/^[0-9a-f]{64}$/u)
      const entries = JSON.parse(gunzipSync(bytes).toString('utf8')) as Array<[string, string]>
      for (const [relative, base64] of entries) {
        const file = join(root, 'node_modules', relative)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, Buffer.from(base64, 'base64'))
      }
      const cli = join(root, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs')
      expect((await readFile(cli)).length).toBeGreaterThan(100_000)
      const child = spawn(process.execPath, [cli, '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
      const closed = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
      const stderr: Buffer[] = []
      child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
      const initialized = new Promise<Record<string, unknown>>((resolve, reject) => {
        let output = Buffer.alloc(0)
        const timer = setTimeout(() => {
          reject(new Error(`offline LSP initialize timed out: ${Buffer.concat(stderr).toString('utf8')}`))
        }, 15_000)
        child.once('error', reject)
        child.once('close', (code) => {
          reject(new Error(`offline LSP exited ${String(code)}: ${Buffer.concat(stderr).toString('utf8')}`))
        })
        child.stdout.on('data', (chunk: Buffer) => {
          output = Buffer.concat([output, chunk])
          for (;;) {
            const boundary = output.indexOf('\r\n\r\n')
            if (boundary < 0) return
            const header = output.subarray(0, boundary).toString('utf8')
            const length = /Content-Length: (\d+)/iu.exec(header)
            if (length === null) { reject(new Error('offline LSP sent invalid framing')); return }
            const end = boundary + 4 + Number(length[1])
            if (output.length < end) return
            const body = JSON.parse(output.subarray(boundary + 4, end).toString('utf8')) as Record<string, unknown>
            output = output.subarray(end)
            if (body.id === 1) { clearTimeout(timer); resolve(body); return }
          }
        })
      })
      try {
        child.stdin.write(message({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { processId: process.pid, rootUri: null, capabilities: {}, workspaceFolders: null },
        }))
        const response = await initialized
        expect(response.id).toBe(1)
        expect(response.result).toHaveProperty('capabilities')
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await closed
      }
    } finally {
      await rm(root, { recursive: true })
    }
  }, 30_000)
})
