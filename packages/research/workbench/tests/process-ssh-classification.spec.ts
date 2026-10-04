import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ code: 0, stdout: '', stderr: '', calls: [] as { command: string; args: string[]; options: { env: Record<string, string> } }[] }))
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return { spawn(command: string, args: string[], options: { env: Record<string, string> }) {
    state.calls.push({ command, args, options })
    const child = Object.assign(new EventEmitter(), {
      pid: 123, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
    })
    queueMicrotask(() => { child.stdout.write(state.stdout); child.stderr.write(state.stderr); child.emit('close', state.code) })
    return child
  } }
})
vi.mock('@deepseek-ai/dsh-ssh/auth', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-ssh/auth')>(),
  planSshAuth: vi.fn(async () => ({ options: ['-o', 'BatchMode=no'], destination: ['-p', '24022', 'research@example.invalid'],
    env: { RESEARCH_SAVED_PASSWORD: 'private-value' }, redact: (text: string) => text.replaceAll('private-value', '[redacted]') })),
}))
const { ssh } = await import('../src/process.ts')
afterEach(() => { state.code = 0; state.stdout = ''; state.stderr = ''; state.calls.length = 0 })

describe('workbench SSH transport', () => {
  it('uses the shared credential plan, quoted arguments and strict nonforwarding options', async () => {
    state.stdout = 'private-value'
    expect(await ssh('research@example.invalid:24022', ['python', '-c', 'print(1)'])).toMatchObject({ code: 0, stdout: '[redacted]' })
    const call = state.calls[0]!
    expect(call.command).toBe('ssh')
    for (const option of ['StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ClearAllForwardings=yes', 'ConnectionAttempts=1', 'ConnectTimeout=15']) expect(call.args).toContain(option)
    expect(call.args).toContain('24022')
    expect(call.args.at(-1)).toBe("'python' '-c' 'print(1)'")
    expect(call.args.join(' ')).not.toContain('private-value')
    expect(call.options.env.RESEARCH_SAVED_PASSWORD).toBe('private-value')
  })

  it.each([
    ['auth', 'Permission denied (publickey,password). private-value'],
    ['handshake', 'kex_exchange_identification: Connection closed by remote host private-value'],
    ['host-key', 'Host key verification failed. private-value'],
  ])('preserves a classified %s failure after redaction', async (kind, stderr) => {
    state.code = 255; state.stderr = stderr
    const error = await ssh('example.invalid', ['true']).then(() => undefined, (failure: unknown) => failure)
    expect(error).toMatchObject({ name: 'SshFailure', kind })
    expect(String(error)).not.toContain('private-value')
  })

  it('keeps a remote program failure distinct from a transport failure', async () => {
    state.code = 2; state.stderr = 'ValueError: bad input'
    expect(await ssh('example.invalid', ['python', 'train.py'])).toMatchObject({ code: 2, stderr: 'ValueError: bad input' })
  })
})
