// @vitest-environment jsdom

/**
 * The research's lines on the entry screen: the line under the headline, which
 * says what this blank conversation is and carries the entry screen's notices,
 * and the two Try sentences, which only ever add to the draft.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { ResearchProject, ResearchSnapshot } from '@deepseek-ai/dsh-research-workbench/types'
import { ResearchEntryLine, ResearchTryChips, type EntryLineProps, type TryChipsProps } from '../src/client/EntryScreen.tsx'
import type { EntryNotice, ResearchView } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'
import { standingOf } from './fixtures/standing.ts'
import { MODES } from './fixtures/modes.ts'

afterEach(cleanup)

const t = (key: string, params?: Record<string, unknown>): string => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (m, name: string) => name in params ? String(params[name]) : m)
}

const draft: ResearchProject = { ...newProject({ title: '新研究', root: '/home/SciPaper/2026-09-26-1', brief: '' }, 'w-draft' as WorkspaceId), draft: true, untitled: true }
const named: ResearchProject = { ...newProject({ title: '块稀疏注意力', root: '/research/sparse', brief: '' }, 'w-sparse' as WorkspaceId), sessionId: 's-first' }
const example: ResearchProject = { ...newProject({ title: '示例', root: '/demo/example', brief: '' }, 'w-example' as WorkspaceId), example: true }

function snapshotOf(projects: ResearchProject[], modes: ResearchSnapshot['modes'] = []): ResearchSnapshot {
  return { projects, preferences: {}, components: [], modes }
}

/** The injected face and globals, reading fixed values. */
function lineProps(parts: {
  current?: string
  notice?: EntryNotice | null
  snapshot?: ResearchSnapshot | null
  directories?: Record<string, string>
}) {
  const snapshot = parts.snapshot === undefined ? snapshotOf([draft, named, example]) : parts.snapshot
  const view: ResearchView = { snapshot, tasks: [], response: null }
  const list = { current: parts.current as SessionId | undefined, byId: {} } as unknown as SessionListState
  const showProgress = vi.fn()
  const props = {
    t,
    useSessions: (select: (state: SessionListState) => unknown) => select(list),
    useEntry: (select: (state: { notice: EntryNotice | null }) => unknown) => select({ notice: parts.notice ?? null }),
    useResearch: (select: (state: ResearchView) => unknown) => select(view),
    useDirectories: (select: (state: Record<string, string>) => unknown) => select(parts.directories ?? {
      's-draft': '/home/SciPaper/2026-09-26-1', 's-new': '/research/sparse', 's-example': '/demo/example', 's-loose': '/elsewhere',
    }),
    showProgress,
  } as unknown as EntryLineProps
  return { props, showProgress }
}

