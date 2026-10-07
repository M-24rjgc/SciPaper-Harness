/** Published PDF and spreadsheet chunks retain their bundled license notices. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { pnpmInvocation } from '../../../../scripts/pnpm-invocation.ts'

const packageRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(packageRoot, '../../..')
const workspacePnpm = join(repositoryRoot, 'node_modules/pnpm/bin/pnpm.cjs')
const bundlePath = join(packageRoot, 'lib/client.js')
const pdfChunkPath = join(packageRoot, 'lib/client.pdf.js')
const require = createRequire(import.meta.url)
const licenseNames = [
  'LICENSE',
  'cmaps/LICENSE',
  'standard_fonts/LICENSE_FOXIT',
  'standard_fonts/LICENSE_LIBERATION',
  'wasm/LICENSE_JBIG2',
  'wasm/LICENSE_OPENJPEG',
  'wasm/LICENSE_PDFJS_JBIG2',
  'wasm/LICENSE_PDFJS_OPENJPEG',
  'wasm/LICENSE_PDFJS_QCMS',
  'wasm/LICENSE_QCMS',
] as const

function run(command: string, args: string[], cwd: string, timeout: number, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout })
  expect(result.error).toBeUndefined()
  expect(result.signal, result.stderr).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

function runPnpm(args: string[], cwd: string, timeout: number, env: NodeJS.ProcessEnv = process.env): string {
  const invocation = pnpmInvocation(args, { ...env, npm_execpath: env.npm_execpath || workspacePnpm })
  return run(invocation.command, invocation.args, cwd, timeout, env)
}

describe('published document preview licenses', () => {
  it('runs workspace pnpm without a lifecycle entrypoint', ({ task }) => {
    const env = { ...process.env }
    Reflect.deleteProperty(env, 'npm_execpath')
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as { packageManager: string }
    expect(runPnpm(['--version'], packageRoot, task.timeout, env).trim()).toBe(manifest.packageManager.split('@')[1])
  })

  it.skipIf(!existsSync(bundlePath))('keeps bundled licenses in the packed lazy chunks', ({ task }) => {
    expect(existsSync(pdfChunkPath)).toBe(true)
    const output = mkdtempSync(join(tmpdir(), 'dsh-document-preview-pack-'))
    try {
      const packed = JSON.parse(runPnpm([
        'pack', '--json', '--pack-destination', output,
      ], packageRoot, task.timeout)) as { filename: string; files: { path: string }[] }
      expect(packed.files.map(file => file.path)).toContain('lib/client.js')
      expect(packed.files.map(file => file.path)).toContain('lib/client.pdf.js')
      expect(packed.files.some(file => file.path.endsWith('pdfjs-NOTICES.txt'))).toBe(false)

      const client = run('tar', ['-xOf', resolve(packageRoot, packed.filename), 'package/lib/client.js'], packageRoot, task.timeout)
      const pdf = run('tar', ['-xOf', resolve(packageRoot, packed.filename), 'package/lib/client.pdf.js'], packageRoot, task.timeout)
      expect([...client.matchAll(/require\.async\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual(['./client.pdf.js', './client.excel.js'])
      expect(client).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect([...pdf.matchAll(/require\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual([])
      expect(client).not.toContain('//! Bundled PDF.js license notices')
      expect(client).not.toContain('/pdfjs-dist/')
      expect(pdf).toContain('//! Bundled PDF.js license notices')
      const excel = run('tar', ['-xOf', resolve(packageRoot, packed.filename), 'package/lib/client.excel.js'], packageRoot, task.timeout)
      expect(excel).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect(client).not.toContain('FortuneSheet')
      expect(excel).toContain('//! Bundled spreadsheet license notices')
      expect(excel).toContain('Copyright (c) 2022 Suzhou Ruilisi Technology Co., Ltd')
      expect(excel).toContain('Permission is hereby granted, free of charge')
      for (const dependency of ['xlsx', 'papaparse']) {
        const root = dirname(require.resolve(dependency === 'xlsx' ? dependency : `${dependency}/package.json`))
        const license = readFileSync(join(root, 'LICENSE'), 'utf8').trimEnd()
        expect(excel).toContain(license.split('\n').map(line => `// ${line}`).join('\n'))
      }
      let initialized = false
      runInNewContext(excel, { window: { __ModuleLoader__: { load: (registration: {
        factory: (resolve: (specifier: string) => unknown) => { ExcelBody: unknown }
      }) => {
        const loaded = registration.factory((specifier) => {
          if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {}
          if (specifier === 'react' || specifier === 'react/jsx-runtime' || specifier === 'react-dom') return require(specifier)
          throw new Error(`Unexpected browser dependency: ${specifier}`)
        })
        expect(typeof loaded.ExcelBody).toBe('function')
        initialized = true
      } } } })
      expect(initialized).toBe(true)
      const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
      for (const name of licenseNames) {
        const source = readFileSync(join(pdfRoot, name), 'utf8').trimEnd()
        const commented = [`// ${name}`, '// ', ...source.split('\n').map(line => `// ${line}`)].join('\n')
        expect(pdf, `${name} must be visible in package/lib/client.pdf.js`).toContain(commented)
      }
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
