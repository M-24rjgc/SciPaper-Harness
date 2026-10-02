// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type {
  KnowledgeGraphNode, KnowledgeGraphPage, ResearchCommand, ResearchPreferences, ResearchResponse, ResearchSnapshot,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { KnowledgePluginPage, KnowledgeTab } from '../src/client/Knowledge.tsx'
import type { KnowledgeChat } from '../src/client/followValues.ts'
import type { ResearchTabProps } from '../src/client/Tabs.tsx'
import { zh } from '../src/client/locales.ts'
import { chatOf } from './fixtures/trace.client.ts'
import { translate } from './fixtures/translate.tsx'

afterEach(cleanup)
const t = translate(zh)
const node =(patch: Partial<KnowledgeGraphNode> & Pick<KnowledgeGraphNode, 'id' | 'kind' | 'label'>): KnowledgeGraphNode =>
  ({ source: 'ai', domain: 'ML', summary: `${patch.label} summary`, ...patch })
const long = 'A pattern whose label is longer than twenty-nine characters'
const rich: KnowledgeGraphPage = {
  nodes: [
    node({ id: 'ai:domain:ML', kind: 'domain', label: 'ML', summary: '' }),
    node({ id: 'project:pattern:q', kind: 'pattern', label: long, source: 'project', problem: 'The problem', solution: 'The solution' }),
    node({ id: 'ai:paper:1', kind: 'paper', label: 'Open paper', url: 'https://example.org/paper' }),
    node({ id: 'ai:paper:2', kind: 'paper', label: 'Script link', url: 'javascript:alert(1)' }),
    node({ id: 'ai:paper:3', kind: 'paper', label: 'Broken link', url: 'not a url' }),
    node({ id: 'ai:paper:4', kind: 'paper', label: 'No link' }),
    node({ id: 'ai:odd', kind: 'method' as never, label: 'Unplaced' }),
  ],
  edges: [
    { from: 'ai:paper:1', to: 'project:pattern:q', kind: 'uses-pattern' },
    { from: 'ai:ghost', to: 'project:pattern:q', kind: 'uses-pattern' },
    { from: 'project:pattern:q', to: 'ai:domain:ML', kind: 'in-domain' },
    { from: 'nowhere', to: 'ai:domain:ML', kind: 'similar' },
  ],
  graphs: [{ source: 'ai', name: 'AI', patterns: 1, papers: 3 }, { source: 'project', name: 'Mine', patterns: 1, papers: 1 }],
  domains: ['ML', 'Physics'], warnings: ['Project graph is unreadable'], total: 20, offset: 8, hasMore: true,
}

const modules = { map: false, evidence: false, memory: false, relations: false }
/** A record in which the research is the one on screen, and one other research. */
function harness(preferences: ResearchPreferences = {}, example = false) {
  const project = newProject({ root: '/research/graph', title: 'Graph study', brief: '' }, 'workspace' as WorkspaceId)
  project.sessionId = 'session-graph'; project.example = example
  const other = newProject({ root: '/research/other', title: 'Other study', brief: '' }, 'workspace' as WorkspaceId)
  const snapshot: ResearchSnapshot = {
    projects: [project, other], preferences, modes: [], components: [], knowledge: { enabled: true, modules },
  }
  const commands: ResearchCommand[] = []
  const configure = vi.fn(async () => {})
  const openKnowledge = vi.fn()
  const props = {
    t, view: 'page' as const, sessionId: project.sessionId,
    useCurrentSession: (select: (value: string) => unknown) => select(project.sessionId!),
    useDirectories: (select: (value: object) => unknown) => select({}),
    useResearch: (select: (value: object) => unknown) => select({ snapshot, tasks: [] }),
    useTabInfo: () => ({ tab: { navigation: { revision: 1, params: {} } } }),
    useInput: (select: (value: object) => unknown) => select({ draft: '' }), inputActions: { setDraft: vi.fn() },
    useChat: (select: (value: KnowledgeChat) => unknown) => select(chatOf([])),
    useMarks: (select: (value: object) => unknown) => select({}), readMarks: vi.fn(),
    refresh: async () => {}, configure, openKnowledge,
    run: async (request: ResearchCommand): Promise<ResearchResponse> => {
      commands.push(request)
      return { project, message: request.action === 'name-patterns' ? 'Graph assembled' : 'Graph ready', knowledgeGraph: rich }
    },
  } as ResearchTabProps & { view: 'page' }
  return { props, project, other, commands, configure, openKnowledge }
}
async function settle(): Promise<void> { await act(async () => { await Promise.resolve() }) }
const detail = (view: ReturnType<typeof render>): HTMLElement | null => view.container.querySelector('[data-knowledge-detail]')
const nodes = (view: ReturnType<typeof render>): Element[] => [...view.container.querySelectorAll('g[role="button"]')]
const patternButton = (view: ReturnType<typeof render>): HTMLElement => view.container.querySelector('[class*="patterns"] button') as HTMLElement

