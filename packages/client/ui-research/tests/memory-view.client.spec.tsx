// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type { MemoryLesson, ProjectId, ResearchCommand, ResearchMemoryPage, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { MemoryView } from '../src/client/MemoryView.tsx'
import type { WorkbenchProps } from '../src/client/contract.ts'
import { en, zh } from '../src/client/locales.ts'
import { environment, experiment, list, page, paper, research, venue } from './fixtures/memory.ts'
import { translate } from './fixtures/translate.ts'

afterEach(cleanup)
const t = translate(en)

const failure = (name: string, reason: string, at: string): MemoryLesson => (
  { research: 'a' as ProjectId, at, kind: 'failed-run', name, reason, exitCode: 137 }
)
const decision = (question: string, at: string): MemoryLesson => (
  { research: 'b' as ProjectId, at, kind: 'decision', question, answer: 'yes', rationale: 'it was the standard', by: 'user' }
)

/** The memory of two researches on this computer, the way the host would send it for the prototype's story. */
const memory: ResearchMemoryPage = page({
  researches: [
    research('a', { title: 'Summary consistency', finished: true, literature: 2, runs: 0, venue: 'AAAI 2026' }),
    research('b', { title: 'Block sparse attention', literature: 2, runs: 1 }),
  ],
  literature: list([paper('Longformer', ['a', 'b']), paper('BigBird', ['b'])]),
  runs: list([experiment('ruler-32k-full', 'b')]),
  environments: list([
    environment('lab', ['a', 'b'], { target: 'ssh', host: 'lab-a100', kind: 'existing', python: '/usr/bin/python3' }), environment('uv', ['a', 'b']),
  ]),
  writing: list([venue('aaai', ['a'], 'AAAI 2026')]),
  lessons: list([failure('train', 'CUDA out of memory', '2026-08-03T12:00:00Z'), decision('Which dataset?', '2026-08-02T12:00:00Z')]),
})

function harness(first: ResearchMemoryPage | null = memory) {
  const project = { ...newProject({ root: '/research/b', title: 'Block sparse attention', brief: '' }, 'workspace' as WorkspaceId), id: 'b' as ProjectId }
  const commands: ResearchCommand[] = []
  let current = first
  const startNew = vi.fn()
  const run = vi.fn(async (request: ResearchCommand): Promise<ResearchResponse> => {
    commandSchema.parse(request)
    commands.push(request)
    if (request.action === 'memory-carry' && current !== null) current = { ...current, carry: { ...current.carry, [request.kind]: request.on } }
    return { message: 'ok', ...current === null ? {} : { memory: current } }
  })
  const props = { t, run, startNew, project } as unknown as WorkbenchProps & { project: typeof project }
  return { props, project, commands, startNew, run }
}
async function settle(): Promise<void> { await act(async () => { await Promise.resolve() }) }
const researchButtons = (view: ReturnType<typeof render>): HTMLElement[] => (
  within(view.getByRole('list', { name: en.memColumnResearches })).getAllByRole('button')
)
const chipsOf = (view: ReturnType<typeof render>): HTMLElement[] => Array.from(view.container.querySelectorAll<HTMLElement>('[data-kind][data-carried]'))
const lines = (view: ReturnType<typeof render>, kind: string, active?: boolean): number =>
  view.container.querySelectorAll(`path[data-kind="${kind}"]${active === undefined ? '' : `[data-active="${active}"]`}`).length

