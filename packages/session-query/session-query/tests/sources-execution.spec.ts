import { expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { assertSessionHeadersCompatible } from '../src/sources.ts'

it('treats SSH host as part of immutable session source identity', () => {
  const local = {
    version: SESSION_FORMAT_VERSION, id: SessionId('s'), createdAt: 1,
    cwd: '/srv/work', isSeeded: false,
  } as const
  expect(() => { assertSessionHeadersCompatible(local, { ...local, execution: { kind: 'local' } }) })
    .not.toThrow()
  expect(() => {
    assertSessionHeadersCompatible(
      { ...local, execution: { kind: 'ssh', host: 'gpu-a' } },
      { ...local, execution: { kind: 'ssh', host: 'gpu-b' } },
    )
  }).toThrow(/source headers conflict/)
})
