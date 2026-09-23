// @vitest-environment jsdom

/**
 * The run panel against the real experiment service: every run on screen is one
 * the service itself admitted through `newExperiment` — which needs no prior
 * confirmation or budget — and every command the panel emits is handed back to
 * the validator the service parses commands with.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
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
import { ResearchRuns, type RunPanelOwnerProps } from '../src/client/RunPanel.tsx'
import type { SessionSeatProps, WorkbenchProps } from '../src/client/contract.ts'
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

/** Let the handlers the panel attached to its own promises run before asserting. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0) })
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
  const run = { ...submitted, ...reported }
  project.experiments.push(run)
  return run
}

/** The panel over one project, recording every command and every composer draft. */
function mount(
  project: ResearchProject | null,
  respond: (command: ResearchCommand) => Promise<ResearchResponse> = () => Promise.resolve({ message: '' }),
): { panel: ReturnType<typeof render>; commands: ResearchCommand[]; drafts: string[] } {
  const commands: ResearchCommand[] = []
  const drafts: string[] = []
  if (project) project.sessionId = SESSION
  const view = {
    snapshot: project === null ? null : { projects: [project], preferences: {}, components: [] },
    tasks: [], busy: false, error: '', response: null,
  }
  const props = {
    sessionId: SESSION,
    t: (key: string, params?: Record<string, unknown>) => {
      const template = (zh as Record<string, string>)[key] ?? key
      return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
    },
    run: (command: ResearchCommand) => { commands.push(command); return respond(command) },
    useResearch: (select: (value: typeof view) => unknown) => select(view),
    inputActions: { setDraft: (text: string) => { drafts.push(text) } },
    useFocus: () => ({ claimId: null }),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select({}),
    focusClaim: () => {},
    expand: () => {},
    install: () => Promise.resolve(),
    configure: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    create: () => Promise.resolve(),
    openConversation: () => Promise.resolve(),
  } as unknown as WorkbenchProps & RunPanelOwnerProps & SessionSeatProps
  return { panel: render(<ResearchRuns {...props} />), commands, drafts }
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

  it('measures a running run against its own time limit and stops it', async () => {
    const project = await submittedProject()
    const run = addRun(project, 'block-sparse-4k', { status: 'running', startedAt: new Date(Date.now() - 125_000).toISOString() })
    const { panel, commands } = mount(project)

    expect(panel.getByText(zh.runRunning)).toBeTruthy()
    expect(panel.getByText(new RegExp(`^${zh.runElapsed} ${say('durationMinutes', { m: 2, s: '\\d+' })}$`))).toBeTruthy()
    expect(panel.getByText(`${zh.runLimit} ${say('durationMinutes', { m: 10, s: 0 })}`)).toBeTruthy()
    // The run names its environment; the interpreter path is one hover away.
    expect(panel.getByText(`${project.environments[0]!.name} · ${zh.local}`).getAttribute('title')).toBe(project.environments[0]!.python)
    // A fifth of the run's 10-minute limit has gone.
    const bar = panel.container.querySelector<HTMLElement>('[style]')!
    expect(Number.parseFloat(bar.style.width)).toBeCloseTo(20.8, 0)

    fireEvent.click(panel.getByRole('button', { name: zh.runStop }))
    expect(commands).toEqual([{ action: 'experiment-cancel', projectId: project.id, runId: run.id }])
    // The service parses every incoming command with exactly this schema, and
    // then finds the run by the id the panel put in it.
    expect(commandSchema.parse(commands[0])).toEqual(commands[0])
    expect(project.experiments.findIndex(item => item.id === run.id)).toBe(0)
  })

  it('shows a queued run as open with nothing elapsed yet', async () => {
    const project = await submittedProject()
    const run = addRun(project, 'warmup')
    expect(run.status).toBe('queued')
    const { panel } = mount(project)

    expect(panel.getByText(zh.runRunning)).toBeTruthy()
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
    const { panel, commands } = mount(project)

    expect(panel.getByText(zh.unknown)).toBeTruthy()
    expect(panel.getByText(zh.runUnknownNote)).toBeTruthy()
    expect(panel.container.querySelector('[style]')).toBeNull()
    expect(panel.queryByRole('button', { name: zh.runStop })).toBeNull()

    fireEvent.click(panel.getByRole('button', { name: zh.runReconnect }))
    fireEvent.click(panel.getByRole('button', { name: zh.dismiss }))
    expect(commands).toEqual([
      { action: 'experiment-refresh', projectId: project.id, runId: run.id },
      { action: 'experiment-dismiss', projectId: project.id, runId: run.id },
    ])
    for (const command of commands) expect(commandSchema.parse(command)).toEqual(command)
  })

  it('swallows a refused stop and a refused reconnect instead of restating the run', async () => {
    const project = await submittedProject()
    addRun(project, 'block-sparse-4k', { status: 'running', startedAt: new Date().toISOString() })
    addRun(project, 'long-context-32k', { status: 'unknown' })
    const { panel, commands } = mount(project, () => Promise.reject(new Error('The supervisor is unreachable')))

    fireEvent.click(panel.getByRole('button', { name: zh.runStop }))
    fireEvent.click(panel.getByRole('button', { name: zh.runReconnect }))
    fireEvent.click(panel.getByRole('button', { name: zh.dismiss }))
    await settle()

    expect(commands.map(command => command.action)).toEqual(['experiment-cancel', 'experiment-refresh', 'experiment-dismiss'])
    expect(panel.getByText(zh.runRunning)).toBeTruthy()
    expect(panel.getByText(zh.unknown)).toBeTruthy()
    expect(panel.queryByText(/unreachable/)).toBeNull()
  })

  it('shows the log text the service read back', async () => {
    const project = await submittedProject()
    const run = addRun(project, 'block-sparse-4k', { status: 'running', startedAt: new Date().toISOString() })
    const { panel, commands } = mount(project, () => Promise.resolve({ message: 'Experiment logs', content: 'epoch 3 | loss 0.412' }))

    expect(panel.queryByText('epoch 3 | loss 0.412')).toBeNull()
    fireEvent.click(panel.getByRole('button', { name: zh.logs }))

    expect(await panel.findByText('epoch 3 | loss 0.412')).toBeTruthy()
    expect(commands).toEqual([{ action: 'experiment-logs', projectId: project.id, runId: run.id }])
    expect(commandSchema.parse(commands[0])).toEqual(commands[0])
  })

  it('falls back to the service message when a run has written no log yet', async () => {
    const project = await submittedProject()
    addRun(project, 'warmup')
    const { panel } = mount(project, () => Promise.resolve({ message: 'Experiment logs' }))

    fireEvent.click(panel.getByRole('button', { name: zh.logs }))
    expect(await panel.findByText('Experiment logs')).toBeTruthy()
  })

  it('shows the failure in place of the logs when the read cannot be done', async () => {
    const project = await submittedProject()
    addRun(project, 'warmup')
    const { panel } = mount(project, () => Promise.reject(new Error('Experiment logs: ssh exited 255')))

    fireEvent.click(panel.getByRole('button', { name: zh.logs }))
    expect(await panel.findByText(/ssh exited 255/)).toBeTruthy()
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
