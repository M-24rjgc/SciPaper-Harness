// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type {
  EvidenceGraphPage, KnowledgeGraphPage, KnowledgeModules, MapOverlayPage, MapViewPage, RelationsPage, ResearchCommand, ResearchResponse,
  ResearchSnapshot,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { KnowledgePluginPage, KnowledgeTab, knowledgeViews } from '../src/client/Knowledge.tsx'
import type { ResearchTabProps } from '../src/client/Tabs.tsx'
import { zh } from '../src/client/locales.ts'
import { page } from './fixtures/memory.ts'
import { translate } from './fixtures/translate.ts'

afterEach(cleanup)
const t = translate(zh)
const graph: KnowledgeGraphPage = {
  nodes: [
    { id: 'ai:domain:ML', kind: 'domain', label: 'ML', source: 'ai', domain: 'ML', summary: '' },
    { id: 'ai:pattern:p', kind: 'pattern', label: 'Sparse attention', source: 'ai', domain: 'ML', summary: 'Attention kernels' },
    { id: 'ai:paper:1', kind: 'paper', label: 'Original paper', source: 'ai', domain: 'ML', summary: 'Verified abstract', url: 'https://example.org/paper' },
  ],
  edges: [{ from: 'ai:paper:1', to: 'ai:pattern:p', kind: 'uses-pattern' }, { from: 'ai:pattern:p', to: 'ai:domain:ML', kind: 'in-domain' }],
  graphs: [{ source: 'ai', name: 'AI', patterns: 1, papers: 1 }], domains: ['ML'], warnings: [], total: 1, offset: 0, hasMore: false,
}
const evidence: EvidenceGraphPage = {
  question: 'Does it scale?', claims: [], sources: [], summary: { claims: 0, supported: 0, stale: 0, missing: 0, proposed: 0, contradicted: 0 },
}
const emptyMemory = page()
const noRelations: RelationsPage = {
  problems: [], counts: { entities: 0, relations: 0, stale: 0, rejected: 0, citationLists: 0 }, match: 'none', hubs: [], candidates: [], rejected: [],
}
const none: KnowledgeModules = { map: false, evidence: false, memory: false, relations: false }
function harness(enabled = true, example = false, modules: KnowledgeModules = none, params: object = { query: 'attention' }, draft = '') {
  const setDraft = vi.fn()
  const project = newProject({ root: '/research/graph', title: 'Graph study', brief: '' }, 'workspace' as WorkspaceId)
  project.sessionId = 'session-graph'; project.example = example
  const snapshot: ResearchSnapshot = { projects: [project], preferences: {}, modes: [], components: [], knowledge: { enabled, modules } }
  const commands: ResearchCommand[] = []
  const configure = vi.fn(async () => {})
  const props = {
    t, view: 'page' as const, sessionId: project.sessionId,
    useCurrentSession: (select: (value: string) => unknown) => select(project.sessionId!),
    useDirectories: (select: (value: object) => unknown) => select({}),
    useResearch: (select: (value: object) => unknown) => select({ snapshot, tasks: [] }),
    useTabInfo: () => ({ tab: { navigation: { revision: 1, params } } }),
    useInput: (select: (value: object) => unknown) => select({ draft }), inputActions: { setDraft },
    refresh: async () => {}, configure, openKnowledge: vi.fn(),
    run: async (request: ResearchCommand): Promise<ResearchResponse> => {
      commandSchema.parse(request); commands.push(request)
      if (request.action === 'evidence-graph') return { message: 'Evidence', evidenceGraph: evidence }
      if (request.action === 'map-view') return { message: 'Map', mapView: { built: false } }
      if (request.action === 'memory') return { message: 'Memory', memory: emptyMemory }
      if (request.action === 'relations-graph') return { message: 'Graph', relations: noRelations }
      return { project, message: 'Graph ready', knowledgeGraph: graph }
    },
  } as ResearchTabProps & { view: 'page' }
  return { props, project, snapshot, commands, configure, setDraft }
}
async function settle(): Promise<void> { await act(async () => { await Promise.resolve() }) }
const everything: KnowledgeModules = { map: true, evidence: true, memory: true, relations: true }

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

