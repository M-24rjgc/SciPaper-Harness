/** Release commands resolve pnpm lifecycle entrypoints without a shell. */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attempt, attemptEchoed, capture, runConcurrent } from './process.ts'

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release process-'))
  roots.push(root)
  const entrypoint = join(root, 'pnpm 中文 $;.cjs')
  const result = join(root, 'result.json')
  writeFileSync(entrypoint, `
    const { writeFileSync, realpathSync } = require('node:fs')
    writeFileSync(process.env.DSH_RELEASE_RESULT, JSON.stringify({
      args: process.argv.slice(2),
      cwd: realpathSync(process.cwd()),
      value: process.env.DSH_RELEASE_VALUE,
    }))
    if (process.env.DSH_RELEASE_STDOUT) process.stdout.write(process.env.DSH_RELEASE_STDOUT)
    process.exitCode = Number(process.env.DSH_RELEASE_STATUS || 0)
  `)
  return {
    root,
    entrypoint,
    result,
    env: { ...process.env, DSH_RELEASE_RESULT: result, DSH_RELEASE_VALUE: 'child environment' },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.each(['javascript', 'native'] as const)('release pnpm %s entrypoint', (kind) => {
  it.each([
    ['attempt', attempt],
    ['attemptEchoed', attemptEchoed],
    ['capture', capture],
    ['runConcurrent', runConcurrent],
  ] as const)('%s preserves arguments, working directory, and child environment', async (_name, run) => {
    const files = fixture()
    const args = ['install', '--lockfile-only', 'path with spaces', '中文 $;&']
    const entrypoint = kind === 'native' ? process.execPath : files.entrypoint
    const invocationArgs = kind === 'native' ? [files.entrypoint, ...args] : args

    await run('pnpm', invocationArgs, {
      cwd: files.root,
      env: { ...files.env, npm_execpath: entrypoint },
    })

    expect(JSON.parse(readFileSync(files.result, 'utf8'))).toEqual({
      args,
      cwd: realpathSync(files.root),
      value: 'child environment',
    })
  })
})

it('capture resolves the inherited lifecycle entrypoint and trims output', () => {
  const files = fixture()
  vi.stubEnv('npm_execpath', files.entrypoint)
  vi.stubEnv('DSH_RELEASE_RESULT', files.result)
  vi.stubEnv('DSH_RELEASE_STDOUT', '  package-manager output\n')

  expect(capture('pnpm', ['--version'])).toBe('package-manager output')
})

it('preserves non-zero exit handling after resolving pnpm', async () => {
  const files = fixture()
  const options = { env: { ...files.env, npm_execpath: files.entrypoint, DSH_RELEASE_STATUS: '7' } }

  expect(attempt('pnpm', ['install'], options).status).toBe(7)
  expect(() => capture('pnpm', ['install'], options)).toThrow('pnpm install exited with 7')
  await expect(runConcurrent('pnpm', ['install'], options)).rejects.toThrow('pnpm install exited with 7')
})

it('keeps non-pnpm executables independent of the lifecycle entrypoint', () => {
  const files = fixture()

  expect(attempt(process.execPath, [files.entrypoint], {
    env: { ...files.env, npm_execpath: '' },
  }).status).toBe(0)
})
