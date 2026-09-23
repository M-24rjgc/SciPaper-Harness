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
import type { EnvironmentId, EvidenceId, ResearchCommand, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchRail, ResearchRailTitle } from '../src/client/Rail.tsx'
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
}

/** A project in the given mode and route; the general mode when none is named. */
function project(mode?: string, route?: string): ResearchProject {
  const record = newProject({ root: ROOT, title: 'Sparse attention scaling study', brief: '', ...(mode ? { mode } : {}), ...(route ? { route } : {}) }, 'workspace' as WorkspaceId)
  record.sessionId = SESSION
  return record
}

function mount(projects: ResearchProject[], options: { fail?: boolean } = {}): { rail: ReturnType<typeof render>; log: Log } {
  const log: Log = { commands: [], lines: [], opened: [], expanded: [] }
  const view = { snapshot: { projects, preferences: {}, components: [], modes: MODES }, tasks: [], busy: false, error: '', response: null }
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
    const stranger = project()
    stranger.sessionId = 'elsewhere'
    expect(mount([stranger]).rail.getByText(zh.railNoProject)).toBeTruthy()
  })

  it('switches the mode and route, and changes its autonomy together with the conversation\'s access preset', async () => {
    const general = project()
    const { rail, log } = mount([general])
    const [mode, autonomy] = rail.getAllByRole('combobox') as HTMLSelectElement[]
    expect(mode!.value).toBe('general')
    expect([...mode!.options].map(option => option.textContent)).toEqual(['通用', 'spark-to-paper · 从提案开始', 'spark-to-paper · 从实测结果开始'])
    expect([...mode!.options].map(option => option.title)).toEqual(['全部工具，不走流水线', '结果先留空', '数字追溯到数据'])
    // The general mode has no pipeline: no phases, no pipeline button.
    expect(rail.queryByRole('button', { name: zh.pipelineRun })).toBeNull()
    expect(rail.queryByText(zh.checkNever)).toBeNull()

    fireEvent.change(mode!, { target: { value: 'spark-to-paper/data' } })
    fireEvent.change(mode!, { target: { value: 'general' } })
    fireEvent.change(autonomy!, { target: { value: 'automatic' } })
    await settle()
    fireEvent.change(autonomy!, { target: { value: 'checkpoints' } })
    await settle()
    expect(log.commands).toEqual([
      { action: 'set-mode', projectId: general.id, mode: 'spark-to-paper', route: 'data' },
      { action: 'set-mode', projectId: general.id, mode: 'general' },
      { action: 'set-autonomy', projectId: general.id, autonomy: 'automatic' },
      { action: 'set-autonomy', projectId: general.id, autonomy: 'checkpoints' },
    ])
    for (const command of log.commands) expect(commandSchema.parse(command)).toEqual(command)
    expect(log.lines).toEqual([[SESSION, '/permission research-auto'], [SESSION, '/permission workspace-write']])
  })

  it('keeps showing a mode whose pack is no longer installed, until another is chosen', () => {
    const { rail } = mount([project('retired-pack')])
    const mode = rail.getAllByRole('combobox')[0] as HTMLSelectElement
    expect(mode.value).toBe('retired-pack')
    expect(mode.options[0]).toMatchObject({ textContent: 'retired-pack', disabled: true })
  })

  it('does not switch the access preset when the autonomy change was refused', async () => {
    const { rail, log } = mount([project()], { fail: true })
    fireEvent.change(rail.getAllByRole('combobox')[1]!, { target: { value: 'automatic' } })
    fireEvent.click(rail.getByRole('button', { name: zh.checkRun }))
    await settle()
    expect(log.commands.map(command => command.action)).toEqual(['set-autonomy', 'check'])
    expect(log.lines).toEqual([])
  })

  it('runs a check, and hands a pipeline mode to the assistant as a goal', () => {
    const routed = project('spark-to-paper', 'data')
    const { rail, log } = mount([routed])
    fireEvent.click(rail.getByRole('button', { name: zh.checkRun }))
    fireEvent.click(rail.getByRole('button', { name: zh.pipelineRun }))
    expect(log.commands).toEqual([{ action: 'check', projectId: routed.id }])
    expect(log.lines).toEqual([[SESSION, `/goal 按spark-to-paper模式逐阶段完成「${routed.title}」的论文，并加载该模式指定的技能；research_check 全部通过即完成。`]])
  })

  it('shows the phases of the last check, what still blocks each, and the errors with the files they name', () => {
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
    // Five errors are listed; the rest are only counted.
    expect(rail.queryByText('untraced 3')).toBeNull()
    fireEvent.click(rail.getByRole('button', { name: 'paper/main.tex:12' }))
    fireEvent.click(rail.getByRole('button', { name: 'paper/main.tex' }))
    expect(log.opened).toEqual([[ROOT, 'paper/main.tex'], [ROOT, 'paper/main.tex']])
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
    const general = project()
    general.lastCheck = { clean: true, scope: 'all', mode: 'general', checkedAt: '', phases: [], findings: [] }
    const second = mount([general])
    expect(second.rail.queryByText(zh.checkNever)).toBeNull()
    expect(second.rail.queryByRole('button', { name: zh.pipelineRun })).toBeNull()
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
    expect(next.queryByText('A0')).toBeNull()
    expect(next.getByText(`${zh.decisionByAgent} · Q5`)).toBeTruthy()
    expect(next.getByText(`${zh.decisionByUser} · Q4`)).toBeTruthy()
    expect(next.getByText('because data')).toBeTruthy()
  })

  it('counts sources, claims, files and runs, each opening its place in the workbench', () => {
    const routed = project('spark-to-paper')
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
    const bare = project()
    expect(mount([bare]).rail.getByText(zh.railNotStarted)).toBeTruthy()
  })
})
