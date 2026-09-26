import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('desktop development launcher', () => {
  it.each([
    { entry: String.raw`C:\Program Files\pnpm\pnpm.exe`, native: true },
    { entry: String.raw`C:\Program Files\pnpm\pnpm.cjs`, native: false },
  ])('starts its repository build with $entry', async ({ entry, native }) => {
    vi.resetModules()
    spawn.mockReset()
    vi.stubEnv('npm_execpath', entry)
    vi.stubGlobal('process', { ...process, argv: [process.execPath, 'dev.ts'], exitCode: undefined })
    const stopped = Promise.withResolvers<undefined>()
    vi.spyOn(console, 'error').mockImplementation(() => { stopped.resolve(undefined) })
    spawn.mockImplementation(() => {
      const child = new EventEmitter()
      queueMicrotask(() => { child.emit('error', new Error('stop before the fixture build')) })
      return child
    })

    await import('../scripts/dev.ts')
    await stopped.promise

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      native ? entry : process.execPath,
      native ? ['run', 'build'] : [entry, 'run', 'build'],
      expect.objectContaining({ cwd: resolve(import.meta.dirname, '../../..'), stdio: 'inherit' }),
    )
    expect(console.error).toHaveBeenCalledWith('stop before the fixture build')
  })
})
