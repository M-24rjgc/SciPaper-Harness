// @vitest-environment jsdom

/**
 * The 资料 (Sources) tab beside a conversation: what the research stands on,
 * named with its authors, year, DOI and what the research holds of it, each
 * source opening in the sidebar's own viewers, and the claims below, each
 * opening its sources over the frame. It imports, searches and verifies
 * nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { EvidenceId, EvidenceRecord, ProjectId, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ClaimFocus, ResearchSourcesParams, SourceReference } from '../src/client/contract.ts'
import { ResearchSourcesTab } from '../src/client/Sources.tsx'
import type { ResearchTabProps } from '../src/client/Tabs.tsx'
import type { Translate } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
// jsdom lays nothing out and has no scrolling; the test that looks at scrolling records each call.
Element.prototype.scrollIntoView = function scrollIntoView() {}

const SESSION = 'session-sources'
const ROOT = 'C:\\research\\summaries'
const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as Translate

function source(id: string, extra: Partial<EvidenceRecord>): EvidenceRecord {
  return {
    id: id as EvidenceId, title: id, kind: 'file', path: `.research/sources/${id}/1.csv`, sha256: 's', revision: 1, importedAt: '', chunks: [],
    coverage: 'data', verified: true, stale: false, ...extra,
  }
}

/** A research with a verified paper, an abstract-only reference, a stale dataset and two claims. */
function research(): ResearchProject {
  const project = newProject({ root: ROOT, title: '长文摘要一致性评测', brief: '' }, 'w' as WorkspaceId)
  project.sessionId = SESSION
  project.evidence.push(
    source('summac', {
      title: 'SummaC: Re-Visiting NLI-based Models', kind: 'literature', path: '.research/sources/summac/reference.json',
      fullTextPath: '.research/sources/summac/fulltext.pdf', doi: '10.1162/tacl_a_00453', coverage: 'full-text',
    }),
    source('summeval', { title: 'SummEval', kind: 'literature', path: '.research/sources/summeval/reference.json', coverage: 'abstract' }),
    source('mnli', { title: 'MNLI', kind: 'literature', path: '.research/sources/mnli/reference.json', coverage: 'metadata' }),
    source('consistency', { title: 'consistency.csv', stale: true }),
  )
  project.claims.push(
    { id: 'rank', text: 'SummaC 与人工排序一致。', kind: 'empirical', state: 'supported', evidence: [], artifactIds: [] },
    { id: 'drop', text: '长度增加后一致性下降。', kind: 'hypothesis', state: 'proposed', evidence: [], artifactIds: [] },
  )
  return project
}

interface Harness {
  props: ResearchTabProps
  opened: [string, string][]
  focused: (ClaimFocus | null)[]
  asked: string[]
  /** Navigate the tab again, as another open of it does. */
  navigate: (params: ResearchSourcesParams | undefined) => void
}

function mount(projects: ResearchProject[], options: {
  params?: ResearchSourcesParams
  openFile?: () => void
  references?: Record<string, SourceReference | undefined>
} = {}): Harness & { view: ReturnType<typeof render> } {
  const opened: [string, string][] = []
  const focused: (ClaimFocus | null)[] = []
  const asked: string[] = []
  const snapshot = { projects, preferences: {}, components: [], modes: [] }
  let navigation = { address: 'sidebar://research-sources', params: options.params as unknown, revision: 1 }
  const props = {
    sessionId: SESSION,
    t,
    useResearch: (select: (value: { snapshot: typeof snapshot; tasks: [] }) => unknown) => select({ snapshot, tasks: [] }),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select({}),
    useTabInfo: () => ({ tab: { contentId: navigation.address, navigation } }),
    openFile: (root: string, path: string) => { opened.push([root, path]); options.openFile?.() },
    focusClaim: (claim: ClaimFocus | null) => { focused.push(claim) },
    reference: (_projectId: ProjectId, item: EvidenceRecord) => {
      asked.push(item.id)
      return Promise.resolve(options.references?.[item.id])
    },
  } as unknown as ResearchTabProps
  const view = render(<ResearchSourcesTab {...props} />)
  const navigate = (params: ResearchSourcesParams | undefined): void => {
    navigation = { ...navigation, params, revision: navigation.revision + 1 }
    view.rerender(<ResearchSourcesTab {...props} />)
  }
  return { props, opened, focused, asked, navigate, view }
}

const settle = async (): Promise<void> => { await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }) }