it('offers a view for each knowledge plugin that is on, in the order of the tab, and none when all are off', () => {
  expect(knowledgeViews(undefined)).toBeUndefined()
  expect(knowledgeViews({ enabled: false, modules: none })).toBeUndefined()
  expect(knowledgeViews({ enabled: true, modules: none })).toEqual(['catalog'])
  expect(knowledgeViews({ enabled: false, modules: { ...none, evidence: true } })).toEqual(['evidence'])
  expect(knowledgeViews({ enabled: false, modules: { ...none, memory: true } })).toEqual(['memory'])
  expect(knowledgeViews({ enabled: false, modules: { ...none, relations: true } })).toEqual(['relations'])
  expect(knowledgeViews({ enabled: true, modules: everything })).toEqual(['map', 'relations', 'evidence', 'memory', 'catalog'])
})

it('opens the tab on the research\'s own evidence and switches between the views of the plugins that are on', async () => {
  const h = harness(true, false, everything, {})
  const view = render(<KnowledgeTab {...h.props} />); await settle()
  const tabs = view.getAllByRole('tab')
  expect(tabs.map(tab => tab.textContent)).toEqual([zh.kgViewMap, zh.kgViewRelations, zh.kgViewEvidence, zh.kgViewMemory, zh.kgViewCatalog])
  expect(view.getByRole('tablist').getAttribute('aria-label')).toBe(zh.kgViews)
  expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false', 'false'])
  expect(h.commands).toEqual([{ action: 'evidence-graph', projectId: h.project.id }])
  expect(view.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[2]!.id)
  expect(view.getByText(zh.egEmpty)).toBeTruthy()

  fireEvent.click(tabs[0]!); await settle()
  expect(h.commands.at(-1)).toEqual({ action: 'map-view', projectId: h.project.id })
  expect(view.getByText(zh.kmNotBuiltTitle)).toBeTruthy()
  expect(view.getByText(zh.kmNotBuiltBody)).toBeTruthy()
  expect(view.queryByText(zh.egEmpty)).toBeNull()

  fireEvent.click(tabs[1]!); await settle()
  expect(h.commands.at(-1)).toEqual({ action: 'relations-graph', projectId: h.project.id, hops: 2 })
  expect(view.getByText(zh.relationsEmptyTitle)).toBeTruthy()
  expect(view.queryByText(zh.kmNotBuiltTitle)).toBeNull()

  fireEvent.click(tabs[3]!); await settle()
  expect(h.commands.at(-1)).toEqual({ action: 'memory', projectId: h.project.id })
  expect(view.getByText(zh.memHeadline)).toBeTruthy()
  expect(view.getByText(zh.memEmpty)).toBeTruthy()

  fireEvent.click(tabs[4]!); await settle()
  expect(h.commands.at(-1)).toMatchObject({ action: 'graph-view' })
  expect(view.getByRole('search')).toBeTruthy()
})

it('shows only the evidence view, without a switch, when the graph engine and the map are off', async () => {
  const h = harness(false, false, { ...none, evidence: true }, {})
  const view = render(<KnowledgeTab {...h.props} />); await settle()
  expect(view.queryByRole('tablist')).toBeNull()
  expect(view.queryByRole('tabpanel')).toBeNull()
  expect(h.commands).toEqual([{ action: 'evidence-graph', projectId: h.project.id }])
  expect(view.getByText(zh.egEmpty)).toBeTruthy()
})

