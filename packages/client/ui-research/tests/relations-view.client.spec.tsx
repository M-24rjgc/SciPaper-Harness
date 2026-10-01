// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import { RelationsView } from '../src/client/RelationsView.tsx'
import { zh } from '../src/client/locales.ts'
import {
  anyId, EDGES, NODES, edge, harness, longformerPage, node, record, relationsPage, t, type Handlers,
} from './fixtures/relations.ts'

afterEach(cleanup)
async function settle(): Promise<void> { await act(async () => { for (let at = 0; at < 8; at++) await Promise.resolve() }) }

type Options = Parameters<typeof harness>[1]
async function mount(handlers: Partial<Handlers> = {}, options: Options = {}) {
  const h = harness(handlers, options)
  const view = render(<RelationsView {...h.props} />)
  await settle()
  return { ...h, view }
}
const graphs = (commands: readonly { action: string }[]): readonly { action: string }[] => commands.filter(command => command.action === 'relations-graph')
const node$ = (view: ReturnType<typeof render>, name: string, kind: string): HTMLElement =>
  view.getByRole('button', { name: t('relationsNodeLabel', { name, kind }) })
const edge$ = (view: ReturnType<typeof render>, from: string, kind: string, to: string): HTMLElement =>
  view.getByRole('button', { name: new RegExp(`^${t('relationsEdgeLabel', { from, kind, to })}`) })

it('reads the graph around the most connected entity and draws every node and relation as a named button', async () => {
  const { view, commands } = await mount()
  expect(graphs(commands)).toEqual([{ action: 'relations-graph', projectId: anyId, hops: 2 }])
  expect(view.getByText(t('relationsCentredOn', { name: '块稀疏注意力' }))).toBeTruthy()
  expect(view.getByText(t('relationsCounts', { entities: 11, relations: 11, stale: 1, rejected: 1 }))).toBeTruthy()
  const graph = view.getByRole('group', { name: zh.relationsGraph })
  expect(within(graph).getAllByRole('button')).toHaveLength(NODES.length + EDGES.length)
  expect(node$(view, '块稀疏注意力', '方法').getAttribute('aria-current')).toBe('true')
  expect(node$(view, '动态选块', '方法').getAttribute('aria-current')).toBeNull()
  expect(node$(view, 'RULER', '数据集')).toBeTruthy()
  expect(edge$(view, '动态选块', '属于', '块稀疏注意力')).toBeTruthy()
  // The legend names every kind of node, and the key says what the lines mean.
  const kinds = [zh.relationsKindMethod, zh.relationsKindTask, zh.relationsKindDataset, zh.relationsKindMetric, zh.relationsKindPaper]
  for (const kind of kinds) {
    expect(view.getAllByText(kind).length).toBeGreaterThan(0)
  }
  expect(view.getByText(zh.relationsLegendPath)).toBeTruthy()
  expect(view.getByText(zh.relationsLegendOther)).toBeTruthy()
  expect(view.container.querySelector('[data-relations-body]')).toBeTruthy()
  expect(view.container.querySelector('[data-relations-aside]')).toBeTruthy()
  expect(view.container.querySelector('[data-relations-view]')?.getAttribute('aria-busy')).toBe('false')
})

it('marks a relation whose sources changed and a paper the research no longer holds', async () => {
  const { view } = await mount()
  const stale = edge$(view, '块稀疏注意力', '评测于', 'RULER')
  expect(stale.textContent).toBe(`${zh.relationsRelEvaluatedOn} · ${zh.relationsStaleShort}`)
  expect(stale.getAttribute('aria-label')).toContain(zh.relationsOutdated)
  expect(stale.getAttribute('data-state')).toBe('stale')
  expect(edge$(view, '块稀疏注意力', '衡量指标', '准确率').getAttribute('data-state')).toBe('plain')
  expect(node$(view, 'BigBird', '论文').getAttribute('title')).toBe(`BigBird · ${zh.relationsOrphaned}`)
  expect(node$(view, 'Longformer', '论文').getAttribute('title')).toBe('Longformer')
})

