import { describe, expect, it } from 'vitest'
import { releasedV5SessionFormatCodec, restoreReleasedV5Artifact, sessionFormatV4ToV5 } from '../src/index.ts'

describe('Session V5 execution identity', () => {
  it('round-trips an SSH POSIX cwd independently of the Windows Host path parser', () => {
    const logical = {
      version: 5, id: 'remote', createdAt: 1, isSeeded: false, delegationDepth: 0,
      cwd: '/srv/work', execution: { kind: 'ssh', host: 'gpu-a' },
    } as const
    const physical = releasedV5SessionFormatCodec.encodeHeader(logical, 0)
    expect(physical).toMatchObject({ type: 'session', cwd: '/srv/work', execution: logical.execution })
    expect(releasedV5SessionFormatCodec.decodeHeader(physical)).toEqual(logical)
  })

  it('migrates a V4 local header without changing its cwd or lineage', () => {
    const prior = {
      version: 4, id: 'local', createdAt: 1, isSeeded: false,
      delegationDepth: 0, cwd: process.platform === 'win32' ? 'C:\\work' : '/work',
    } as const
    const migrated = sessionFormatV4ToV5.migrateHeader(prior)
    expect(migrated).toEqual({ ...prior, version: 5, execution: { kind: 'local' } })
  })

  it('rejects a Windows path for an SSH execution identity', () => {
    expect(() => releasedV5SessionFormatCodec.encodeHeader({
      version: 5, id: 'bad', createdAt: 1, isSeeded: false, delegationDepth: 0,
      cwd: 'C:\\work', execution: { kind: 'ssh', host: 'gpu-a' },
    }, 0)).toThrow(/SSH cwd must be absolute POSIX/)
  })

  it('rejects a V5 delivery marker owned by another Session', () => {
    const marker = { type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2,
      data: { sessionId: 'other', throughSeq: 0, sessionFormatVersion: 5 } } as const
    const artifact = {
      header: { version: 5, id: 'remote', createdAt: 1, isSeeded: false, delegationDepth: 0,
        cwd: '/srv/work', execution: { kind: 'ssh', host: 'gpu-a' } },
      inheritedEventCount: 0,
      events: [{ type: 'feedback/record', seq: 0, time: 1, data: { text: 'earlier' } }, marker],
    } as const
    expect(() => restoreReleasedV5Artifact(artifact, new Set([marker.type, 'feedback/record'])))
      .toThrow('wrong Session')
  })
})
