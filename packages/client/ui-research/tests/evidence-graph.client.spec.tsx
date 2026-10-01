// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type { EvidenceGraphPage, ResearchCommand, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { EvidenceView } from '../src/client/EvidenceGraph.tsx'
import type { WorkbenchProps } from '../src/client/contract.ts'
import { en, zh } from '../src/client/locales.ts'
import { translate } from './fixtures/translate.tsx'

afterEach(cleanup)
const t = translate(en)

/** The page the host would send for the prototype's record: two supported conclusions, one waiting, one resting on changed literature. */
const graph: EvidenceGraphPage = {
  question: 'Does dynamic block selection keep accuracy at a quarter of the FLOPs?',
  summary: { claims: 5, supported: 2, stale: 1, missing: 2, proposed: 0, contradicted: 0 },
  claims: [
    {
      id: 'c1', text: 'Dynamic selection is within one point of full attention at 32K', kind: 'empirical', status: 'supported', expected: [], expectedMore: 0,
      files: [{ id: 'a1' as never, path: 'paper/main.tex', revision: 3, stale: false }, { id: 'a2' as never, path: 'paper/fig.pdf', revision: 1, stale: false }],
      links: [
        { sourceId: 'run:dyn', revision: 1, outdated: false, locator: { page: 2 }, quote: 'accuracy 0.814' },
        { sourceId: 'run:full', revision: 1, outdated: false, locator: {} },
      ],
    },
    {
      id: 'c2', text: 'Fixed blocks cut peak memory from 61.5 GB to 37.9 GB', kind: 'empirical', status: 'supported', expected: [], expectedMore: 0, files: [],
      links: [{ sourceId: 'run:fixed', revision: 1, outdated: false, locator: {} }, { sourceId: 'run:full', revision: 1, outdated: false, locator: {} }],
    },
    { id: 'c3', text: 'The edge grows at 64K', kind: 'empirical', status: 'missing', files: [], links: [], expected: ['expected:r64', 'expected:r65'], expectedMore: 2 },
    {
      id: 'c4', text: 'Longformer and BigBird use fixed sparse patterns', kind: 'literature', status: 'stale', expected: [], expectedMore: 0,
      files: [{ id: 'a1' as never, path: 'paper/main.tex', revision: 3, stale: true }],
      links: [
        { sourceId: 'source:lf', revision: 1, outdated: false, locator: {} },
        { sourceId: 'source:bb', revision: 1, outdated: true, locator: { page: 5 }, quote: 'random, window and global' },
      ],
    },
    { id: 'c5', text: 'Nothing cites or runs for this one', kind: 'method', status: 'missing', files: [], links: [], expected: ['none:c5'], expectedMore: 0 },
  ],
  sources: [
    { id: 'run:dyn', kind: 'run', label: 'ruler-32k-dynamic', seed: 42, status: 'completed', metrics: { accuracy: 0.814 }, host: 'local', changed: false, path: '.research/runs/dyn/metrics.json' },
    { id: 'run:full', kind: 'run', label: 'ruler-32k-full', seed: 42, status: 'completed', metrics: { accuracy: 0.821 }, host: 'local', changed: false },
    { id: 'run:fixed', kind: 'run', label: 'ruler-32k-fixed', seed: 42, status: 'completed', metrics: { peak_memory_gb: 37.9 }, host: 'local', changed: false },
    { id: 'expected:r64', kind: 'expected-run', label: 'ruler-64k-dynamic', seed: 42, status: 'queued', host: 'lab-a100', changed: false },
    { id: 'expected:r65', kind: 'expected-run', label: 'ruler-64k-fixed', seed: 42, status: 'running', host: 'lab-a100', changed: false },
    { id: 'source:lf', kind: 'literature', label: 'Longformer', verified: true, coverage: 'full-text', changed: false },
    { id: 'source:bb', kind: 'literature', label: 'BigBird', verified: true, coverage: 'abstract', changed: true },
    { id: 'none:c5', kind: 'none', label: '', changed: false },
  ],
}

function harness(page: EvidenceGraphPage | null = graph) {
  const project = newProject({ root: '/research/study', title: 'Study', brief: '' }, 'workspace' as WorkspaceId)
  const commands: ResearchCommand[] = []
  const openFile = vi.fn()
  const focusClaim = vi.fn()
  const run = vi.fn(async (request: ResearchCommand): Promise<ResearchResponse> => {
    commandSchema.parse(request)
    commands.push(request)
    return { message: 'ok', ...page === null ? {} : { evidenceGraph: page } }
  })
  const props: WorkbenchProps & { project: typeof project } = { t, run, openFile, focusClaim, project } as never
  return { props, project, commands, openFile, focusClaim, run }
}
async function settle(): Promise<void> { await act(async () => { await Promise.resolve() }) }
const selectedClaim = (view: ReturnType<typeof render>): string => view.getAllByRole('button', { pressed: true })[0]!.textContent ?? ''
/** The detail panel as it is now: choosing another conclusion replaces it. */
const panel = (view: ReturnType<typeof render>) => within(view.container.querySelector('[data-evidence-detail]') as HTMLElement)

