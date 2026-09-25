// @vitest-environment jsdom

/**
 * The research rail. It reports how the project stands by its last check, what
 * was decided and what the project holds, and offers the project's tools. The
 * assistant sets the mode and runs the checks, so the one thing a person
 * changes here is the autonomy; that control keeps its own pending and failure
 * state, and every command it emits is handed back to the validator the
 * service parses commands with.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type { EvidenceId, ExperimentRecord, ResearchCommand, ResearchProject, RunStatus } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ProjectStatus, ResearchRail, ResearchRailTitle } from '../src/client/Rail.tsx'
import type { SessionSeatProps, WorkbenchProps } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'
import { MODES } from './fixtures/modes.ts'

afterEach(() => { cleanup() })

const SESSION = 'session-rail'
const ROOT = 'C:\\research\\sparse'

interface Log {
  commands: ResearchCommand[]
  lines: [string, string][]
  opened: [string, string][]
  expanded: [string, string | undefined][]
  /** How many times the research folder's file tab was asked for. */
  files: number
}

/** How the host answers; it accepts everything unless a test says otherwise. */
interface Host {
  run?: () => Promise<unknown>
  command?: () => Promise<unknown>
  openFile?: () => void
  openFiles?: () => void
}

/** The Chinese dictionary, interpolating `{name}` the way the locale seat does. */
function t(key: string, params?: Record<string, unknown>): string {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}

/** A project in the given mode and route; the general mode when none is named. */
function project(mode?: string, route?: string): ResearchProject {
  const record = newProject({ root: ROOT, title: 'Sparse attention scaling study', brief: '', ...(mode ? { mode } : {}), ...(route ? { route } : {}) }, 'workspace' as WorkspaceId)
  record.sessionId = SESSION
  return record
}

/** One recorded run in the given state. */
function run(id: string, status: RunStatus): ExperimentRecord {
  return { id: id as never, spec: {} as never, status, createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: {}, message: '', snapshotPath: '', collected: false }
}

function seat(projects: ResearchProject[], host: Host): { props: WorkbenchProps & SessionSeatProps; log: Log } {
  const log: Log = { commands: [], lines: [], opened: [], expanded: [], files: 0 }
  const view = { snapshot: { projects, preferences: {}, components: [], modes: MODES }, tasks: [], response: null }
  const props = {
    sessionId: SESSION,
    t,
    useResearch: (select: (value: typeof view) => unknown) => select(view),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select({}),
    run: (command: ResearchCommand) => {
      log.commands.push(command)
      return host.run ? host.run() : Promise.resolve({ message: '' })
    },
    command: (sessionId: string, line: string) => {
      log.lines.push([sessionId, line])
      return host.command ? host.command() : Promise.resolve()
    },
    openFile: (root: string, path: string) => { log.opened.push([root, path]); host.openFile?.() },
    openFiles: () => { log.files += 1; host.openFiles?.() },
    expand: (projectId: string, panel?: string) => { log.expanded.push([projectId, panel]) },
  } as unknown as WorkbenchProps & SessionSeatProps
  return { props, log }
}

/** The rail beside the conversation `SESSION`. */
function mount(projects: ResearchProject[], host: Host = {}): { rail: ReturnType<typeof render>; log: Log } {
  const { props, log } = seat(projects, host)
  return { rail: render(<ResearchRail {...props} />), log }
}

/** Let the host's answers land. */
const settle = async (): Promise<void> => { await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }) }

/** A host answer that waits until the test lets it through. */
function held(): { answer: () => Promise<unknown>; release: () => void } {
  let release = (): void => {}
  const pending = new Promise<unknown>((resolve) => { release = () => { resolve({ message: '' }) } })
  return { answer: () => pending, release: () => { release() } }
}

