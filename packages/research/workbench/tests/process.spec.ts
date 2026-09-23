import { describe, expect, it } from 'vitest'
import { checked, runProcess, shQuote, ssh } from '../src/process.ts'

/** Run a short Node script as the child: the one interpreter every test host has. */
const node = (script: string, options: Parameters<typeof runProcess>[2] = {}) => runProcess(process.execPath, ['-e', script], options)

describe('child processes run bounded, without a shell and without model credentials', () => {
  it('returns output and exit code, feeds stdin, and passes an explicit environment', async () => {
    const echoed = await node('process.stdin.pipe(process.stdout)', { input: 'hello' })
    expect(echoed).toEqual({ code: 0, stdout: 'hello', stderr: '' })
    const failed = await node('process.stderr.write("bad"); process.exit(3)')
    expect(failed).toMatchObject({ code: 3, stderr: 'bad' })
    expect((await node('process.stdout.write(process.env.RESEARCH_FLAG ?? "")', { env: { RESEARCH_FLAG: 'on' } })).stdout).toBe('on')
    expect((await node('process.stdout.write(process.env.PYTHONUTF8)')).stdout).toBe('1')
  })

  it('never hands secrets from the parent environment to a child', async () => {
    process.env.RESEARCH_TEST_API_KEY = 'secret-value'
    process.env.RESEARCH_TEST_TOKEN = 'token-value'
    try {
      const seen = await node('process.stdout.write(JSON.stringify([process.env.RESEARCH_TEST_API_KEY ?? null, process.env.RESEARCH_TEST_TOKEN ?? null]))')
      expect(JSON.parse(seen.stdout)).toEqual([null, null])
    } finally {
      delete process.env.RESEARCH_TEST_API_KEY
      delete process.env.RESEARCH_TEST_TOKEN
    }
  })

  it('stops a child that runs too long, prints too much, or is cancelled', async () => {
    await expect(node('setTimeout(() => {}, 60000)', { timeoutMs: 200 })).rejects.toThrow(/timed out/)
    await expect(node('process.stdout.write("x".repeat(4096)); setTimeout(() => {}, 60000)', { maxBytes: 1024 })).rejects.toThrow(/output limit/)
    const controller = new AbortController()
    const running = node('setTimeout(() => {}, 60000)', { signal: controller.signal })
    setTimeout(() => { controller.abort() }, 100)
    await expect(running).rejects.toThrow(/cancelled/)
    const aborted = new AbortController()
    aborted.abort()
    await expect(node('', { signal: aborted.signal })).rejects.toThrow()
  })

  it('kills the whole process tree the way each platform allows', async () => {
    // Each platform's kill falls back to killing the child itself where its tool is unavailable.
    for (const platform of ['win32', 'linux'] as const) {
      await expect(node('setTimeout(() => {}, 60000)', { timeoutMs: 200, platform })).rejects.toThrow(/timed out/)
    }
    // Without taskkill on the PATH the Windows tree kill falls back to killing the child.
    const path = process.env.PATH
    process.env.PATH = ''
    try {
      await expect(node('setTimeout(() => {}, 60000)', { timeoutMs: 200, platform: 'win32' })).rejects.toThrow(/timed out/)
    } finally {
      process.env.PATH = path
    }
    // Repeated overflow after the first stop is ignored; the first reason wins.
    await expect(node('for (let i = 0; i < 64; i++) process.stdout.write("x".repeat(1024)); setTimeout(() => {}, 60000)', { maxBytes: 1024 })).rejects.toThrow(/output limit/)
  })

  it('stops a child cancelled before it started, and reports one that could not start', async () => {
    const early = new AbortController()
    const pending = node('setTimeout(() => {}, 60000)', { signal: early.signal })
    early.abort()
    await expect(pending).rejects.toThrow(/cancelled/)
    const never = new AbortController()
    const missing = runProcess('research-no-such-program', [], { signal: never.signal, input: 'x' })
    never.abort()
    await expect(missing).rejects.toThrow()
    await expect(runProcess('research-no-such-program', [])).rejects.toThrow()
    expect((await node('process.stdin.destroy(); process.exit(0)', { input: 'x'.repeat(1 << 20) })).code).toBe(0)
  })

  it('reports a child ended by a signal with no exit code', async () => {
    const ended = await node('process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 60000)')
    expect(ended.code).not.toBe(0)
  })

  it('reaches a configured SSH host through OpenSSH in batch mode', async () => {
    // No network in tests: the call is cut short, which still exercises how the command is built and run.
    const outcome = await ssh('research-host.invalid', ['true'], { timeoutMs: 100 }).then(result => result.code, (error: unknown) => String(error))
    expect(outcome).not.toBe(0)
  })

  it('checks results and quotes remote arguments for the login shell', async () => {
    expect(checked({ code: 0, stdout: ' ok \n', stderr: '' }, 'Step')).toBe('ok')
    expect(() => checked({ code: 2, stdout: 'out', stderr: 'err' }, 'Step')).toThrow(/Step failed \(2\): err out/)
    expect(shQuote("it's")).toBe("'it'\\''s'")
    expect(() => ssh('-oProxyCommand=evil', [])).toThrow(/OpenSSH host alias/)
    expect(() => ssh('host name', [])).toThrow(/OpenSSH host alias/)
    expect(() => ssh('', [])).toThrow(/OpenSSH host alias/)
  })
})
