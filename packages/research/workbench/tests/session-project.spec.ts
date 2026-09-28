import { describe, expect, it } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { newProject } from '../src/project.ts'
import { remoteResearchAt } from '../src/session-project.ts'
import type { ResearchProject } from '../src/types.ts'

const project = (root: string, host = 'alpha', remoteRoot = '/srv/study'): ResearchProject => {
  const value = newProject({ root, title: root, brief: '' }, 'workspace' as WorkspaceId)
  value.environments.push({
    id: root as ResearchProject['environments'][number]['id'], name: 'Remote', kind: 'existing', target: 'ssh',
    python: '/usr/bin/python3', sshHost: host, remoteRoot, requirements: [], fingerprint: 'test',
    status: 'ready', details: '', isDefault: false,
  })
  return value
}

describe('remote research matching', () => {
  it('requires the exact host and a POSIX descendant of a ready SSH environment root', () => {
    const study = project('local-study')
    const at = (host: string, cwd: string) => remoteResearchAt([study], { cwd, execution: { kind: 'ssh', host } })
    expect(at('alpha', '/srv/study')).toEqual({ kind: 'project', project: study })
    expect(at('alpha', '/srv/study/code')).toEqual({ kind: 'project', project: study })
    expect(at('alpha', '/srv/study-other')).toEqual({ kind: 'none' })
    expect(at('beta', '/srv/study')).toEqual({ kind: 'none' })
    expect(at('alpha', 'srv/study')).toEqual({ kind: 'none' })
    expect(remoteResearchAt([study], { cwd: '/srv/study', execution: { kind: 'local' } })).toEqual({ kind: 'none' })
    study.environments[0]!.remoteRoot = '/'
    expect(at('alpha', '/srv/study')).toEqual({ kind: 'none' })
    study.environments[0]!.remoteRoot = '/srv/study'
    study.environments[0]!.status = 'failed'
    expect(at('alpha', '/srv/study')).toEqual({ kind: 'none' })
  })

  it('deduplicates environments within one project and refuses overlapping projects', () => {
    const first = project('local-first')
    first.environments.push({ ...first.environments[0]!, id: 'other' as ResearchProject['environments'][number]['id'] })
    expect(remoteResearchAt([first], { cwd: '/srv/study/code', execution: { kind: 'ssh', host: 'alpha' } }))
      .toEqual({ kind: 'project', project: first })
    const second = project('local-second', 'alpha', '/srv/study/code')
    expect(remoteResearchAt([first, second], { cwd: '/srv/study/code', execution: { kind: 'ssh', host: 'alpha' } }))
      .toEqual({ kind: 'ambiguous' })
  })
})
