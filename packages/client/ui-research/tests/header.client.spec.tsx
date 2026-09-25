// @vitest-environment jsdom

/**
 * The conversation header's research chip. It names the mode and where the
 * host's standing says the research is, for this session's project only — found through the
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
import { standingOf } from './fixtures/standing.ts'

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

  it('names the current phase and how many are done, and the automatic autonomy', () => {
    const mine = project('C:\\research\\mine', 'spark-to-paper', 'proposal')
    mine.autonomy = 'automatic'
    mine.standing = standingOf([['plan', 'done'], ['cite', 'current'], ['experiments', 'pending']])
    // Any conversation opened inside the project folder shows it, bound or not.
    const chip = render(<ResearchStatusChip {...propsFor([mine], log(), { [SESSION]: 'c:/research/MINE/paper' })} />)
    expect(chip.container.textContent).toBe(`spark-to-paper · 引用 1/3·${zh.autonomyShortAutomatic}`)
  })

  it('says first that an example is an example', () => {
    const shipped = project('C:\\home\\demo\\sparse', 'spark-to-paper')
    shipped.sessionId = SESSION
    shipped.example = true
    expect(render(<ResearchStatusChip {...propsFor([shipped], log())} />).container.textContent).toBe(`${zh.exampleTag}·spark-to-paper`)
  })

  it('says a finished paper is finished, and a deferred phase deferred', () => {
    const mine = project('/research/mine', 'spark-to-paper', 'proposal')
    mine.sessionId = SESSION
    mine.standing = standingOf([['plan', 'done'], ['submission', 'done']], { finished: true })
    expect(render(<ResearchStatusChip {...propsFor([mine], log())} />).container.textContent).toBe('spark-to-paper · 已完成 ✓')
    cleanup()
    mine.standing = standingOf([['plan', 'done'], ['experiments', 'deferred'], ['submission', 'current']])
    expect(render(<ResearchStatusChip {...propsFor([mine], log())} />).container.textContent).toBe('spark-to-paper · 实验已推迟')
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
