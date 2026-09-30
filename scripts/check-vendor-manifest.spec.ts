/** The vendor manifest guard runs through its shebang and a POSIX shell. */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./check-vendor-manifest.sh', import.meta.url))
const gitExecPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
const shellDirectory = process.platform === 'win32' ? resolve(gitExecPath, '../../../usr/bin') : '/bin'
const launcher = join(shellDirectory, process.platform === 'win32' ? 'sh.exe' : 'sh')
const dash = join(shellDirectory, process.platform === 'win32' ? 'dash.exe' : 'dash')
const posixShell = existsSync(dash) ? dash : launcher
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vendor-guard-'))
  roots.push(root)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = `${shellDirectory}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] ?? ''}`
  function git(args: string[]) {
    return execFileSync('git', args, { cwd: root, env, encoding: 'utf8' })
  }
  git(['init', '--quiet'])
  const guard = join(root, 'check-vendor-manifest.sh')
  copyFileSync(script, guard)
  chmodSync(guard, 0o755)
  function stage(file: string) {
    const target = join(root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'change\n')
    git(['add', '--', file])
  }
  return { root, env, stage }
}

describe.each(['shebang', 'POSIX shell'] as const)('vendor manifest guard through %s', (mode) => {
  it.each([
    { name: 'an empty index', files: [], status: 0 },
    { name: 'ordinary source changes', files: ['packages/example/src/index.ts'], status: 0 },
    { name: 'vendor package metadata', files: ['vendor/example/package.json'], status: 0 },
    { name: 'vendor source without its manifest', files: ['vendor/example/src/index.ts'], status: 1 },
    { name: 'a vendor bin without its manifest', files: ['vendor/example/bin.js'], status: 1 },
    { name: 'vendor source with its manifest', files: ['vendor/example/src/index.ts', 'vendor/README.md'], status: 0 },
  ])('checks $name', ({ files, status }) => {
    const fixture = repository()
    for (const file of files) fixture.stage(file)
    const result = mode === 'shebang'
      ? spawnSync(launcher, ['-c', 'exec ./check-vendor-manifest.sh'], { cwd: fixture.root, env: fixture.env, encoding: 'utf8' })
      : spawnSync(posixShell, ['./check-vendor-manifest.sh'], { cwd: fixture.root, env: fixture.env, encoding: 'utf8' })

    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(status)
    if (status === 1) {
      expect(result.stdout).toContain('vendored SOURCE changed without updating vendor/README.md')
      expect(result.stdout).toContain(files[0])
    } else expect(result.stdout).toBe('')
  })
})
