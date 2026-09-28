import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId } from '../src/index.ts'

describe('Session execution identity', () => {
  it('accepts a POSIX SSH cwd on Windows and retains its host through a fork', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('ssh-parent'), {
      meta: { cwd: '/srv/work', execution: { kind: 'ssh', host: 'gpu-a' } },
    })
    expect(session.header).toMatchObject({
      version: SESSION_FORMAT_VERSION, cwd: '/srv/work', execution: { kind: 'ssh', host: 'gpu-a' },
    })
    const child = ctx.sessions.fork(session, undefined, SessionId('ssh-child'))
    expect(child.header).toMatchObject({ cwd: '/srv/work', execution: { kind: 'ssh', host: 'gpu-a' } })
    await ctx.fiber.dispose()
  })

  it('defaults older caller metadata to local execution', () => {
    const session = Session.create(SessionId('local-default'))
    expect(session.header.execution).toEqual({ kind: 'local' })
  })
})
