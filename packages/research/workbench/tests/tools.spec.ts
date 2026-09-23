import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { projectBrief, registerResearchTools } from '../src/tools.ts'
import { newProject } from '../src/project.ts'
import type { ResearchWorkbench } from '../src/index.ts'
import type { ProjectId, ResearchCommand, ResearchProject, ResearchTask } from '../src/types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

interface RegisteredTool {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
  presentCall(args: unknown): { title: string } | undefined
  output: { render(args: unknown, value: unknown): { type: string; text: string }[] }
}
type PreExecute = (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>

const root = process.platform === 'win32' ? 'C:\\research\\study' : '/research/study'
const other = process.platform === 'win32' ? 'C:\\research\\other' : '/research/other'

function harness() {
  const project = newProject({ root, title: 'Study', brief: 'b', mode: 'paper-first' }, 'w' as WorkspaceId)
  const foreign = newProject({ root: other, title: 'Other', brief: '' }, 'w' as WorkspaceId)
  const executed: { request: ResearchCommand; actor: string }[] = []
  const created: unknown[] = []
  const tasks: ResearchTask[] = [
    { id: 'job', kind: 'compile', projectId: project.id, status: 'completed', message: 'ok', createdAt: '', result: { message: 'done', project } },
    { id: 'bare', kind: 'compile', projectId: project.id, status: 'running', message: 'r', createdAt: '' },
    { id: 'global', kind: 'install', status: 'completed', message: 'ok', createdAt: '' },
  ]
  const service = {
    projects: () => [project, foreign],
    getProject: (id: ProjectId) => { const found = [project, foreign].find(item => item.id === id); if (!found) throw new Error('Research project not found'); return found },
    projectAt: async (cwd: string) => cwd.startsWith(root) ? project : cwd.startsWith(other) ? foreign : undefined,
    execute: async (request: ResearchCommand, _signal: AbortSignal, actor: string) => { executed.push({ request, actor }); return { message: `did ${request.action}`, project } },
    createProject: async (request: { root: string }, sessionId?: string) => { created.push({ request, sessionId }); return newProject({ ...request, title: 't', brief: '' }, 'w' as WorkspaceId) },
    tasks: () => tasks,
  } as unknown as ResearchWorkbench
  const tools = new Map<string, RegisteredTool>()
  let hook: PreExecute | undefined
  const ctx = {
    tools: { register: (tool: RegisteredTool) => { tools.set(tool.name, tool) } },
    on: (name: string, listener: PreExecute) => { if (name === 'tools/pre-execute') hook = listener },
  } as unknown as Context
  registerResearchTools(ctx, service)
  const exec = (cwd: string | undefined, name = 'research_project') => ({
    name, signal: new AbortController().signal,
    ...(cwd === undefined ? {} : { agent: { session: { id: 'agent-session', header: { cwd } } } }),
  })
  /** `null` runs the call without an agent session, as a non-agent caller would. */
  const call = (name: string, args: Record<string, unknown>, cwd: string | null = root) =>
    tools.get(name)!.execute(args, exec(cwd ?? undefined, name))
  return { project, foreign, executed, created, tools, call, exec, hook: () => hook! }
}

describe('research tools find the project from the working directory', () => {
  it('reports the current project with its route, autonomy guidance and phases', async () => {
    const h = harness()
    const brief = await h.call('research_project', { action: 'current' }, `${root}/paper`) as { id: string; guide: string[]; mode: string }
    expect(brief.id).toBe(h.project.id)
    expect(brief.mode).toBe('paper-first')
    expect(brief.guide[0]).toMatch(/idea → literature/)
    expect(brief.guide[1]).toMatch(/ask_user_question/)
    await expect(h.call('research_project', { action: 'current' }, process.platform === 'win32' ? 'C:\\elsewhere' : '/elsewhere')).rejects.toThrow(/No research project contains/)
    await expect(h.call('research_project', { action: 'current' }, null)).rejects.toThrow(/working directory/)
    await expect(h.call('research_project', { action: 'current', projectId: h.foreign.id })).rejects.toThrow(/does not belong/)
    expect(await h.call('research_project', { action: 'current', projectId: h.project.id })).toMatchObject({ id: h.project.id })
    expect(await h.call('research_project', { action: 'list' })).toEqual([
      { id: h.project.id, title: 'Study', root, mode: 'paper-first' },
      { id: h.foreign.id, title: 'Other', root: other, mode: null },
    ])
  })

  it('creates a project in the working directory, binding the calling session', async () => {
    const h = harness()
    await h.call('research_project', { action: 'create', title: 'New', mode: 'free', autonomy: 'automatic' }, `${root}/new`)
    await h.call('research_project', { action: 'create', title: 'Elsewhere', root: other, brief: 'x' }, `${root}/new`)
    expect(h.created).toEqual([
      { request: { title: 'New', root: `${root}/new`, brief: '', mode: 'free', autonomy: 'automatic' }, sessionId: 'agent-session' },
      { request: { title: 'Elsewhere', root: other, brief: 'x' }, sessionId: undefined },
    ])
    await expect(h.call('research_project', { action: 'create' }, null)).rejects.toThrow(/needs a title/)
  })

  it('turns routing, autonomy and decisions into ledger commands', async () => {
    const h = harness()
    await h.call('research_project', { action: 'set-mode', mode: 'from-results', reason: 'data exists' })
    await h.call('research_project', { action: 'set-autonomy', autonomy: 'automatic' })
    const result = await h.call('research_project', { action: 'record-decision', question: 'Q?', answer: 'A' })
    expect(result).toEqual({ message: 'did record-decision' })
    await h.call('research_project', { action: 'record-decision', question: 'Go?', answer: 'Yes', decidedBy: 'user' })
    expect(h.executed.map(item => [item.request, item.actor])).toEqual([
      [{ action: 'set-mode', projectId: h.project.id, mode: 'from-results', reason: 'data exists' }, 'agent'],
      [{ action: 'set-autonomy', projectId: h.project.id, autonomy: 'automatic' }, 'agent'],
      [{ action: 'record-decision', projectId: h.project.id, question: 'Q?', answer: 'A' }, 'agent'],
      [{ action: 'record-decision', projectId: h.project.id, question: 'Go?', answer: 'Yes', decidedBy: 'user' }, 'agent'],
    ])
  })

  it('runs checks and family actions with typed fields and compact results', async () => {
    const h = harness()
    expect(await h.call('research_check', { scope: 'draft' })).toEqual({ message: 'did check' })
    expect(await h.call('research_artifact', { action: 'compile', engine: 'xelatex' })).toEqual({ message: 'did compile' })
    await h.call('research_experiment', { action: 'experiment-wait', runIds: ['r'], timeoutSeconds: 30 })
    await expect(h.call('research_evidence', { action: 'import' })).rejects.toThrow()
    await expect(h.call('research_media', { action: 'complete-visual-review', artifactId: 'a', artifactRevision: 1, sessionId: 'other-session', findings: 'f' }))
      .rejects.toThrow(/assigned visual-review session/)
    await h.call('research_media', { action: 'complete-visual-review', artifactId: 'a', artifactRevision: 1, sessionId: 'agent-session', findings: 'f' })
    expect(h.executed.map(item => item.request.action)).toEqual(['check', 'compile', 'experiment-wait', 'complete-visual-review'])
    expect(h.executed[1]?.request).toEqual({ action: 'compile', projectId: h.project.id, engine: 'xelatex' })
    const valid: Record<string, unknown> = {
      research_project: { action: 'current' }, research_check: {}, research_task: { jobId: 'j' }, research_evidence: { action: 'import' },
      research_artifact: { action: 'export' }, research_environment: { action: 'environment' }, research_experiment: { action: 'experiment-logs' },
      research_media: { action: 'visual-review' },
    }
    for (const tool of h.tools.values()) expect(tool.presentCall(valid[tool.name])?.title).toBeTruthy()
    expect(h.tools.get('research_check')!.output.render({}, { clean: true })).toEqual([{ type: 'text', text: '{"clean":true}' }])
  })

  it('reads desktop tasks only for the calling project, without the project body', async () => {
    const h = harness()
    expect(await h.call('research_task', { jobId: 'job' })).toMatchObject({ id: 'job', result: { message: 'done' } })
    expect(JSON.stringify(await h.call('research_task', { jobId: 'job' }))).not.toContain('"project"')
    expect(await h.call('research_task', { jobId: 'bare' })).toMatchObject({ id: 'bare' })
    await expect(h.call('research_task', { jobId: 'global' })).rejects.toThrow(/not found/)
    await expect(h.call('research_task', { jobId: 'job' }, other)).rejects.toThrow(/does not belong/)
  })
})

describe('reaching outside the project asks the user through DSH approval', () => {
  const decide = async (h: ReturnType<typeof harness>, name: string, args: Record<string, unknown>, cwd: string | null = root) => {
    const exec = { ...h.exec(cwd ?? undefined, name), arguments: args } as unknown as ToolExecution
    return h.hook()(exec, async () => ({ kind: 'allow' }))
  }
  it('asks before importing files or templates from outside the project, and before binding a local interpreter', async () => {
    const h = harness()
    expect(await decide(h, 'research_evidence', { action: 'import', paths: ['data/a.csv', `${root}/b.csv`] })).toEqual({ kind: 'allow' })
    const outside = await decide(h, 'research_evidence', { action: 'import', paths: ['../secret.txt', 7] })
    expect(outside.kind).toBe('ask')
    expect((outside as { reason: string }).reason).toMatch(/into it: \.\.\/secret\.txt$/)
    expect(await decide(h, 'research_artifact', { action: 'import-template', paths: [other] })).toMatchObject({ kind: 'ask' })
    expect(await decide(h, 'research_artifact', { action: 'import-template' })).toEqual({ kind: 'allow' })
    expect(await decide(h, 'research_environment', { action: 'environment', environment: { kind: 'existing', target: 'local', python: 'C:/py.exe' } }))
      .toMatchObject({ kind: 'ask' })
    const interpreter = await decide(h, 'research_environment', { action: 'environment', environment: { kind: 'existing', target: 'local', python: 'C:/py.exe' } })
    expect((interpreter as { reason: string }).reason).toMatch(/C:\/py\.exe/)
    expect(await decide(h, 'research_environment', { action: 'environment', environment: { kind: 'uv', target: 'local', python: '' } })).toEqual({ kind: 'allow' })
    expect(await decide(h, 'research_environment', { action: 'environment', environment: { kind: 'existing', target: 'ssh', python: '/usr/bin/python' } })).toEqual({ kind: 'allow' })
    expect(await decide(h, 'research_environment', { action: 'environment' })).toEqual({ kind: 'allow' })
    expect(await decide(h, 'bash', { command: 'ls' })).toEqual({ kind: 'allow' })
    expect(await decide(h, 'research_evidence', { action: 'import', paths: ['../x'] }, null)).toEqual({ kind: 'allow' })
    const bare = { ...h.exec(root, 'research_evidence') } as unknown as ToolExecution
    expect(await h.hook()(bare, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
  })
})

describe('the project brief the model reads', () => {
  it('describes an unrouted automatic project and the next unfinished phase of a routed one', () => {
    const project: ResearchProject = newProject({ root, title: 'T', brief: '', autonomy: 'automatic' }, 'w' as WorkspaceId)
    const unrouted = projectBrief(project) as { guide: string[]; mode: null; lastCompile: null }
    expect(unrouted.mode).toBeNull()
    expect(unrouted.guide[0]).toMatch(/No mode yet/)
    expect(unrouted.guide[1]).toMatch(/Autonomy automatic/)
    expect(unrouted.lastCompile).toBeNull()
    project.mode = 'free'
    expect((projectBrief(project) as { guide: string[] }).guide[0]).toBe('Mode free: no pipeline.')
    project.mode = 'from-results'
    project.lastCheck = { clean: false, scope: 'all', phases: [{ id: 'ingest', done: true, missing: [] }, { id: 'plan', done: false, missing: ['x'] }], findings: [], checkedAt: '' }
    project.compilations.push({ artifactId: 'a' as never, artifactRevision: 1, inputDigest: 'd', engine: 'pdflatex', status: 'completed', pdfPath: 'x.pdf', logPath: 'l', diagnostics: [], createdAt: '' })
    project.decisions.push({ id: 'd', question: 'Q', answer: 'A', by: 'user', rationale: '', at: '' })
    project.artifacts.push({ id: 'a' as never, path: 'paper/main.tex', kind: 'manuscript', revision: 2, sha256: 's', evidence: [], claimIds: [], inputArtifacts: [], stale: false, updatedAt: '', author: 'agent' })
    project.evidence.push({ id: 'e' as never, title: 'data', kind: 'file', path: 'p', sha256: 's', revision: 1, importedAt: '', chunks: [{ text: 'secret body', locator: {} }], coverage: 'data', verified: true, stale: false })
    project.environments.push({ id: 'env' as never, name: 'env', kind: 'uv', target: 'local', python: 'py', requirements: [], fingerprint: 'f', status: 'ready', details: 'long details', isDefault: true })
    project.experiments.push({ id: 'r' as never, spec: { name: 'train' } as never, status: 'running', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: {}, message: 'm', snapshotPath: '', collected: false })
    const routed = projectBrief(project) as {
      guide: string[]
      lastCompile: unknown
      decisions: unknown[]
      artifacts: unknown[]
      evidence: unknown[]
      environments: unknown[]
      experiments: unknown[]
    }
    expect(routed.guide[0]).toMatch(/Next unfinished phase: plan/)
    expect(routed.lastCompile).toEqual({ status: 'completed', pdfPath: 'x.pdf' })
    expect(routed.decisions).toEqual([{ question: 'Q', answer: 'A', by: 'user', rationale: '' }])
    expect(routed.artifacts).toEqual([{ id: 'a', path: 'paper/main.tex', kind: 'manuscript', revision: 2, stale: false }])
    expect(JSON.stringify(routed.evidence)).not.toContain('secret body')
    expect(JSON.stringify(routed.environments)).not.toContain('long details')
    expect(routed.experiments).toEqual([{ id: 'r', status: 'running', message: 'm', metrics: {}, name: 'train' }])
    project.lastCheck = { ...project.lastCheck, phases: [{ id: 'ingest', done: true, missing: [] }] }
    expect((projectBrief(project) as { guide: string[] }).guide[0]).not.toMatch(/Next/)
  })
})