it('draws the question, the conclusions and their evidence, with the count strip and the first conclusion selected', async () => {
  const h = harness()
  const view = render(<EvidenceView {...h.props} />)
  expect(view.getByRole('status').textContent).toBe(en.kgLoading)
  await settle()
  expect(h.commands).toEqual([{ action: 'evidence-graph', projectId: h.project.id }])
  expect(view.getByText(graph.question)).toBeTruthy()
  for (const chip of ['5 conclusions', '2 with evidence', '1 to re-check', '2 without evidence']) expect(view.getByText(chip)).toBeTruthy()
  expect(view.queryByText(/to verify|contradicted/)).toBeNull()
  expect(view.getByText(en.egCaption)).toBeTruthy()
  const claims = within(view.getByRole('list', { name: en.egColumnClaims })).getAllByRole('button')
  expect(claims.map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false', 'false'])
  expect(claims.map(button => button.getAttribute('data-status'))).toEqual(['supported', 'supported', 'missing', 'stale', 'missing'])
  expect(within(claims[0]!).getByText('paper/main.tex', { exact: false })).toBeTruthy()
  const evidence = within(view.getByRole('list', { name: en.egColumnEvidence })).getAllByRole('listitem')
  expect(evidence).toHaveLength(8)
  expect(evidence[0]!.textContent).toBe('Runruler-32k-dynamic · seed 42accuracy 0.814 · Local')
  expect(evidence[6]!.textContent).toContain('Literature · source changed')
  expect(evidence[3]!.querySelector('[data-kind="expected-run"]')).toBeTruthy()
  expect(evidence[7]!.textContent).toContain(en.egNoneLabel)
})

it('lights the lines and the evidence of the selected conclusion and moves the detail panel with it', async () => {
  const h = harness()
  const view = render(<EvidenceView {...h.props} />)
  await settle()
  const lines = (): string[] => [...view.container.querySelectorAll('path')].map(path => `${path.getAttribute('data-kind')}:${path.getAttribute('data-active')}`)
  expect(view.container.querySelectorAll('path')).toHaveLength(5 + (2 + 2 + 2 + 2 + 1))
  expect(lines().filter(line => line === 'ask:true')).toHaveLength(1)
  expect(lines().filter(line => line === 'support:true')).toHaveLength(2)
  expect(lines().filter(line => line.startsWith('expected:'))).toEqual(['expected:false', 'expected:false', 'expected:false'])
  expect(lines().filter(line => line.startsWith('outdated:'))).toHaveLength(1)
  const lit = (): string[] => [...view.container.querySelectorAll('[data-linked="true"]')].map(card => card.textContent ?? '')
  expect(lit()).toHaveLength(2)
  let detail = panel(view)
  expect(detail.getByText('Evidence')).toBeTruthy()
  expect(detail.getByText('paper/main.tex and 1 more')).toBeTruthy()
  expect(detail.getByText('accuracy 0.814 · Local')).toBeTruthy()
  expect(detail.getByText('accuracy 0.814')).toBeTruthy()
  expect(detail.getByText('p. 2 · rev. 1')).toBeTruthy()
  expect(detail.getByText('It rests on 2 runs. If any of them changes, this conclusion is marked for re-checking.')).toBeTruthy()
  expect(detail.getByText('The files that carry it are marked too: paper/main.tex, paper/fig.pdf.')).toBeTruthy()
  expect(detail.getByText(en.egNextOk)).toBeTruthy()

  fireEvent.click(view.getByRole('button', { name: /Longformer and BigBird/ }))
  expect(selectedClaim(view)).toContain('Longformer and BigBird')
  expect(lit()).toHaveLength(2)
  expect(lines().filter(line => line === 'support:true')).toHaveLength(1)
  detail = panel(view)
  expect(detail.getByText('Re-check')).toBeTruthy()
  expect(detail.getByText('Already flagged: BigBird changed after it was cited.')).toBeTruthy()
  expect(detail.getByText('random, window and global')).toBeTruthy()
  expect(detail.getByText(/Changed since it was cited/)).toBeTruthy()
  expect(detail.getByText(en.egNextStale)).toBeTruthy()
})

it('says what a conclusion without evidence waits for: the runs in progress, or that nothing is cited or under way', async () => {
  const h = harness()
  const view = render(<EvidenceView {...h.props} />)
  await settle()
  fireEvent.click(view.getByRole('button', { name: /The edge grows at 64K/ }))
  let detail = panel(view)
  expect(detail.getByText('No evidence')).toBeTruthy()
  expect(detail.getByText('Under way: ruler-64k-dynamic · seed 42. Once its results are collected and cited, this conclusion can be supported.')).toBeTruthy()
  expect(detail.getByText('Under way: ruler-64k-fixed · seed 42. Once its results are collected and cited, this conclusion can be supported.')).toBeTruthy()
  expect(detail.getByText('2 more runs are under way or not collected yet.')).toBeTruthy()
  expect(detail.getByText(en.egInvalidateNone)).toBeTruthy()
  expect(detail.getByText(en.egNextWait)).toBeTruthy()
  expect(detail.getByText(en.egWhereNone)).toBeTruthy()
  expect(detail.queryByRole('button', { name: en.egOpenFile })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: /Nothing cites or runs/ }))
  detail = panel(view)
  expect(detail.getByText(en.egSupportNone)).toBeTruthy()
  expect(detail.getByText(en.egNextMissing)).toBeTruthy()
})

