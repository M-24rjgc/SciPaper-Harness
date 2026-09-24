// @vitest-environment jsdom

/**
 * The figure gallery panel. Every search and save it sends goes through the
 * validator the service parses commands with, so a control that builds a
 * request the service would refuse fails here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type { GalleryFigure, GalleryPage, ResearchCommand, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { Gallery } from '../src/client/Gallery.tsx'
import type { GallerySearchRequest, WorkbenchProps } from '../src/client/contract.ts'
import { galleryImageUrl } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const t = (key: string, params?: Record<string, unknown>): string => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}

function figure(id: string, extra: Partial<GalleryFigure> = {}): GalleryFigure {
  return { id, venue: 'neurips', year: 2024, title: `Figure ${id}`, authors: ['Ada Lovelace'], pattern: 'architecture', paper: `https://papers.example/${id}`, width: 800, height: 400, ...extra }
}

const FACETS: GalleryPage['facets'] = {
  venue: { neurips: 5, iclr: 3, chi: 1 }, year: { 2024: 6, 2026: 2, 2023: 1 },
  pattern: { architecture: 4, pipeline: 5, 'hand-drawn': 1 }, tier: { award: 1, oral: 2 },
}
const SOURCE = { name: 'Top-Conf Figure Gallery', repository: 'https://github.com/owner/gallery', commit: 'c', license: 'MIT' }
const page = (figures: GalleryFigure[], total = figures.length, basis: GalleryPage['basis'] = 'browse', offset = 0): GalleryPage =>
  ({ total, offset, figures, basis, facets: FACETS, source: SOURCE })

interface Pending { request: GallerySearchRequest; answer: (value: GalleryPage) => void; fail: (reason: unknown) => void }

interface Harness {
  props: WorkbenchProps & { project: ResearchProject }
  searches: Pending[]
  runs: ResearchCommand[]
  /** Whether the next save is refused. */
  failRun: { next: boolean }
}

function harness(project: ResearchProject): Harness {
  const searches: Pending[] = []
  const runs: ResearchCommand[] = []
  const failRun = { next: false }
  const props = {
    t, project,
    searchFigures: (request: GallerySearchRequest) => {
      expect(commandSchema.parse(request)).toBeTruthy()
      return new Promise<GalleryPage>((answer, fail) => { searches.push({ request, answer, fail }) })
    },
    run: (command: ResearchCommand) => {
      expect(commandSchema.parse(command)).toBeTruthy()
      runs.push(command)
      return failRun.next ? Promise.reject(new Error('saving failed')) : Promise.resolve({ message: 'started', jobId: 'job' })
    },
  } as unknown as WorkbenchProps & { project: ResearchProject }
  return { props, searches, runs, failRun }
}

const project = (): ResearchProject => newProject({ root: '/research/agents', title: 'Agents', brief: '' }, 'w' as WorkspaceId)
const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
async function answer(pending: Pending | undefined, value: GalleryPage): Promise<void> {
  await act(async () => { pending?.answer(value); await Promise.resolve() })
}

