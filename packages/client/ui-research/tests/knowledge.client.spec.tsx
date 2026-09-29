// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type { KnowledgeGraphPage, ResearchCommand, ResearchResponse, ResearchSnapshot } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { KnowledgePluginPage, KnowledgeTab } from '../src/client/Knowledge.tsx'
import type { ResearchTabProps } from '../src/client/Tabs.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const t = (key: string, params?: Record<string, unknown>): string => {
  const text = (zh as Record<string, string>)[key] ?? key
  return text.replace(/\{(\w+)\}/g, (match, name: string) => params?.[name] === undefined ? match : String(params[name]))
}
const graph: KnowledgeGraphPage = {
  nodes: [
    { id: 'ai:domain:ML', kind: 'domain', label: 'ML', source: 'ai', domain: 'ML', summary: '' },
    { id: 'ai:pattern:p', kind: 'pattern', label: 'Sparse attention', source: 'ai', domain: 'ML', summary: 'Attention kernels' },
    { id: 'ai:paper:1', kind: 'paper', label: 'Original paper', source: 'ai', domain: 'ML', summary: 'Verified abstract', url: 'https://example.org/paper' },
  ],
  edges: [{ from: 'ai:paper:1', to: 'ai:pattern:p', kind: 'uses-pattern' }, { from: 'ai:pattern:p', to: 'ai:domain:ML', kind: 'in-domain' }],
  graphs: [{ source: 'ai', name: 'AI', patterns: 1, papers: 1 }], domains: ['ML'], warnings: [], total: 1, offset: 0, hasMore: false,
}
function harness(enabled = true, example = false) {
  const project = newProject({ root: '/research/graph', title: 'Graph study', brief: '' }, 'workspace' as WorkspaceId)
  project.sessionId = 'session-graph'; project.example = example
  const snapshot: ResearchSnapshot = { projects: [project], preferences: {}, modes: [], components: [], knowledge: { enabled } }
  const commands: ResearchCommand[] = []
  const configure = vi.fn(async () => {})
  const props = {
    t, view: 'page' as const, sessionId: project.sessionId,
    useCurrentSession: (select: (value: string) => unknown) => select(project.sessionId!),
    useDirectories: (select: (value: object) => unknown) => select({}),
    useResearch: (select: (value: object) => unknown) => select({ snapshot, tasks: [] }),
    useTabInfo: () => ({ tab: { navigation: { revision: 1, params: { query: 'attention' } } } }),
    refresh: async () => {}, configure, openKnowledge: vi.fn(),
    run: async (request: ResearchCommand): Promise<ResearchResponse> => {
      commandSchema.parse(request); commands.push(request)
      return { project, message: 'Graph ready', knowledgeGraph: graph }
    },
  } as ResearchTabProps & { view: 'page' }
  return { props, project, snapshot, commands, configure }
}
async function settle(): Promise<void> { await act(async () => { await Promise.resolve() }) }

it('opens the graph from the official plugin detail page and follows nodes to source papers', async () => {
  const h = harness()
  const view = render(<KnowledgePluginPage {...h.props} />)
  fireEvent.click(view.getByRole('button', { name: zh.kgOpen })); await settle()
  expect(h.commands[0]).toMatchObject({ action: 'graph-view', projectId: h.project.id })
  expect(view.container.querySelectorAll('[data-relation]')).toHaveLength(2)
  fireEvent.click(view.getByRole('button', { name: 'Original paper' }))
  expect(view.getByRole('link', { name: zh.kgOriginal }).getAttribute('href')).toBe('https://example.org/paper')
  fireEvent.change(view.getByRole('combobox', { name: zh.kgSource }), { target: { value: 'project' } }); await settle()
  expect(h.commands.at(-1)).toMatchObject({ action: 'graph-view', source: 'project' })
  fireEvent.change(view.getByRole('searchbox'), { target: { value: 'graph learning' } })
  fireEvent.submit(view.getByRole('search')); await settle()
  expect(h.commands.at(-1)).toMatchObject({ query: 'graph learning' })
})

it('uses the tool result query in the conversation sidebar and reports failed queries', async () => {
  const h = harness()
  const view = render(<KnowledgeTab {...h.props} />); await settle()
  expect(h.commands[0]).toMatchObject({ query: 'attention' })
  expect((view.getByRole('searchbox') as HTMLInputElement).value).toBe('attention')
  const failed = { ...h.props, run: async () => { throw new Error('Graph unavailable') } }
  view.rerender(<KnowledgeTab {...failed} />)
  fireEvent.submit(view.getByRole('search')); await settle()
  expect(view.getByText(/Graph unavailable/)).toBeTruthy()
})

it('withdraws graph controls when disabled and does not offer graph writes for read-only examples', () => {
  const disabled = harness(false)
  const view = render(<KnowledgePluginPage {...disabled.props} />)
  expect(view.getByText(zh.kgDisabled)).toBeTruthy()
  expect(view.queryByRole('button', { name: zh.kgOpen })).toBeNull()
  expect(disabled.commands).toEqual([])
  cleanup()
  const example = render(<KnowledgePluginPage {...harness(true, true).props} />)
  expect(example.queryByText(zh.kgBuild)).toBeNull()
  expect(example.getByRole('button', { name: zh.kgOpen })).toBeTruthy()
})

it('validates prepared-corpus writes and prevents saving a key without an embedding endpoint', async () => {
  const h = harness()
  const view = render(<KnowledgePluginPage {...h.props} />)
  fireEvent.click(view.getByText(zh.kgBuild))
  fireEvent.change(view.getByLabelText(zh.kgDomain), { target: { value: 'Physics' } })
  fireEvent.submit(view.getByRole('button', { name: zh.kgCluster }).closest('form')!); await settle()
  expect(h.commands).toContainEqual({ action: 'build-graph', projectId: h.project.id, papers: 'papers.jsonl', domain: 'Physics' })
  fireEvent.click(view.getByText(zh.kgSettings))
  fireEvent.change(view.getByLabelText(zh.kgKey), { target: { value: 'example-key' } })
  fireEvent.submit(view.getByRole('button', { name: zh.kgSave }).closest('form')!); await settle()
  expect(h.configure).not.toHaveBeenCalled()
  expect(view.getByText(new RegExp(zh.kgEmbeddingRequired))).toBeTruthy()
})