it('explores a pattern, its papers and their links, and returns from the related papers', async () => {
  const h = harness()
  const view = render(<KnowledgeTab {...h.props} />); await settle()
  expect(view.getByText(zh.kgSourceWarning)).toBeTruthy()
  expect(view.getByText('Project graph is unreadable')).toBeTruthy()
  expect(view.getByText(`${zh.kgBuiltin} · ${t('kgCounts', { patterns: 1, papers: 3 })}`)).toBeTruthy()
  // The node that no column holds is left out, and so are the relations that lack an end.
  expect(nodes(view)).toHaveLength(6)
  expect(view.container.querySelectorAll('[data-relation]')).toHaveLength(2)
  expect(nodes(view)[1]!.textContent).toContain('A pattern whose label is lon…')

  fireEvent.click(patternButton(view))
  expect(detail(view)!.textContent).toContain(long)
  expect(detail(view)!.textContent).toContain(zh.kgPattern)
  expect(detail(view)!.textContent).toContain(zh.kgProject)
  expect(detail(view)!.textContent).toContain('The problem')
  expect(detail(view)!.textContent).toContain('The solution')
  fireEvent.click(within(detail(view)!).getByRole('button', { name: 'Open paper' }))
  expect(view.getByRole('link', { name: zh.kgOriginal }).getAttribute('href')).toBe('https://example.org/paper')

  fireEvent.click(patternButton(view))
  fireEvent.click(view.getByRole('button', { name: zh.kgRelated })); await settle()
  expect(h.commands.at(-1)).toMatchObject({ action: 'graph-view', source: 'project', pattern: 'project:pattern:q' })
  expect(detail(view)).toBeNull()
  fireEvent.click(view.getByRole('button', { name: zh.kgBack })); await settle()
  expect(h.commands.at(-1)).toMatchObject({ action: 'graph-view', source: 'project' })
  expect(view.queryByRole('button', { name: zh.kgBack })).toBeNull()
})

it('selects nodes in the drawing with the keyboard and offers a link only for a web address', async () => {
  const h = harness()
  const view = render(<KnowledgeTab {...h.props} />); await settle()
  const [domain, , paper, script, broken, plain] = nodes(view)
  fireEvent.keyDown(domain!, { key: 'Enter' })
  expect(detail(view)!.textContent).toContain(zh.kgDomain)
  fireEvent.keyDown(paper!, { key: ' ' })
  expect(view.getByRole('link', { name: zh.kgOriginal })).toBeTruthy()
  fireEvent.keyDown(script!, { key: 'Enter' })
  expect(view.queryByRole('link', { name: zh.kgOriginal })).toBeNull()
  fireEvent.keyDown(broken!, { key: 'Enter' })
  expect(view.queryByRole('link', { name: zh.kgOriginal })).toBeNull()
  fireEvent.keyDown(plain!, { key: 'Escape' })
  expect(detail(view)!.textContent).toContain('Broken link')
  fireEvent.click(plain!)
  expect(detail(view)!.textContent).toContain('No link')
  expect(detail(view)!.textContent).toContain(zh.kgPaper)
})

it('filters by domain and pages through the results', async () => {
  const h = harness()
  const view = render(<KnowledgeTab {...h.props} />); await settle()
  const domain = view.getByRole('combobox', { name: zh.kgDomain })
  fireEvent.change(domain, { target: { value: 'Physics' } }); await settle()
  expect(h.commands.at(-1)).toMatchObject({ domain: 'Physics', offset: 0, pattern: undefined })
  fireEvent.change(domain, { target: { value: '' } }); await settle()
  expect(h.commands.at(-1)).toMatchObject({ domain: undefined })
  expect(view.getByText(t('kgMatches', { count: 20 }))).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: zh.kgPrevious })); await settle()
  expect(h.commands.at(-1)).toMatchObject({ offset: 0 })
  fireEvent.click(view.getByRole('button', { name: zh.kgNext })); await settle()
  expect(h.commands.at(-1)).toMatchObject({ offset: 16 })
})

it('saves the embedding endpoint with its key, and removes it when both fields are cleared', async () => {
  const h = harness({ embedding: { baseUrl: 'https://emb.example/v1', model: 'emb-small' } })
  const view = render(<KnowledgePluginPage {...h.props} />)
  fireEvent.click(view.getByText(zh.kgSettings))
  expect((view.getByLabelText(zh.kgEndpoint) as HTMLInputElement).value).toBe('https://emb.example/v1')
  fireEvent.change(view.getByLabelText(zh.kgModel), { target: { value: 'emb-large' } })
  fireEvent.change(view.getByLabelText(zh.kgKey), { target: { value: 'secret' } })
  fireEvent.submit(view.getByRole('button', { name: zh.kgSave }).closest('form')!); await settle()
  expect(h.configure).toHaveBeenLastCalledWith({ embedding: { baseUrl: 'https://emb.example/v1', model: 'emb-large' } }, { image: '', embedding: 'secret' })
  expect(view.getByRole('status').textContent).toBe(zh.kgSaved)
  expect((view.getByLabelText(zh.kgKey) as HTMLInputElement).value).toBe('')
  fireEvent.change(view.getByLabelText(zh.kgEndpoint), { target: { value: '' } })
  fireEvent.change(view.getByLabelText(zh.kgModel), { target: { value: '' } })
  fireEvent.submit(view.getByRole('button', { name: zh.kgSave }).closest('form')!); await settle()
  expect(h.configure).toHaveBeenLastCalledWith({}, { image: '', embedding: '' })
})