describe('the figure gallery panel', () => {
  it('browses the gallery first, with filters drawn from its facets', async () => {
    const h = harness(project())
    const view = render(<Gallery {...h.props} />)
    // Before the first page arrives the filters have nothing to offer.
    expect(within(view.getByRole('combobox', { name: zh.galleryPatternLabel })).getAllByRole('option')).toHaveLength(1)
    expect(h.searches[0]?.request).toEqual({ action: 'find-reference-figures', projectId: h.props.project.id, limit: 24, offset: 0 })
    await answer(h.searches[0], page([
      figure('iclr2025-1', { venue: 'iclr', year: 2025, award: 'best', tier: 'oral' }),
      figure('neurips2024-2', { tier: 'spotlight' }),
      figure('chi2024-3', { venue: 'chi' }),
    ], 30))
    expect(view.getByText('共 30 张 · 按录取等级与设计分排序')).toBeTruthy()
    const cards = view.getAllByRole('button', { pressed: false })
    expect(cards.map(card => card.textContent)).toEqual([
      'Figure iclr2025-1ICLR 2025最佳论文与荣誉提名', 'Figure neurips2024-2NeurIPS 2024Spotlight', 'Figure chi2024-3CHI 2024',
    ])
    expect(within(cards[0]!).getByRole('img').getAttribute('src')).toBe(galleryImageUrl('iclr2025-1'))
    const options = (name: string): string[] => within(view.getByRole('combobox', { name })).getAllByRole('option').map(option => option.textContent ?? '')
    expect(options(zh.galleryPatternLabel)).toEqual(['图的类型 · 全部', '流程图 (5)', '架构图 (4)', 'hand-drawn (1)'])
    expect(options(zh.galleryVenueLabel)).toEqual(['会议 · 全部', 'CHI (1)', 'ICLR (3)', 'NeurIPS (5)'])
    expect(options(zh.galleryYearLabel)).toEqual(['年份 · 全部', '2026 (2)', '2024 (6)', '2023 (1)'])
    expect(options(zh.galleryTierLabel)).toEqual(['录取等级 · 全部', '最佳论文与荣誉提名 (1)', 'Oral (2)', 'Spotlight (0)'])
    expect(view.getByRole('link', { name: '来自 Top-Conf Figure Gallery' }).getAttribute('href')).toBe(SOURCE.repository)
  })

  it('narrows with each filter and ranks by the submitted query, one page after another', async () => {
    const h = harness(project())
    const view = render(<Gallery {...h.props} />)
    await answer(h.searches[0], page([figure('neurips2024-1')], 1))
    fireEvent.change(view.getByRole('combobox', { name: zh.galleryPatternLabel }), { target: { value: 'pipeline' } })
    fireEvent.change(view.getByRole('combobox', { name: zh.galleryVenueLabel }), { target: { value: 'iclr' } })
    fireEvent.change(view.getByRole('combobox', { name: zh.galleryYearLabel }), { target: { value: '2026' } })
    fireEvent.change(view.getByRole('combobox', { name: zh.galleryTierLabel }), { target: { value: 'oral' } })
    fireEvent.change(view.getByRole('searchbox', { name: zh.galleryQuery }), { target: { value: '  agent memory ' } })
    fireEvent.submit(view.getByRole('search'))
    const base = { action: 'find-reference-figures', projectId: h.props.project.id, limit: 24, offset: 0 }
    expect(h.searches.slice(1).map(item => item.request)).toEqual([
      { ...base, pattern: 'pipeline' },
      { ...base, pattern: 'pipeline', venue: 'iclr' },
      { ...base, pattern: 'pipeline', venue: 'iclr', year: 2026 },
      { ...base, pattern: 'pipeline', venue: 'iclr', year: 2026, tier: 'oral' },
      { ...base, pattern: 'pipeline', venue: 'iclr', year: 2026, tier: 'oral', query: 'agent memory' },
    ])
    await answer(h.searches[5], page([figure('iclr2026-1'), figure('iclr2026-2')], 3, 'semantic'))
    expect(view.getByText('共 3 张 · 按关键词与语义排序')).toBeTruthy()
    // Typing without searching again does not change what the next page continues.
    fireEvent.change(view.getByRole('searchbox', { name: zh.galleryQuery }), { target: { value: 'something else' } })
    fireEvent.click(view.getByRole('button', { name: zh.galleryMore }))
    expect(h.searches[6]?.request).toMatchObject({ query: 'agent memory', offset: 2 })
    await answer(h.searches[6], page([figure('iclr2026-3')], 3, 'semantic', 2))
    expect(view.getAllByRole('button', { pressed: false }).map(card => card.textContent?.slice(0, 17))).toEqual([
      'Figure iclr2026-1', 'Figure iclr2026-2', 'Figure iclr2026-3',
    ])
    expect(view.queryByRole('button', { name: zh.galleryMore })).toBeNull()
  })

  it('keeps only the latest answer, and says what went wrong with it', async () => {
    const h = harness(project())
    const view = render(<Gallery {...h.props} />)
    const fail = async (pending: Pending | undefined, reason: unknown): Promise<void> => {
      await act(async () => { pending?.fail(reason); await Promise.resolve() })
    }
    fireEvent.submit(view.getByRole('search'))
    // The first search answers after the second: it is dropped.
    await answer(h.searches[1], page([], 0, 'keyword'))
    await answer(h.searches[0], page([figure('neurips2024-1')]))
    expect(view.getByText(zh.galleryEmpty)).toBeTruthy()
    // So is the failure of a search that a newer one replaced; the newest one's failure is shown.
    fireEvent.submit(view.getByRole('search'))
    fireEvent.submit(view.getByRole('search'))
    await fail(h.searches[2], new Error('late'))
    expect(view.queryByRole('alert')).toBeNull()
    await fail(h.searches[3], new Error('gallery offline'))
    expect(view.getByRole('alert').textContent).toBe('gallery offline')
    fireEvent.submit(view.getByRole('search'))
    await fail(h.searches[4], 'unreadable')
    expect(view.getByRole('alert').textContent).toBe('unreadable')
    fireEvent.submit(view.getByRole('search'))
    await answer(h.searches[5], page([figure('neurips2024-1')]))
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('opens a figure with its paper, and saves it as a reference under the label given', async () => {
    const h = harness(project())
    const view = render(<Gallery {...h.props} />)
    const crowd = ['A One', 'B Two', 'C Three', 'D Four', 'E Five', 'F Six']
    await answer(h.searches[0], page([
      figure('iclr2025-1', { venue: 'iclr', year: 2025, authors: crowd, tier: 'oral', pattern: 'pipeline' }),
      figure('neurips2024-2', { authors: ['Ada Lovelace', 'Alan Turing'] }),
    ]))
    fireEvent.click(view.getByRole('button', { name: /Figure iclr2025-1/ }))
    const detail = view.getByRole('article', { name: 'Figure iclr2025-1' })
    expect(within(detail).getByText('A One, B Two, C Three, D Four 等 2 人')).toBeTruthy()
    expect(within(detail).getByText('ICLR 2025 · 流程图 · Oral')).toBeTruthy()
    expect(within(detail).getByRole('link', { name: zh.galleryOpenPaper }).getAttribute('href')).toBe('https://papers.example/iclr2025-1')
    expect(view.getByRole('button', { pressed: true }).textContent).toMatch(/^Figure iclr2025-1/)
    fireEvent.change(within(detail).getByRole('textbox', { name: zh.galleryLabel }), { target: { value: 'agent-loop' } })
    fireEvent.submit(within(detail).getByRole('button', { name: zh.gallerySave }).closest('form')!)
    expect(h.runs).toEqual([{ action: 'fetch-reference-figures', projectId: h.props.project.id, galleryIds: ['iclr2025-1'], label: 'agent-loop' }])
    expect(within(detail).getByRole('status').textContent).toBe(zh.gallerySaving)
    expect(within(detail).getByText(zh.galleryCopyright)).toBeTruthy()

    // Another figure starts afresh: its own label, nothing saving; a failed save leaves the panel as it was.
    fireEvent.click(view.getByRole('button', { name: /Figure neurips2024-2/ }))
    const next = view.getByRole('article', { name: 'Figure neurips2024-2' })
    expect(within(next).getByText('Ada Lovelace, Alan Turing')).toBeTruthy()
    expect(within(next).getByText('NeurIPS 2024 · 架构图')).toBeTruthy()
    expect(within(next).queryByRole('status')).toBeNull()
    h.failRun.next = true
    fireEvent.submit(within(next).getByRole('button', { name: zh.gallerySave }).closest('form')!)
    await settle()
    expect(h.runs.at(-1)).toMatchObject({ galleryIds: ['neurips2024-2'], label: 'method-overview' })
    fireEvent.click(within(next).getByRole('button', { name: zh.close }))
    expect(view.queryByRole('article')).toBeNull()
  })
})