it('centres the graph on a node that is clicked, and ignores a click on the centre', async () => {
  const { view, commands } = await mount()
  fireEvent.click(node$(view, '块稀疏注意力', '方法')); await settle()
  expect(graphs(commands)).toHaveLength(1)
  fireEvent.click(node$(view, 'Longformer', '论文')); await settle()
  expect(graphs(commands).at(-1)).toMatchObject({ entity: 'longformer', hops: 2 })
  expect(view.getByText(t('relationsCentredOn', { name: 'Longformer' }))).toBeTruthy()
  // Where the host left nodes out for size, the picture says so.
  expect(view.getByText(t('relationsOmitted', { nodes: 2, edges: 3 }))).toBeTruthy()
  expect(node$(view, 'Longformer', '论文').getAttribute('aria-current')).toBe('true')
})

it('starts from a hub, and a hub that is the centre is pressed', async () => {
  const { view, commands } = await mount()
  const hubs = view.getByText(zh.relationsHubsHead).parentElement as HTMLElement
  const centre = within(hubs).getByRole('button', { name: '块稀疏注意力' })
  expect(centre.getAttribute('aria-pressed')).toBe('true')
  const other = within(hubs).getByRole('button', { name: '固定分块' })
  expect(other.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(other); await settle()
  expect(graphs(commands).at(-1)).toMatchObject({ entity: 'fixed' })
})

it('finds an entity by name or alias and keeps the picture when nothing matches', async () => {
  const { view, commands } = await mount()
  const input = view.getByRole('searchbox', { name: zh.relationsSearch })
  const go = view.getByRole('button', { name: zh.relationsSearchButton }) as HTMLButtonElement
  expect(go.disabled).toBe(true)
  fireEvent.submit(view.getByRole('search'))
  expect(graphs(commands)).toHaveLength(1)
  fireEvent.change(input, { target: { value: ' Longformer ' } })
  expect(go.disabled).toBe(false)
  fireEvent.click(go); await settle()
  expect(graphs(commands).at(-1)).toMatchObject({ entity: 'Longformer' })
  expect(view.getByText(t('relationsCentredOn', { name: 'Longformer' }))).toBeTruthy()
  expect(view.queryByText(t('relationsUnknown', { text: 'Longformer' }))).toBeNull()

  fireEvent.change(input, { target: { value: 'nonsense' } })
  fireEvent.submit(view.getByRole('search')); await settle()
  expect(view.getByText(t('relationsUnknown', { text: 'nonsense' })).getAttribute('role')).toBe('status')
  // The earlier picture stays, and a read after a change still asks for the entity that was found.
  expect(view.getByText(t('relationsCentredOn', { name: 'Longformer' }))).toBeTruthy()
})

it('lists the entities an ambiguous name matches and centres on the one that is picked', async () => {
  const { view, commands } = await mount()
  fireEvent.change(view.getByRole('searchbox', { name: zh.relationsSearch }), { target: { value: 'attention' } })
  fireEvent.submit(view.getByRole('search')); await settle()
  expect(view.getByText(t('relationsAmbiguous', { text: 'attention' }))).toBeTruthy()
  const choices = view.getByText(t('relationsAmbiguous', { text: 'attention' })).parentElement as HTMLElement
  expect(within(choices).getAllByRole('button').map(button => button.textContent)).toEqual(['块稀疏注意力，方法', '动态选块，方法'])
  fireEvent.click(within(choices).getByRole('button', { name: '动态选块，方法' })); await settle()
  expect(graphs(commands).at(-1)).toMatchObject({ entity: 'dynamic' })
})

it('selects a relation by its name and shows it in the card, and takes the selection away when another graph replaces it', async () => {
  const { view } = await mount()
  expect(view.getByText(zh.relationsSelectedNone)).toBeTruthy()
  const label = edge$(view, '动态选块', '属于', '块稀疏注意力')
  fireEvent.click(label)
  expect(label.getAttribute('aria-pressed')).toBe('true')
  const card = view.container.querySelector('[data-relations-selected]') as HTMLElement
  expect(within(card).getByRole('heading', { name: '动态选块 —属于→ 块稀疏注意力' })).toBeTruthy()
  fireEvent.click(node$(view, 'Longformer', '论文')); await settle()
  expect(view.getByText(zh.relationsSelectedNone)).toBeTruthy()
})

it('shows the problems of the stored file as a warning', async () => {
  const { view } = await mount({ graph: () => ({ message: 'Graph', relations: relationsPage({ problems: ['Relation x was dropped: unknown entity.'] }) }) })
  const warning = view.container.querySelector('[data-relations-problems]') as HTMLElement
  expect(warning.getAttribute('role')).toBe('alert')
  expect(within(warning).getByText(zh.relationsProblemsHead)).toBeTruthy()
  expect(within(warning).getByText('Relation x was dropped: unknown entity.')).toBeTruthy()
})

it('says why there are no relations and offers the citation lists and the add form, with nothing in the way', async () => {
  const bare = { graph: () => ({ message: 'Graph', relations: relationsPage({ match: 'none', hubs: [], neighbourhood: undefined, counts: { entities: 0, relations: 0, stale: 0, rejected: 1, citationLists: 0 } }) }) }
  const { view } = await mount(bare)
  const empty = view.container.querySelector('[data-relations-empty]') as HTMLElement
  expect(within(empty).getByRole('heading', { name: zh.relationsEmptyTitle })).toBeTruthy()
  expect(within(empty).getByText(zh.relationsEmptyBody)).toBeTruthy()
  expect(within(empty).queryByText(zh.relationsEmptyNoSources)).toBeNull()
  expect(within(empty).getByRole('button', { name: zh.relationsCitations })).toBeTruthy()
  const form = empty.querySelector('[data-relations-propose]') as HTMLDetailsElement
  expect(form.open).toBe(true)
  expect(empty.querySelector('[data-relations-rejected]')).toBeTruthy()
  expect(view.container.querySelector('[data-relations-body]')).toBeNull()
  expect(view.queryByRole('searchbox')).toBeNull()
})

it('tells a research without imported sources to import some first, and leaves out what needs them', async () => {
  const bare = { graph: () => ({ message: 'Graph', relations: relationsPage({ hubs: [], neighbourhood: undefined, rejected: [] }) }) }
  const { view } = await mount(bare, { evidence: [] })
  expect(view.getByText(zh.relationsEmptyNoSources)).toBeTruthy()
  expect(view.queryByRole('button', { name: zh.relationsCitations })).toBeNull()
  expect(view.container.querySelector('[data-relations-propose]')).toBeNull()
  view.unmount()
  // Files alone can be quoted, but they have no reference lists to look up.
  const files = await mount(bare, { evidence: [record('e-notes', { kind: 'file', title: 'notes.md' })] })
  expect(files.view.queryByText(zh.relationsEmptyNoSources)).toBeNull()
  expect(files.view.queryByRole('button', { name: zh.relationsCitations })).toBeNull()
  expect(files.view.container.querySelector('[data-relations-propose]')).toBeTruthy()
})

it('can be looked at in an example research but changes nothing there', async () => {
  const { view, commands } = await mount({}, { example: true })
  fireEvent.click(edge$(view, '块稀疏注意力', '评测于', 'RULER'))
  const card = view.container.querySelector('[data-relations-selected]') as HTMLElement
  const writes = [
    within(card).getByRole('button', { name: zh.relationsRejectRelation }), within(card).getByRole('button', { name: zh.relationsReground }),
    within(card).getByRole('button', { name: zh.relationsRejectGround }),
    view.getByRole('button', { name: zh.relationsCitations }),
  ]
  for (const button of writes) {
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('title')).toBe(zh.relationsExampleReadOnly)
  }
  const before = commands.length
  for (const button of writes) fireEvent.click(button)
  const rejected = view.container.querySelector('[data-relations-rejected]') as HTMLElement
  fireEvent.click(rejected.querySelector('summary') as HTMLElement)
  expect(within(rejected).getByRole<HTMLButtonElement>('button', { name: zh.relationsRestore }).disabled).toBe(true)
  await settle()
  expect(commands).toHaveLength(before)
})