it('draws the researches, what they left and the next research, with the headline, the lock and the first read', async () => {
  const h = harness()
  const view = render(<MemoryView {...h.props} />)
  expect(view.getByRole('status').textContent).toBe(en.kgLoading)
  await settle()
  expect(h.commands).toEqual([{ action: 'memory', projectId: 'b' }])
  expect(view.getByText(en.memHeadline)).toBeTruthy()
  expect(view.getByText(en.memLock)).toBeTruthy()
  expect(view.getByText(en.memCaption)).toBeTruthy()
  expect(view.queryByText(en.memSingle)).toBeNull()
  const researches = researchButtons(view)
  expect(researches.map(button => button.textContent)).toEqual([
    'FinishedSummary consistency2 papers · AAAI 2026', 'In progress· open nowBlock sparse attention2 papers · 1 experiment',
  ])
  expect(researches.map(button => button.getAttribute('data-finished'))).toEqual(['true', 'false'])
  expect(researches.map(button => button.getAttribute('data-current'))).toEqual(['false', 'true'])
  const items = within(view.getByRole('list', { name: en.memColumnItems })).getAllByRole('listitem')
  expect(items.map(item => item.textContent)).toEqual([
    'PaperLongformer', 'PaperBigBird', 'Runruler-32k-full', 'Envlab-a100 · SSH', 'Envuv · this computer', 'VenueAAAI 2026',
  ])
  expect(view.getByText('Carries 6 items')).toBeTruthy()
  expect(lines(view, 'source')).toBe(9)
  expect(lines(view, 'carry')).toBe(6)
  const switches = view.getAllByRole('switch')
  expect(switches.map(item => item.getAttribute('aria-label'))).toEqual(['Literature', 'Finished experiments', 'Environments', 'Writing preferences'])
  expect(switches.map(item => item.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'true'])
  expect(view.getByText('2 papers from 2 researches, merged by title. 1 used in more than one research.')).toBeTruthy()
  expect(view.getByText('2 environments: lab-a100 · SSH, uv · this computer.')).toBeTruthy()
  expect(view.getByText(en.memCarryNote)).toBeTruthy()
})

