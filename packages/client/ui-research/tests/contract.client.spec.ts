/**
 * How a seat finds the research of its conversation and the installed modes,
 * and how a path inside a research folder is named relative to it.
 */
import { describe, expect, it } from 'vitest'
import {
  localResearchFileSession, pathInProject, sessionDirectoriesOf, sessionProject, SshWorkspaceError, sshWorkspaceErrorOf, useModes,
  type ResearchView, type WorkbenchProps,
} from '../src/client/contract.ts'
import { MODES } from './fixtures/modes.ts'

describe('an SSH workspace the host refused', () => {
  const refusal = (code: string, reason: unknown) => Object.assign(new Error('workspace create failed'), {
    rpcError: { code, message: 'The host says no', details: { path: '/srv', reason } },
  })

  it('carries the host classification and its English text', () => {
    for (const reason of ['auth', 'unreachable', 'host-key', 'host-key-changed', 'unsupported'] as const) {
      const error = sshWorkspaceErrorOf(refusal('workspace/ssh-failed', reason))
      expect(error).toBeInstanceOf(SshWorkspaceError)
      expect(error).toMatchObject({ name: 'SshWorkspaceError', reason, message: 'The host says no' })
    }
  })

  it('carries the key an unknown host presents, when it is well formed', () => {
    const key = { type: 'ED25519', fingerprint: 'SHA256:abc' }
    const error = sshWorkspaceErrorOf(Object.assign(new Error('x'), {
      rpcError: { code: 'workspace/ssh-failed', message: 'm', details: { reason: 'host-key', hostKey: key } },
    }))
    expect(error?.hostKey).toEqual(key)
    for (const hostKey of [undefined, { type: 'ED25519' }, { fingerprint: 'SHA256:abc' }, { type: 1, fingerprint: 2 }]) {
      const plain = sshWorkspaceErrorOf(Object.assign(new Error('x'), {
        rpcError: { code: 'workspace/ssh-failed', message: 'm', details: { reason: 'host-key', hostKey } },
      }))
      expect(plain?.hostKey).toBeUndefined()
    }
  })

  it('recognizes nothing else', () => {
    expect(sshWorkspaceErrorOf(refusal('workspace/invalid-path', 'auth'))).toBeUndefined()
    expect(sshWorkspaceErrorOf(refusal('workspace/ssh-failed', 'something new'))).toBeUndefined()
    expect(sshWorkspaceErrorOf(new Error('plain'))).toBeUndefined()
    expect(sshWorkspaceErrorOf(null)).toBeUndefined()
    expect(sshWorkspaceErrorOf(Object.assign(new Error('x'), { rpcError: { code: 'workspace/ssh-failed', message: 'm' } }))).toBeUndefined()
  })
})

