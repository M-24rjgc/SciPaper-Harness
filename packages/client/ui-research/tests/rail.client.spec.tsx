// @vitest-environment jsdom

/**
 * The research rail. It says how the project is run and where it stands by its
 * last check, and every command it emits is handed back to the validator the
 * service parses commands with. It never starts work by itself: the only two
 * actions are a check and handing the pipeline to the assistant as a goal.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type { EnvironmentId, EvidenceId, ResearchCommand, ResearchMode, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchRail, ResearchRailTitle } from '../src/client/Rail.tsx'
import type { SessionSeatProps, WorkbenchProps } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const SESSION = 'session-rail'
const ROOT = 'C:\\research\\sparse'

interface Log {
  commands: ResearchCommand[]
  lines: [string, string][]
  opened: [string, string][]
  expanded: [string, string | undefined][]
}

function project(mode?: ResearchMode): ResearchProject {
  const record = newProject({ root: ROOT, title: 'Sparse attention scaling study', brief: '', ...(mode ? { mode } : {}) }, 'workspace' as WorkspaceId)
  record.sessionId = SESSION
  return record
}

function mount(projects: ResearchProject[], options: { fail?: boolean } = {}): { rail: ReturnType<typeof render>; log: Log } {
  const log: Log = { commands: [], lines: [], opened: [], expanded: [] }
  const view = { snapshot: { projects, preferences: {}, components: [] }, tasks: [], busy: false, error: '', response: null }
  const props = {
    sessionId: SESSION,
    t: (key: string, params?: Record<string, unknown>) => {
      const template = (zh as Record<string, string>)[key] ?? key
      return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
    },
    useResearch: (select: (value: typeof view) => unknown) => select(view),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select({}),
    run: (command: ResearchCommand) => {
      log.commands.push(command)
      return options.fail ? Promise.reject(new Error('refused')) : Promise.resolve({ message: '' })
    },
    command: (sessionId: string, line: string) => { log.lines.push([sessionId, line]); return Promise.resolve() },
    openFile: (root: string, path: string) => { log.opened.push([root, path]) },
    expand: (projectId: string, panel?: string) => { log.expanded.push([projectId, panel]) },
  } as unknown as WorkbenchProps & SessionSeatProps
  return { rail: render(<ResearchRail {...props} />), log }
}

const settle = (): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

describe('the research rail', () => {
  it('names itself, and says so when the folder is not a research project yet', () => {
    const t = (key: string) => (zh as Record<string, string>)[key] ?? key
    expect(render(<ResearchRailTitle t={t as WorkbenchProps['t']} />).container.textContent).toBe(zh.railTitle)
    cleanup()
    const stranger = project('free')
    stranger.sessionId = 'elsewhere'
    expect(mount([stranger]).rail.getByText(zh.railNoProject)).toBeTruthy()
  })

  it('routes the project and changes its autonomy together with the conversation\'s access preset', async () => {
    const unrouted = project()
    const { rail, log } = mount([unrouted])
    const [mode, autonomy] = rail.getAllByRole('combobox') as HTMLSelectElement[]
    expect(mode!.value).toBe('')
    expect(rail.getByText(zh.modeAuto)).toBeTruthy()
    // No pipeline button until the project has a pipeline mode.
    expect(rail.queryByRole('button', { name: zh.pipelineRun })).toBeNull()
    expect(rail.getByText(zh.checkNever)).toBeTruthy()

    fireEvent.change(mode!, { target: { value: 'paper-first' } })
    fireEvent.change(autonomy!, { target: { value: 'automatic' } })
    await settle()
    fireEvent.change(autonomy!, { target: { value: 'checkpoints' } })
    await settle()
    expect(log.commands).toEqual([
      { action: 'set-mode', projectId: unrouted.id, mode: 'paper-first' },
      { action: 'set-autonomy', projectId: unrouted.id, autonomy: 'automatic' },
      { action: 'set-autonomy', projectId: unrouted.id, autonomy: 'checkpoints' },
    ])
    for (const command of log.commands) expect(commandSchema.parse(command)).toEqual(command)
    expect(log.lines).toEqual([[SESSION, '/permission research-auto'], [SESSION, '/permission workspace-write']])
  })

  it('does not switch the access preset when the autonomy change was refused', async () => {
    const { rail, log } = mount([project('free')], { fail: true })
    fireEvent.change(rail.getAllByRole('combobox')[1]!, { target: { value: 'automatic' } })
    fireEvent.click(rail.getByRole('button', { name: zh.checkRun }))
    await settle()
    expect(log.commands.map(command => command.action)).toEqual(['set-autonomy', 'check'])
    expect(log.lines).toEqual([])
  })

  it('runs a check, and hands a pipeline mode to the assistant as a goal', () => {
    const routed = project('from-results')
    const { rail, log } = mount([routed])
    fireEvent.click(rail.getByRole('button', { name: zh.checkRun }))
    fireEvent.click(rail.getByRole('button', { name: zh.pipelineRun }))
    expect(log.commands).toEqual([{ action: 'check', projectId: routed.id }])
    expect(log.lines).toHaveLength(1)
    expect(log.lines[0]![0]).toBe(SESSION)
    expect(log.lines[0]![1]).toMatch(/^\/goal /)
    expect(log.lines[0]![1]).toContain(routed.title)
    expect(log.lines[0]![1]).toContain(zh.modeShortFromResults)
  })

  it('shows the phases of the last check, what still blocks each, and the errors with the files they name', () => {
    const routed = project('paper-first')
    routed.lastCheck = {
      clean: false, scope: 'all', mode: 'paper-first', checkedAt: '',
      phases: [
        { id: 'idea', done: true, missing: [] },
        { id: 'literature', done: false, missing: ['2 error(s) in cite', 'No bibliography entries yet', 'hidden third'] },
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
    expect(rail.getByText(zh.phase_idea)).toBeTruthy()
    expect(rail.getByText(zh.phase_literature)).toBeTruthy()
    expect(rail.getByText('No bibliography entries yet')).toBeTruthy()
    expect(rail.queryByText('hidden third')).toBeNull()
    expect(rail.getByText(zh.findings)).toBeTruthy()
    expect(rail.getByText(/7 个错误 · 1 个提醒/)).toBeTruthy()
    // Five errors are listed; the rest are only counted.
    expect(rail.queryByText('untraced 3')).toBeNull()
    fireEvent.click(rail.getByRole('button', { name: 'paper/main.tex:12' }))
    fireEvent.click(rail.getByRole('button', { name: 'paper/main.tex' }))
    expect(log.opened).toEqual([[ROOT, 'paper/main.tex'], [ROOT, 'paper/main.tex']])
  })

  it('asks for a check when the last one was for another mode, and shows no phases in free mode', () => {
    const switched = project('from-results')
    switched.lastCheck = { clean: true, scope: 'all', mode: 'paper-first', checkedAt: '', phases: [{ id: 'idea', done: true, missing: [] }], findings: [] }
    const first = mount([switched])
    expect(first.rail.getByText(zh.checkNever)).toBeTruthy()
    expect(first.rail.getByText(zh.checkClean)).toBeTruthy()
    cleanup()
    const free = project('free')
    free.lastCheck = { clean: true, scope: 'all', mode: 'free', checkedAt: '', phases: [], findings: [] }
    const second = mount([free])
    expect(second.rail.queryByText(zh.checkNever)).toBeNull()
    expect(second.rail.queryByRole('button', { name: zh.pipelineRun })).toBeNull()
  })

  it('lists the newest decisions with who made them and why', () => {
    const routed = project('paper-first')
    const { rail } = mount([routed])
    expect(rail.getByText(zh.noDecisions)).toBeTruthy()
    cleanup()
    for (let index = 0; index < 6; index++) {
      routed.decisions.push({ id: `d${index}`, question: `Q${index}`, answer: `A${index}`, by: index % 2 === 0 ? 'user' : 'agent', rationale: index === 5 ? 'because data' : '', at: '' })
    }
    const next = mount([routed]).rail
    expect(next.queryByText('A0')).toBeNull()
    expect(next.getByText(`${zh.decisionByAgent} · Q5`)).toBeTruthy()
    expect(next.getByText(`${zh.decisionByUser} · Q4`)).toBeTruthy()
    expect(next.getByText('because data')).toBeTruthy()
  })

  it('counts sources, claims, files and runs, each opening its place in the workbench', () => {
    const routed = project('paper-first')
    routed.evidence.push({ id: 'e' as EvidenceId, title: 't', kind: 'file', path: 'p', sha256: 's', revision: 1, importedAt: '', chunks: [], coverage: 'data', verified: true, stale: true })
    routed.experiments.push({ id: 'r' as never, spec: {} as never, status: 'running', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: {}, message: '', snapshotPath: '', collected: false })
    routed.environments.push({ id: 'env' as EnvironmentId, name: 'gpu', kind: 'uv', target: 'ssh', python: '/opt/py', requirements: [], fingerprint: 'f', status: 'ready', details: '', isDefault: false })
    const { rail, log } = mount([routed])
    expect(rail.getByText('1 待更新')).toBeTruthy()
    expect(rail.getByText(zh.runRunning)).toBeTruthy()
    expect(rail.getByText(`gpu · ${zh.ssh} · /opt/py`)).toBeTruthy()
    for (const label of [zh.railSourcesLabel, zh.claims, zh.artifacts, zh.railExperimentsLabel]) fireEvent.click(rail.getByTitle(label))
    expect(log.expanded).toEqual([[routed.id, 'sources'], [routed.id, 'claims'], [routed.id, 'artifacts'], [routed.id, 'experiments']])
    cleanup()
    const bare = project('free')
    expect(mount([bare]).rail.getByText(zh.railNotStarted)).toBeTruthy()
  })
})
