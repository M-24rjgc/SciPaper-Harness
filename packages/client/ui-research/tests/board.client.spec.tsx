// @vitest-environment jsdom

/**
 * The experiment board page: its fixed parts, the agent's blocks and the
 * charts, drawn from a board read and the live project record. Every command
 * it sends goes through the validator the service parses commands with.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type {
  BoardBlock, BoardSnapshot, EnvironmentId, ExperimentRecord, ResearchCommand, ResearchProject, ResearchResponse,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { Board } from '../src/client/Board.tsx'
import { BlockView, SectionView } from '../src/client/BoardBlocks.tsx'
import { LineChart } from '../src/client/LineChart.tsx'
import type { BoardViewRequest, WorkbenchProps } from '../src/client/contract.ts'
import type { Translate } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as Translate
const flush = async (): Promise<void> => { await act(async () => { for (let index = 0; index < 6; index++) await Promise.resolve() }) }
const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString()

function run(id: string, name: string, status: ExperimentRecord['status'], extra: Partial<ExperimentRecord> & { environmentId?: string } = {}): ExperimentRecord {
  const { environmentId = 'here', ...rest } = extra
  return {
    id: id as never, status, createdAt: `2026-09-24T10:${String(id.length).padStart(2, '0')}:00.000Z`, updatedAt: ago(0), directory: '', inputRevision: 1,
    environmentFingerprint: '', metrics: {}, message: '', snapshotPath: '', collected: true,
    spec: { name, seed: 1, environmentId: environmentId as EnvironmentId, argv: ['{python}', 'code/train.py'], cwd: '.', maxSeconds: 600, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' },
    ...rest,
  }
}

function fixture(): ResearchProject {
  const project = newProject({ root: '/research/sparse', title: 'Sparse', brief: '' }, 'w' as WorkspaceId)
  project.environments.push(
    { id: 'here' as EnvironmentId, name: '本机', kind: 'uv', target: 'local', python: 'py', requirements: [], fingerprint: 'f', status: 'ready', details: '', isDefault: true },
    { id: 'gpu' as EnvironmentId, name: 'A100', kind: 'existing', target: 'ssh', python: '/py', sshHost: 'gpu-box', remoteRoot: '/data', requirements: [], fingerprint: 'f', status: 'ready', details: '', isDefault: false },
  )
  project.experiments.push(
    run('live', 'main/a', 'running', { startedAt: ago(120), progress: { values: { epoch: 2, loss: 1 }, fraction: 0.5, note: 'fold 1', at: ago(1) } }),
    run('queue', 'main/b', 'queued', { environmentId: 'gone' }),
    run('lostrun', 'lost', 'unknown', { environmentId: 'gpu', startedAt: ago(30), progress: { values: { step: 7 }, at: ago(1) } }),
    run('finished', 'ablation/x', 'completed', { startedAt: ago(300), finishedAt: ago(200), message: 'finished well', metrics: { acc: 0.9, loss: 0.1, f1: 0.8, extra: 1 } }),
    run('broken', 'ablation/y', 'failed', { startedAt: ago(100), finishedAt: ago(90) }),
  )
  return project
}

const table: BoardBlock = {
  type: 'table', title: 'Table 1', note: 'mean over seeds',
  columns: [{ key: 'method', label: 'Method' }, { key: 'acc', label: 'Acc', align: 'right' }, { key: 'c', label: 'C', align: 'center' }, { key: 'l', label: 'L', align: 'left' }],
  rows: [
    { cells: { method: 'Ours', acc: { run: 'ablation/x', metric: 'acc', scale: 100, digits: 1, unit: '%', target: 95 }, c: { run: 'main/a', metric: 'acc' } } },
    { tone: 'muted', cells: { method: 'Reported', acc: { value: 88.1, sub: 'prior work' } } },
  ],
}

function snapshot(extra: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    spec: {
      title: 'Sparse board', summary: 'Does it hold?', tags: ['2 seeds'], collectors: [],
      sections: [
        { id: 'main', title: 'Main results', note: 'Paper table', blocks: [table] },
        { id: 'old', title: 'Superseded', collapsed: true, note: 'kept', blocks: [{ type: 'text', text: 'old idea' }] },
      ],
    },
    capturedAt: '2026-09-24T12:00:00.000Z', refreshing: false,
    machines: [
      {
        key: 'local', environments: ['本机'], at: '', host: 'box', os: 'Linux',
        gpus: [
          { name: 'A100', util: 63, memoryUsed: 20480, memoryTotal: 40960, temperature: 61, power: 250 },
          { name: 'Spare', memoryUsed: 1024 },
        ],
        cpu: { util: 0.34, cores: 16 }, memory: { used: 95, total: 100 }, disk: { path: '/', used: 50, total: 100, free: 50 },
        history: [{ t: 1_700_000_000_000, gpu: 0.5, cpu: 0.2, memory: 0.9 }, { t: 1_700_000_060_000, gpu: 0.6, cpu: 0.3 }],
      },
      { key: 'gpu-box', environments: ['A100'], at: '', error: 'Connection refused', gpus: [], history: [] },
      { key: 'cpu-only', environments: [], at: '', gpus: [], cpu: { cores: 4 }, disk: { path: '/', used: 95, total: 100, free: 5 }, history: [] },
      { key: 'coreless', environments: [], at: '', gpus: [], cpu: { util: 0.5 }, history: [] },
    ],
    series: { live: [{ epoch: 1, loss: 2, acc: 0.4 }, { epoch: 2, loss: 1, acc: 0.6 }], lostrun: [] },
    collected: {
      queue: {
        at: '2026-09-24T12:00:00.000Z', ms: 42, stats: [{ label: 'Server queue', value: '2 / 6', progress: 0.33 }],
        sections: [{ id: 'server', title: 'Server queue', blocks: [{ type: 'list', items: [{ title: 'fold0', status: 'done' }] }] }],
        alerts: [{ level: 'info', text: 'queue note' }],
      },
      broken: { at: '', ms: 1, stats: [], sections: [], alerts: [], error: 'Traceback' },
    },
    alerts: [{ level: 'warning', text: 'local: disk nearly full' }],
    ...extra,
  }
}

interface Harness { props: WorkbenchProps & { project: ResearchProject }; commands: ResearchCommand[]; reads: BoardViewRequest[] }
function harness(
  project: ResearchProject,
  board: (request: BoardViewRequest) => Promise<BoardSnapshot>,
  respond: (command: ResearchCommand) => Promise<ResearchResponse> = () => Promise.resolve({ message: '' }),
): Harness {
  const commands: ResearchCommand[] = []
  const reads: BoardViewRequest[] = []
  const props = {
    t, project,
    run: (command: ResearchCommand) => {
      commands.push(command)
      expect(commandSchema.parse(command)).toBeTruthy()
      return respond(command)
    },
    board: (request: BoardViewRequest) => { reads.push(request); expect(commandSchema.parse(request)).toBeTruthy(); return board(request) },
  } as unknown as WorkbenchProps & { project: ResearchProject }
  return { props, commands, reads }
}

describe('the experiment board page', () => {
  it('draws its fixed parts and the agent\'s sections from one read, and reads again on its own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const project = fixture()
    let answer = snapshot({ refreshing: true })
    const h = harness(project, () => Promise.resolve(answer))
    const ui = render(<Board {...h.props} />)
    await flush()
    expect(h.reads).toEqual([{ action: 'board-view', projectId: project.id, refresh: true }])
    expect(ui.getByText(zh.boardReading)).toBeTruthy()
    expect(ui.getByRole('heading', { name: 'Sparse board' })).toBeTruthy()
    expect(ui.getByText('Does it hold?')).toBeTruthy()
    expect(ui.getByText('2 seeds')).toBeTruthy()
    // The read's own alerts, the collectors' and the runs a person must look at.
    for (const text of ['local: disk nearly full', 'queue note', t('boardUnknownRun', { name: 'lost' })]) expect(ui.getByText(text)).toBeTruthy()
    // Counts: one running, one queued, one completed, and the failed and unconfirmed runs to look at; then the collector's number.
    const tile = (label: string): string | null | undefined => ui.getAllByText(label)[0]?.parentElement?.textContent
    expect([zh.boardRunning, zh.boardQueued, zh.boardDone, zh.boardAttention, 'Server queue'].map(tile)).toEqual([`${zh.boardRunning}1`, `${zh.boardQueued}1`, `${zh.boardDone}1`, `${zh.boardAttention}2`, 'Server queue2 / 6'])
    expect(ui.getByRole('heading', { name: zh.boardActive })).toBeTruthy()
    expect(ui.getByRole('heading', { name: zh.boardMachines })).toBeTruthy()
    expect(ui.getByRole('heading', { name: 'Main results' })).toBeTruthy()
    expect(ui.getByRole('heading', { name: 'Server queue' })).toBeTruthy()
    expect(ui.getByText(new RegExp(`^${t('boardCollectorOk', { id: 'queue', time: '.*', ms: 42 })}$`))).toBeTruthy()
    expect(ui.getByText(t('boardCollectorError', { id: 'broken', error: 'Traceback' }))).toBeTruthy()
    // While a read is under way the page asks again soon, without starting another; then on its own timer.
    answer = snapshot()
    await act(async () => { vi.advanceTimersByTime(2000) })
    await flush()
    expect(h.reads.at(-1)).toEqual({ action: 'board-view', projectId: project.id, refresh: false })
    expect(ui.getByText(zh.boardLive)).toBeTruthy()
    await act(async () => { vi.advanceTimersByTime(15_000) })
    await flush()
    expect(h.reads).toHaveLength(3)
    expect(h.reads.at(-1)?.refresh).toBe(true)
    // Read now asks at once; turning the timer off stops the next read.
    fireEvent.click(ui.getByRole('button', { name: zh.boardSyncNow }))
    await flush()
    expect(h.reads).toHaveLength(4)
    fireEvent.click(ui.getByLabelText(zh.boardAuto))
    await flush()
    expect(h.reads).toHaveLength(5)
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(h.reads).toHaveLength(5)
  })

  it('says when a read fails, keeps trying while the timer is on, and stops when it is off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const project = fixture()
    const h = harness(project, () => Promise.reject(new Error('service offline')))
    const ui = render(<Board {...h.props} />)
    await flush()
    expect(ui.getByText(zh.boardOffline)).toBeTruthy()
    expect(ui.getByRole('alert').textContent).toBe('service offline')
    expect(ui.getByRole('heading', { name: zh.boardTitle })).toBeTruthy()
    await act(async () => { vi.advanceTimersByTime(15_000) })
    await flush()
    expect(h.reads).toHaveLength(2)
    fireEvent.click(ui.getByLabelText(zh.boardAuto))
    await flush()
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(h.reads).toHaveLength(3)
    cleanup()
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the scenario under test
    const thrown = harness(project, () => Promise.reject('plain'))
    expect((await (async () => { const view = render(<Board {...thrown.props} />); await flush(); return view })()).getByRole('alert').textContent).toBe('plain')
  })

  it('shows an empty board as a promise of what will come, and ignores a read that answers after it closed', async () => {
    const bare = newProject({ root: '/r', title: 'Bare', brief: '' }, 'w' as WorkspaceId)
    let resolve = (_value: BoardSnapshot): void => {}
    const late = harness(bare, () => new Promise((done) => { resolve = done }))
    const ui = render(<Board {...late.props} />)
    expect(ui.getByText(zh.boardStale)).toBeTruthy()
    expect(ui.getByText(zh.boardEmpty)).toBeTruthy()
    ui.unmount()
    resolve(snapshot())
    await flush()
    let reject = (_reason: unknown): void => {}
    const failing = harness(bare, () => new Promise((_done, fail) => { reject = fail }))
    render(<Board {...failing.props} />).unmount()
    reject(new Error('late'))
    await flush()
    const nothing = snapshot({ machines: [], capturedAt: undefined, collected: {}, alerts: [] })
    const quiet = harness(bare, () => Promise.resolve({ ...nothing, spec: { sections: [], collectors: [] } }))
    const view = render(<Board {...quiet.props} />)
    await flush()
    expect(view.getByText(zh.boardStale)).toBeTruthy()
    expect(view.queryByRole('heading', { name: zh.boardMachines })).toBeNull()
    expect(view.queryByRole('heading', { name: zh.boardAllRuns })).toBeNull()
    expect(view.queryByRole('list')).toBeNull()
  })

  it('reports each run in flight by its progress, its time, and its curves, and stops it or reads its logs', async () => {
    const project = fixture()
    const answers: Record<string, ResearchResponse | Error> = { 'experiment-logs': { message: 'no log', content: 'epoch 2' } }
    const h = harness(project, () => Promise.resolve(snapshot()), (command) => {
      const answer = answers[command.action]
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer ?? { message: '' })
    })
    const ui = render(<Board {...h.props} />)
    await flush()
    const live = ui.getAllByRole('article').filter(card => card.textContent?.includes(zh.runSeed))
    expect(live.map(card => card.textContent?.split(' ·')[0])).toEqual(['lost', 'main/b', 'main/a'])
    const [unknown, queued, running] = live as [HTMLElement, HTMLElement, HTMLElement]
    // The running one reports half done, the time it will still take, its note, and a curve per field.
    expect(within(running).getByText(zh.running)).toBeTruthy()
    expect(within(running).getByText(/^50% · /)).toBeTruthy()
    expect(within(running).getByText(t('boardEta', { time: t('durationMinutes', { m: 2, s: 0 }) }))).toBeTruthy()
    expect(within(running).getByText('fold 1')).toBeTruthy()
    expect(within(running).getAllByRole('img').map(chart => chart.getAttribute('aria-label'))).toEqual(['loss', 'acc'])
    expect(within(running).getByText(`本机 · ${zh.local}`)).toBeTruthy()
    // The queued one measures its time against its limit and names no environment it no longer has.
    expect(within(queued).getByText(zh.queued)).toBeTruthy()
    expect(within(queued).getByText(new RegExp(`^${zh.runElapsed} .* · ${zh.runLimit} `))).toBeTruthy()
    // The unconfirmed one shows the numbers of its last line, and cannot be stopped.
    expect(within(unknown).getByText(zh.unknown)).toBeTruthy()
    expect(within(unknown).getByText('step')).toBeTruthy()
    expect(within(unknown).queryByRole('button', { name: zh.runStop })).toBeNull()
    fireEvent.click(within(running).getByRole('button', { name: zh.runStop }))
    fireEvent.click(within(running).getByRole('button', { name: zh.logs }))
    await flush()
    expect(within(running).getByText('epoch 2')).toBeTruthy()
    answers['experiment-logs'] = { message: 'no log yet' }
    fireEvent.click(within(queued).getByRole('button', { name: zh.logs }))
    await flush()
    expect(within(queued).getByText('no log yet')).toBeTruthy()
    answers['experiment-logs'] = new Error('host gone')
    answers['experiment-cancel'] = new Error('refused')
    fireEvent.click(within(unknown).getByRole('button', { name: zh.logs }))
    fireEvent.click(within(queued).getByRole('button', { name: zh.runStop }))
    await flush()
    expect(within(unknown).getByText('host gone')).toBeTruthy()
    expect(h.commands.map(command => command.action)).toEqual(['experiment-cancel', 'experiment-logs', 'experiment-logs', 'experiment-logs', 'experiment-cancel'])
    cleanup()
    // A run that reports a fraction before it started has no time to estimate from; one with no progress at all shows neither.
    const early = fixture()
    early.experiments = [
      run('a', 'early', 'running', { progress: { values: {}, fraction: 0.01, at: '' } }),
      run('bb', 'fresh', 'running', { startedAt: ago(10), progress: { values: {}, fraction: 0.001, at: '' } }),
      run('ccc', 'silent', 'running'),
    ]
    const view = render(<Board {...harness(early, () => Promise.resolve(snapshot({ series: {} }))).props} />)
    await flush()
    expect(view.queryByText(/预计还需/)).toBeNull()
    expect(view.getAllByText(/^1% · |^0% · /)).toHaveLength(2)
  })

  it('draws each machine: GPUs, processors, memory and disk, and their use over time', async () => {
    const h = harness(fixture(), () => Promise.resolve(snapshot()))
    const ui = render(<Board {...h.props} />)
    await flush()
    const machines = ui.getAllByRole('article').filter(card => !card.textContent?.includes(zh.runSeed))
    const [local, remote, cpuOnly, coreless] = machines as [HTMLElement, HTMLElement, HTMLElement, HTMLElement]
    expect(within(local).getByText(zh.boardThisMachine)).toBeTruthy()
    expect(within(local).getByText('box · Linux · 本机')).toBeTruthy()
    expect(within(local).getByText('63%')).toBeTruthy()
    expect(within(local).getByText(`${zh.boardGpuMemory} 20.0 / 40.0 GB · 61 °C · 250 W`)).toBeTruthy()
    expect(within(local).getByText('—')).toBeTruthy()
    expect(within(local).getByText(`${zh.boardCpu} · ${t('boardCores', { n: 16 })}`)).toBeTruthy()
    expect(within(local).getByRole('img', { name: zh.boardHistory })).toBeTruthy()
    expect(within(remote).getByText('gpu-box')).toBeTruthy()
    expect(within(remote).getByText('Connection refused')).toBeTruthy()
    expect(within(remote).queryByText(zh.boardNoGpu)).toBeNull()
    expect(within(cpuOnly).getByText(zh.boardNoGpu)).toBeTruthy()
    expect(within(cpuOnly).queryByText(zh.boardCpu)).toBeNull()
    expect(within(cpuOnly).getByText(t('boardFree', { free: '0.0', total: '0.0' }))).toBeTruthy()
    expect(within(coreless).getByText(zh.boardCpu)).toBeTruthy()
    // Memory and disk nearly full turn their meters amber.
    expect(local.querySelectorAll('[class*="meterWarn"]')).toHaveLength(1)
    expect(cpuOnly.querySelectorAll('[class*="meterWarn"]')).toHaveLength(1)
  })

  it('lists every run, filtered and found by name, and opens one to its command, numbers and curves', async () => {
    const project = fixture()
    let extra: Record<string, Record<string, number>[]> = { finished: [{ epoch: 1, acc: 0.5 }, { epoch: 2, acc: 0.9 }] }
    const h = harness(project, request => request.runs === undefined
      ? Promise.resolve(snapshot())
      : Promise.resolve(snapshot({ series: extra })))
    const ui = render(<Board {...h.props} />)
    await flush()
    const list = ui.getByRole('heading', { name: zh.boardAllRuns }).closest('section')!
    const names = (): string[] => [...list.querySelectorAll('tbody tr')].map(row => row.querySelector('button')?.textContent?.trim() ?? '')
    expect(names()).toEqual(['ablation/x', 'lost', 'ablation/y', 'main/b', 'main/a'])
    expect(within(list).getByText(`${zh.running} · 50%`)).toBeTruthy()
    expect(within(list).getByText('acc 0.9 · loss 0.1 · f1 0.8')).toBeTruthy()
    expect(within(list).getAllByText('—').length).toBeGreaterThan(0)
    for (const [filter, expected] of [[zh.boardFilterActive, ['lost', 'main/b', 'main/a']], [zh.boardFilterDone, ['ablation/x']], [zh.boardFilterProblem, ['lost', 'ablation/y']], [zh.boardFilterAll, ['ablation/x', 'lost', 'ablation/y', 'main/b', 'main/a']]] as const) {
      fireEvent.click(within(list).getByRole('button', { name: filter }))
      expect(names()).toEqual(expected)
    }
    fireEvent.change(within(list).getByLabelText(zh.boardSearch), { target: { value: ' ABLATION ' } })
    expect(names()).toEqual(['ablation/x', 'ablation/y'])
    fireEvent.change(within(list).getByLabelText(zh.boardSearch), { target: { value: 'nothing' } })
    expect(within(list).getByText(zh.boardNoRuns)).toBeTruthy()
    fireEvent.change(within(list).getByLabelText(zh.boardSearch), { target: { value: '' } })
    // A finished run's curves are read on demand; a run the read carries shows them at once.
    fireEvent.click(within(list).getByRole('button', { name: /ablation\/x/ }))
    await flush()
    expect(h.reads.at(-1)).toEqual({ action: 'board-view', projectId: project.id, runs: ['finished'] })
    expect(within(list).getByText('finished well')).toBeTruthy()
    expect(within(list).getByText('{python} code/train.py')).toBeTruthy()
    expect(within(list).getByRole('img', { name: 'acc' })).toBeTruthy()
    fireEvent.click(within(list).getByRole('button', { name: /ablation\/x/ }))
    expect(within(list).queryByText('finished well')).toBeNull()
    extra = {}
    fireEvent.click(within(list).getByRole('button', { name: /ablation\/y/ }))
    await flush()
    expect(within(list).queryAllByRole('img')).toHaveLength(0)
    fireEvent.click(within(list).getByRole('button', { name: /main\/a/ }))
    expect(within(list).getAllByRole('img', { name: 'loss' }).length).toBeGreaterThan(0)
    cleanup()
    // A read that fails leaves the curves empty; a closed detail ignores a late answer.
    let late = (_value: BoardSnapshot): void => {}
    const refusing = harness(project, request => request.runs === undefined
      ? Promise.resolve(snapshot())
      : request.runs[0] === 'broken' ? Promise.reject(new Error('gone')) : new Promise((resolve) => { late = resolve }))
    const again = render(<Board {...refusing.props} />)
    await flush()
    fireEvent.click(again.getByRole('button', { name: /ablation\/y/ }))
    await flush()
    fireEvent.click(again.getByRole('button', { name: /ablation\/x/ }))
    fireEvent.click(again.getByRole('button', { name: /ablation\/x/ }))
    late(snapshot({ series: { finished: [{ epoch: 1, acc: 1 }] } }))
    await flush()
    expect(within(again.getByRole('heading', { name: zh.boardAllRuns }).closest('section')!).queryAllByRole('img', { name: 'acc' })).toHaveLength(0)
  })

  it('lists thirty runs and keeps the rest behind a button', async () => {
    const project = fixture()
    project.experiments = Array.from({ length: 32 }, (_, index) => run(`r${String(index).padStart(2, '0')}`, `sweep/${index}`, 'completed'))
    const ui = render(<Board {...harness(project, () => Promise.resolve(snapshot({ machines: [] }))).props} />)
    await flush()
    const list = ui.getByRole('heading', { name: zh.boardAllRuns }).closest('section')!
    expect(list.querySelectorAll('tbody tr')).toHaveLength(30)
    fireEvent.click(within(list).getByRole('button', { name: t('boardShowAll', { n: 32 }) }))
    expect(list.querySelectorAll('tbody tr')).toHaveLength(32)
    expect(within(list).queryByRole('button', { name: t('boardShowAll', { n: 32 }) })).toBeNull()
  })
})

describe('the blocks a section is made of', () => {
  const project = fixture()
  const board = snapshot()
  const block = (value: BoardBlock) => render(<BlockView t={t} project={project} snapshot={board} block={value} />)

  it('fills a table from the runs its cells follow, and counts the cells filled', () => {
    const ui = block(table)
    expect(ui.getByText(t('boardFilled', { done: 1, total: 2 }))).toBeTruthy()
    expect(ui.getByText('90.0%')).toBeTruthy()
    expect(ui.getByText('90.0%').className).toMatch(/warning/)
    expect(ui.getByText(zh.runRunning)).toBeTruthy()
    expect(ui.getByText('prior work')).toBeTruthy()
    expect(ui.getByRole('heading', { name: 'Table 1' })).toBeTruthy()
    expect(ui.getByText('mean over seeds')).toBeTruthy()
    cleanup()
    const plain = block({ type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ cells: { a: 'x' } }] })
    expect(plain.queryByText(/已填/)).toBeNull()
  })

  it('draws stats, lists, run groups, text, key-value pairs and logs', () => {
    const ui = render(<>
      <BlockView t={t} project={project} snapshot={board} block={{ type: 'stats', items: [{ label: 'Best', run: 'ablation/x', metric: 'acc' }, { label: 'Share', value: 3, progress: 0.3 }] }} />
      <BlockView t={t} project={project} snapshot={board} block={{
        type: 'list', items: [
          { title: 'Follows a run', run: 'main/a' }, { title: 'Follows a finished run', run: 'ablation/x' },
          { title: 'Blocked', status: 'blocked', detail: 'licence', tone: 'bad' }, { title: 'Custom', status: 'reviewing', progress: 0.2 }, { title: 'Bare' },
        ],
      }} />
      <BlockView t={t} project={project} snapshot={board} block={{ type: 'runs', match: 'ablation/*', metrics: ['acc'], scale: 100, digits: 1 }} />
      <BlockView t={t} project={project} snapshot={board} block={{ type: 'runs', match: 'main/*' }} />
      <BlockView t={t} project={project} snapshot={board} block={{ type: 'runs', match: 'nothing/*' }} />
      <BlockView t={t} project={project} snapshot={board} block={{ type: 'runs', match: 'ablation/x' }} />
      <BlockView t={t} project={project} snapshot={board} block={{ type: 'text', text: 'First.\n\nSecond.' }} />
      <BlockView t={t} project={project} snapshot={board} block={{ type: 'text', text: 'Careful', tone: 'warning' }} />
      <BlockView t={t} project={project} snapshot={board} block={{ type: 'kv', items: [{ label: 'lr', value: 0.1 }, { label: 'schedule', value: 'cosine', tone: 'good' }] }} />
      <BlockView t={t} project={project} snapshot={board} block={{ type: 'log', text: 'Traceback' }} />
    </>)
    expect(ui.getAllByText('0.9')).toHaveLength(2)
    expect(ui.getAllByText(`${zh.running} · 50%`)).toHaveLength(2)
    expect(ui.getAllByText(zh.completed).length).toBeGreaterThan(0)
    expect(ui.getByText(zh.boardStatusBlocked)).toBeTruthy()
    expect(ui.getByText('reviewing')).toBeTruthy()
    expect(ui.getByText('90.0')).toBeTruthy()
    expect(ui.getByText(t('boardDoneOf', { done: 1, total: 2 }))).toBeTruthy()
    expect(ui.getByText(t('boardNoRunsYet', { match: 'nothing/*' }))).toBeTruthy()
    expect(ui.getByText('Second.')).toBeTruthy()
    expect(ui.getByText('Careful').parentElement?.className).toMatch(/warning/)
    // The kv value 0.1 beside the loss of the ablation run.
    expect(ui.getAllByText('0.1')).toHaveLength(2)
    expect(ui.getByText('Traceback')).toBeTruthy()
  })

  it('plots charts from run progress lines and from points a collector computed', () => {
    const ui = block({
      type: 'chart', xLabel: 'epoch', yLabel: 'acc', min: 0, max: 1,
      series: [{ run: 'main/a', key: 'acc' }, { run: 'nobody', key: 'acc', label: 'Missing' }, { points: [[1, 0.2], [2, 0.3]] }, { run: 'lost', key: 'acc' }, { run: 'ablation/x', key: 'acc', label: 'Unread' }],
    })
    expect(ui.getByRole('img', { name: `acc, Missing, ${t('boardSeriesN', { n: 3 })}, acc, Unread` })).toBeTruthy()
    cleanup()
    expect(block({ type: 'chart', title: 'Curve', series: [{ run: 'main/a', key: 'loss', label: 'Loss' }] }).getByRole('img', { name: 'Curve' })).toBeTruthy()
  })

  it('opens a folded section on request', () => {
    const ui = render(<SectionView t={t} project={project} snapshot={board} section={{ id: 'old', title: 'Superseded', collapsed: true, note: 'kept', blocks: [{ type: 'text', text: 'old idea' }] }} />)
    expect(ui.container.querySelector('details')?.open).toBe(false)
    expect(ui.getByText('kept')).toBeTruthy()
    cleanup()
    const open = render(<SectionView t={t} project={project} snapshot={board} section={{ id: 'new', title: 'Current', blocks: [] }} />)
    expect(open.container.querySelector('details')).toBeNull()
    expect(open.getByRole('heading', { name: 'Current' })).toBeTruthy()
  })
})

describe('the board\'s line charts', () => {
  const lines = [{ label: 'train', points: [[1, 0.2], [2, 0.5], [3, 0.7]] as [number, number][] }, { label: 'val', points: [[1, 0.1], [3, 0.6]] as [number, number][] }]

  it('waits for data, and draws a bare sparkline when compact', () => {
    expect(render(<LineChart t={t} lines={[{ label: 'x', points: [] }]} name="empty" />).getByText(zh.boardWaiting)).toBeTruthy()
    cleanup()
    const spark = render(<LineChart t={t} lines={[lines[0]!]} name="spark" compact />)
    expect(spark.getByRole('img', { name: 'spark' }).querySelectorAll('polyline')).toHaveLength(1)
    expect(spark.queryByText(zh.boardChartData)).toBeNull()
  })

  it('reads every line at the pointer, lists the data, and takes its column\'s width', () => {
    const observers: { callback: ResizeObserverCallback; disconnected: boolean }[] = []
    vi.stubGlobal('ResizeObserver', class {
      entry: { callback: ResizeObserverCallback; disconnected: boolean }
      constructor(callback: ResizeObserverCallback) { this.entry = { callback, disconnected: false }; observers.push(this.entry) }
      observe(): void {}
      disconnect(): void { this.entry.disconnected = true }
    })
    const ui = render(<LineChart t={t} lines={lines} name="acc" xLabel="epoch" yLabel="accuracy" percent formatX={x => `e${x}`} />)
    const svg = ui.getByRole('img', { name: 'acc' })
    act(() => { observers[0]!.callback([{ contentRect: { width: 900 } } as ResizeObserverEntry], {} as ResizeObserver) })
    expect(svg.getAttribute('viewBox')).toBe('0 0 900 200')
    act(() => { observers[0]!.callback([], {} as ResizeObserver) })
    act(() => { observers[0]!.callback([{ contentRect: { width: 100 } } as ResizeObserverEntry], {} as ResizeObserver) })
    expect(svg.getAttribute('viewBox')).toBe('0 0 240 200')
    // The pointer finds the nearest recorded x; a chart that has no width yet ignores it.
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 0 } as DOMRect)
    fireEvent.pointerMove(svg, { clientX: 10 })
    expect(ui.queryByRole('status')).toBeNull()
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 240 } as DOMRect)
    fireEvent.pointerMove(svg, { clientX: 230 })
    const tooltip = ui.getByRole('status')
    expect(tooltip.textContent).toBe('epoch e3train 70.0%val 60.0%')
    fireEvent.pointerLeave(svg)
    expect(ui.queryByRole('status')).toBeNull()
    expect(ui.getByText('accuracy')).toBeTruthy()
    expect([...ui.container.querySelectorAll('tbody tr')].map(row => row.textContent)).toEqual(['e120.0%10.0%', 'e250.0%', 'e370.0%60.0%'])
    ui.unmount()
    expect(observers[0]!.disconnected).toBe(true)
  })

  it('pads a flat or single-point line, thins a long table, and names a nameless axis', () => {
    const flat = render(<LineChart t={t} lines={[{ label: 'flat', points: [[5, 2], [5, 2]] }]} name="flat" />)
    expect(flat.getByRole('img', { name: 'flat' })).toBeTruthy()
    expect(flat.getByRole('columnheader', { name: zh.boardChartX })).toBeTruthy()
    expect(flat.queryByText(/^flat /)).toBeNull()
    cleanup()
    const zero = render(<LineChart t={t} lines={[{ label: 'zero', points: [[1, 0], [2, 0]] }]} name="zero" />)
    expect(zero.getByRole('img', { name: 'zero' })).toBeTruthy()
    cleanup()
    expect(render(<LineChart t={t} lines={[{ label: 'floor', points: [[1, 2], [2, 4]] }]} name="floor" min={0} />).getByRole('img', { name: 'floor' })).toBeTruthy()
    cleanup()
    expect(render(<LineChart t={t} lines={[{ label: 'ceiling', points: [[1, 2], [2, 4]] }]} name="ceiling" max={10} />).getByRole('img', { name: 'ceiling' })).toBeTruthy()
    cleanup()
    const long = render(<LineChart t={t} lines={[{ label: 'long', points: Array.from({ length: 130 }, (_, index) => [index, index] as [number, number]) }]} name="long" />)
    const rows = long.container.querySelectorAll('tbody tr')
    expect(rows.length).toBeLessThanOrEqual(61)
    expect(rows[rows.length - 1]?.textContent).toBe('129129')
    vi.spyOn(long.getByRole('img', { name: 'long' }), 'getBoundingClientRect').mockReturnValue({ left: 0, width: 640 } as DOMRect)
    fireEvent.pointerMove(long.getByRole('img', { name: 'long' }), { clientX: 46 })
    expect(long.getByRole('status').textContent).toBe('0long 0')
  })
})