describe('the research rail', () => {
  it('names itself, and says so when the folder is not a research project yet', () => {
    expect(render(<ResearchRailTitle t={t as WorkbenchProps['t']} />).container.textContent).toBe(zh.railTitle)
    cleanup()
    const stranger = project()
    stranger.sessionId = 'elsewhere'
    expect(mount([stranger]).rail.getByText(zh.railNoProject)).toBeTruthy()
  })

  it('offers the autonomy as its one setting, and changes it together with the conversation\'s access preset', async () => {
    const general = project()
    const { rail, log } = mount([general])
    // The mode is the assistant's to set: the autonomy is the only choice on the rail.
    const [autonomy, ...others] = rail.getAllByRole('combobox') as HTMLSelectElement[]
    expect(others).toEqual([])
    expect(autonomy!.value).toBe('checkpoints')
    expect([...autonomy!.options].map(option => option.textContent)).toEqual([zh.autonomyCheckpoints, zh.autonomyAutomatic])

    fireEvent.change(autonomy!, { target: { value: 'automatic' } })
    await settle()
    fireEvent.change(autonomy!, { target: { value: 'checkpoints' } })
    await settle()
    expect(log.commands).toEqual([
      { action: 'set-autonomy', projectId: general.id, autonomy: 'automatic' },
      { action: 'set-autonomy', projectId: general.id, autonomy: 'checkpoints' },
    ])
    for (const command of log.commands) expect(commandSchema.parse(command)).toEqual(command)
    expect(log.lines).toEqual([[SESSION, '/permission research-auto'], [SESSION, '/permission workspace-write']])
    expect(rail.queryByRole('alert')).toBeNull()
  })

  it('holds the autonomy while a change is being saved', async () => {
    const saving = held()
    const { rail } = mount([project()], { run: saving.answer })
    const autonomy = rail.getByRole('combobox') as HTMLSelectElement
    fireEvent.change(autonomy, { target: { value: 'automatic' } })
    expect(autonomy.disabled).toBe(true)
    saving.release()
    await settle()
    expect(autonomy.disabled).toBe(false)
  })

  it('says why an autonomy change failed, and leaves the access preset alone when the change was refused', async () => {
    const refused = mount([project()], { run: () => Promise.reject(new Error('refused')) })
    fireEvent.change(refused.rail.getByRole('combobox'), { target: { value: 'automatic' } })
    await settle()
    expect(refused.rail.getByRole('alert').textContent).toBe(t('actionFailed', { reason: 'refused' }))
    expect(refused.log.lines).toEqual([])
    expect((refused.rail.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false)
    cleanup()

    // The autonomy was recorded, but the conversation kept its old access preset.
    const stuck = mount([project()], { command: () => Promise.reject(new Error('no such preset')) })
    fireEvent.change(stuck.rail.getByRole('combobox'), { target: { value: 'automatic' } })
    await settle()
    expect(stuck.log.commands.map(command => command.action)).toEqual(['set-autonomy'])
    expect(stuck.rail.getByRole('alert').textContent).toBe(t('actionFailed', { reason: 'no such preset' }))
  })

  it('changes the autonomy from outside a conversation without touching any access preset', async () => {
    const general = project()
    const { props, log } = seat([general], {})
    const status = render(<ProjectStatus {...props} project={general} commandSession={undefined} />)
    fireEvent.change(status.getByRole('combobox'), { target: { value: 'automatic' } })
    await settle()
    expect(log.commands).toEqual([{ action: 'set-autonomy', projectId: general.id, autonomy: 'automatic' }])
    expect(log.lines).toEqual([])
  })

  it('shows the phases of the last check, what still blocks each, and the errors with the files they name', async () => {
    const routed = project('spark-to-paper', 'proposal')
    routed.lastCheck = {
      clean: false, scope: 'all', mode: 'spark-to-paper', route: 'proposal', checkedAt: '',
      phases: [
        { id: 'plan', done: true, missing: [] },
        { id: 'cite', done: false, missing: ['2 error(s) in cite', 'No bibliography entries yet', 'hidden third'] },
        { id: 'renamed-upstream', done: false, missing: [] },
      ],
      findings: [
        { check: 'cite', severity: 'error', message: 'Citation key has no bibliography entry: x', file: 'paper/main.tex', line: 12 },
        { check: 'compile', severity: 'error', message: 'The paper has not been compiled yet', file: 'paper/main.tex' },
        { check: 'structure', severity: 'error', message: 'No LaTeX manuscript yet' },
        { check: 'review', severity: 'warning', message: 'No review yet' },
        ...Array.from({ length: 4 }, (_, index) => ({ check: 'numbers' as const, severity: 'error' as const, message: `untraced ${index}` })),
      ],
    }
    const { rail, log } = mount([routed])
    expect(rail.getByText('规划')).toBeTruthy()
    expect(rail.getByText('引用')).toBeTruthy()
    // A phase the installed pack no longer has shows its id.
    expect(rail.getByText('renamed-upstream')).toBeTruthy()
    expect(rail.getByText('No bibliography entries yet')).toBeTruthy()
    expect(rail.queryByText('hidden third')).toBeNull()
    expect(rail.getByText(zh.findings)).toBeTruthy()
    expect(rail.getByText(/7 个错误 · 1 个提醒/)).toBeTruthy()
    expect(rail.getByText('No LaTeX manuscript yet')).toBeTruthy()
    // Five errors are listed; the rest are only counted.
    expect(rail.queryByText('untraced 3')).toBeNull()
    fireEvent.click(rail.getByRole('button', { name: 'paper/main.tex:12' }))
    fireEvent.click(rail.getByRole('button', { name: 'paper/main.tex' }))
    await settle()
    expect(log.opened).toEqual([[ROOT, 'paper/main.tex'], [ROOT, 'paper/main.tex']])
  })

  it('says why a finding\'s file could not be opened', async () => {
    const routed = project('spark-to-paper', 'proposal')
    routed.lastCheck = {
      clean: false, scope: 'all', mode: 'spark-to-paper', route: 'proposal', checkedAt: '', phases: [],
      findings: [{ check: 'compile', severity: 'error', message: 'The paper has not been compiled yet', file: 'paper/main.tex' }],
    }
    const { rail } = mount([routed], { openFile: () => { throw new Error('no sidebar') } })
    expect(rail.queryByRole('alert')).toBeNull()
    fireEvent.click(rail.getByRole('button', { name: 'paper/main.tex' }))
    await settle()
    expect(rail.getByRole('alert').textContent).toBe(t('actionFailed', { reason: 'no sidebar' }))
  })

  it('asks for a check when the last one was for another route or mode, and shows no phases in the general mode', () => {
    const switched = project('spark-to-paper', 'data')
    switched.lastCheck = { clean: true, scope: 'all', mode: 'spark-to-paper', route: 'proposal', checkedAt: '', phases: [{ id: 'plan', done: true, missing: [] }], findings: [] }
    const first = mount([switched])
    expect(first.rail.getByText(zh.checkNever)).toBeTruthy()
    expect(first.rail.getByText(zh.checkClean)).toBeTruthy()
    cleanup()
    switched.lastCheck = { ...switched.lastCheck, route: 'data', mode: 'general' }
    expect(mount([switched]).rail.getByText(zh.checkNever)).toBeTruthy()
    cleanup()
    switched.lastCheck = { ...switched.lastCheck, mode: 'spark-to-paper', phases: [] }
    expect(mount([switched]).rail.getByText(zh.checkNever)).toBeTruthy()
    cleanup()
    const unchecked = mount([project('spark-to-paper')])
    expect(unchecked.rail.getByText(zh.checkNever)).toBeTruthy()
    expect(unchecked.rail.queryByText(zh.findings)).toBeNull()
    cleanup()
    const general = project()
    general.lastCheck = { clean: true, scope: 'all', mode: 'general', checkedAt: '', phases: [], findings: [] }
    const second = mount([general])
    expect(second.rail.queryByText(zh.checkNever)).toBeNull()
    expect(second.rail.getByText(zh.checkClean)).toBeTruthy()
  })

  it('lists the newest decisions with who made them and why', () => {
    const routed = project('spark-to-paper')
    const { rail } = mount([routed])
    expect(rail.getByText(zh.noDecisions)).toBeTruthy()
    cleanup()
    for (let index = 0; index < 6; index++) {
      routed.decisions.push({ id: `d${index}`, question: `Q${index}`, answer: `A${index}`, by: index % 2 === 0 ? 'user' : 'agent', rationale: index === 5 ? 'because data' : '', at: '' })
    }
    const next = mount([routed]).rail
    expect(next.queryByText(zh.noDecisions)).toBeNull()
    expect(next.queryByText('A0')).toBeNull()
    expect(next.getByText(`${zh.decisionByAgent} · Q5`)).toBeTruthy()
    expect(next.getByText(`${zh.decisionByUser} · Q4`)).toBeTruthy()
    expect(next.getByText('because data')).toBeTruthy()
  })

  it('marks an example, credits its answers to the example\'s author, and changes nothing', () => {
    const shipped = project('spark-to-paper')
    shipped.example = true
    shipped.decisions.push(
      { id: 'd0', question: 'Q0', answer: 'A0', by: 'user', rationale: '', at: '' },
      { id: 'd1', question: 'Q1', answer: 'A1', by: 'agent', rationale: '', at: '' },
    )
    const { rail } = mount([shipped])
    expect(rail.getByText(zh.exampleBanner)).toBeTruthy()
    expect(rail.getByText(`${zh.exampleAuthor} · Q0`)).toBeTruthy()
    expect(rail.getByText(`${zh.decisionByAgent} · Q1`)).toBeTruthy()
    expect(rail.queryByText(`${zh.decisionByUser} · Q0`)).toBeNull()
    expect((rail.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true)
    cleanup()
    // The person's own research carries no banner.
    expect(mount([project('spark-to-paper')]).rail.queryByText(zh.exampleBanner)).toBeNull()
  })

  it('counts sources, claims, files and runs, each opening its place in the workbench', () => {
    const routed = project('spark-to-paper')
    routed.evidence.push({ id: 'e' as EvidenceId, title: 't', kind: 'file', path: 'p', sha256: 's', revision: 1, importedAt: '', chunks: [], coverage: 'data', verified: true, stale: true })
    routed.experiments.push(run('done', 'completed'), run('waiting', 'queued'))
    const { rail, log } = mount([routed])
    expect(rail.getByText('1 待更新')).toBeTruthy()
    expect(rail.getByTitle(zh.railExperimentsLabel).textContent).toBe(`${zh.railExperimentsLabel}${zh.runRunning}2`)
    for (const label of [zh.railSourcesLabel, zh.claims, zh.artifacts, zh.railExperimentsLabel]) fireEvent.click(rail.getByTitle(label))
    expect(log.expanded).toEqual([[routed.id, 'sources'], [routed.id, 'claims'], [routed.id, 'artifacts'], [routed.id, 'experiments']])
    cleanup()
    // Nothing stale and nothing moving: the rows carry no tags.
    const quiet = project('spark-to-paper')
    quiet.experiments.push(run('done', 'completed'))
    const calm = mount([quiet]).rail
    expect(calm.getByTitle(zh.railSourcesLabel).textContent).toBe(`${zh.railSourcesLabel}0`)
    expect(calm.getByTitle(zh.railExperimentsLabel).textContent).toBe(`${zh.railExperimentsLabel}1`)
  })

  it('shows the runs row only on a route with an experiments phase, or once a run exists', () => {
    // A route that plans experiments says none has started yet.
    expect(mount([project('spark-to-paper', 'proposal')]).rail.getByTitle(zh.railExperimentsLabel).textContent).toBe(`${zh.railExperimentsLabel}${zh.railNotStarted}`)
    cleanup()
    expect(mount([project('spark-to-paper', 'data')]).rail.queryByTitle(zh.railExperimentsLabel)).toBeNull()
    cleanup()
    expect(mount([project()]).rail.queryByTitle(zh.railExperimentsLabel)).toBeNull()
    cleanup()
    // A run the assistant registered anyway is part of the record.
    const general = project()
    general.experiments.push(run('probe', 'failed'))
    expect(mount([general]).rail.getByTitle(zh.railExperimentsLabel).textContent).toBe(`${zh.railExperimentsLabel}1`)
  })

  it('opens the experiment board, the figure gallery and the research files from its tools row', async () => {
    const general = project()
    const { rail, log } = mount([general])
    fireEvent.click(rail.getByRole('button', { name: zh.boardTitle }))
    fireEvent.click(rail.getByRole('button', { name: zh.gallery }))
    fireEvent.click(rail.getByRole('button', { name: zh.researchFiles }))
    await settle()
    expect(log.expanded).toEqual([[general.id, 'experiments'], [general.id, 'gallery']])
    expect(log.files).toBe(1)
    expect(rail.queryByRole('alert')).toBeNull()
  })

  it('says why the research files could not be shown', async () => {
    const { rail } = mount([project()], { openFiles: () => { throw new Error('no sidebar') } })
    fireEvent.click(rail.getByRole('button', { name: zh.researchFiles }))
    await settle()
    expect(rail.getByRole('alert').textContent).toBe(t('actionFailed', { reason: 'no sidebar' }))
  })
})
