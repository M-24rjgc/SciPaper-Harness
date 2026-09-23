// @vitest-environment jsdom

/**
 * The conversation header's research share. It names the mode and the phase
 * the last check left open, for this session's project only — found through the
 * session's binding or its working directory — and offers the project files.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { ResearchMode, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchProjectActions, ResearchStatusChip } from '../src/client/Header.tsx'
import type { SessionSeatProps, WorkbenchProps } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const SESSION = 'session-header'

function project(root: string, mode?: ResearchMode): ResearchProject {
  return newProject({ root, title: 'Sparse attention scaling study', brief: '', ...(mode ? { mode } : {}) }, 'workspace' as WorkspaceId)
}

function propsFor(
  projects: ResearchProject[],
  log: { expanded: string[]; progress: number },
  directories: Record<string, string> = {},
): WorkbenchProps & SessionSeatProps {
  const view = { snapshot: projects.length > 0 ? { projects, preferences: {}, components: [] } : null, tasks: [], busy: false, error: '', response: null }
  return {
    sessionId: SESSION,
    t: (key: string, params?: Record<string, unknown>) => {
      const template = (zh as Record<string, string>)[key] ?? key
      return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
    },
    useResearch: (select: (value: typeof view) => unknown) => select(view),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select(directories),
    expand: (projectId: string) => { log.expanded.push(projectId) },
    showProgress: () => { log.progress += 1 },
  } as unknown as WorkbenchProps & SessionSeatProps
}

const log = (): { expanded: string[]; progress: number } => ({ expanded: [], progress: 0 })

describe('the header names where this session\'s project stands', () => {
  it('draws nothing until the session works in a research project', () => {
    const stranger = project('C:\\research\\other', 'paper-first')
    stranger.sessionId = 'session-elsewhere'
    expect(render(<ResearchStatusChip {...propsFor([], log())} />).container.textContent).toBe('')
    expect(render(<ResearchStatusChip {...propsFor([stranger], log())} />).container.textContent).toBe('')
    expect(render(<ResearchProjectActions {...propsFor([stranger], log())} />).container.textContent).toBe('')
  })

  it('names an unrouted project as such, and a routed one by its mode before any check', () => {
    const unrouted = project('C:\\research\\a')
    unrouted.sessionId = SESSION
    expect(render(<ResearchStatusChip {...propsFor([unrouted], log())} />).container.textContent).toBe(zh.modeUnset)
    cleanup()
    const routed = project('C:\\research\\b', 'from-results')
    routed.sessionId = SESSION
    expect(render(<ResearchStatusChip {...propsFor([routed], log())} />).container.textContent).toBe(zh.modeShortFromResults)
  })

  it('names the first unfinished phase and how many are done, and the automatic autonomy', () => {
    const mine = project('C:\\research\\mine', 'paper-first')
    mine.autonomy = 'automatic'
    mine.lastCheck = {
      clean: false, scope: 'all', mode: 'paper-first', checkedAt: '',
      phases: [{ id: 'idea', done: true, missing: [] }, { id: 'literature', done: false, missing: ['x'] }, { id: 'plan', done: false, missing: [] }],
      findings: [],
    }
    // Any conversation opened inside the project folder shows it, bound or not.
    const records = log()
    const chip = render(<ResearchStatusChip {...propsFor([mine], records, { [SESSION]: 'c:/research/MINE/paper' })} />)
    expect(chip.container.textContent).toBe(`${zh.modeShortPaperFirst} · ${zh.phase_literature} 1/3·${zh.autonomyShortAutomatic}`)
    fireEvent.click(chip.getByRole('button'))
    expect(records.progress).toBe(1)
  })

  it('says the check is clean once every phase is done', () => {
    const mine = project('/research/mine', 'free')
    mine.sessionId = SESSION
    mine.lastCheck = { clean: true, scope: 'all', mode: 'free', checkedAt: '', phases: [{ id: 'submission', done: true, missing: [] }], findings: [] }
    expect(render(<ResearchStatusChip {...propsFor([mine], log())} />).container.textContent).toBe(`${zh.modeShortFree} · ${zh.checkClean}`)
  })

  it('opens the project files of this session\'s project, never a stranger\'s', () => {
    const stranger = project('/research/stranger', 'free')
    const mine = project('/research/mine', 'free')
    mine.sessionId = SESSION
    const records = log()
    const actions = render(<ResearchProjectActions {...propsFor([stranger, mine], records)} />)
    fireEvent.click(actions.getByRole('button', { name: zh.projectFolder }))
    expect(records.expanded).toEqual([mine.id])
  })
})
