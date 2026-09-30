// @vitest-environment jsdom

/**
 * The run panel against the real experiment service: every run on screen is one
 * the service itself admitted through `newExperiment` — which needs no prior
 * confirmation or budget — and every command the panel emits is handed back to
 * the validator the service parses commands with.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { writeArtifact } from '@deepseek-ai/dsh-research-workbench/src/artifacts.ts'
import { newExperiment } from '@deepseek-ai/dsh-research-workbench/src/experiments.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type {
  EnvironmentId, ExperimentRecord, ResearchCommand, ResearchProject, ResearchResponse,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchRuns, type RunPanelProps } from '../src/client/RunPanel.tsx'
import { zh } from '../src/client/locales.ts'

const LIMIT = 100_000
const SEED = 20260921
const roots: string[] = []

afterEach(async () => {
  cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** One dictionary sentence with its placeholders filled, as the real `t` renders it. */
function say(key: keyof typeof zh, params: Record<string, string | number> = {}): string {
  return Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), zh[key])
}

/** Let the work a press started, and the state it settles into, run before asserting. */
async function flush(): Promise<void> {
  await act(async () => { for (let index = 0; index < 6; index++) await Promise.resolve() })
}

/** A host answer the test settles by hand, to look at the panel while the work is under way. */
function pending(): { promise: Promise<ResearchResponse>; resolve(response: ResearchResponse): void } {
  let resolve = (_response: ResearchResponse): void => {}
  const promise = new Promise<ResearchResponse>((done) => { resolve = done })
  return { promise, resolve: (response) => { resolve(response) } }
}

/** A project with registered run code and a ready environment: all a run needs. */
async function submittedProject(): Promise<ResearchProject> {
  const root = await mkdtemp(join(tmpdir(), 'research-runs-'))
  roots.push(root)
  const project = newProject({ root, title: 'Sparse attention scaling study', mode: 'spark-to-paper', brief: '块稀疏能否在 1/4 FLOPs 下保住长上下文准确率' }, 'workspace' as WorkspaceId)
  await writeArtifact(project, {
    action: 'save-artifact', projectId: project.id, path: 'code/train.py', content: 'print("sparse attention")\n',
    kind: 'code', expectedRevision: 0, evidence: [], claimIds: [], inputArtifacts: [],
  }, 'agent', LIMIT)
  // createEnvironment fingerprints an interpreter by running it, which this
  // jsdom suite has no interpreter for; the ready record it would return is
  // assigned so newExperiment below sees a real, complete environment.
  project.environments.push({
    id: 'environment-local' as EnvironmentId, name: '本机 3.12', kind: 'existing', target: 'local',
    python: '/usr/bin/python3.12', requirements: [], fingerprint: 'e3b0c442', status: 'ready',
    details: '{"executable":"/usr/bin/python3.12"}', isDefault: true,
  })
  return project
}

/**
 * One run the experiment service admitted, carrying the state a supervisor
 * would later report back. `newExperiment` only ever returns `queued`, and
 * every field past that is written by a real child process, so the reported
 * ones are assigned onto the record the service produced.
 */
function addRun(project: ResearchProject, name: string, reported: Partial<ExperimentRecord> = {}): ExperimentRecord {
  const code = project.artifacts.find(item => item.kind === 'code')!
  const submitted = newExperiment(project, {
    environmentId: project.environments[0]!.id, name, argv: ['{python}', 'code/train.py'], cwd: '.',
    seed: SEED, maxSeconds: 600, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [code.id],
    metricsPath: 'metrics.json',
  }, randomUUID())
  // The service records the submitting conversation on the run; this spec's runs are this conversation's unless a test says otherwise.
  const run = { ...submitted, sessionId: SESSION, ...reported }
  project.experiments.push(run)
  return run
}

interface Mounted {
  panel: ReturnType<typeof render>
  commands: ResearchCommand[]
  drafts: string[]
  /** How many times a card asked for the experiment board. */
  boards: number[]
  /** Draw the panel again, as the store does after the host re-read the record. */
  redraw: () => void
}