describe('the line under the headline', () => {
  it('says nothing for the untouched draft, a conversation outside every research, or no conversation', () => {
    for (const current of ['s-draft', 's-loose', undefined]) {
      const { props } = lineProps({ ...(current === undefined ? {} : { current }) })
      expect(render(<ResearchEntryLine {...props} />).container.innerHTML).toBe('')
      cleanup()
    }
  })

  it('names a new conversation of a research with where the research stands, and opens the research tab from it', () => {
    const { props, showProgress } = lineProps({ current: 's-new' })
    const view = render(<ResearchEntryLine {...props} />)
    // Before the modes arrive, the mode reads by its id.
    expect(view.container.textContent).toBe(`${zh.entryNewConversation}·general·${zh.entryRecord}`)
    fireEvent.click(view.getByRole('button', { name: zh.entryRecord }))
    expect(showProgress).toHaveBeenCalledOnce()
    cleanup()
    const phased = { ...named, mode: 'spark-to-paper', route: 'data', standing: standingOf([['data', 'done'], ['plan', 'current'], ['cite', 'pending']]) }
    const staged = lineProps({ current: 's-new', snapshot: snapshotOf([phased], MODES) })
    expect(render(<ResearchEntryLine {...staged.props} />).container.textContent).toBe('新对话·spark-to-paper · 规划 1/3·研究记录')
  })

  it('says an example is only to be viewed', () => {
    const { props } = lineProps({ current: 's-example' })
    expect(render(<ResearchEntryLine {...props} />).container.textContent).toBe(zh.entryExample)
  })

  it('shows a notice only on the screen it was raised on', () => {
    const here: EntryNotice = { kind: 'here', sessionId: 's-draft' }
    const shown = render(<ResearchEntryLine {...lineProps({ current: 's-draft', notice: here }).props} />)
    expect(shown.getByRole('status').textContent).toBe(zh.entryHere)
    cleanup()
    expect(render(<ResearchEntryLine {...lineProps({ current: 's-new', notice: here }).props} />).queryByRole('status')).toBeNull()
  })

  it('says why a landing, 新研究, a move or a reveal failed, beside the line it may follow', () => {
    const sentences = { land: zh.entryLandFailed, new: zh.entryNewFailed, move: zh.entryMoveFailed, reveal: zh.entryRevealFailed }
    for (const [action, sentence] of Object.entries(sentences)) {
      const notice = { kind: 'failed', action, reason: '磁盘已满', sessionId: undefined } as EntryNotice
      const view = render(<ResearchEntryLine {...lineProps({ notice, snapshot: null }).props} />)
      expect(view.getByRole('alert').textContent).toBe(sentence.replace('{reason}', '磁盘已满'))
      cleanup()
    }
    const both = render(<ResearchEntryLine {...lineProps({ current: 's-new', notice: { kind: 'failed', action: 'new', reason: 'x', sessionId: 's-new' } }).props} />)
    expect(both.getByRole('alert')).toBeTruthy()
    expect(both.getByRole('button', { name: zh.entryRecord })).toBeTruthy()
  })
})

/** Props of the Try sentences above one session's composer. */
function tryProps(parts: { draftText?: string; blank?: boolean | undefined; projects?: ResearchProject[] | null; sessionId?: string }) {
  const sessionId = (parts.sessionId ?? 's-draft') as SessionId
  const view: ResearchView = { snapshot: parts.projects === null ? null : snapshotOf(parts.projects ?? [draft]), tasks: [], response: null }
  const byId = parts.blank === undefined ? {} : { [sessionId]: { blank: parts.blank } }
  const list = { current: sessionId, byId } as unknown as SessionListState
  const setDraft = vi.fn()
  const props = {
    t, sessionId,
    input: { draft: parts.draftText ?? '' },
    inputActions: { setDraft },
    useSessions: (select: (state: SessionListState) => unknown) => select(list),
    useResearch: (select: (state: ResearchView) => unknown) => select(view),
    useDirectories: (select: (state: Record<string, string>) => unknown) => select({ 's-draft': '/home/SciPaper/2026-09-26-1', 's-new': '/research/sparse' }),
  } as unknown as TryChipsProps
  return { props, setDraft }
}

describe('the Try sentences', () => {
  it('offer the two example sentences above the untouched draft\'s empty composer, and only add them to the draft', () => {
    const { props, setDraft } = tryProps({ blank: true, draftText: '  ' })
    const view = render(<ResearchTryChips {...props} />)
    expect(view.container.textContent).toBe(`${zh.entryTry}「${zh.heroOpeningMaterials}」「${zh.heroOpeningIdea}」`)
    const chips = view.getAllByRole('button')
    expect(chips.map(chip => chip.getAttribute('title'))).toEqual([zh.entryTryHint, zh.entryTryHint])
    fireEvent.click(chips[1]!)
    expect(setDraft).toHaveBeenCalledWith(zh.heroOpeningIdea)
  })

  it('stay away once something is typed, once the first turn started, outside the draft, and before the record is read', () => {
    const cases = [
      tryProps({ blank: true, draftText: '已经写了一句' }),
      tryProps({ blank: false }),
      tryProps({ blank: undefined }),
      tryProps({ blank: true, sessionId: 's-new', projects: [draft, named] }),
      tryProps({ blank: true, projects: null }),
    ]
    for (const { props } of cases) {
      expect(render(<ResearchTryChips {...props} />).container.innerHTML).toBe('')
      cleanup()
    }
  })
})