it('says why the graph could not be read: a plugin that went off, an empty answer, or a refusal that is not an error', async () => {
  const off = await mount({ graph: () => { throw new Error('Relation graph plugin is disabled.') } })
  expect(off.view.getByRole('alert').textContent).toContain('Relation graph plugin is disabled.')
  expect(off.view.container.querySelector('[data-relations-view]')?.getAttribute('aria-busy')).toBe('false')
  off.view.unmount()
  const none = await mount({ graph: () => ({ message: 'Graph' }) })
  expect(none.view.getByRole('alert').textContent).toContain(zh.kgNoResponse)
  none.view.unmount()
  const plain = await mount({ graph: () => { throw 'plain refusal' } })
  expect(plain.view.getByRole('alert').textContent).toContain('plain refusal')
})

it('shows that it is reading, and reads again when the research record changes', async () => {
  const slow = Promise.withResolvers<ResearchResponse>()
  const h = harness({ graph: () => slow.promise })
  const view = render(<RelationsView {...h.props} />)
  expect(view.getByRole('status').textContent).toBe(zh.kgLoading)
  expect(view.container.querySelector('[data-relations-view]')?.getAttribute('aria-busy')).toBe('true')
  slow.resolve({ message: 'Graph', relations: relationsPage() }); await settle()
  expect(h.commands.filter(command => command.action === 'relations-graph')).toHaveLength(1)
  view.rerender(<RelationsView {...h.props} project={{ ...h.props.project, revision: h.props.project.revision + 1 }} />); await settle()
  expect(h.commands.filter(command => command.action === 'relations-graph')).toHaveLength(2)
})