/** The panel over one project, recording every command and every composer draft. */
function mount(
  project: ResearchProject | null,
  options: { respond?: (command: ResearchCommand) => Promise<ResearchResponse>; draft?: string; blank?: boolean } = {},
): Mounted {
  const { respond = () => Promise.resolve({ message: '' }), draft = '', blank = false } = options
  const commands: ResearchCommand[] = []
  const drafts: string[] = []
  const boards: number[] = []
  if (project) project.sessionId = SESSION
  const view = {
    snapshot: project === null ? null : { projects: [project], preferences: {}, components: [], modes: [] },
    tasks: [],
  }
  const list = { byId: { [SESSION]: { id: SESSION, blank } } }
  const props = {
    sessionId: SESSION,
    t: (key: string, params?: Record<string, unknown>) => {
      const template = (zh as Record<string, string>)[key] ?? key
      return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
    },
    run: (command: ResearchCommand) => { commands.push(command); return respond(command) },
    useResearch: (select: (value: typeof view) => unknown) => select(view),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select({}),
    useSessions: (select: (value: typeof list) => unknown) => select(list),
    input: { draft },
    inputActions: { setDraft: (text: string) => { drafts.push(text) } },
    openBoard: () => { boards.push(boards.length + 1) },
  } as unknown as RunPanelProps
  const panel = render(<ResearchRuns {...props} />)
  return { panel, commands, drafts, boards, redraw: () => { panel.rerender(<ResearchRuns {...props} />) } }
}

/** Press 停止 on the panel, then confirm it in the question that follows. */
function stopConfirmed(panel: ReturnType<typeof render>): void {
  fireEvent.click(panel.getByRole('button', { name: zh.runStop }))
  fireEvent.click(within(panel.getByRole('group', { name: zh.confirmStop })).getByRole('button', { name: zh.runStop }))
}

/** The session every project in this spec is dispatched into. */
const SESSION = 'session-runs'

