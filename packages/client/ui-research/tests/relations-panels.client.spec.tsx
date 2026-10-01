// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { RelationEdgeView, ResearchCommand, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import { RelationsView } from '../src/client/RelationsView.tsx'
import { zh } from '../src/client/locales.ts'
import {
  anyId, NODES, edge, ground, harness, pathsPage, relationsPage, runGround, t, type Handlers,
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
type View = ReturnType<typeof render>
const label = (view: View, from: string, kind: string, to: string): HTMLElement =>
  view.getByRole('button', { name: new RegExp(`^${t('relationsEdgeLabel', { from, kind, to })}`) })
const card = (view: View, hook: string): HTMLElement => view.container.querySelector(`[${hook}]`) as HTMLElement
const asked = (commands: readonly ResearchCommand[], action: ResearchCommand['action']): ResearchCommand[] => commands.filter(command => command.action === action)
const lit = (view: View): string[] => [...view.container.querySelectorAll('button[data-state="path"]')].map(button => button.getAttribute('aria-label') as string)

/** The graph with other relations in place of the usual ones, so that a card can be shown what it has to handle. */
function withEdges(edges: RelationEdgeView[]): Partial<Handlers> {
  return { graph: () => ({ message: 'Graph', relations: relationsPage({ neighbourhood: { center: 'block', nodes: NODES, edges, omitted: { nodes: 0, edges: 0 } } }) }) }
}

async function ask(view: View, to: string): Promise<void> {
  const paths = card(view, 'data-relations-paths')
  fireEvent.change(within(paths).getByLabelText(zh.relationsTo), { target: { value: to } })
  fireEvent.click(within(paths).getByRole('button', { name: zh.relationsPathFind })); await settle()
}

it('asks how two things connect, starting from the entity the graph is centred on, and offers the graph\'s names', async () => {
  const { view, commands } = await mount()
  const paths = card(view, 'data-relations-paths')
  const from = within(paths).getByLabelText(zh.relationsFrom) as HTMLInputElement
  expect(from.value).toBe('块稀疏注意力')
  const find = within(paths).getByRole('button', { name: zh.relationsPathFind }) as HTMLButtonElement
  expect(find.disabled).toBe(true)
  const options = [...paths.querySelectorAll('datalist option')].map(option => option.getAttribute('value'))
  expect(options).toEqual(expect.arrayContaining(['块稀疏注意力', '固定分块', 'RULER', 'Longformer']))
  expect(new Set(options).size).toBe(options.length)
  await ask(view, '长文档摘要')
  expect(asked(commands, 'relations-paths')).toEqual([{ action: 'relations-paths', projectId: anyId, from: 'block', to: '长文档摘要', k: 3 }])
  // A start the person types is sent as typed, for the host to resolve by name or alias.
  fireEvent.change(from, { target: { value: 'Fixed blocks' } })
  fireEvent.submit(within(paths).getByRole('button', { name: zh.relationsPathFind }).closest('form') as HTMLElement); await settle()
  expect(asked(commands, 'relations-paths').at(-1)).toMatchObject({ from: 'Fixed blocks', to: '长文档摘要' })
})

it('shows the best path as a chain with each hop\'s words and place, and folds the other paths away', async () => {
  const { view } = await mount()
  await ask(view, '长文档摘要')
  const paths = card(view, 'data-relations-paths')
  expect(within(paths).getByText(/找到 2 条路径。/).textContent).toBe('找到 2 条路径。 最好的一条：2 个关系，可信度 67%。')
  const hops = paths.querySelectorAll('ol > li')
  expect(hops).toHaveLength(2)
  expect(within(hops[0] as HTMLElement).getByText('块稀疏注意力 ←属于— 固定分块')).toBeTruthy()
  expect(within(hops[1] as HTMLElement).getByText('固定分块 —用于→ 长文档摘要')).toBeTruthy()
  expect(within(hops[0] as HTMLElement).getByText(ground('x').quote as string)).toBeTruthy()
  expect(within(hops[0] as HTMLElement).getByText('全文 · Longformer: The Long-Document Transformer · 第 3 页')).toBeTruthy()
  expect(within(paths).queryByText(zh.relationsPathStale)).toBeNull()
  const others = paths.querySelector('details') as HTMLDetailsElement
  expect(within(others).getByText(t('relationsPathOthers', { n: 1 }))).toBeTruthy()
  expect(within(others).getByText('块稀疏注意力 —用于→ 长上下文建模 ←用于— 长文档摘要')).toBeTruthy()
  // The best path is lit in the graph; its relations are thick, the others thin.
  expect(lit(view)).toEqual(['固定分块 属于 块稀疏注意力', '固定分块 用于 长文档摘要'])
})

it('lights another path in the graph when it is chosen, marks a stale hop and says that the path rests on a changed source', async () => {
  const { view } = await mount()
  await ask(view, '长文档摘要')
  const paths = card(view, 'data-relations-paths')
  fireEvent.click(within(paths).getByRole('button', { name: zh.relationsPathShow }))
  expect(within(paths).getByText(/这条路径：2 个关系，可信度 40%。/)).toBeTruthy()
  expect(within(paths).getByText(zh.relationsPathStale)).toBeTruthy()
  expect(within(paths).getAllByText(zh.relationsStaleShort).length).toBeGreaterThan(0)
  expect(lit(view)).toEqual(['块稀疏注意力 用于 长上下文建模'])
  // The best one can be chosen back from the folded list.
  fireEvent.click(within(paths).getByRole('button', { name: zh.relationsPathShow }))
  expect(within(paths).getByText(/最好的一条/)).toBeTruthy()
})

it('shows a ground that has no quotation by its source alone, and a single path without a folded list', async () => {
  const single = pathsPage()
  single.paths = [{ ...single.paths[0], hops: [{ ...(single.paths[0]?.hops[0] as NonNullable<typeof single.paths[0]>['hops'][number]), grounds: [runGround] }] } as typeof single.paths[number]]
  const { view } = await mount({ paths: () => ({ message: 'Paths', relationPaths: single }) })
  await ask(view, '长文档摘要')
  const paths = card(view, 'data-relations-paths')
  expect(within(paths).getByText(/找到 1 条路径。/)).toBeTruthy()
  expect(within(paths).getByText('运行 · ruler-32k-dynamic · seed 42')).toBeTruthy()
  expect(paths.querySelector('blockquote')).toBeNull()
  expect(paths.querySelector('details')).toBeNull()
})

it('explains in words why there is no path, without saying the two are unrelated', async () => {
  const none = (reason: NonNullable<ReturnType<typeof pathsPage>['none']>) => ({ paths: () => ({ message: 'Paths', relationPaths: pathsPage({ paths: [], none: reason, nodes: [] }) }) })
  const reasons: [NonNullable<ReturnType<typeof pathsPage>['none']>, string][] = [
    ['unknown-node', zh.relationsPathUnknown], ['same-node', zh.relationsPathSame], ['no-path', zh.relationsPathNone],
  ]
  for (const [reason, text] of reasons) {
    const { view } = await mount(none(reason))
    await ask(view, 'whatever')
    expect(within(card(view, 'data-relations-paths')).getByText(text)).toBeTruthy()
    expect(card(view, 'data-relations-paths').querySelector('ol')).toBeNull()
    view.unmount()
  }
  expect(zh.relationsPathNone).toContain('并不说明两者无关')
})

it('lists the entities an ambiguous end matches and asks again with the one that is picked', async () => {
  const [a, b] = NODES.slice(1, 3).map(({ id, kind, name, aliases, status, degree }) => ({ id, kind, name, aliases, status, degree })) as [ReturnType<typeof relationsPage>['hubs'][number], ReturnType<typeof relationsPage>['hubs'][number]]
  let count = 0
  const { view, commands } = await mount({
    paths: () => count++ === 0
      ? { message: 'Paths', relationPaths: pathsPage({ paths: [], nodes: [], none: 'ambiguous-node', candidates: { from: [a, b], to: [a] } }) }
      : { message: 'Paths', relationPaths: pathsPage() },
  })
  await ask(view, 'block')
  const paths = card(view, 'data-relations-paths')
  expect(within(paths).getByText(zh.relationsPathAmbiguous)).toBeTruthy()
  // A side with one candidate has nothing to choose from.
  expect(paths.querySelectorAll('[data-side="to"]')).toHaveLength(0)
  fireEvent.click(within(paths).getByRole('button', { name: '固定分块，方法' })); await settle()
  expect(asked(commands, 'relations-paths').at(-1)).toMatchObject({ from: 'fixed', to: 'block' })
  expect(within(paths).getByLabelText<HTMLInputElement>(zh.relationsFrom).value).toBe('固定分块')
})

it('picks the end that is ambiguous on the to side by its id', async () => {
  const [a, b] = NODES.slice(1, 3).map(({ id, kind, name, aliases, status, degree }) => ({ id, kind, name, aliases, status, degree })) as [ReturnType<typeof relationsPage>['hubs'][number], ReturnType<typeof relationsPage>['hubs'][number]]
  const { view, commands } = await mount({
    paths: request => request.to === 'dynamic'
      ? { message: 'Paths', relationPaths: pathsPage() }
      : { message: 'Paths', relationPaths: pathsPage({ paths: [], nodes: [], none: 'ambiguous-node', candidates: { from: [a], to: [a, b] } }) },
  })
  await ask(view, 'attention')
  fireEvent.click(within(card(view, 'data-relations-paths')).getByRole('button', { name: '动态选块，方法' })); await settle()
  expect(asked(commands, 'relations-paths').at(-1)).toMatchObject({ from: 'block', to: 'dynamic' })
})

it('clears the pair for another one and puts the cursor in the second field', async () => {
  const { view } = await mount()
  await ask(view, '长文档摘要')
  const paths = card(view, 'data-relations-paths')
  fireEvent.change(within(paths).getByLabelText(zh.relationsFrom), { target: { value: 'something else' } })
  fireEvent.click(within(paths).getByRole('button', { name: zh.relationsPathAnother }))
  expect(within(paths).getByLabelText<HTMLInputElement>(zh.relationsFrom).value).toBe('块稀疏注意力')
  const to = within(paths).getByLabelText(zh.relationsTo) as HTMLInputElement
  expect(to.value).toBe('')
  expect(document.activeElement).toBe(to)
  expect(paths.querySelector('ol')).toBeNull()
  expect(lit(view)).toEqual([])
})

it('brings the start of a path that the picture does not hold to the centre, and asks again when the record changes', async () => {
  const outside = pathsPage()
  outside.paths = [{ ...(outside.paths[0] as typeof outside.paths[number]), nodes: ['outsider', 'fixed'] }]
  const { view, commands, props } = await mount({ paths: () => ({ message: 'Paths', relationPaths: outside }) })
  await ask(view, 'fixed')
  const graphs = asked(commands, 'relations-graph')
  expect(graphs.at(-1)).toMatchObject({ entity: 'outsider' })
  view.rerender(<RelationsView {...props} project={{ ...props.project, revision: props.project.revision + 1 }} />); await settle()
  expect(asked(commands, 'relations-paths')).toHaveLength(2)
})

it('says when the path could not be found, and when the host answered nothing', async () => {
  const failing = await mount({ paths: () => { throw new Error('Relation graph plugin is disabled.') } })
  await ask(failing.view, 'x')
  expect(within(card(failing.view, 'data-relations-paths')).getByRole('alert').textContent).toContain('Relation graph plugin is disabled.')
  failing.view.unmount()
  const empty = await mount({ paths: () => ({ message: 'Paths' }) })
  await ask(empty.view, 'x')
  expect(within(card(empty.view, 'data-relations-paths')).getByRole('alert').textContent).toContain(zh.kgNoResponse)
  empty.view.unmount()
  const slow = Promise.withResolvers<ResearchResponse>()
  const waiting = await mount({ paths: () => slow.promise })
  await ask(waiting.view, 'x')
  expect(within(card(waiting.view, 'data-relations-paths')).getByRole('button', { name: zh.relationsPathFinding })).toBeTruthy()
  fireEvent.click(within(card(waiting.view, 'data-relations-paths')).getByRole('button', { name: zh.relationsPathAnother }))
  slow.resolve({ message: 'Paths', relationPaths: pathsPage() }); await settle()
  expect(card(waiting.view, 'data-relations-paths').querySelector('ol')).toBeNull()
  waiting.view.unmount()
  const late = Promise.withResolvers<ResearchResponse>()
  const lost = await mount({ paths: () => late.promise })
  await ask(lost.view, 'x')
  fireEvent.click(within(card(lost.view, 'data-relations-paths')).getByRole('button', { name: zh.relationsPathAnother }))
  late.reject(new Error('Overtaken failure')); await settle()
  expect(lost.view.queryByText(/Overtaken failure/)).toBeNull()
})

it('writes a relation\'s ground in the source\'s own words with its place, who recorded it and how many grounds each source gave', async () => {
  const { view } = await mount()
  fireEvent.click(label(view, '固定分块', '属于', '块稀疏注意力'))
  const selected = card(view, 'data-relations-selected')
  expect(within(selected).getByRole('heading', { name: '固定分块 —属于→ 块稀疏注意力' })).toBeTruthy()
  expect(within(selected).getByText(/由助手记录 · 可信度 82% · 全文 1/)).toBeTruthy()
  expect(within(selected).getByText(t('relationsGroundsHead', { n: 1 }))).toBeTruthy()
  expect(selected.querySelector('blockquote')?.textContent).toBe('Longformer combines a sliding window with global attention on a few tokens.')
  expect(within(selected).getByText('全文 · Longformer: The Long-Document Transformer · 第 3 页')).toBeTruthy()
  expect(within(selected).getByText('由助手记录')).toBeTruthy()
  expect(within(selected).queryByText(zh.relationsOutdated)).toBeNull()
  expect(within(selected).queryByRole('button', { name: zh.relationsReground })).toBeNull()
})

it('shows a run as a ground with its setting and no source to open, and the person as its recorder', async () => {
  const { view, openFile } = await mount()
  fireEvent.click(label(view, '块稀疏注意力', '对比', '全注意力'))
  const selected = card(view, 'data-relations-selected')
  expect(within(selected).getByText(/由你记录/)).toBeTruthy()
  expect(within(selected).getByText(/运行 1$/)).toBeTruthy()
  expect(within(selected).getByText('运行 · ruler-32k-dynamic · seed 42')).toBeTruthy()
  expect(within(selected).getByText(t('relationsSetting', { setting: '32K' }))).toBeTruthy()
  expect(within(selected).queryByRole('button', { name: zh.relationsOpen })).toBeNull()
  expect(openFile).not.toHaveBeenCalled()
})

it('opens the source of a ground, and says so when the source is gone or cannot be shown', async () => {
  const { view, openFile } = await mount()
  fireEvent.click(label(view, '固定分块', '属于', '块稀疏注意力'))
  fireEvent.click(within(card(view, 'data-relations-selected')).getByRole('button', { name: zh.relationsOpen }))
  await settle()
  expect(openFile).toHaveBeenCalledWith('/research/relations', 'literature/longformer.pdf')
  openFile.mockImplementation(() => { throw new Error('No conversation is open to show it.') })
  fireEvent.click(within(card(view, 'data-relations-selected')).getByRole('button', { name: zh.relationsOpen }))
  await settle()
  expect(within(card(view, 'data-relations-selected')).getByRole('alert').textContent).toContain('No conversation is open to show it.')
  view.unmount()
  const gone = await mount({}, { evidence: [] })
  fireEvent.click(label(gone.view, '固定分块', '属于', '块稀疏注意力'))
  const open = within(card(gone.view, 'data-relations-selected')).getByRole('button', { name: zh.relationsOpen }) as HTMLButtonElement
  expect(open.disabled).toBe(true)
  expect(open.getAttribute('title')).toBe(zh.relationsOpenGone)
})

it('marks outdated grounds and checks them against their sources again', async () => {
  const { view, commands } = await mount()
  fireEvent.click(label(view, '块稀疏注意力', '评测于', 'RULER'))
  const selected = card(view, 'data-relations-selected')
  expect(within(selected).getAllByText(zh.relationsOutdated)).toHaveLength(2)
  const before = asked(commands, 'relations-graph').length
  fireEvent.click(within(selected).getByRole('button', { name: zh.relationsReground })); await settle()
  expect(asked(commands, 'relations-reground')).toEqual([{ action: 'relations-reground', projectId: anyId }])
  expect(within(card(view, 'data-relations-selected')).getByRole('status').textContent).toBe(t('relationsRegrounded', { regrounded: 1, lapsed: 0 }))
  expect(asked(commands, 'relations-graph').length).toBe(before + 1)
})

it('says when a source check fails or the host answers nothing', async () => {
  const failing = await mount({ reground: () => { throw new Error('Plugin disabled') } })
  fireEvent.click(label(failing.view, '块稀疏注意力', '评测于', 'RULER'))
  fireEvent.click(within(card(failing.view, 'data-relations-selected')).getByRole('button', { name: zh.relationsReground })); await settle()
  expect(within(card(failing.view, 'data-relations-selected')).getByRole('alert').textContent).toContain('Plugin disabled')
  failing.view.unmount()
  const empty = await mount({ reground: () => ({ message: 'Regrounded' }) })
  fireEvent.click(label(empty.view, '块稀疏注意力', '评测于', 'RULER'))
  fireEvent.click(within(card(empty.view, 'data-relations-selected')).getByRole('button', { name: zh.relationsReground })); await settle()
  expect(within(card(empty.view, 'data-relations-selected')).getByRole('alert').textContent).toContain(zh.kgNoResponse)
})

it('rejects a relation with the reason the person gives, and the graph is read again', async () => {
  const { view, commands } = await mount()
  fireEvent.click(label(view, '固定分块', '属于', '块稀疏注意力'))
  const selected = (): HTMLElement => card(view, 'data-relations-selected')
  fireEvent.click(within(selected()).getByRole('button', { name: zh.relationsRejectRelation }))
  fireEvent.change(within(selected()).getByLabelText(zh.relationsRejectWhy), { target: { value: '  the other way round ' } })
  const before = asked(commands, 'relations-graph').length
  fireEvent.click(within(selected()).getByRole('button', { name: zh.relationsRejectConfirm })); await settle()
  expect(asked(commands, 'relations-reject')).toEqual([
    { action: 'relations-reject', projectId: anyId, relation: 'is-a:fixed>block', reason: 'the other way round' },
  ])
  expect(within(selected()).queryByLabelText(zh.relationsRejectWhy)).toBeNull()
  expect(asked(commands, 'relations-graph').length).toBe(before + 1)
})

it('rejects one ground without a reason, cancels a rejection, and restores a ground that was rejected', async () => {
  const rejected = ground('g-rejected', { status: 'rejected', rejection: { by: 'user', at: '2026-09-30T08:00:00.000Z', reason: 'misquoted' } })
  const bare = ground('g-bare', { status: 'rejected', rejection: { by: 'agent', at: '2026-09-30T08:00:00.000Z' } })
  const many = edge('is-a', 'fixed', 'block', { grounds: [ground('g-ok'), rejected, bare], sources: { 'full-text': 1, 'abstract': 0, 'file': 0, 'run': 0, 'citation': 0 } })
  const { view, commands } = await mount(withEdges([many]))
  fireEvent.click(label(view, '固定分块', '属于', '块稀疏注意力'))
  const selected = (): HTMLElement => card(view, 'data-relations-selected')
  expect(within(selected()).getByText(`${t('relationsRejectedBy', { who: '你', date: '9 月 30 日' })} · 原因：misquoted`)).toBeTruthy()
  expect(within(selected()).getByText(t('relationsRejectedBy', { who: '助手', date: '9 月 30 日' }))).toBeTruthy()
  fireEvent.click(within(selected()).getAllByRole('button', { name: zh.relationsRejectGround })[0] as HTMLElement)
  fireEvent.click(within(selected()).getByRole('button', { name: zh.cancel }))
  expect(within(selected()).queryByLabelText(zh.relationsRejectWhy)).toBeNull()
  fireEvent.click(within(selected()).getAllByRole('button', { name: zh.relationsRejectGround })[0] as HTMLElement)
  fireEvent.click(within(selected()).getByRole('button', { name: zh.relationsRejectConfirm })); await settle()
  expect(asked(commands, 'relations-reject')).toEqual([{ action: 'relations-reject', projectId: anyId, relation: 'is-a:fixed>block', ground: 'g-ok' }])
  fireEvent.click(within(selected()).getAllByRole('button', { name: zh.relationsRestoreGround })[0] as HTMLElement); await settle()
  expect(asked(commands, 'relations-restore')).toEqual([{ action: 'relations-restore', projectId: anyId, relation: 'is-a:fixed>block', ground: 'g-rejected' }])
})

it('shows the host\'s own message when it refuses a rejection, and says when it answers nothing or fails', async () => {
  const refused = await mount({ reject: () => ({ message: 'Refused', relationOutcomes: [{ status: 'refused', code: 'not-yours', message: 'The person rejected this; only the person can restore it.' }] }) })
  fireEvent.click(label(refused.view, '固定分块', '属于', '块稀疏注意力'))
  fireEvent.click(within(card(refused.view, 'data-relations-selected')).getByRole('button', { name: zh.relationsRejectRelation }))
  fireEvent.click(within(card(refused.view, 'data-relations-selected')).getByRole('button', { name: zh.relationsRejectConfirm })); await settle()
  expect(within(card(refused.view, 'data-relations-selected')).getByRole('alert').textContent)
    .toBe(t('relationsRefused', { message: 'The person rejected this; only the person can restore it.' }))
  // Asking again clears the refusal.
  fireEvent.click(within(card(refused.view, 'data-relations-selected')).getByRole('button', { name: zh.relationsRejectRelation }))
  expect(within(card(refused.view, 'data-relations-selected')).queryByText(/没有完成/)).toBeNull()
  refused.view.unmount()
  const empty = await mount({ reject: () => ({ message: 'Rejected' }) })
  fireEvent.click(label(empty.view, '固定分块', '属于', '块稀疏注意力'))
  fireEvent.click(within(card(empty.view, 'data-relations-selected')).getByRole('button', { name: zh.relationsRejectRelation }))
  fireEvent.click(within(card(empty.view, 'data-relations-selected')).getByRole('button', { name: zh.relationsRejectConfirm })); await settle()
  expect(within(card(empty.view, 'data-relations-selected')).getByRole('alert').textContent).toContain(zh.kgNoResponse)
})

it('starts the add form from the selected relation', async () => {
  const { view } = await mount()
  const form = card(view, 'data-relations-propose') as HTMLDetailsElement
  expect(form.open).toBe(false)
  fireEvent.click(label(view, '块稀疏注意力', '评测于', 'RULER'))
  fireEvent.click(within(card(view, 'data-relations-selected')).getByRole('button', { name: zh.relationsAddOne }))
  const opened = card(view, 'data-relations-propose') as HTMLDetailsElement
  expect(opened.open).toBe(true)
  expect(within(opened).getByLabelText<HTMLInputElement>(`${zh.relationsFrom} · ${zh.relationsFormName}`).value).toBe('块稀疏注意力')
  expect(within(opened).getByLabelText<HTMLInputElement>(`${zh.relationsTo} · ${zh.relationsFormName}`).value).toBe('RULER')
  expect(within(opened).getByLabelText<HTMLSelectElement>(`${zh.relationsTo} · ${zh.relationsFormType}`).value).toBe('dataset')
  expect(within(opened).getByLabelText<HTMLSelectElement>(zh.relationsFormKind).value).toBe('evaluated-on')
})

it('lists the rejected relations and restores one, or shows why the host refused', async () => {
  const { view, commands } = await mount()
  const rejected = card(view, 'data-relations-rejected')
  fireEvent.click(rejected.querySelector('summary') as HTMLElement)
  expect(within(rejected).getByText(t('relationsRejectedHead', { n: 1 }))).toBeTruthy()
  expect(within(rejected).getByText('全注意力 —用于→ 长上下文建模')).toBeTruthy()
  expect(within(rejected).getByText(`${t('relationsRejectedBy', { who: '你', date: '9 月 30 日' })} · 原因：wrong direction`)).toBeTruthy()
  fireEvent.click(within(rejected).getByRole('button', { name: zh.relationsRestore })); await settle()
  expect(asked(commands, 'relations-restore')).toEqual([{ action: 'relations-restore', projectId: anyId, relation: 'applied-to:full>context' }])
  view.unmount()

  const refusing = await mount({ restore: () => ({ message: 'Refused', relationOutcomes: [{ status: 'refused', code: 'not-yours', message: 'Only the person can restore it.' }] }) })
  fireEvent.click(within(card(refusing.view, 'data-relations-rejected')).getByRole('button', { name: zh.relationsRestore })); await settle()
  expect(within(card(refusing.view, 'data-relations-rejected')).getByRole('alert').textContent).toBe(t('relationsRefused', { message: 'Only the person can restore it.' }))
  refusing.view.unmount()
  const empty = await mount({ restore: () => ({ message: 'Restored', relationOutcomes: [] }) })
  fireEvent.click(within(card(empty.view, 'data-relations-rejected')).getByRole('button', { name: zh.relationsRestore })); await settle()
  expect(within(card(empty.view, 'data-relations-rejected')).getByRole('alert').textContent).toContain(zh.kgNoResponse)
  empty.view.unmount()
  const none = await mount({ graph: () => ({ message: 'Graph', relations: relationsPage({ rejected: [] }) }) })
  expect(none.view.container.querySelector('[data-relations-rejected]')).toBeNull()
})

it('shows a rejected relation without who rejected it when the host does not say', async () => {
  const { view } = await mount({
    graph: () => ({ message: 'Graph', relations: relationsPage({ rejected: [{ id: 'is-a:full>block', kind: 'is-a', from: 'full', to: 'block', fromName: '全注意力', toName: '块稀疏注意力' }] }) }),
  })
  const rejected = card(view, 'data-relations-rejected')
  expect(within(rejected).getByText('全注意力 —属于→ 块稀疏注意力')).toBeTruthy()
  expect(rejected.textContent).not.toMatch(/原因|你在|助手在/)
})
