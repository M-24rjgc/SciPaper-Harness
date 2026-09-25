// @vitest-environment jsdom

/**
 * The conversation header's research chip. It names the mode and the phase
 * the last check left open, for this session's project only — found through the
 * session's binding or its working directory — and it is the one door to the
 * research record: the record opens when the person clicks it, never by itself.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchStatusChip } from '../src/client/Header.tsx'
import type { ResearchView, SessionSeatProps, WorkbenchProps } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'
import { MODES } from './fixtures/modes.ts'

afterEach(() => { cleanup() })

const SESSION = 'session-header'

function project(root: string, mode?: string, route?: string): ResearchProject {
  return newProject({ root, title: 'Sparse attention scaling study', brief: '', ...(mode ? { mode } : {}), ...(route ? { route } : {}) }, 'workspace' as WorkspaceId)
}

function propsFor(
  projects: ResearchProject[],
  log: { progress: number },
  directories: Record<string, string> = {},
): WorkbenchProps & SessionSeatProps {
  const snapshot = projects.length > 0 ? { projects, preferences: {}, components: [], modes: MODES } : null
  const view: ResearchView = { snapshot, tasks: [], response: null }
  return {
    sessionId: SESSION,
    t: (key: string, params?: Record<string, unknown>) => {
      const template = (zh as Record<string, string>)[key] ?? key
      return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
    },
    useResearch: (select: (value: ResearchView) => unknown) => select(view),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select(directories),
    showProgress: () => { log.progress += 1 },
  } as unknown as WorkbenchProps & SessionSeatProps
}

const log = (): { progress: number } => ({ progress: 0 })

describe('the header names where this session\'s project stands', () => {
  it('draws nothing until the session works in a research project', () => {
    const stranger = project('C:\\research\\other', 'spark-to-paper')
    stranger.sessionId = 'session-elsewhere'
    expect(render(<ResearchStatusChip {...propsFor([], log())} />).container.textContent).toBe('')
    expect(render(<ResearchStatusChip {...propsFor([stranger], log())} />).container.textContent).toBe('')
  })

  it('names the mode before any check, and a pack that is gone by its id', () => {
    const general = project('C:\\research\\a')
    general.sessionId = SESSION
    expect(render(<ResearchStatusChip {...propsFor([general], log())} />).container.textContent).toBe('通用')
    cleanup()
    const routed = project('C:\\research\\b', 'spark-to-paper', 'data')
    routed.sessionId = SESSION
    expect(render(<ResearchStatusChip {...propsFor([routed], log())} />).container.textContent).toBe('spark-to-paper')
    cleanup()
    routed.mode = 'retired-pack'
    expect(render(<ResearchStatusChip {...propsFor([routed], log())} />).container.textContent).toBe('retired-pack')
  })

  it('names the first unfinished phase and how many are done, and the automatic autonomy', () => {
    const mine = project('C:\\research\\mine', 'spark-to-paper', 'proposal')
    mine.autonomy = 'automatic'
    mine.lastCheck = {
      clean: false, scope: 'all', mode: 'spark-to-paper', route: 'proposal', checkedAt: '',
      phases: [{ id: 'plan', done: true, missing: [] }, { id: 'cite', done: false, missing: ['x'] }, { id: 'experiments', done: false, missing: [] }],
      findings: [],
    }
    // Any conversation opened inside the project folder shows it, bound or not.
    const chip = render(<ResearchStatusChip {...propsFor([mine], log(), { [SESSION]: 'c:/research/MINE/paper' })} />)
    expect(chip.container.textContent).toBe(`spark-to-paper · 引用 1/3·${zh.autonomyShortAutomatic}`)
  })

  it('says the check is clean once every phase is done', () => {
    const mine = project('/research/mine', 'spark-to-paper', 'proposal')
    mine.sessionId = SESSION
    mine.lastCheck = { clean: true, scope: 'all', mode: 'spark-to-paper', route: 'proposal', checkedAt: '', phases: [{ id: 'submission', done: true, missing: [] }], findings: [] }
    expect(render(<ResearchStatusChip {...propsFor([mine], log())} />).container.textContent).toBe(`spark-to-paper · ${zh.checkClean}`)
    cleanup()
    // A check made on another route no longer says where this one stands.
    mine.route = 'data'
    expect(render(<ResearchStatusChip {...propsFor([mine], log())} />).container.textContent).toBe('spark-to-paper')
  })
})

describe('the chip is the door to the research record', () => {
  it('opens the record on each click and never by itself', () => {
    const stranger = project('/research/stranger')
    const mine = project('/research/mine')
    mine.sessionId = SESSION
    const records = log()
    const chip = render(<ResearchStatusChip {...propsFor([stranger, mine], records)} />)
    // Showing the chip opens nothing beside the conversation.
    expect(records.progress).toBe(0)
    const button = chip.getByRole('button', { name: '通用' })
    expect(button.getAttribute('title')).toBe(zh.railGuideTitle)
    fireEvent.click(button)
    expect(records.progress).toBe(1)
    fireEvent.click(button)
    expect(records.progress).toBe(2)
  })
})