describe('the run panel reports the runs the experiment service admitted', () => {
  it('draws nothing before a project owns a run', async () => {
    const project = await submittedProject()
    expect(project.experiments).toEqual([])
    expect(mount(null).panel.container.firstChild).toBeNull()
    expect(mount(project).panel.container.firstChild).toBeNull()
  })

  it('draws only the runs this conversation submitted; the others and the runs recorded without one are on the board', async () => {
    const project = await submittedProject()
    addRun(project, 'elsewhere', { status: 'running', sessionId: 'session-other' })
    const unrecorded = addRun(project, 'unrecorded', { status: 'running' })
    delete unrecorded.sessionId
    expect(mount(project).panel.container.firstChild).toBeNull()
    cleanup()
    addRun(project, 'mine', { status: 'running', startedAt: new Date().toISOString() })
    const { panel } = mount(project)
    expect(panel.getAllByRole('article').map(card => card.textContent?.split(' ')[0])).toEqual(['mine'])
  })

  it('draws nothing on a blank conversation unless one of its runs is still open', async () => {
    const project = await submittedProject()
    addRun(project, 'finished', { status: 'completed' })
    expect(mount(project, { blank: true }).panel.container.firstChild).toBeNull()
    cleanup()
    addRun(project, 'waiting')
    const { panel } = mount(project, { blank: true })
    expect(panel.getByText(/^waiting /)).toBeTruthy()
  })

  it('lets an example\'s runs be read and followed to the board, and offers nothing else', async () => {
    const project = await submittedProject()
    project.example = true
    addRun(project, 'running', { status: 'running', startedAt: new Date().toISOString() })
    addRun(project, 'lost', { status: 'unknown' })
    addRun(project, 'finished', { status: 'completed', collected: true })
    const { panel, commands, boards } = mount(project, { respond: () => Promise.resolve({ message: 'Experiment logs', content: 'epoch 1' }) })
    fireEvent.click(panel.getByRole('button', { name: say('runsShowSettled', { n: 1 }) }))
    for (const name of [zh.runStop, zh.runReconnect, zh.dismiss, zh.runPlot]) expect(panel.queryByRole('button', { name })).toBeNull()
    // The unconfirmed run is named without pointing at a reconnect the example lacks.
    expect(panel.getByText(zh.runUnknownNoteExample)).toBeTruthy()
    expect(panel.queryByText(zh.runUnknownNote)).toBeNull()
    expect(panel.getAllByRole('button', { name: zh.logs })).toHaveLength(3)
    fireEvent.click(panel.getAllByRole('button', { name: zh.boardOpen })[0]!)
    fireEvent.click(panel.getAllByRole('button', { name: zh.logs })[0]!)
    await flush()
    expect(boards).toEqual([1])
    expect(commands.map(command => command.action)).toEqual(['experiment-logs'])
  })

  it('measures a running run against its own time limit', async () => {
    const project = await submittedProject()
    addRun(project, 'block-sparse-4k', { status: 'running', startedAt: new Date(Date.now() - 125_000).toISOString() })
    const { panel } = mount(project)

    expect(panel.getByText(zh.runRunning)).toBeTruthy()
    expect(panel.getByText(new RegExp(`^${zh.runElapsed} ${say('durationMinutes', { m: 2, s: '\\d+' })}$`))).toBeTruthy()
    expect(panel.getByText(`${zh.runLimit} ${say('durationMinutes', { m: 10, s: 0 })}`)).toBeTruthy()
    // The run names its environment; the interpreter path is one hover away.
    expect(panel.getByText(`${project.environments[0]!.name} · ${zh.local}`).getAttribute('title')).toBe(project.environments[0]!.python)
    // A fifth of the run's 10-minute limit has gone.
    const bar = panel.container.querySelector<HTMLElement>('[style]')!
    expect(Number.parseFloat(bar.style.width)).toBeCloseTo(20.8, 0)
  })

  it('stops a run only after the person confirms, and folds it away once the host stopped it', async () => {
    const project = await submittedProject()
    const run = addRun(project, 'block-sparse-4k', { status: 'running', startedAt: new Date().toISOString() })
    const cancel = pending()
    const { panel, commands, redraw } = mount(project, { respond: () => cancel.promise })

    // A stopped run cannot be resumed, so the first press only asks.
    fireEvent.click(panel.getByRole('button', { name: zh.runStop }))
    expect(within(panel.getByRole('group', { name: zh.confirmStop })).getByText(zh.confirmStop)).toBeTruthy()
    fireEvent.click(panel.getByRole('button', { name: zh.runKeep }))
    await flush()
    expect(commands).toEqual([])
    expect(panel.getByText(zh.runRunning)).toBeTruthy()

    stopConfirmed(panel)
    await flush()
    expect(panel.getByRole('status').textContent).toBe(zh.runStopping)
    expect(panel.queryByRole('button', { name: zh.runStop })).toBeNull()
    expect(commands).toEqual([{ action: 'experiment-cancel', projectId: project.id, runId: run.id }])
    // The service parses every incoming command with exactly this schema, and
    // then finds the run by the id the panel put in it.
    expect(commandSchema.parse(commands[0])).toEqual(commands[0])
    expect(project.experiments.findIndex(item => item.id === run.id)).toBe(0)

    // The host reads the record again before the stop settles; a stopped run is a finished one.
    Object.assign(run, { status: 'cancelled', finishedAt: new Date().toISOString() })
    await act(async () => { cancel.resolve({ message: 'Cancelled' }) })
    redraw()
    expect(panel.queryByRole('article')).toBeNull()
    expect(panel.getByRole('button', { name: say('runsShowSettled', { n: 1 }) })).toBeTruthy()
  })

  it('follows a run by its own progress line, shows its latest numbers, and opens the board', async () => {
    const project = await submittedProject()
    addRun(project, 'block-sparse-8k', {
      status: 'running', startedAt: new Date(Date.now() - 65_000).toISOString(),
      progress: { values: { epoch: 3, val_acc: 0.81 }, fraction: 0.25, note: 'fold 1/4', at: new Date().toISOString() },
    })
    addRun(project, 'block-sparse-16k', {
      status: 'running', startedAt: new Date().toISOString(), progress: { values: {}, fraction: 0.5, at: new Date().toISOString() },
    })
    // A run that reports a fraction before its supervisor stamped a start has no time yet.
    addRun(project, 'block-sparse-32k', { progress: { values: {}, fraction: 0.75, at: new Date().toISOString() } })
    const { panel, boards } = mount(project)
    expect(panel.getByText('25% · fold 1/4')).toBeTruthy()
    expect(panel.getByText('50%')).toBeTruthy()
    expect(panel.getAllByText(new RegExp(`^${zh.runElapsed} `))).toHaveLength(3)
    expect(panel.getByText('75%')).toBeTruthy()
    expect(panel.getByText('val_acc')).toBeTruthy()
    expect(panel.getByText('0.81')).toBeTruthy()
    const widths = [...panel.container.querySelectorAll<HTMLElement>('[style]')].map(bar => bar.style.width)
    expect(widths).toEqual(expect.arrayContaining(['25%', '50%']))
    fireEvent.click(panel.getAllByRole('button', { name: zh.boardOpen })[0]!)
    expect(boards).toEqual([1])
  })

  it('says a queued run is queued, not running, with nothing elapsed yet', async () => {
    const project = await submittedProject()
    const run = addRun(project, 'warmup')
    expect(run.status).toBe('queued')
    const { panel } = mount(project)

    expect(panel.getByText(zh.queued)).toBeTruthy()
    expect(panel.queryByText(zh.runRunning)).toBeNull()
    expect(panel.getByText(`${zh.runElapsed} ${say('durationSeconds', { s: 0 })}`)).toBeTruthy()
    expect(panel.container.querySelector<HTMLElement>('[style]')!.style.width).toBe('0%')
    expect(panel.getByRole('button', { name: zh.runStop })).toBeTruthy()
  })

  it('reports a finished run\'s measurements and drafts a plot request from it', async () => {
    const project = await submittedProject()
    addRun(project, 'block-sparse-4k', {
      status: 'completed', startedAt: '2026-09-20T08:00:00.000Z', finishedAt: '2026-09-20T09:02:05.000Z',
      collected: true, metrics: { accuracy: 0.871, tokensPerSecond: 14200 },
    })
    const { panel, drafts } = mount(project)
    fireEvent.click(panel.getByRole('button', { name: say('runsShowSettled', { n: 1 }) }))

    expect(panel.getByText(zh.runCollected)).toBeTruthy()
    expect(panel.queryByText(zh.runRunning)).toBeNull()
    expect(panel.getByText(say('durationHours', { h: 1, m: 2 }))).toBeTruthy()
    expect(panel.getByText('accuracy')).toBeTruthy()
    expect(panel.getByText('0.871')).toBeTruthy()
    expect(panel.getByText('14200')).toBeTruthy()
    expect(panel.queryByRole('button', { name: zh.runStop })).toBeNull()

    fireEvent.click(panel.getByRole('button', { name: zh.runPlot }))
    expect(drafts).toEqual([say('runPlotDraft', { name: 'block-sparse-4k', seed: SEED })])
    expect(drafts[0]!).toContain('block-sparse-4k')
    expect(drafts[0]!).toContain(String(SEED))
  })

  it('adds the plot request after what the person already typed instead of replacing it', async () => {
    const project = await submittedProject()
    addRun(project, 'block-sparse-4k', { status: 'completed', collected: true, metrics: { accuracy: 0.871 } })
    const { panel, drafts } = mount(project, { draft: '先和基线对比一下。\n' })
    fireEvent.click(panel.getByRole('button', { name: say('runsShowSettled', { n: 1 }) }))

    fireEvent.click(panel.getByRole('button', { name: zh.runPlot }))
    expect(drafts).toEqual([`先和基线对比一下。\n${say('runPlotDraft', { name: 'block-sparse-4k', seed: SEED })}`])
  })

  it('keeps reporting a run whose environment and exit time no longer resolve', async () => {
    const project = await submittedProject()
    // A finish time the panel cannot read falls back to now. No supervisor
    // writes one, so the unreadable value is assigned to reach that fallback.
    addRun(project, 'ablation-no-gate', {
      status: 'completed', startedAt: new Date(Date.now() - 45_000).toISOString(), finishedAt: 'sometime',
    })
    // The record outlives the environment register; this interpreter was dropped.
    project.environments.length = 0
    const { panel } = mount(project)
    fireEvent.click(panel.getByRole('button', { name: say('runsShowSettled', { n: 1 }) }))

    expect(panel.queryByText(zh.runCollected)).toBeNull()
    expect(panel.queryByText(new RegExp(zh.local))).toBeNull()
    expect(panel.getByText(new RegExp(`^${say('durationSeconds', { s: '4\\d' })}$`))).toBeTruthy()
    expect(panel.getByRole('button', { name: zh.runPlot })).toBeTruthy()
  })

  it('says an unconfirmed run is unconfirmed and offers to reconnect or dismiss it', async () => {
    const project = await submittedProject()
    // A lost submission receipt is what produces `unknown`, and such a record
    // can carry a start time nothing ever reported; both are assigned.
    const run = addRun(project, 'long-context-32k', { status: 'unknown', startedAt: 'unreported' })
    const answers = { 'experiment-refresh': pending(), 'experiment-dismiss': pending() }
    const { panel, commands } = mount(project, { respond: command => answers[command.action as keyof typeof answers].promise })

    expect(panel.getByText(zh.unknown)).toBeTruthy()
    expect(panel.getByText(zh.runUnknownNote)).toBeTruthy()
    expect(panel.container.querySelector('[style]')).toBeNull()
    expect(panel.queryByRole('button', { name: zh.runStop })).toBeNull()

    // Each button holds itself off while its own request runs; the other stays available.
    fireEvent.click(panel.getByRole('button', { name: zh.runReconnect }))
    await flush()
    expect(panel.getByRole('button', { name: zh.runReconnect }).hasAttribute('disabled')).toBe(true)
    expect(panel.getByRole('button', { name: zh.dismiss }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(panel.getByRole('button', { name: zh.dismiss }))
    await flush()
    expect(panel.getByRole('button', { name: zh.dismiss }).hasAttribute('disabled')).toBe(true)
    expect(commands).toEqual([
      { action: 'experiment-refresh', projectId: project.id, runId: run.id },
      { action: 'experiment-dismiss', projectId: project.id, runId: run.id },
    ])
    for (const command of commands) expect(commandSchema.parse(command)).toEqual(command)

    await act(async () => {
      answers['experiment-refresh'].resolve({ message: 'Reconnected' })
      answers['experiment-dismiss'].resolve({ message: 'Dismissed' })
    })
    await flush()
    expect(panel.getByRole('button', { name: zh.runReconnect }).hasAttribute('disabled')).toBe(false)
    expect(panel.getByRole('button', { name: zh.dismiss }).hasAttribute('disabled')).toBe(false)
    expect(panel.queryByRole('alert')).toBeNull()
  })

  it('says beside each run why a stop, a reconnect or a dismiss was refused', async () => {
    const project = await submittedProject()
    addRun(project, 'block-sparse-4k', { status: 'running', startedAt: new Date().toISOString() })
    addRun(project, 'long-context-32k', { status: 'unknown' })
    const { panel, commands } = mount(project, { respond: () => Promise.reject(new Error('The supervisor is unreachable')) })
    const [unconfirmed, running] = panel.getAllByRole('article') as [HTMLElement, HTMLElement]

    stopConfirmed(panel)
    fireEvent.click(panel.getByRole('button', { name: zh.runReconnect }))
    fireEvent.click(panel.getByRole('button', { name: zh.dismiss }))
    await flush()

    expect(commands.map(command => command.action)).toEqual(['experiment-cancel', 'experiment-refresh', 'experiment-dismiss'])
    const refusal = say('actionFailed', { reason: 'The supervisor is unreachable' })
    expect(within(running).getAllByRole('alert').map(line => line.textContent)).toEqual([refusal])
    expect(within(unconfirmed).getAllByRole('alert').map(line => line.textContent)).toEqual([refusal, refusal])
    // The runs are reported as they were, and every control can be tried again.
    expect(within(running).getByText(zh.runRunning)).toBeTruthy()
    expect(within(running).getByRole('button', { name: zh.runStop })).toBeTruthy()
    expect(within(unconfirmed).getByText(zh.unknown)).toBeTruthy()
    expect(within(unconfirmed).getByRole('button', { name: zh.runReconnect }).hasAttribute('disabled')).toBe(false)
  })

  it('shows the log text the service read back', async () => {
    const project = await submittedProject()
    const run = addRun(project, 'block-sparse-4k', { status: 'running', startedAt: new Date().toISOString() })
    const read = pending()
    const { panel, commands } = mount(project, { respond: () => read.promise })

    expect(panel.queryByText('epoch 3 | loss 0.412')).toBeNull()
    fireEvent.click(panel.getByRole('button', { name: zh.logs }))
    await flush()
    // One read at a time: the button holds itself off until the service answers.
    expect(panel.getByRole('button', { name: zh.logs }).hasAttribute('disabled')).toBe(true)
    await act(async () => { read.resolve({ message: 'Experiment logs', content: 'epoch 3 | loss 0.412' }) })

    expect(await panel.findByText('epoch 3 | loss 0.412')).toBeTruthy()
    expect(panel.getByRole('button', { name: zh.logs }).hasAttribute('disabled')).toBe(false)
    expect(commands).toEqual([{ action: 'experiment-logs', projectId: project.id, runId: run.id }])
    expect(commandSchema.parse(commands[0])).toEqual(commands[0])
  })

  it('falls back to the service message when a run has written no log yet', async () => {
    const project = await submittedProject()
    addRun(project, 'warmup')
    const { panel } = mount(project, { respond: () => Promise.resolve({ message: 'Experiment logs' }) })

    fireEvent.click(panel.getByRole('button', { name: zh.logs }))
    expect(await panel.findByText('Experiment logs')).toBeTruthy()
  })

  it('says why the logs could not be read, under the run, instead of showing them', async () => {
    const project = await submittedProject()
    addRun(project, 'warmup')
    const { panel } = mount(project, { respond: () => Promise.reject(new Error('Experiment logs: ssh exited 255')) })

    fireEvent.click(panel.getByRole('button', { name: zh.logs }))
    await flush()
    expect(panel.getByRole('alert').textContent).toBe(say('actionFailed', { reason: 'Experiment logs: ssh exited 255' }))
    expect(panel.container.querySelector('pre')).toBeNull()
    expect(panel.getByRole('button', { name: zh.logs }).hasAttribute('disabled')).toBe(false)
  })

  it('draws the five newest runs and collapses the rest into a count', async () => {
    const project = await submittedProject()
    for (let index = 0; index < 7; index++) addRun(project, `sweep-${index}`)
    const { panel } = mount(project)

    expect(panel.getAllByRole('button', { name: zh.logs })).toHaveLength(5)
    expect(panel.getByText(say('runMore', { n: 2 }))).toBeTruthy()
    expect(panel.getByText(/^sweep-6 /)).toBeTruthy()
    expect(panel.queryByText(/^sweep-1 /)).toBeNull()
  })

  it('keeps runs that need a person open and folds finished ones into one row', async () => {
    const project = await submittedProject()
    addRun(project, 'baseline', { status: 'completed', collected: true, metrics: { accuracy: 0.821 } })
    addRun(project, 'fixed', { status: 'failed' })
    addRun(project, 'lab-seed-13', { status: 'unknown' })
    const { panel } = mount(project)

    expect(panel.getByText(/^lab-seed-13 /)).toBeTruthy()
    expect(panel.queryByText(/^baseline /)).toBeNull()
    const toggle = panel.getByRole('button', { name: say('runsShowSettled', { n: 2 }) })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(panel.getByText(/^baseline /)).toBeTruthy()
    expect(panel.getByText(/^fixed /)).toBeTruthy()
    // Open runs stay first; the finished ones follow, newest first.
    expect(panel.getAllByRole('article').map(card => card.textContent?.split(' ')[0])).toEqual(['lab-seed-13', 'fixed', 'baseline'])

    fireEvent.click(panel.getByRole('button', { name: zh.runsHideSettled }))
    expect(panel.queryByText(/^baseline /)).toBeNull()
  })
})