it('opens on the map when it is the first view offered, and on the catalog when a tool result searched for something', async () => {
  const onlyMap = harness(true, false, { ...none, map: true }, {})
  const first = render(<KnowledgeTab {...onlyMap.props} />); await settle()
  expect(first.getAllByRole('tab').map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false'])
  expect(onlyMap.commands).toEqual([{ action: 'map-view', projectId: onlyMap.project.id }])
  first.unmount()
  const searched = harness(true, false, everything, { pattern: 'ai:pattern:p' })
  const second = render(<KnowledgeTab {...searched.props} />); await settle()
  expect(second.getAllByRole('tab').map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false', 'false', 'true'])
  expect(searched.commands).toEqual([{ action: 'graph-view', projectId: searched.project.id, source: 'all', pattern: 'ai:pattern:p', query: undefined }])
  fireEvent.click(second.getAllByRole('tab')[2]!); await settle()
  expect(second.getAllByRole('tab').map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false', 'false'])
})

it('says when no conversation research is open and when no knowledge plugin is on', () => {
  const noResearch = harness(true, false, everything)
  const props = { ...noResearch.props, useCurrentSession: (select: (value: string | undefined) => unknown) => select(undefined) }
  const view = render(<KnowledgeTab {...props} sessionId="elsewhere" />)
  expect(view.getByText(zh.railNoProject)).toBeTruthy()
  view.unmount()
  expect(render(<KnowledgeTab {...harness(false).props} />).getByText(zh.kgDisabled)).toBeTruthy()
})

it('offers the evidence view on the plugin page while the graph engine is off, without the graph-building forms', async () => {
  const h = harness(false, false, { ...none, evidence: true }, {})
  const view = render(<KnowledgePluginPage {...h.props} />)
  expect(view.queryByText(zh.kgDisabled)).toBeNull()
  expect(view.queryByText(zh.kgBuild)).toBeNull()
  fireEvent.click(view.getByRole('button', { name: zh.kgOpen })); await settle()
  expect(h.commands).toEqual([{ action: 'evidence-graph', projectId: h.project.id }])
})

it('hands the map\'s questions to the composer after what is already typed, and a region\'s words to the catalog', async () => {
  const built: MapViewPage = {
    built: true, graph: { name: 'ai', papers: 1, patterns: 1 }, points: Buffer.from([0, 128, 0, 128]).toString('base64'), regionOf: Buffer.from([0]).toString('base64'),
    regions: [{ index: 0, label: 'attention / sparse', keywords: ['attention', 'sparse'], papers: 1, domain: 'ML', x: 0.5, y: 0.5 }], gaps: [],
  }
  const overlay: MapOverlayPage = {
    built: true, library: [], recalled: [], marks: [],
    idea: { text: 'an idea', source: 'recall', placement: { x: 0.5, y: 0.5, confidence: 1, region: 'attention / sparse', alternatives: [], nearest: [], crowding: 0.5 } },
  }
  const h = harness(true, false, { map: true, evidence: false }, {}, 'First line')
  const run = h.props.run
  h.props.run = async request => request.action === 'map-view' ? { message: 'Map', mapView: built }
    : request.action === 'map-overlay' ? { message: 'Overlay', mapOverlay: overlay } : run(request)
  const view = render(<KnowledgeTab {...h.props} />); await settle()
  fireEvent.click(view.getByRole('button', { name: zh.kmAskNovelty }))
  expect(h.setDraft).toHaveBeenCalledWith(`First line\n${zh.kmAskNoveltyDraft}`)
  fireEvent.click(view.getByRole('button', { name: zh.kmInCatalog })); await settle()
  expect(view.getAllByRole('tab').map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  expect(h.commands.at(-1)).toMatchObject({ action: 'graph-view', query: 'attention sparse' })
  expect((view.getByRole('searchbox') as HTMLInputElement).value).toBe('attention sparse')
})

it('offers the map no way to the catalog while the graph engine is off', async () => {
  const h = harness(false, false, { map: true, evidence: false }, {})
  const run = h.props.run
  h.props.run = async request => request.action === 'map-view' ? { message: 'Map', mapView: { built: false } } : run(request)
  const view = render(<KnowledgeTab {...h.props} />); await settle()
  expect(view.queryByRole('tablist')).toBeNull()
  expect(view.getByText(zh.kmNotBuiltTitle)).toBeTruthy()
})
