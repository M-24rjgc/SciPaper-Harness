// @vitest-environment jsdom

/**
 * The experiment board and figure gallery tabs beside a conversation: each
 * shows the research of the conversation it sits beside, and an example
 * research reads as view only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { EnvironmentId, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { GallerySearchRequest } from '../src/client/contract.ts'
import {
  ResearchBoardTab, ResearchBoardTitle, ResearchGalleryTab, ResearchGalleryTitle, ResearchSourcesTitle, type ResearchTabProps,
} from '../src/client/Tabs.tsx'
import type { Translate } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const SESSION = 'session-tab'
const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as Translate

/** The conversation's research, one run of it in flight. */
function research(example: boolean): ResearchProject {
  const project = newProject({ root: '/research/sparse', title: 'Sparse', brief: '' }, 'w' as WorkspaceId)
  project.sessionId = SESSION
  if (example) project.example = true
  project.experiments.push({
    id: 'live' as never, status: 'running', createdAt: '2026-09-24T10:00:00.000Z', updatedAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    directory: '', inputRevision: 1, environmentFingerprint: '', metrics: {}, message: '', snapshotPath: '', collected: false,
    spec: { name: 'main/a', seed: 1, environmentId: 'here' as EnvironmentId, argv: ['{python}', 'train.py'], cwd: '.', maxSeconds: 600, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' },
  })
  return project
}

/** A tab beside the conversation `SESSION`; the board's and the gallery's reads never answer. */
function tab(projects: ResearchProject[]): { props: ResearchTabProps; searches: GallerySearchRequest[] } {
  const searches: GallerySearchRequest[] = []
  const view = { snapshot: { projects, preferences: {}, components: [], modes: [] }, tasks: [] }
  const props = {
    sessionId: SESSION,
    t,
    useResearch: (select: (value: typeof view) => unknown) => select(view),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select({}),
    board: () => new Promise(() => {}),
    searchFigures: (request: GallerySearchRequest) => { searches.push(request); return new Promise(() => {}) },
    run: () => new Promise(() => {}),
  } as unknown as ResearchTabProps
  return { props, searches }
}

describe('the experiment board tab', () => {
  it('shows the board of the conversation\'s research, whose runs in flight can be stopped', () => {
    const view = render(<ResearchBoardTab {...tab([research(false)]).props} />)
    expect(view.getByRole('region', { name: zh.boardTitle })).toBeTruthy()
    expect(view.getByRole('button', { name: zh.runStop })).toBeTruthy()
    expect(view.queryByText(zh.exampleBanner)).toBeNull()
  })

  it('opens an example research as view only', () => {
    const view = render(<ResearchBoardTab {...tab([research(true)]).props} />)
    expect(view.getByText(zh.exampleBanner)).toBeTruthy()
    expect(view.getByRole('button', { name: zh.logs })).toBeTruthy()
    expect(view.queryByRole('button', { name: zh.runStop })).toBeNull()
  })
})

describe('the figure gallery tab', () => {
  it('searches the gallery for the conversation\'s research, marking an example', () => {
    const own = research(false)
    const { props, searches } = tab([own])
    const view = render(<ResearchGalleryTab {...props} />)
    expect(view.getByText(zh.galleryIntro)).toBeTruthy()
    expect(view.queryByText(zh.exampleBanner)).toBeNull()
    expect(searches).toEqual([{ action: 'find-reference-figures', projectId: own.id, limit: 24, offset: 0 }])
    cleanup()
    expect(render(<ResearchGalleryTab {...tab([research(true)]).props} />).getByText(zh.exampleBanner)).toBeTruthy()
  })
})

describe('a tab beside a conversation in no research', () => {
  it('says so instead of showing another research\'s board or figures', () => {
    const elsewhere = research(false)
    elsewhere.sessionId = 'another-conversation'
    expect(render(<ResearchBoardTab {...tab([elsewhere]).props} />).getByText(zh.railNoProject)).toBeTruthy()
    cleanup()
    const { props, searches } = tab([elsewhere])
    expect(render(<ResearchGalleryTab {...props} />).getByText(zh.railNoProject)).toBeTruthy()
    expect(searches).toEqual([])
  })
})

describe('the tabs\' chips', () => {
  it('name each tab in the interface language as it is now', () => {
    expect(render(<ResearchBoardTitle t={t} />).container.textContent).toBe(zh.boardTitle)
    cleanup()
    expect(render(<ResearchSourcesTitle t={t} />).container.textContent).toBe(zh.sourcesTab)
    cleanup()
    expect(render(<ResearchGalleryTitle t={t} />).container.textContent).toBe(zh.gallery)
  })
})
