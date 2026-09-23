// @vitest-environment jsdom

/**
 * The blank-session entry and the dock beside a research conversation. The
 * resume card says where the most recently touched project stands by its last
 * check; the dock opens the rail once and shows the newest claim and figure.
 * No decision is ever raised here — the assistant asks in the conversation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { ArtifactId, ResearchMode, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchDock, ResearchStarters, ResearchHeroMark, ResearchPromise } from '../src/client/Hero.tsx'
import type { SessionSeatProps, WorkbenchProps } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const SESSION = 'session-hero'

function project(title: string, updatedAt: string, mode?: ResearchMode): ResearchProject {
  const record = newProject({ root: `/research/${title}`, title, brief: '', ...(mode ? { mode } : {}) }, 'workspace' as WorkspaceId)
  record.updatedAt = updatedAt
  return record
}

function propsFor(
  projects: ResearchProject[] | null, blank: boolean, opened: string[] = [], progress: { n: number } = { n: 0 },
): WorkbenchProps & SessionSeatProps & { session: { blank: boolean } } {
  const view = { snapshot: projects === null ? null : { projects, preferences: {}, components: [] }, tasks: [], busy: false, error: '', response: null }
  return {
    sessionId: SESSION,
    t: (key: string, params?: Record<string, unknown>) => {
      const template = (zh as Record<string, string>)[key] ?? key
      return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
    },
    useResearch: (select: (value: typeof view) => unknown) => select(view),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select({}),
    openConversation: (sessionId: string) => { opened.push(sessionId); return Promise.resolve() },
    showProgress: () => { progress.n += 1 },
    focusClaim: () => {},
    expand: () => {},
    session: { blank },
  } as unknown as WorkbenchProps & SessionSeatProps & { session: { blank: boolean } }
}

describe('the mark and the standing promises', () => {
  it('draws the mark at the size the hero asks for, keeping the host class, or its own size', () => {
    const svg = render(<ResearchHeroMark size={20} className="host" />).container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('20')
    expect(svg?.getAttribute('class')).toBe('host')
    expect(render(<ResearchHeroMark />).container.querySelectorAll('svg')[0]?.getAttribute('width')).toBe('34')
  })

  it('states the promises under the hero and stays silent under the composer', () => {
    const hero = render(<ResearchPromise {...propsFor([], true)} variant="hero" />)
    expect(hero.getByText(zh.heroPromiseDecide)).toBeTruthy()
    expect(hero.getByText(zh.heroPromiseTrace)).toBeTruthy()
    expect(hero.getByText(zh.heroPromiseRuns)).toBeTruthy()
    expect(render(<ResearchPromise {...propsFor([], true)} variant="composer" />).container.textContent).toBe('')
  })
})

describe('the openings a blank session offers', () => {
  it('teaches the two ways in when there is no project to return to, snapshot or not', () => {
    for (const projects of [[], null]) {
      const view = render(<ResearchStarters {...propsFor(projects, true)} />)
      expect(view.getByText(zh.heroCardMaterials)).toBeTruthy()
      expect(view.getByText(zh.heroCardIdea)).toBeTruthy()
      expect(view.getByText(zh.heroNoHistory)).toBeTruthy()
      cleanup()
    }
  })

  it('offers the most recently touched project, standing by its last check, and walks back into it', () => {
    const older = project('older', '2026-09-01T00:00:00.000Z', 'free')
    older.sessionId = 'session-old'
    const newer = project('newer', '2026-09-20T00:00:00.000Z', 'paper-first')
    newer.sessionId = 'session-new'
    newer.lastCheck = { clean: false, scope: 'all', mode: 'paper-first', checkedAt: '', findings: [], phases: [{ id: 'idea', done: true, missing: [] }, { id: 'literature', done: false, missing: [] }] }
    const opened: string[] = []
    const view = render(<ResearchStarters {...propsFor([older, newer], true, opened)} />)
    expect(view.getByText('newer')).toBeTruthy()
    expect(view.getByText(`${zh.modeShortPaperFirst} · ${zh.phase_literature} 1/2`)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: new RegExp(zh.heroCardResume) }))
    expect(opened).toEqual(['session-new'])
  })

  it('shows a project without a session as a card, and stays standing when walking back is refused', async () => {
    const unbound = project('unbound', '2026-09-20T00:00:00.000Z')
    const first = render(<ResearchStarters {...propsFor([unbound], true)} />)
    expect(first.queryByRole('button')).toBeNull()
    expect(first.getByText(zh.modeUnset)).toBeTruthy()
    cleanup()
    const bound = project('bound', '2026-09-20T00:00:00.000Z', 'free')
    bound.sessionId = 'session-9'
    const refusing = { ...propsFor([bound], true), openConversation: () => Promise.reject(new Error('gone')) } as unknown as ReturnType<typeof propsFor>
    const view = render(<ResearchStarters {...refusing} />)
    fireEvent.click(view.getByRole('button', { name: new RegExp(zh.heroCardResume) }))
    await Promise.resolve()
    expect(view.getByText('bound')).toBeTruthy()
  })
})

describe('the dock beside a research conversation', () => {
  it('draws nothing without this session\'s project, and opens the rail once for it', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    expect(render(<ResearchDock {...propsFor([], false)} />).container.textContent).toBe('')
    const stranger = project('stranger', '2026-09-20T00:00:00.000Z', 'free')
    stranger.sessionId = 'session-elsewhere'
    expect(render(<ResearchDock {...propsFor([stranger], false)} />).container.textContent).toBe('')
    const mine = project('mine', '2026-09-20T00:00:00.000Z', 'free')
    mine.sessionId = SESSION
    const progress = { n: 0 }
    render(<ResearchDock {...propsFor([mine], true, [], progress)} />)
    expect(progress.n).toBe(1)
    const withoutProgress = { ...propsFor([mine], true), showProgress: undefined } as unknown as ReturnType<typeof propsFor>
    expect(render(<ResearchDock {...withoutProgress} />).container.textContent).toBe('')
  })

  it('keeps the newest claim and figure in view until runs take their place', () => {
    const mine = project('mine', '2026-09-20T00:00:00.000Z', 'paper-first')
    mine.sessionId = SESSION
    mine.claims.push({ id: 'c', text: '块稀疏保住了精度', kind: 'hypothesis', state: 'proposed', evidence: [], artifactIds: [] })
    mine.artifacts.push({ id: 'a' as ArtifactId, path: 'figures/arch.svg', kind: 'diagram', revision: 1, sha256: 's', evidence: [], claimIds: [], inputArtifacts: [], stale: false, updatedAt: '', author: 'agent' })
    const started = render(<ResearchDock {...propsFor([mine], false)} />)
    expect(started.getByText('块稀疏保住了精度')).toBeTruthy()
    // Blank sessions keep the entry openings instead.
    expect(render(<ResearchDock {...propsFor([mine], true)} />).container.querySelectorAll('article')).toHaveLength(0)
    cleanup()
    mine.experiments.push({ id: 'r' as never, spec: {} as never, status: 'running', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: {}, message: '', snapshotPath: '', collected: false })
    expect(render(<ResearchDock {...propsFor([mine], false)} />).container.textContent).toBe('')
  })
})
