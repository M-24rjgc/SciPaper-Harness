// @vitest-environment jsdom

/**
 * The conversation header's research chip. It names the mode and where the
 * host's standing says the research is, for this session's project only —
 * found through the session's binding or its working directory — with a dot
 * while something of the research moves or waits on the person. It is the
 * one door to the research record: a click opens it, or closes the panel
 * showing it, and nothing opens it by itself.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { ResearchGoal, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchStatusChip, type StatusChipProps } from '../src/client/Header.tsx'
import type { ResearchView } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'
import { MODES } from './fixtures/modes.ts'
import { standingOf } from './fixtures/standing.ts'

afterEach(() => { cleanup() })

const SESSION = 'session-header'

/** A research in the given mode, chosen by the person; the general mode when none is named. */
function project(root: string, mode = 'general', route?: string): ResearchProject {
  return newProject({ root, title: 'Sparse attention scaling study', brief: '', mode, ...(route ? { route } : {}) }, 'workspace' as WorkspaceId)
}

interface Page {
  directories?: Record<string, string>
  sessions?: SessionSummary[]
  pending?: [string, string][]
}

function propsFor(projects: ResearchProject[], log: { toggles: number }, page: Page = {}): StatusChipProps {
  const snapshot = projects.length > 0 ? { projects, preferences: {}, components: [], modes: MODES } : null
  const view: ResearchView = { snapshot, tasks: [] }
  const sessions = page.sessions ?? []
  const list: SessionListState = {
    ids: sessions.map(item => item.id), byId: Object.fromEntries(sessions.map(item => [item.id, item])),
    current: SESSION as SessionId, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
  const pending = new Map<SessionId, SessionPendingInteractionBase>((page.pending ?? []).map(([id, kind]) => [
    id as SessionId, { key: `${id}-${kind}`, kind, sessionId: id as SessionId },
  ]))
  return {
    sessionId: SESSION,
    t: (key: string, params?: Record<string, unknown>) => {
      const template = (zh as Record<string, string>)[key] ?? key
      return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
    },
    useResearch: (select: (value: ResearchView) => unknown) => select(view),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select(page.directories ?? {}),
    useSessions: (select: (value: SessionListState) => unknown) => select(list),
    useSessionPendingInteraction: (select: (value: typeof pending) => unknown) => select(pending),
    toggleProgress: () => { log.toggles += 1 },
  } as unknown as StatusChipProps
}

const log = (): { toggles: number } => ({ toggles: 0 })
const chipText = (projects: ResearchProject[], page?: Page): string | null =>
  render(<ResearchStatusChip {...propsFor(projects, log(), page)} />).container.textContent

describe('the chip names where this session\'s research stands', () => {
  it('draws nothing until the session works in a research', () => {
    const stranger = project('C:\\research\\other', 'spark-to-paper')
    stranger.sessionId = 'session-elsewhere'
    expect(chipText([])).toBe('')
    expect(chipText([stranger])).toBe('')
  })

  it('says 模式待定 before the mode is chosen, 通用 in the general mode, and a pack that is gone by its id', () => {
    const unchosen = project('C:\\research\\a')
    unchosen.sessionId = SESSION
    unchosen.modeSetBy = undefined
    expect(chipText([unchosen])).toBe(zh.modeUnchosen)
    cleanup()
    const general = project('C:\\research\\a')
    general.sessionId = SESSION
    expect(chipText([general])).toBe('通用')
    cleanup()
    const routed = project('C:\\research\\b', 'spark-to-paper', 'data')
    routed.sessionId = SESSION
    expect(chipText([routed])).toBe('spark-to-paper')
    cleanup()
    routed.mode = 'retired-pack'
    expect(chipText([routed])).toBe('retired-pack')
  })

  it('names the current phase and how many are done, and no longer the autonomy', () => {
    const mine = project('C:\\research\\mine', 'spark-to-paper', 'proposal')
    mine.autonomy = 'automatic'
    mine.standing = standingOf([['plan', 'done'], ['cite', 'current'], ['experiments', 'pending']])
    // Any conversation opened inside the research folder shows it, bound or not.
    expect(chipText([mine], { directories: { [SESSION]: 'c:/research/MINE/paper' } })).toBe('spark-to-paper · 引用 1/3')
  })

  it('says first that an example is an example', () => {
    const shipped = project('C:\\home\\demo\\sparse', 'spark-to-paper')
    shipped.sessionId = SESSION
    shipped.example = true
    expect(chipText([shipped])).toBe(`${zh.exampleTag}·spark-to-paper`)
  })

  it('says a finished paper is finished with a verified mark, a deferred phase deferred, and a paper that needs another check', () => {
    const mine = project('/research/mine', 'spark-to-paper', 'proposal')
    mine.sessionId = SESSION
    mine.standing = standingOf([['plan', 'done'], ['submission', 'done']], { finished: true })
    const chip = render(<ResearchStatusChip {...propsFor([mine], log())} />)
    expect(chip.container.textContent).toBe('spark-to-paper · 已完成 ✓')
    expect(chip.getByText('✓').className).toContain('verified')
    cleanup()
    mine.standing = standingOf([['plan', 'done'], ['experiments', 'deferred'], ['submission', 'current']])
    expect(chipText([mine])).toBe('实验已推迟')
    cleanup()
    mine.standing = standingOf([['plan', 'done'], ['submission', 'done']])
    expect(chipText([mine])).toBe(`spark-to-paper · ${zh.standingRecheck}`)
  })
})

describe('the chip\'s dot', () => {
  const root = '/research/mine'
  const goal = (phase: ResearchGoal['phase']): ResearchGoal => ({ sessionId: 'other', objective: 'the paper', phase, roundsStarted: 1, updatedAt: 1 })
  const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
    ({ id: id as SessionId, displayTitle: id, cwd: root, running: false, blank: false, updatedAt: 1, ...extra })
  const mine = (): ResearchProject => { const record = project(root); record.sessionId = SESSION; return record }
  const dotOf = (projects: ResearchProject[], page: Page): { signal: string | null | undefined; label: string | undefined } => {
    const chip = render(<ResearchStatusChip {...propsFor(projects, log(), { directories: { [SESSION]: root, other: root }, ...page })} />)
    const dot = chip.container.querySelector('[data-signal]')
    return { signal: dot?.getAttribute('data-signal'), label: dot?.nextElementSibling?.textContent ?? undefined }
  }

  it('shows nothing while nothing moves, ongoing blue while a conversation, a goal or a run of the research moves', () => {
    expect(dotOf([mine()], { sessions: [session(SESSION), session('other')] }).signal).toBeUndefined()
    cleanup()
    expect(dotOf([mine()], { sessions: [session(SESSION), session('other', { running: true })] })).toEqual({ signal: 'ongoing', label: zh.treeOngoing })
    cleanup()
    const driving = mine()
    driving.goals = [goal('active')]
    expect(dotOf([driving], {}).signal).toBe('ongoing')
    cleanup()
    const running = mine()
    running.experiments.push({ id: 'r', status: 'running' } as never)
    expect(dotOf([running], {}).signal).toBe('ongoing')
  })

  it('shows the warn dot while a conversation or a goal of the research waits on the person', () => {
    expect(dotOf([mine()], { sessions: [session(SESSION), session('other', { running: true })], pending: [['other', 'question']] }))
      .toEqual({ signal: 'waiting', label: zh.treeWaiting })
    cleanup()
    const blocked = mine()
    blocked.goals = [goal('blocked')]
    expect(dotOf([blocked], {}).signal).toBe('waiting')
  })
})

describe('the chip is the door to the research record', () => {
  it('asks to open or close the record on each click and never by itself', () => {
    const stranger = project('/research/stranger')
    const mine = project('/research/mine')
    mine.sessionId = SESSION
    const records = log()
    const chip = render(<ResearchStatusChip {...propsFor([stranger, mine], records)} />)
    // Showing the chip opens nothing beside the conversation.
    expect(records.toggles).toBe(0)
    const button = chip.getByRole('button', { name: '通用' })
    expect(button.getAttribute('title')).toBe(zh.railGuideTitle)
    fireEvent.click(button)
    expect(records.toggles).toBe(1)
    fireEvent.click(button)
    expect(records.toggles).toBe(2)
  })
})
