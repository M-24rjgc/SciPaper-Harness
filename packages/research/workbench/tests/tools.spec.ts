import { beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { projectBrief, registerResearchTools } from '../src/tools.ts'
import { newProject } from '../src/project.ts'
import { ModeRegistry, type ModePack, type ResolvedMode } from '../src/modes.ts'
import { projectStanding } from '../src/progress.ts'
import type { ResearchWorkbench } from '../src/index.ts'
import type { ProjectId, ResearchCommand, ResearchGoal, ResearchProject, ResearchStanding, ResearchTask } from '../src/types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

let modes: ModeRegistry
beforeAll(async () => { modes = await ModeRegistry.load([join(import.meta.dirname, '../runtime/modes')], { warn: (...args: unknown[]) => { throw new Error(args.join(' ')) } }) })

/** Where a project stands, over files that never changed and all exist. */
const standingOf = (project: ResearchProject, mode: ResolvedMode = modes.resolve(project)): Promise<ResearchStanding> =>
  projectStanding(project, mode, { newest: async () => 0, exists: () => true })

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
  const executed: { request: ResearchCommand; actor: string; sessionId?: string | undefined }[] = []
  const created: unknown[] = []
  const goals: ResearchGoal[] = []
  const tasks: ResearchTask[] = [
    { id: 'job', kind: 'compile', projectId: project.id, status: 'completed', message: 'ok', createdAt: '', result: { message: 'done', project } },
    { id: 'bare', kind: 'compile', projectId: project.id, status: 'running', message: 'r', createdAt: '' },
    { id: 'global', kind: 'install', status: 'completed', message: 'ok', createdAt: '' },
  ]
  const service = {
    projects: () => [project, foreign],
    getProject: (id: ProjectId) => { const found = [project, foreign].find(item => item.id === id); if (!found) throw new Error('Research project not found'); return found },
    projectAt: async (cwd: string) => cwd.startsWith(root) ? project : cwd.startsWith(other) ? foreign : undefined,
    execute: async (request: ResearchCommand, _signal: AbortSignal, actor: string, sessionId?: string) => {
      executed.push({ request, actor, ...(sessionId === undefined ? {} : { sessionId }) })
      return { message: `did ${request.action}`, project }
    },
    createProject: async (request: { root: string }, sessionId?: string) => { created.push({ request, sessionId }); return newProject({ ...request, title: 't', brief: '' }, 'w' as WorkspaceId) },
    tasks: () => tasks,
    standing: (item: ResearchProject) => standingOf(item),
    activeGoals: () => goals,
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
  return { project, foreign, executed, created, goals, tools, call, exec, hook: () => hook! }
}

describe('research tools find the project from the working directory', () => {
  it('reports the current project with its route, autonomy guidance and phases', async () => {
    const h = harness()
    type Brief = { id: string; guide: string[]; mode: string; route: string; phases: unknown[] }
    const brief = await h.call('research_project', { action: 'current' }, `${root}/paper`) as Brief
    expect(brief.id).toBe(h.project.id)
    expect(brief).toMatchObject({ mode: 'spark-to-paper', route: 'proposal', paperRoot: '.', checkedAt: null, changedSinceCheck: false, finished: false })
    expect(brief.guide[0]).toMatch(/^Mode spark-to-paper \(route proposal\): plan → cite → .* → submission\. Next phase: plan\./)
    expect(brief.guide[0]).toMatch(/ Checkpoint before: experiments\.$/)
    // The user named the mode at creation, so the route is settled and the entry skill does not route again.
    expect(brief).toMatchObject({ modeChosen: true, modeSetBy: 'user', routingSettled: true, activeGoal: null })
    expect(brief).not.toHaveProperty('untitled')
    expect(brief.guide[2]).toBe('Load the ts-paper skill when you start work in this mode, not for a question or a status report. '
      + 'Routing is settled (routingSettled): skip the routing step of the entry skill.')
    expect(brief.guide[3]).toMatch(/ask_user_question/)
    expect(brief.phases[0]).toEqual({ id: 'plan', state: 'current', done: false, checkpoint: false, missing: ['Not checked yet'] })
    expect(brief.phases[1]).toMatchObject({ id: 'cite', state: 'pending' })
    // current never fails: outside a research, and in a conversation with no folder, it says what to do instead.
    const elsewhere = process.platform === 'win32' ? 'C:\\elsewhere' : '/elsewhere'
    const outside = /^No research contains this conversation's folder\. .*action create; to work in another folder, ask the user .*新研究/
    expect(await h.call('research_project', { action: 'current' }, elsewhere)).toEqual({ project: null, hint: expect.stringMatching(outside) as unknown })
    expect(await h.call('research_project', { action: 'current' }, null))
      .toEqual({ project: null, hint: expect.stringMatching(/^This conversation has no working folder/) as unknown })
    expect(await h.call('research_project', { action: 'current', projectId: h.foreign.id }))
      .toEqual({ project: null, hint: 'The tool session does not belong to this research project' })
    await expect(h.call('research_check', {}, null)).rejects.toThrow(/no working folder/)
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

  it('creates a research only in the conversation\'s own folder, binding the calling session', async () => {
    const h = harness()
    const fresh = process.platform === 'win32' ? 'C:\\research\\fresh' : '/research/fresh'
    const created = await h.call('research_project', { action: 'create', title: 'New', mode: 'spark-to-paper', route: 'idea', autonomy: 'automatic' }, fresh)
    expect(created).toMatchObject({ mode: 'spark-to-paper', route: 'idea' })
    // Naming the folder the conversation is in is the same as omitting it.
    await h.call('research_project', { action: 'create', title: 'Same', root: fresh, brief: 'x' }, fresh)
    expect(h.created).toEqual([
      { request: { title: 'New', root: fresh, brief: '', mode: 'spark-to-paper', route: 'idea', autonomy: 'automatic' }, sessionId: 'agent-session' },
      { request: { title: 'Same', root: fresh, brief: 'x' }, sessionId: 'agent-session' },
    ])
    // Any other folder is the user's to choose.
    await expect(h.call('research_project', { action: 'create', title: 'Elsewhere', root: other }, fresh)).rejects.toThrow(new RegExp(
      '^create makes only this conversation\'s folder .* a research, never .*; to work in another folder, '
      + 'ask the user to start a research with 新研究 \\(New research\\) and choose its folder with 更改位置 \\(Change location\\)$',
    ))
    // A folder inside a research belongs to it: nothing new is made there.
    expect(await h.call('research_project', { action: 'create', title: 'Nested' }, `${root}/paper`)).toMatchObject({ id: h.project.id })
    expect(h.created).toHaveLength(2)
    await expect(h.call('research_project', { action: 'create', title: 'Nowhere' }, null)).rejects.toThrow(/no working folder/)
    await expect(h.call('research_project', { action: 'create' }, fresh)).rejects.toThrow(/needs a title/)
  })

  it('turns routing, autonomy and decisions into ledger commands', async () => {
    const h = harness()
    await h.call('research_project', { action: 'set-mode', mode: 'spark-to-paper', route: 'data', reason: 'data exists', decidedBy: 'user' })
    await h.call('research_project', { action: 'set-autonomy', autonomy: 'automatic' })
    await h.call('research_project', { action: 'rename', title: ' Sparse attention study ' })
    await expect(h.call('research_project', { action: 'rename', title: '  ' })).rejects.toThrow()
    const result = await h.call('research_project', { action: 'record-decision', question: 'Q?', answer: 'A' })
    expect(result).toEqual({ message: 'did record-decision' })
    await h.call('research_project', { action: 'record-decision', question: 'Go?', answer: 'Yes', decidedBy: 'user' })
    await h.call('research_project', { action: 'record-decision', question: 'Run experiments?', answer: 'Not here', key: 'experiments-deferred' })
    await expect(h.call('research_project', { action: 'record-decision', question: 'Q?', answer: 'A', key: 'Not A Slug' })).rejects.toThrow(/lowercase words/)
    expect(h.executed.map(item => [item.request, item.actor, item.sessionId])).toEqual([
      [{ action: 'set-mode', projectId: h.project.id, mode: 'spark-to-paper', route: 'data', reason: 'data exists', decidedBy: 'user' }, 'agent', 'agent-session'],
      [{ action: 'set-autonomy', projectId: h.project.id, autonomy: 'automatic' }, 'agent', 'agent-session'],
      [{ action: 'rename', projectId: h.project.id, title: 'Sparse attention study' }, 'agent', 'agent-session'],
      [{ action: 'record-decision', projectId: h.project.id, question: 'Q?', answer: 'A' }, 'agent', 'agent-session'],
      [{ action: 'record-decision', projectId: h.project.id, question: 'Go?', answer: 'Yes', decidedBy: 'user' }, 'agent', 'agent-session'],
      [{ action: 'record-decision', projectId: h.project.id, question: 'Run experiments?', answer: 'Not here', key: 'experiments-deferred' }, 'agent', 'agent-session'],
    ])
  })

  it('reports the goal a conversation of the research already holds, and says whose it is', async () => {
    const h = harness()
    type Brief = { activeGoal: Record<string, unknown> | null; guide: string[] }
    const current = async (): Promise<Brief> => await h.call('research_project', { action: 'current' }) as Brief
    h.goals.push({ sessionId: 'other-session', objective: 'Finish the paper', phase: 'active', roundsStarted: 3, updatedAt: 2 })
    const elsewhere = await current()
    expect(elsewhere.activeGoal).toEqual({ conversation: 'other-session', thisConversation: false, objective: 'Finish the paper', phase: 'active', roundsStarted: 3 })
    expect(elsewhere.guide).toContain('A goal is already running in another conversation of this research (activeGoal): continue the work there or tell the user where it runs; never create a second goal.')
    // The reader's own goal comes first, and the others are counted.
    h.goals.push({ sessionId: 'agent-session', objective: 'Mine', phase: 'paused', roundsStarted: 1, updatedAt: 1 })
    const own = await current()
    expect(own.activeGoal).toEqual({ conversation: 'agent-session', thisConversation: true, objective: 'Mine', phase: 'paused', roundsStarted: 1, otherConversationsWithGoals: 1 })
    expect(own.guide).toContain('This conversation holds the research\'s goal (activeGoal): keep working toward it; never create a second.')
    h.goals.splice(0, 2, { sessionId: 'other-session', objective: 'Stuck', phase: 'blocked', roundsStarted: 9, updatedAt: 3 })
    expect((await current()).guide).toContain('A goal is already blocked in another conversation of this research (activeGoal): continue the work there or tell the user where it runs; never create a second goal.')
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
      research_media: { action: 'visual-review' }, research_knowledge: { action: 'graph-status' }, research_board: { action: 'board-get' },
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
  it('describes a general automatic project and the next unfinished phase of a pack mode', async () => {
    const project: ResearchProject = newProject({ root, title: 'T', brief: '', autonomy: 'automatic' }, 'w' as WorkspaceId)
    const brief = async (): Promise<ReturnType<typeof projectBrief>> =>
      projectBrief(project, modes.resolve(project), await standingOf(project))
    const general = await brief() as { guide: string[]; mode: string; route: null; phases: unknown[]; lastCompile: null }
    // Created without naming a mode: general, with the mode not chosen yet.
    expect(general).toMatchObject({
      mode: 'general', route: null, paperRoot: 'paper', phases: [], lastCompile: null,
      modeChosen: false, modeSetBy: null, routingSettled: false, activeGoal: null,
    })
    const unchosen = /^The mode is not chosen yet \(modeChosen false\)\. After the user's first message, choose it with the research-modes /
    expect(general.guide[0]).toMatch(unchosen)
    expect(general.guide[1]).toMatch(/^Mode general: no pipeline\. .*suggest a mode \(research_project modes\)/)
    expect(general.guide[2]).toMatch(/Autonomy automatic/)
    // A placeholder title asks for a real one.
    project.untitled = true
    const untitled = await brief() as { untitled?: boolean; guide: string[] }
    expect(untitled.untitled).toBe(true)
    expect(untitled.guide.at(-1)).toBe('The research has no title of its own yet: once the topic is clear, give it a short one with rename.')
    delete project.untitled
    project.modeSetBy = 'agent'
    project.mode = 'gone'
    expect((await brief() as { guide: string[] }).guide[0]).toMatch(/"gone" is not installed/)
    project.mode = 'spark-to-paper'
    project.route = 'data'
    const at = '2026-09-25T10:00:00.000Z'
    project.progress = {
      mode: 'spark-to-paper', route: 'data', findings: {},
      phases: { data: { done: true, unmet: [], checkedAt: at }, plan: { done: false, unmet: ['file:blueprint.json', 'errors:blueprint-lint'], checkedAt: at } },
    }
    project.compilations.push({ artifactId: 'a' as never, artifactRevision: 1, inputDigest: 'd', engine: 'pdflatex', status: 'completed', pdfPath: 'x.pdf', logPath: 'l', diagnostics: [], createdAt: '' })
    project.decisions.push({ id: 'd', question: 'Q', answer: 'A', by: 'user', rationale: '', at: '' })
    project.artifacts.push({ id: 'a' as never, path: 'paper/main.tex', kind: 'manuscript', revision: 2, sha256: 's', evidence: [], claimIds: [], inputArtifacts: [], stale: false, updatedAt: '', author: 'agent' })
    project.evidence.push({ id: 'e' as never, title: 'data', kind: 'file', path: 'p', sha256: 's', revision: 1, importedAt: '', chunks: [{ text: 'secret body', locator: {} }], coverage: 'data', verified: true, stale: false })
    project.environments.push({ id: 'env' as never, name: 'env', kind: 'uv', target: 'local', python: 'py', requirements: [], fingerprint: 'f', status: 'ready', details: 'long details', isDefault: true })
    project.experiments.push({ id: 'r' as never, spec: { name: 'train' } as never, status: 'running', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: {}, message: 'm', snapshotPath: '', collected: false })
    const routed = await brief() as {
      guide: string[]
      phases: unknown[]
      checkedAt: string
      phaseSkills: Record<string, string[]>
      lastCompile: unknown
      decisions: unknown[]
      artifacts: unknown[]
      evidence: unknown[]
      environments: unknown[]
      experiments: unknown[]
    }
    // The next phase and what it lacks are the ones the person's record shows, in the pack's own words.
    expect(routed.guide[0]).toMatch(/ Next phase: plan \(There is no paper blueprint yet\)\.$/)
    expect(routed.phases).toHaveLength(9)
    expect(routed.phases.slice(0, 3)).toEqual([
      { id: 'data', state: 'done', done: true, checkpoint: false, missing: [] },
      { id: 'plan', state: 'current', done: false, checkpoint: false, missing: ['There is no paper blueprint yet', 'Fix the errors in Blueprint check'] },
      { id: 'cite', state: 'pending', done: false, checkpoint: false, missing: ['Not checked yet'] },
    ])
    expect(routed.checkedAt).toBe(at)
    expect(routed.phaseSkills.data).toEqual(['ts-paper-data', 'results-ingest'])
    expect(routed.lastCompile).toEqual({ status: 'completed', pdfPath: 'x.pdf' })
    expect(routed.decisions).toEqual([{ question: 'Q', answer: 'A', by: 'user', rationale: '' }])
    // The agent chose this mode and no decision settled the route, so the entry skill may still route.
    expect(routed).toMatchObject({ modeChosen: true, modeSetBy: 'agent', routingSettled: false })
    expect(routed.guide[2]).toBe('Load the ts-paper skill when you start work in this mode, not for a question or a status report.')
    project.decisions.push({ id: 'm', question: '模式与路线', answer: 'spark-to-paper · data', by: 'agent', rationale: '', at: '', key: 'mode' })
    expect(await brief()).toMatchObject({ routingSettled: true })
    project.decisions.pop()
    expect(routed.artifacts).toEqual([{ id: 'a', path: 'paper/main.tex', kind: 'manuscript', revision: 2, stale: false }])
    expect(JSON.stringify(routed.evidence)).not.toContain('secret body')
    expect(JSON.stringify(routed.environments)).not.toContain('long details')
    expect(routed.experiments).toEqual([{ id: 'r', status: 'running', message: 'm', metrics: {}, name: 'train' }])
    // A current phase that was never checked has no hint to give.
    project.progress.phases.plan = { done: true, unmet: [], checkedAt: at }
    expect((await brief() as { guide: string[] }).guide[0]).toMatch(/ Next phase: cite\.$/)
    // A phase deferred by a recorded decision is named as deferred, and never as done.
    project.route = 'proposal'
    project.progress = { mode: 'spark-to-paper', route: 'proposal', findings: {}, phases: {} }
    for (const phase of ['plan', 'cite', 'write', 'refine', 'review', 'figures', 'latex', 'submission']) project.progress.phases[phase] = { done: true, unmet: [], checkedAt: at }
    project.decisions.push({ id: 'k', question: 'Run experiments here?', answer: 'No GPU', by: 'user', rationale: '', at, key: 'experiments-deferred' })
    const deferred = await brief() as { guide: string[]; phases: { id: string; state: string; done: boolean }[] }
    expect(deferred.guide[0]).toMatch(/ → submission\. Deferred by a recorded decision: experiments\. Checkpoint before: experiments\.$/)
    expect(deferred.phases.find(phase => phase.id === 'experiments')).toMatchObject({ state: 'deferred', done: false, missing: ['Not checked yet'] })
    // Progress stored for another route no longer describes this one.
    project.route = 'idea'
    const rerouted = await brief() as { guide: string[]; phases: { missing: string[] }[] }
    expect(rerouted.guide[0]).toMatch(/ Next phase: story\./)
    expect(rerouted.phases[0]?.missing).toEqual(['Not checked yet'])
  })

  it('names the skills a pack loads first, and a pack route without phases', async () => {
    const pack = (id: string, extra: Partial<ModePack>): ModePack => ({
      id, order: 5, name: { en: id, zh: id }, summary: { en: 's', zh: 's' }, paperRoot: 'paper', preload: [], routes: [], phases: [], gates: [], scripts: [],
      directory: '', skills: [], ...extra,
    })
    const general = pack('general', {})
    const registry = new ModeRegistry([general, pack('family', { preload: ['first', 'second'], entry: 'lead' }), pack('solo', { entry: 'lead' })])
    const project: ResearchProject = { ...newProject({ root, title: 'T', brief: '' }, 'w' as WorkspaceId), modeSetBy: 'agent' }
    const briefIn = async (modes: ModeRegistry): Promise<{ guide: string[] }> => {
      const mode = modes.resolve(project)
      return projectBrief(project, mode, await standingOf(project, mode)) as { guide: string[] }
    }
    project.mode = 'family'
    expect((await briefIn(registry)).guide.slice(0, 2)).toEqual([
      'Mode family: no pipeline on this route; work as the mode\'s skills direct and run the relevant checks.',
      'Load the first, then second, then lead skills when you start work in this mode, not for a question or a status report.',
    ])
    project.mode = 'solo'
    expect((await briefIn(registry)).guide[1]).toBe('Load the lead skill when you start work in this mode, not for a question or a status report.')
    expect(() => new ModeRegistry([pack('solo', {})])).toThrow(/general mode pack is missing/)
    const flat = new ModeRegistry([general, pack('flat', { phases: [{ id: 'p', label: { en: 'P', zh: 'P' }, skills: [], checkpoint: false, checks: [], requires: [] }] })])
    project.mode = 'flat'
    expect((await briefIn(flat)).guide[0]).toBe('Mode flat: p. Next phase: p.')
  })
})