it('lights the lines and the items of the selected research, and clears them when it is selected again', async () => {
  const h = harness()
  const view = render(<MemoryView {...h.props} />)
  await settle()
  const linked = (): string[] => chipsOf(view).filter(chip => chip.getAttribute('data-linked') === 'true').map(chip => chip.textContent ?? '')
  expect(linked()).toEqual([])
  expect(lines(view, 'source', true)).toBe(0)
  fireEvent.click(researchButtons(view)[1]!)
  expect(researchButtons(view)[1]!.getAttribute('aria-pressed')).toBe('true')
  expect(linked()).toEqual(['PaperLongformer', 'PaperBigBird', 'Runruler-32k-full', 'Envlab-a100 · SSH', 'Envuv · this computer'])
  expect(lines(view, 'source', true)).toBe(5)
  expect(lines(view, 'carry', true)).toBe(5)
  fireEvent.click(researchButtons(view)[0]!)
  expect(researchButtons(view).map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
  expect(linked()).toEqual(['PaperLongformer', 'Envlab-a100 · SSH', 'Envuv · this computer', 'VenueAAAI 2026'])
  fireEvent.click(researchButtons(view)[0]!)
  expect(linked()).toEqual([])
})

it('carries a kind or not at the person\'s switch: it holds the switches while it saves, and the chips and lines follow the answer', async () => {
  const h = harness()
  const view = render(<MemoryView {...h.props} />)
  await settle()
  const slow = Promise.withResolvers<ResearchResponse>()
  h.run.mockImplementationOnce(async (request) => {
    commandSchema.parse(request)
    h.commands.push(request)
    return slow.promise
  })
  const literature = view.getByRole('switch', { name: en.memKindLiterature })
  fireEvent.click(literature)
  await settle()
  expect(h.commands.at(-1)).toEqual({ action: 'memory-carry', projectId: 'b', kind: 'literature', on: false })
  expect(view.getAllByRole('switch').every(item => (item as HTMLButtonElement).disabled)).toBe(true)
  slow.resolve({ message: 'ok', memory: { ...memory, carry: { ...memory.carry, literature: false } } })
  await settle()
  expect(view.getAllByRole('switch').some(item => (item as HTMLButtonElement).disabled)).toBe(false)
  expect(view.getByRole('switch', { name: en.memKindLiterature }).getAttribute('aria-checked')).toBe('false')
  expect(chipsOf(view).map(chip => chip.getAttribute('data-carried'))).toEqual(['false', 'false', 'true', 'true', 'true', 'true'])
  expect(lines(view, 'carry')).toBe(4)
  expect(view.getByText('Carries 4 items')).toBeTruthy()
  fireEvent.click(view.getByRole('switch', { name: en.memKindLiterature })); await settle()
  expect(h.commands.at(-1)).toEqual({ action: 'memory-carry', projectId: 'b', kind: 'literature', on: true })
  expect(lines(view, 'carry')).toBe(6)
})

it('says why a switch could not be saved and leaves it where it was', async () => {
  const h = harness()
  const view = render(<MemoryView {...h.props} />)
  await settle()
  h.run.mockImplementationOnce(async () => { throw new Error('Research memory plugin is disabled.') })
  fireEvent.click(view.getByRole('switch', { name: en.memKindRuns })); await settle()
  expect(view.getByRole('alert').textContent).toContain('Research memory plugin is disabled.')
  expect(view.getByRole('switch', { name: en.memKindRuns }).getAttribute('aria-checked')).toBe('true')
  h.run.mockImplementationOnce(async () => ({ message: 'ok' }))
  fireEvent.click(view.getByRole('switch', { name: en.memKindRuns })); await settle()
  expect(view.getByRole('alert').textContent).toContain(en.kgNoResponse)
})

it('lists the first lessons recorded, counts the rest, and shows nothing when the records hold none', async () => {
  const many = list(
    Array.from({ length: 6 }, (_, at) => at % 2 === 0 ? failure(`run-${at}`, at === 0 ? 'CUDA out of memory' : '', '2026-08-03T12:00:00Z') : decision(`Question ${at}?`, '2026-08-02T12:00:00Z')),
    9,
  )
  const full = render(<MemoryView {...harness({ ...memory, lessons: many }).props} />)
  await settle()
  expect(full.getByText(en.memLessonsHead)).toBeTruthy()
  expect(full.getByText('Run run-0 failed: CUDA out of memory')).toBeTruthy()
  expect(full.getByText('Run run-2 failed: exit code 137')).toBeTruthy()
  expect(full.getByText('Question 1? → yes')).toBeTruthy()
  expect(full.getAllByText('Why: it was the standard')).toHaveLength(2)
  expect(full.queryByText('Question 5? → yes')).toBeNull()
  expect(full.getByText('4 more on record')).toBeTruthy()
  full.unmount()
  const few = render(<MemoryView {...harness().props} />)
  await settle()
  expect(few.getByText('Run train failed: CUDA out of memory')).toBeTruthy()
  expect(few.queryByText(/more on record/)).toBeNull()
  few.unmount()
  const none = render(<MemoryView {...harness({ ...memory, lessons: list([]) }).props} />)
  await settle()
  expect(none.queryByText(en.memLessonsHead)).toBeNull()
})

it('starts a new research through the entry the sidebar uses', async () => {
  const h = harness()
  const view = render(<MemoryView {...h.props} />)
  await settle()
  fireEvent.click(view.getByRole('button', { name: en.memStartNew }))
  expect(h.startNew).toHaveBeenCalledTimes(1)
})

it('says so when no research has left memory, when only one has, and when the researches hold nothing to carry', async () => {
  const empty = render(<MemoryView {...harness(page()).props} />)
  await settle()
  expect(empty.getByText(en.memEmpty)).toBeTruthy()
  expect(empty.getByText(en.memLock)).toBeTruthy()
  expect(empty.queryByRole('switch')).toBeNull()
  expect(empty.queryByRole('button', { name: en.memStartNew })).toBeNull()
  empty.unmount()
  const bare = render(<MemoryView {...harness(page({ researches: [research('b', { title: 'Bare' })] })).props} />)
  await settle()
  expect(bare.getByText(en.memSingle)).toBeTruthy()
  expect(bare.getByText(en.memNothing)).toBeTruthy()
  expect(bare.getByText('Carries nothing yet')).toBeTruthy()
  expect(researchButtons(bare).map(button => button.textContent)).toEqual(['In progress· open nowBare'])
  expect(bare.getAllByText('Nothing recorded yet.')).toHaveLength(4)
  bare.unmount()
  const many = render(<MemoryView {...harness().props} />)
  await settle()
  expect(many.queryByText(en.memSingle)).toBeNull()
  expect(many.queryByText(en.memNothing)).toBeNull()
})

it('shows a host that answers nothing and a failed read', async () => {
  const nothing = render(<MemoryView {...harness(null).props} />)
  await settle()
  expect(nothing.getByRole('alert').textContent).toContain(en.kgNoResponse)
  nothing.unmount()
  const base = harness()
  const failed = render(<MemoryView {...base.props} run={async () => { throw new Error('Research memory plugin is disabled.') }} />)
  await settle()
  expect(failed.getByRole('alert').textContent).toContain('Research memory plugin is disabled.')
  failed.unmount()
  const refused = render(<MemoryView {...base.props} run={async () => { throw 'plain refusal' }} />)
  await settle()
  expect(refused.getByRole('alert').textContent).toContain('plain refusal')
})

it('reads the memory again when the record moves on, and drops an answer that a newer read or a switch has overtaken', async () => {
  const h = harness()
  const slow = Promise.withResolvers<ResearchResponse>()
  const view = render(<MemoryView {...h.props} run={() => slow.promise} />)
  const second = { ...h.project, revision: h.project.revision + 1 }
  view.rerender(<MemoryView {...h.props} project={second} />)
  await settle()
  expect(h.run).toHaveBeenCalledTimes(1)
  expect(view.getByText(en.memHeadline)).toBeTruthy()
  slow.resolve({ message: 'late', memory: page() })
  await settle()
  expect(view.queryByText(en.memEmpty)).toBeNull()
  const failing = Promise.withResolvers<ResearchResponse>()
  view.rerender(<MemoryView {...h.props} project={{ ...second, revision: second.revision + 1 }} run={() => failing.promise} />)
  view.rerender(<MemoryView {...h.props} project={{ ...second, revision: second.revision + 2 }} />)
  await settle()
  failing.reject(new Error('Overtaken failure'))
  await settle()
  expect(view.queryByRole('alert')).toBeNull()
  expect(h.run).toHaveBeenCalledTimes(2)
  // A read that is still on its way when a switch is saved would put the old switches back.
  const reading = Promise.withResolvers<ResearchResponse>()
  const third = { ...second, revision: second.revision + 3 }
  view.rerender(<MemoryView {...h.props} project={third} run={request => request.action === 'memory' ? reading.promise : h.run(request)} />)
  fireEvent.click(view.getByRole('switch', { name: en.memKindWriting })); await settle()
  expect(view.getByRole('switch', { name: en.memKindWriting }).getAttribute('aria-checked')).toBe('false')
  reading.resolve({ message: 'old', memory })
  await settle()
  expect(view.getByRole('switch', { name: en.memKindWriting }).getAttribute('aria-checked')).toBe('false')
})

it('words the view in the reader\'s language', async () => {
  const h = harness()
  const view = render(<MemoryView {...h.props} t={translate(zh)} />)
  await settle()
  expect(view.getByText(zh.memHeadline)).toBeTruthy()
  expect(view.getByText(zh.memLock)).toBeTruthy()
  expect(view.getByText(zh.memCarryHead)).toBeTruthy()
  expect(view.getByText('带上 6 项')).toBeTruthy()
  expect(view.getByRole('button', { name: zh.memStartNew })).toBeTruthy()
  expect(view.getAllByRole('switch').map(item => item.getAttribute('aria-label'))).toEqual(['文献库', '已完成的实验', '实验环境', '写作偏好'])
})
