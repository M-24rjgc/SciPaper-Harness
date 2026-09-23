import { beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { projectBrief, registerResearchTools } from '../src/tools.ts'
import { newProject } from '../src/project.ts'
import { ModeRegistry, type ModePack } from '../src/modes.ts'
import type { ResearchWorkbench } from '../src/index.ts'
import type { ProjectId, ResearchCommand, ResearchProject, ResearchTask } from '../src/types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

let modes: ModeRegistry
beforeAll(async () => { modes = await ModeRegistry.load([join(import.meta.dirname, '../runtime/modes')], { warn: (...args: unknown[]) => { throw new Error(args.join(' ')) } }) })

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
  const project = newProject({ root, title: 'Study', brief: 'b', mode: 'spark-to-paper', route: 'proposal' }, 'w' as WorkspaceId)
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
    modes,
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
    type Brief = { id: string; guide: string[]; mode: string; route: string; phases: unknown[] }
    const brief = await h.call('research_project', { action: 'current' }, `${root}/paper`) as Brief
    expect(brief.id).toBe(h.project.id)
    expect(brief).toMatchObject({ mode: 'spark-to-paper', route: 'proposal' })
    expect(brief.guide[0]).toMatch(/^Mode spark-to-paper \(route proposal\): plan → cite → .* → submission\./)
    expect(brief.guide[0]).toMatch(/ Checkpoint before: experiments\.$/)
    expect(brief.guide[2]).toBe('Load the ts-paper skill before working in this mode.')
    expect(brief.guide[3]).toMatch(/ask_user_question/)
    expect(brief.phases[0]).toEqual({ id: 'plan', done: false, missing: ['Not checked yet'] })
    await expect(h.call('research_project', { action: 'current' }, process.platform === 'win32' ? 'C:\\elsewhere' : '/elsewhere')).rejects.toThrow(/No research project contains/)
    await expect(h.call('research_project', { action: 'current' }, null)).rejects.toThrow(/working directory/)
    await expect(h.call('research_project', { action: 'current', projectId: h.foreign.id })).rejects.toThrow(/does not belong/)
    expect(await h.call('research_project', { action: 'current', projectId: h.project.id })).toMatchObject({ id: h.project.id })
    expect(await h.call('research_project', { action: 'list' })).toEqual([
      { id: h.project.id, title: 'Study', root, mode: 'spark-to-paper', route: 'proposal' },
      { id: h.foreign.id, title: 'Other', root: other, mode: 'general', route: null },
    ])
  })

  it('lists the installed modes with their routes and the phases on each route', async () => {
    const h = harness()
    const catalog = await h.call('research_project', { action: 'modes' }) as { id: string; defaultRoute: string | null; phases: { route: string | null; phases: string[] }[] }[]
    expect(catalog.map(mode => mode.id)).toEqual(['general', 'spark-to-paper', 'ccfa'])
    expect(catalog[0]).toMatchObject({ defaultRoute: null, routes: [], phases: [{ route: null, phases: [] }] })
    expect(catalog[1]?.defaultRoute).toBe('proposal')
    expect(catalog[1]?.phases.map(item => [item.route, item.phases[0]])).toEqual([['idea', 'story'], ['proposal', 'plan'], ['data', 'data']])
  })

  it('creates a project in the working directory, binding the calling session', async () => {
    const h = harness()
    const created = await h.call('research_project', { action: 'create', title: 'New', mode: 'spark-to-paper', route: 'idea', autonomy: 'automatic' }, `${root}/new`)
    expect(created).toMatchObject({ mode: 'spark-to-paper', route: 'idea' })
    await h.call('research_project', { action: 'create', title: 'Elsewhere', root: other, brief: 'x' }, `${root}/new`)
    expect(h.created).toEqual([
      { request: { title: 'New', root: `${root}/new`, brief: '', mode: 'spark-to-paper', route: 'idea', autonomy: 'automatic' }, sessionId: 'agent-session' },
      { request: { title: 'Elsewhere', root: other, brief: 'x' }, sessionId: undefined },
    ])
    await expect(h.call('research_project', { action: 'create' }, null)).rejects.toThrow(/needs a title/)
  })

  it('turns routing, autonomy and decisions into ledger commands', async () => {
    const h = harness()
    await h.call('research_project', { action: 'set-mode', mode: 'spark-to-paper', route: 'data', reason: 'data exists' })
    await h.call('research_project', { action: 'set-autonomy', autonomy: 'automatic' })
    const result = await h.call('research_project', { action: 'record-decision', question: 'Q?', answer: 'A' })
    expect(result).toEqual({ message: 'did record-decision' })
    await h.call('research_project', { action: 'record-decision', question: 'Go?', answer: 'Yes', decidedBy: 'user' })
    expect(h.executed.map(item => [item.request, item.actor])).toEqual([
      [{ action: 'set-mode', projectId: h.project.id, mode: 'spark-to-paper', route: 'data', reason: 'data exists' }, 'agent'],
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
      research_media: { action: 'visual-review' }, research_knowledge: { action: 'graph-status' },
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
  it('describes a general automatic project and the next unfinished phase of a pack mode', () => {
    const project: ResearchProject = newProject({ root, title: 'T', brief: '', autonomy: 'automatic' }, 'w' as WorkspaceId)
    const brief = (): ReturnType<typeof projectBrief> => projectBrief(project, modes.resolve(project))
    const general = brief() as { guide: string[]; mode: string; route: null; phases: unknown[]; lastCompile: null }
    expect(general).toMatchObject({ mode: 'general', route: null, phases: [], lastCompile: null })
    expect(general.guide[0]).toMatch(/^Mode general: no pipeline\. .*suggest a mode \(research_project modes\)/)
    expect(general.guide[1]).toMatch(/Autonomy automatic/)
    project.mode = 'gone'
    expect((brief() as { guide: string[] }).guide[0]).toMatch(/"gone" is not installed/)
    project.mode = 'spark-to-paper'
    project.route = 'data'
    project.lastCheck = { clean: false, scope: 'all', mode: 'spark-to-paper', route: 'data', phases: [{ id: 'data', done: true, missing: [] }, { id: 'plan', done: false, missing: ['x'] }], findings: [], checkedAt: '' }
    project.compilations.push({ artifactId: 'a' as never, artifactRevision: 1, inputDigest: 'd', engine: 'pdflatex', status: 'completed', pdfPath: 'x.pdf', logPath: 'l', diagnostics: [], createdAt: '' })
    project.decisions.push({ id: 'd', question: 'Q', answer: 'A', by: 'user', rationale: '', at: '' })
    project.artifacts.push({ id: 'a' as never, path: 'paper/main.tex', kind: 'manuscript', revision: 2, sha256: 's', evidence: [], claimIds: [], inputArtifacts: [], stale: false, updatedAt: '', author: 'agent' })
    project.evidence.push({ id: 'e' as never, title: 'data', kind: 'file', path: 'p', sha256: 's', revision: 1, importedAt: '', chunks: [{ text: 'secret body', locator: {} }], coverage: 'data', verified: true, stale: false })
    project.environments.push({ id: 'env' as never, name: 'env', kind: 'uv', target: 'local', python: 'py', requirements: [], fingerprint: 'f', status: 'ready', details: 'long details', isDefault: true })
    project.experiments.push({ id: 'r' as never, spec: { name: 'train' } as never, status: 'running', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: {}, message: 'm', snapshotPath: '', collected: false })
    const routed = brief() as {
      guide: string[]
      phases: unknown[]
      phaseSkills: Record<string, string[]>
      lastCompile: unknown
      decisions: unknown[]
      artifacts: unknown[]
      evidence: unknown[]
      environments: unknown[]
      experiments: unknown[]
    }
    expect(routed.guide[0]).toMatch(/Next unfinished phase: plan\.$/)
    expect(routed.phases).toHaveLength(2)
    expect(routed.phaseSkills.data).toEqual(['ts-paper-data', 'results-ingest'])
    expect(routed.lastCompile).toEqual({ status: 'completed', pdfPath: 'x.pdf' })
    expect(routed.decisions).toEqual([{ question: 'Q', answer: 'A', by: 'user', rationale: '' }])
    expect(routed.artifacts).toEqual([{ id: 'a', path: 'paper/main.tex', kind: 'manuscript', revision: 2, stale: false }])
    expect(JSON.stringify(routed.evidence)).not.toContain('secret body')
    expect(JSON.stringify(routed.environments)).not.toContain('long details')
    expect(routed.experiments).toEqual([{ id: 'r', status: 'running', message: 'm', metrics: {}, name: 'train' }])
    project.lastCheck = { ...project.lastCheck, phases: [{ id: 'data', done: true, missing: [] }] }
    expect((brief() as { guide: string[] }).guide[0]).not.toMatch(/Next/)
    // A check made on another route no longer describes this one.
    project.route = 'idea'
    const rerouted = brief() as { guide: string[]; phases: { missing: string[] }[] }
    expect(rerouted.guide[0]).not.toMatch(/Next/)
    expect(rerouted.phases[0]?.missing).toEqual(['Not checked yet'])
  })

  it('names the skills a pack loads first, and a pack route without phases', () => {
    const pack = (id: string, extra: Partial<ModePack>): ModePack => ({
      id, order: 5, name: { en: id, zh: id }, summary: { en: 's', zh: 's' }, preload: [], routes: [], phases: [], gates: [], scripts: [],
      directory: '', skills: [], ...extra,
    })
    const general = pack('general', {})
    const registry = new ModeRegistry([general, pack('family', { preload: ['first', 'second'], entry: 'lead' }), pack('solo', { entry: 'lead' })])
    const project: ResearchProject = newProject({ root, title: 'T', brief: '' }, 'w' as WorkspaceId)
    project.mode = 'family'
    const family = projectBrief(project, registry.resolve(project)) as { guide: string[] }
    expect(family.guide.slice(0, 2)).toEqual(['Mode family: no pipeline on this route; work as the mode\'s skills direct and run the relevant checks.', 'Load the first, then second, then lead skills before working in this mode.'])
    project.mode = 'solo'
    expect((projectBrief(project, registry.resolve(project)) as { guide: string[] }).guide[1]).toBe('Load the lead skill before working in this mode.')
    expect(() => new ModeRegistry([pack('solo', {})])).toThrow(/general mode pack is missing/)
    const flat = new ModeRegistry([general, pack('flat', { phases: [{ id: 'p', label: { en: 'P', zh: 'P' }, skills: [], checkpoint: false, checks: [], requires: [] }] })])
    project.mode = 'flat'
    expect((projectBrief(project, flat.resolve(project)) as { guide: string[] }).guide[0]).toBe('Mode flat: p.')
  })
})