it('assembles the project graph from the cluster names and opens it', async () => {
  const h = harness()
  const view = render(<KnowledgePluginPage {...h.props} />)
  fireEvent.click(view.getByText(zh.kgBuild))
  fireEvent.change(view.getByLabelText(zh.kgNames), { target: { value: 'names.json' } })
  fireEvent.submit(view.getByRole('button', { name: zh.kgAssemble }).closest('form')!); await settle()
  expect(h.commands[0]).toEqual({ action: 'name-patterns', projectId: h.project.id, names: 'names.json' })
  expect(view.getByText('Graph assembled')).toBeTruthy()
  expect(h.commands.at(-1)).toMatchObject({ action: 'graph-view', projectId: h.project.id })
})

it('chooses the research whose graph to open, opens it beside the conversation, and words the summary and the wait', async () => {
  const h = harness()
  const view = render(<KnowledgePluginPage {...h.props} />)
  fireEvent.change(view.getByLabelText(zh.kgResearch), { target: { value: h.other.id } })
  fireEvent.click(view.getByRole('button', { name: zh.kgOpen })); await settle()
  expect(h.commands[0]).toMatchObject({ projectId: h.other.id })
  fireEvent.click(view.getByRole('button', { name: zh.kgBesideChat }))
  expect(h.openKnowledge).toHaveBeenCalledOnce()
  view.unmount()
  expect(render(<KnowledgePluginPage {...h.props} view="summary" />).getByText(zh.kgShared)).toBeTruthy()
  cleanup()
  const unread = ((select: (value: object) => unknown): unknown => select({ snapshot: null, tasks: [] })) as never
  const waiting = render(<KnowledgePluginPage {...h.props} useResearch={unread} />)
  expect(waiting.getByRole('status').textContent).toBe(zh.kgLoading)
  cleanup()
  const tab = render(<KnowledgeTab {...h.props} useResearch={unread} />)
  expect(tab.getByText(zh.kgDisabled)).toBeTruthy()
})

it('shows an empty graph, an answer without one, and a refusal that is not an error', async () => {
  const h = harness()
  const empty = render(<KnowledgeTab {...h.props} run={async () => ({ message: 'ok', knowledgeGraph: { ...rich, nodes: [], edges: [] } })} />); await settle()
  expect(empty.getByText(zh.kgEmpty)).toBeTruthy()
  empty.unmount()
  const nothing = render(<KnowledgeTab {...h.props} run={async () => ({ message: 'ok' })} />); await settle()
  expect(nothing.getByRole('alert').textContent).toContain(zh.kgNoResponse)
  nothing.unmount()
  const refused = render(<KnowledgeTab {...h.props} run={async () => { throw 'plain refusal' }} />); await settle()
  expect(refused.getByRole('alert').textContent).toContain('plain refusal')
})

it('ignores the answer and the failure of a query that a newer one has overtaken', async () => {
  const h = harness()
  const pending: PromiseWithResolvers<ResearchResponse>[] = []
  const run = (): Promise<ResearchResponse> => {
    const next = Promise.withResolvers<ResearchResponse>()
    pending.push(next)
    return next.promise
  }
  const view = render(<KnowledgeTab {...h.props} run={run} />)
  fireEvent.submit(view.getByRole('search'))
  pending[1]!.resolve({ message: 'ok', knowledgeGraph: rich }); await settle()
  pending[0]!.resolve({ message: 'late', knowledgeGraph: { ...rich, nodes: [], edges: [] } }); await settle()
  expect(view.queryByText(zh.kgEmpty)).toBeNull()
  expect(nodes(view)).toHaveLength(6)
  fireEvent.submit(view.getByRole('search'))
  fireEvent.submit(view.getByRole('search'))
  pending[3]!.resolve({ message: 'ok', knowledgeGraph: rich }); await settle()
  pending[2]!.reject(new Error('Overtaken failure')); await settle()
  expect(view.queryByRole('alert')).toBeNull()
})

it('offers no research to open when the record holds none and no conversation is on screen', () => {
  const h = harness()
  const props = {
    ...h.props,
    useCurrentSession: (select: (value: undefined) => unknown) => select(undefined),
    useResearch: (select: (value: object) => unknown) => select({
      snapshot: { projects: [], preferences: {}, modes: [], components: [], knowledge: { enabled: true, modules } }, tasks: [],
    }),
  }
  const view = render(<KnowledgePluginPage {...props as typeof h.props} />)
  expect((view.getByLabelText(zh.kgResearch) as HTMLSelectElement).value).toBe('')
  expect((view.getByRole('button', { name: zh.kgOpen }) as HTMLButtonElement).disabled).toBe(true)
  expect(view.queryByRole('button', { name: zh.kgBesideChat })).toBeNull()
})