it('drops the answers of reads that a later read has overtaken', async () => {
  const first = Promise.withResolvers<ResearchResponse>()
  const second = Promise.withResolvers<ResearchResponse>()
  const pending = [first, second]
  const h = harness({ graph: () => (pending.shift() as typeof first).promise })
  const view = render(<RelationsView {...h.props} />)
  view.rerender(<RelationsView {...h.props} project={{ ...h.props.project, revision: 9 }} />)
  second.resolve({ message: 'Graph', relations: longformerPage() }); await settle()
  first.reject(new Error('Overtaken failure')); await settle()
  expect(view.queryByText(/Overtaken failure/)).toBeNull()
  expect(view.getByText(t('relationsCentredOn', { name: 'Longformer' }))).toBeTruthy()
  view.unmount()
  const late = Promise.withResolvers<ResearchResponse>()
  const lone = harness({ graph: () => late.promise })
  const gone = render(<RelationsView {...lone.props} />)
  gone.unmount()
  late.resolve({ message: 'Graph', relations: relationsPage() }); await settle()
  expect(document.body.textContent).toBe('')
})

it('keeps drawing a neighbourhood whose centre is missing from its nodes, and gives each node and relation a name to reach it by', async () => {
  const headless = relationsPage()
  headless.neighbourhood = { center: 'gone', nodes: NODES.slice(1, 4), edges: [edge('is-a', 'dynamic', 'fixed')], omitted: { nodes: 0, edges: 0 } }
  const { view } = await mount({ graph: () => ({ message: 'Graph', relations: headless }) })
  expect(view.getByText(t('relationsCentredOn', { name: 'gone' }))).toBeTruthy()
  expect(view.getAllByRole('button').every(button => button.tabIndex === 0)).toBe(true)
  expect(node$(view, '动态选块', '方法')).toBeTruthy()
  expect(node$(view, '固定分块', '方法')).toBeTruthy()
  expect(NODES[1]?.name).toBe(node('dynamic', 'method', '动态选块').name)
})
