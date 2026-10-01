// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import { RelationsView } from '../src/client/RelationsView.tsx'
import { en, zh, type ResearchKey } from '../src/client/locales.ts'
import { anyId, cell, gapsPage, harness, type Handlers } from './fixtures/relations.tsx'

afterEach(cleanup)
async function settle(): Promise<void> { await act(async () => { for (let at = 0; at < 8; at++) await Promise.resolve() }) }
async function mount(handlers: Partial<Handlers> = {}) {
  const h = harness(handlers)
  const view = render(<RelationsView {...h.props} />)
  await settle()
  return { ...h, view }
}
const gaps = (view: ReturnType<typeof render>): HTMLElement => view.container.querySelector('[data-relations-gaps]') as HTMLElement

it('shows what the project\'s own sources report for each method and task, shaded by state, with the counts in the tooltip', async () => {
  const { view, commands } = await mount()
  const card = gaps(view)
  expect(commands.filter(command => command.action === 'relations-gaps')).toEqual([{ action: 'relations-gaps', projectId: anyId, axis: 'task' }])
  expect(within(card).getByRole('heading', { name: '本项目文献中的空白' })).toBeTruthy()
  expect(within(card).getByText('方法 × 任务')).toBeTruthy()
  const table = within(card).getByRole('table')
  expect(within(table).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['', '长上下文建模', '长文档摘要', '问答'])
  expect(within(table).getAllByRole('rowheader').map(header => header.textContent)).toEqual(['动态选块', '固定分块'])
  const cells = within(table).getAllByRole('cell')
  expect(cells.map(item => item.getAttribute('data-state'))).toEqual(['reported', 'mentioned', 'uncovered', 'absent', 'stale', 'project-only'])
  expect(cells.map(item => item.textContent)).toEqual(['3 篇', '2 处', '未涉及', '空白', '待核', '仅本项目'])
  expect(cells[0]?.getAttribute('aria-label')).toBe('动态选块 × 长上下文建模: 本项目文献中有 3 篇报告')
  expect(cells[3]?.getAttribute('title')).toBe('论文 0（其中经子类 0）· 实验 0 · 文件 0 · 已变化 0 · 同时提到 0 处 · 已驳回 1')
  // The key explains every state that appears, with the host's wording and no count.
  const key = within(card).getAllByRole('listitem').map(item => item.textContent)
  expect(key).toEqual([
    '本项目文献中有 N 篇报告', '仅见于本项目的实验或笔记', '依据已更新，需重新核对', '有 N 处同时提到，尚未核实', '本项目文献中没有报告', '本项目文献未涉及，结论前请先检索',
  ])
  expect(within(card).getByText('1 格在本项目文献中没有报告，1 格本项目文献未涉及。这只说明已导入的资料里有什么，不说明别处有没有。')).toBeTruthy()
  expect(within(card).getByText('依据：12 条文献记录（全文 7、仅摘要 4、仅元数据 1）和 3 个项目文件。')).toBeTruthy()
})

it('never says that nobody tested a pair or that the field has a gap', async () => {
  const { view } = await mount()
  const text = gaps(view).textContent
  expect(text).not.toMatch(/没有人|无人|没人|尚无研究|领域.{0,4}空白|nobody|no one/i)
  for (const dictionary of [zh, en]) {
    for (const [key, value] of Object.entries(dictionary).filter(([name]) => name.startsWith('relationsGap'))) {
      expect(value, key).not.toMatch(/没有人|无人|没人|nobody|no one|untested|never been tested|the field/i)
    }
  }
  expect(en.relationsGapHeading).toBe('Blanks in this project\'s literature')
})

it('uses the wording keys the host names for the heading and each state', async () => {
  const page = gapsPage()
  const keys = [page.wording.heading, ...Object.values(page.wording.states)]
  for (const key of keys) {
    expect(Object.keys(zh), key).toContain(key)
    expect(Object.keys(en), key).toContain(key)
  }
  expect(page.wording.states.absent as ResearchKey).toBe('relationsGapAbsent')
})