describe('the Sources tab', () => {
  it('names each source with its byline, DOI and what the research holds of it', async () => {
    const references = {
      summac: { authors: ['Philippe Laban', 'Tobias Schnabel', 'Paul Bennett', 'Marti Hearst'], year: 2022 },
      summeval: { authors: ['Alexander Fabbri'] },
    }
    const { view, asked } = mount([research()], { references })
    await settle()
    // Only the literature sources have a reference record to read.
    expect(asked).toEqual(['summac', 'summeval', 'mnli'])
    expect(view.getByRole('heading', { name: `${zh.sourcesTab}4` })).toBeTruthy()
    const rows = view.getAllByRole('listitem').slice(0, 4)
    expect(within(rows[0]!).getByText('Philippe Laban, Tobias Schnabel, Paul Bennett 等 1 人 · 2022 · DOI 10.1162/tacl_a_00453')).toBeTruthy()
    expect(within(rows[0]!).getByText(zh.fullText, { selector: 'span' })).toBeTruthy()
    expect(within(rows[1]!).getByText('Alexander Fabbri')).toBeTruthy()
    expect(within(rows[1]!).getByText(zh.abstract)).toBeTruthy()
    // A reference that could not be read leaves the byline out.
    expect(within(rows[2]!).queryByText(/·/)).toBeNull()
    expect(within(rows[2]!).getByText(zh.metadata)).toBeTruthy()
    expect(within(rows[3]!).getByText(zh.data)).toBeTruthy()
    expect(within(rows[3]!).getByText(zh.stale)).toBeTruthy()
    // It offers nothing to import, search or verify.
    expect(view.queryByRole('textbox')).toBeNull()
    expect(view.queryByRole('combobox')).toBeNull()
  })

  it('opens a source and its full text in the sidebar\'s own viewers, and says why one could not be opened', async () => {
    let refuse = false
    const { view, opened } = mount([research()], { openFile: () => { if (refuse) throw new Error('no sidebar') } })
    const first = view.getAllByRole('listitem')[0]!
    fireEvent.click(within(first).getByRole('button', { name: zh.claimOpenSource }))
    fireEvent.click(within(first).getByRole('button', { name: zh.fullText }))
    await settle()
    expect(opened).toEqual([[ROOT, '.research/sources/summac/reference.json'], [ROOT, '.research/sources/summac/fulltext.pdf']])
    // A source without full text offers none.
    expect(within(view.getAllByRole('listitem')[3]!).queryByRole('button', { name: zh.fullText })).toBeNull()
    expect(view.queryByRole('alert')).toBeNull()
    refuse = true
    fireEvent.click(within(first).getByRole('button', { name: zh.claimOpenSource }))
    await settle()
    expect(view.getByRole('alert').textContent).toBe(t('actionFailed', { reason: 'no sidebar' }))
  })

  it('lists the claims with their state, each opening its sources over the frame', () => {
    const project = research()
    const { view, focused } = mount([project])
    expect(view.getByRole('heading', { name: `${zh.claims}2` })).toBeTruthy()
    const claim = view.getByRole('button', { name: /SummaC 与人工排序一致/ })
    expect(within(claim).getByText(zh.supported)).toBeTruthy()
    expect(within(view.getByRole('button', { name: /长度增加后/ })).getByText(zh.proposed)).toBeTruthy()
    fireEvent.click(claim)
    expect(focused).toEqual([{ projectId: project.id, claimId: 'rank' }])
  })

  it('scrolls to the claims when it is opened for them, and to its top for any other open, on every open', () => {
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this) })
    const { view, navigate } = mount([research()], { params: { section: 'claims' } })
    const claims = view.getByRole('heading', { name: `${zh.claims}2` }).parentElement
    const top = view.container.firstElementChild
    expect(scrolled).toEqual([claims])
    navigate({ section: 'claims' })
    expect(scrolled).toEqual([claims, claims])
    // An open for the sources, or a navigation carrying other parameters, starts at the top.
    navigate(undefined)
    navigate({ line: 3 } as never)
    expect(scrolled).toEqual([claims, claims, top, top])
  })

  it('says when a research has no sources or claims yet, and marks an example', () => {
    const bare = newProject({ root: ROOT, title: 'Bare', brief: '' }, 'w' as WorkspaceId)
    bare.sessionId = SESSION
    bare.example = true
    const { view, asked } = mount([bare])
    expect(view.getByText(zh.sourcesEmpty)).toBeTruthy()
    expect(view.getByText(zh.noClaims)).toBeTruthy()
    expect(view.getByText(zh.exampleBanner)).toBeTruthy()
    expect(asked).toEqual([])
  })

  it('says so beside a conversation in no research', () => {
    const elsewhere = research()
    elsewhere.sessionId = 'another-conversation'
    expect(mount([elsewhere]).view.getByText(zh.railNoProject)).toBeTruthy()
  })

  it('drops a byline that arrives after the tab closed', async () => {
    let answer = (_value: SourceReference): void => {}
    const project = research()
    project.evidence.splice(1)
    const props = {
      sessionId: SESSION, t,
      useResearch: (select: (value: unknown) => unknown) =>
        select({ snapshot: { projects: [project], preferences: {}, components: [], modes: [] }, tasks: [] }),
      useDirectories: (select: (value: Record<string, string>) => unknown) => select({}),
      useTabInfo: () => ({ tab: { contentId: 'sidebar://research-sources', navigation: { address: 'sidebar://research-sources', params: undefined, revision: 1 } } }),
      reference: () => new Promise<SourceReference>((resolve) => { answer = resolve }),
    } as unknown as ResearchTabProps
    const errors = vi.spyOn(console, 'error')
    render(<ResearchSourcesTab {...props} />).unmount()
    await act(async () => { answer({ authors: ['Late'] }); await Promise.resolve() })
    expect(errors).not.toHaveBeenCalled()
  })
})