it('opens the file that carries the conclusion and the sheet of all its sources, and shows a refused file', async () => {
  const h = harness()
  const view = render(<EvidenceView {...h.props} />)
  await settle()
  fireEvent.click(view.getByRole('button', { name: en.egAllSources }))
  expect(h.focusClaim).toHaveBeenCalledWith({ projectId: h.project.id, claimId: 'c1' })
  fireEvent.click(view.getByRole('button', { name: en.egOpenFile })); await settle()
  expect(h.openFile).toHaveBeenCalledWith('/research/study', 'paper/main.tex')
  h.openFile.mockImplementation(() => { throw new Error('No conversation is on screen') })
  fireEvent.click(view.getByRole('button', { name: en.egOpenFile })); await settle()
  expect(view.getByRole('alert').textContent).toContain('No conversation is on screen')
  fireEvent.click(view.getByRole('button', { name: /Fixed blocks cut/ }))
  expect(view.queryByRole('alert')).toBeNull()
})

it('shows the empty record, a host that answers nothing, and a failed read', async () => {
  const empty = render(<EvidenceView {...harness({ question: 'q', claims: [], sources: [], summary: { claims: 0, supported: 0, stale: 0, missing: 0, proposed: 0, contradicted: 0 } }).props} />)
  await settle()
  expect(empty.getByText(en.egEmpty)).toBeTruthy()
  empty.unmount()
  const nothing = render(<EvidenceView {...harness(null).props} />)
  await settle()
  expect(nothing.getByRole('alert').textContent).toContain(en.kgNoResponse)
  nothing.unmount()
  const base = harness()
  const failed = render(<EvidenceView {...base.props} run={async () => { throw new Error('Evidence graph plugin is disabled.') }} />)
  await settle()
  expect(failed.getByRole('alert').textContent).toContain('Evidence graph plugin is disabled.')
  failed.unmount()
  const refused = render(<EvidenceView {...base.props} run={async () => { throw 'plain refusal' }} />)
  await settle()
  expect(refused.getByRole('alert').textContent).toContain('plain refusal')
})

it('reads the graph again when the record moves on, and drops an answer that a newer read has overtaken', async () => {
  const h = harness()
  const slow = Promise.withResolvers<ResearchResponse>()
  const view = render(<EvidenceView {...h.props} run={() => slow.promise} />)
  const second = { ...h.project, revision: h.project.revision + 1 }
  view.rerender(<EvidenceView {...h.props} project={second} />)
  await settle()
  expect(h.run).toHaveBeenCalledTimes(1)
  expect(view.getByText(graph.question)).toBeTruthy()
  slow.resolve({ message: 'late', evidenceGraph: { ...graph, question: 'Overtaken answer' } })
  await settle()
  expect(view.queryByText('Overtaken answer')).toBeNull()
  const failing = Promise.withResolvers<ResearchResponse>()
  view.rerender(<EvidenceView {...h.props} project={{ ...second, revision: second.revision + 1 }} run={() => failing.promise} />)
  view.rerender(<EvidenceView {...h.props} project={{ ...second, revision: second.revision + 2 }} />)
  await settle()
  failing.reject(new Error('Overtaken failure'))
  await settle()
  expect(view.queryByRole('alert')).toBeNull()
  expect(h.run).toHaveBeenCalledTimes(2)
})

it('words the panel in the reader\'s language', async () => {
  const h = harness()
  const view = render(<EvidenceView {...h.props} t={translate(zh)} />)
  await settle()
  expect(view.getByText('5 条结论')).toBeTruthy()
  expect(view.getByText(zh.egCaption)).toBeTruthy()
  expect(view.getAllByText(zh.egQuestion).length).toBeGreaterThan(0)
})