describe('matching a session to its project', () => {
  it('prefers the bound project, then the innermost folder containing the session', () => {
    const outer = { root: 'C:\\Research', sessionId: 'x' }
    const inner = { root: 'C:\\Research\\Paper\\', sessionId: undefined }
    const posix = { root: '/data/Paper' }
    expect(sessionProject([outer, inner], 'x')).toBe(outer)
    expect(sessionProject([outer, inner], 'y', { y: 'c:/research/paper/sections' })).toBe(inner)
    expect(sessionProject([outer, inner], 'y', { y: 'D:/elsewhere' })).toBeUndefined()
    expect(sessionProject([posix], 'y', { y: '/data/paper' })).toBeUndefined()
    expect(sessionProject([posix], 'y', { y: '/data/Paper' })).toBe(posix)
    expect(sessionProject([posix], 'y')).toBeUndefined()
    expect(sessionProject(undefined, 'y', { y: '/data' })).toBeUndefined()
  })

  it('matches an SSH conversation only to its unique ready environment and local ledger', () => {
    const project = { root: 'C:\\research\\paper', sessionId: 'local', environments: [
      { target: 'ssh', status: 'ready', sshHost: 'lab', remoteRoot: '/srv/paper' },
    ] }
    const unrelated = { root: '/srv/paper', sessionId: 'ssh' }
    const directories = sessionDirectoriesOf({
      local: { cwd: project.root, execution: { kind: 'local' } },
      ssh: { cwd: '/srv/paper/./runs/../code', execution: { kind: 'ssh', host: 'lab' } },
    })
    expect(directories).toEqual({ local: project.root, ssh: { kind: 'ssh', host: 'lab', cwd: '/srv/paper/./runs/../code' } })
    expect(sessionProject([project, unrelated], 'ssh', directories)).toBe(project)
    expect(localResearchFileSession(project, directories)).toBe('local')
    expect(sessionProject([project, unrelated], 'ssh', { ssh: { kind: 'ssh', host: 'other', cwd: '/srv/paper/code' } })).toBeUndefined()
    expect(sessionProject([project, unrelated], 'ssh', { ssh: { kind: 'ssh', host: 'lab', cwd: '/srv/paper2' } })).toBeUndefined()
  })

  it('rejects absent paths, unready environments, ambiguous ledgers, and remote paths masquerading as local paths', () => {
    const bound = { root: '/srv/paper', sessionId: 'ssh' }
    const ready = { root: 'C:\\research\\a', environments: [{ target: 'ssh', status: 'ready', sshHost: 'lab', remoteRoot: '/srv/paper' }] }
    const second = { root: 'D:\\research\\b', environments: [{ target: 'ssh', status: 'ready', sshHost: 'lab', remoteRoot: '/srv/paper/code' }] }
    const pending = { root: 'E:\\research\\c', environments: [{ target: 'ssh', status: 'pending', sshHost: 'lab', remoteRoot: '/srv/paper' }] }
    const remote = (cwd?: string) => ({ ssh: { kind: 'ssh' as const, host: 'lab', cwd } })
    expect(sessionProject([bound, ready], 'ssh', remote('/srv/paper/code'))).toBe(ready)
    expect(sessionProject([bound, pending], 'ssh', remote('/srv/paper/code'))).toBeUndefined()
    expect(sessionProject([bound, ready, second], 'ssh', remote('/srv/paper/code'))).toBeUndefined()
    expect(sessionProject([bound, ready], 'ssh', remote())).toBeUndefined()
    expect(sessionProject([bound, ready], 'ssh', remote('srv/paper'))).toBeUndefined()
    expect(sessionProject([bound, ready], 'ssh', remote('/'))).toBeUndefined()
    expect(localResearchFileSession(ready, remote('/srv/paper'))).toBeUndefined()
  })

  it('reads the installed modes from the record, and none before it arrives', () => {
    const props = (snapshot: ResearchView['snapshot']): WorkbenchProps => ({
      useResearch: (select: (value: ResearchView) => unknown) => select({ snapshot, tasks: [] }),
    }) as unknown as WorkbenchProps
    expect(useModes(props({ projects: [], preferences: {}, components: [], modes: MODES }))).toBe(MODES)
    expect(useModes(props(null))).toEqual([])
  })
})

describe('a path inside a research folder', () => {
  it('is named relative to the folder, drive letters compared without case and either separator accepted', () => {
    expect(pathInProject('C:\\Research\\Paper\\', 'c:/research/Paper/figures/Arch.drawio')).toBe('figures/Arch.drawio')
    expect(pathInProject('/data/paper', '/data/paper/figures/a b.drawio')).toBe('figures/a b.drawio')
    expect(pathInProject('\\\\server\\share\\p', '//server/share/p/x.drawio')).toBe('x.drawio')
  })

  it('is nothing for the folder itself, a folder beside it, or a POSIX path in another case', () => {
    expect(pathInProject('/data/paper', '/data/paper')).toBeUndefined()
    expect(pathInProject('/data/paper', '/data/paper-2/x.drawio')).toBeUndefined()
    expect(pathInProject('/data/paper', '/data/Paper/x.drawio')).toBeUndefined()
  })
})