it('compares the methods with datasets or settings when asked, and reads again', async () => {
  const { view, commands } = await mount()
  const card = gaps(view)
  const axis = within(card).getByLabelText(zh.relationsGapAxis) as HTMLSelectElement
  expect([...axis.options].map(option => option.textContent)).toEqual(['任务', '数据集', '设置'])
  fireEvent.change(axis, { target: { value: 'dataset' } }); await settle()
  expect(commands.filter(command => command.action === 'relations-gaps').at(-1)).toMatchObject({ axis: 'dataset' })
  expect(within(card).getByText('方法 × 数据集')).toBeTruthy()
  fireEvent.change(axis, { target: { value: 'setting' } }); await settle()
  expect(within(card).getByText('方法 × 设置')).toBeTruthy()
})

it('says that nothing can be compared yet while the matrix has no rows or no columns, and still names what it rests on', async () => {
  const { view } = await mount({ gaps: () => ({ message: 'Gaps', relationGaps: gapsPage({ rows: [], cells: [] }) }) })
  const card = gaps(view)
  expect(within(card).getByText(zh.relationsGapNone)).toBeTruthy()
  expect(within(card).queryByRole('table')).toBeNull()
  expect(within(card).getByText(/依据：12 条文献记录/)).toBeTruthy()
  view.unmount()
  const columns = await mount({ gaps: () => ({ message: 'Gaps', relationGaps: gapsPage({ columns: [], cells: [[], []] }) }) })
  expect(within(gaps(columns.view)).getByText(zh.relationsGapNone)).toBeTruthy()
})

it('says when every cell has something behind it', async () => {
  const { view } = await mount({
    gaps: () => ({ message: 'Gaps', relationGaps: gapsPage({ rows: [{ id: 'a', name: 'A', passages: 1 }], columns: [{ id: 'b', name: 'B', passages: 1 }], cells: [[cell('reported', { papers: 1 })]] }) }),
  })
  expect(within(gaps(view)).getByText(zh.relationsGapTakeawayNone)).toBeTruthy()
})

it('shows that the matrix is being read, why it could not be, and drops a read that was overtaken', async () => {
  const slow = Promise.withResolvers<ResearchResponse>()
  const waiting = harness({ gaps: () => slow.promise })
  const view = render(<RelationsView {...waiting.props} />); await settle()
  expect(within(gaps(view)).getByRole('status').textContent).toBe(zh.kgLoading)
  expect(gaps(view).getAttribute('aria-busy')).toBe('true')
  slow.resolve({ message: 'Gaps', relationGaps: gapsPage() }); await settle()
  expect(gaps(view).getAttribute('aria-busy')).toBe('false')
  view.unmount()
  const off = await mount({ gaps: () => { throw new Error('Relation graph plugin is disabled.') } })
  expect(within(gaps(off.view)).getByRole('alert').textContent).toContain('Relation graph plugin is disabled.')
  off.view.unmount()
  const none = await mount({ gaps: () => ({ message: 'Gaps' }) })
  expect(within(gaps(none.view)).getByRole('alert').textContent).toContain(zh.kgNoResponse)
  none.view.unmount()
  const first = Promise.withResolvers<ResearchResponse>()
  const second = Promise.withResolvers<ResearchResponse>()
  const queue = [first, second]
  const racing = harness({ gaps: () => (queue.shift() as typeof first).promise })
  const race = render(<RelationsView {...racing.props} />); await settle()
  fireEvent.change(within(gaps(race)).getByLabelText(zh.relationsGapAxis), { target: { value: 'dataset' } })
  second.resolve({ message: 'Gaps', relationGaps: gapsPage({ axis: 'dataset' }) }); await settle()
  first.reject(new Error('Overtaken failure')); await settle()
  expect(race.queryByText(/Overtaken failure/)).toBeNull()
  expect(within(gaps(race)).getByRole('table')).toBeTruthy()
  race.unmount()
  // An answer that arrives after a newer question is dropped too.
  const early = Promise.withResolvers<ResearchResponse>()
  const newer = Promise.withResolvers<ResearchResponse>()
  const order = [early, newer]
  const crossing = harness({ gaps: () => (order.shift() as typeof early).promise })
  const cross = render(<RelationsView {...crossing.props} />); await settle()
  fireEvent.change(within(gaps(cross)).getByLabelText(zh.relationsGapAxis), { target: { value: 'dataset' } })
  newer.resolve({ message: 'Gaps', relationGaps: gapsPage({ axis: 'dataset' }) }); await settle()
  early.resolve({ message: 'Gaps', relationGaps: gapsPage({ rows: [], cells: [] }) }); await settle()
  expect(within(gaps(cross)).getByRole('table')).toBeTruthy()
})
