/** Real console events reach asynchronous JavaScript shutdown in Electron Node mode. */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecFileOptions } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const require = createRequire(import.meta.url)
let root: string | undefined
let probe: string
let electron: string
let entry: string

/** Await compilation or terminate its owned command tree before fixture cleanup. */
async function compileConsoleProbe(command: string, args: readonly string[], options: ExecFileOptions): Promise<void> {
  const compilation = execute(command, args, options)
  let termination: Promise<unknown> | undefined
  let expired = false
  const timer = setTimeout(() => {
    if (compilation.child.exitCode !== null || compilation.child.signalCode !== null || compilation.child.pid === undefined) return
    expired = true
    termination = execute('taskkill.exe', ['/PID', String(compilation.child.pid), '/T', '/F'], {
      windowsHide: true, timeout: 5_000,
    }).catch((error: unknown) => {
      compilation.child.kill()
      throw error
    })
    // Retain the rejection for the finally await without leaving it unobserved while compilation drains.
    void termination.catch(() => {})
  }, 45_000)
  try {
    await compilation
    if (expired) throw new Error('Console fixture compiler exceeded 45000ms')
  } catch (error) {
    if (expired) throw new Error('Console fixture compiler exceeded 45000ms', { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
    await termination
  }
}

describe.skipIf(process.platform !== 'win32')('Windows Electron console signals', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cli-console-科研-'))
    electron = require('electron') as string
    const programFiles = process.env['ProgramFiles(x86)']
    if (programFiles === undefined || process.env.ComSpec === undefined) throw new Error('Windows compiler environment is unavailable')
    const vswhere = join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    const discoveryStarted = performance.now()
    let vs: string
    try {
      vs = (await execute(vswhere, ['-latest', '-products', '*', '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], {
        windowsHide: true, timeout: 30_000,
      })).stdout.trim()
    } catch (error) {
      const field = (name: string): string => typeof error === 'object' && error !== null && name in error
        ? String(Reflect.get(error, name)) : 'unavailable'
      throw new Error(`Visual Studio discovery failed after ${Math.round(performance.now() - discoveryStarted)}ms (deadline=30000ms): `
        + `code=${field('code')}; signal=${field('signal')}; killed=${field('killed')}\n`
        + `stdout:\n${field('stdout')}\nstderr:\n${field('stderr')}`, { cause: error })
    }
    if (vs === '' || !existsSync(join(vs, 'VC/Auxiliary/Build/vcvars64.bat'))) {
      throw new Error(`Visual Studio discovery returned no usable x64 C++ installation: ${JSON.stringify(vs)}`)
    }
    probe = join(root, 'console-probe.exe')
    const compile = join(root, 'compile.cmd')
    await copyFile(new URL('fixtures/cli-console-probe.cpp', import.meta.url), join(root, 'console-probe.cpp'))
    // ASCII batch contents and relative compiler inputs keep Unicode paths in native cwd/environment arguments.
    await writeFile(compile, ['@echo off', 'call "%DSH_CONSOLE_TEST_VCVARS%" >nul',
      'if errorlevel 1 exit /b %errorlevel%',
      'cl /nologo /std:c++17 /EHsc /MT /W4 /WX console-probe.cpp /Foconsole.obj /Feconsole-probe.exe', '',
    ].join('\r\n'))
    try { await compileConsoleProbe(process.env.ComSpec, ['/d', '/v:off', '/c', 'compile.cmd'], { cwd: root, windowsHide: true,
      env: { ...process.env, DSH_CONSOLE_TEST_VCVARS: join(vs, 'VC/Auxiliary/Build/vcvars64.bat').replaceAll('%', '%%') } }) }
    catch (error) {
      const output = typeof error === 'object' && error !== null
        ? ['stdout', 'stderr'].map(field => field in error ? String(Reflect.get(error, field)) : '').join('\n') : ''
      throw new Error(`Console fixture compilation failed:\n${output}`, { cause: error })
    }
    // Only TypeScript is erased; the child has no source-loader hook that could change signal handling.
    const source = await readFile(new URL('../../desktop-host/src/windows-cli-signals.ts', import.meta.url), 'utf8')
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
      .replace(/(['"])koffi\1/u, JSON.stringify(pathToFileURL(require.resolve('koffi')).href))
    await writeFile(join(root, 'signals.mjs'), code)
    entry = join(root, 'entry.mjs')
    await writeFile(entry, [
      "import { writeFileSync } from 'node:fs'",
      "import { writeFile } from 'node:fs/promises'",
      "import { installWindowsCliSignals } from './signals.mjs'",
      'await installWindowsCliSignals()',
      'const [marker, ready] = process.argv.slice(2)',
      "for (const [signal, code] of [['SIGINT',130],['SIGBREAK',131]]) process.on(signal, async () => {",
      '  await writeFile(marker, signal); process.exit(code)',
      '})',
      "writeFileSync(ready, 'ready')",
      'setInterval(() => {}, 1000)', '',
    ].join('\n'))
  }, 90_000)

  afterAll(async () => {
    if (root === undefined) return
    await chmod(root, 0o700)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it.each([['SIGINT', '0'], ['SIGBREAK', '1']] as const)('delivers %s before process exit', async (signal, event) => {
    if (root === undefined) throw new Error('Console fixture is not prepared')
    const marker = join(root, signal + '.txt')
    const ready = join(root, signal + '.ready')
    const report = join(root, signal + '.report')
    let failure: unknown
    try { await execute(probe, [electron, entry, marker, ready, report, event], { windowsHide: true, timeout: 35_000 }) }
    catch (error) { failure = error }
    const observed = existsSync(report) ? await readFile(report, 'utf8') : 'Console probe exited before reporting.'
    expect(failure, observed).toBeUndefined()
    expect(await readFile(marker, 'utf8')).toBe(signal)
  }, 40_000)
})
