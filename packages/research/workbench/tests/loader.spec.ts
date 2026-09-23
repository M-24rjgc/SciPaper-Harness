import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { pathToFileURL } from 'node:url'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as DomainPlugin from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, parse } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ProcessOptions, ProcessResult } from '../src/process.ts'
import type { ResearchProject } from '../src/types.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Every child process the service starts, answered by a scripted stand-in. */
const processes = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[]; options?: unknown }[],
  runner: { status: 'completed', metrics: { accuracy: 0.8123 } } as Record<string, unknown>,
  compileFails: false,
  launchFails: false,
  /** Compile variants: a missing style on the first pass, a pass that fails, no final log. */
  missingSty: false,
  /** Successful engine passes left before the next one fails; undefined never fails. */
  passesBeforeFailure: undefined as number | undefined,
  noLog: false,
  /** Replaces the document extractor's answer when set. */
  extracted: undefined as string | undefined,
  /** SSH answers by argument; the default acknowledges with an empty object. */
  ssh: undefined as ((args: string[]) => ProcessResult) | undefined,
  /** Process kinds ('latex', 'launch', 'status') held until the test releases them. */
  holds: new Map<string, Promise<void>>(),
}))
vi.mock('../src/process.ts', async (original) => {
  const actual = await original<typeof import('../src/process.ts')>()
  const { writeFile: write, mkdir: make, readFile: read } = await import('node:fs/promises')
  const path = await import('node:path')
  const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: '' })
  return {
    ...actual,
    ssh: async (_host: string, args: readonly string[]) => processes.ssh?.([...args]) ?? ok('{}'),
    runProcess: async (command: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> => {
      processes.calls.push({ command, args: [...args], options })
      const joined = args.join(' ')
      if (args[0] === '-c' && joined.includes('importlib.metadata')) return ok(JSON.stringify({ executable: command, version: '3.12' }))
      if (args[0] === '-c') return ok('ready')
      if (joined.includes('experiment_runner.py')) {
        await processes.holds.get(String(args[1]))
        if (args[1] === 'launch' && processes.launchFails) throw new Error('spawn failed')
        const state = args[1] === 'launch' ? { status: 'running' } : processes.runner
        return ok(JSON.stringify(state))
      }
      if (joined.includes('documents.py') && args[1] === 'render') {
        const destination = String(args[args.indexOf('--output') + 1])
        await make(destination, { recursive: true })
        await write(path.join(destination, 'page-001.png'), 'png')
        return ok(JSON.stringify([path.join(destination, 'page-001.png')]))
      }
      if (joined.includes('documents.py')) return ok(processes.extracted ?? JSON.stringify([{ text: 'metric,value\naccuracy,0.8123', locator: { line: 1 } }]))
      if (/latex|biber|bibtex/.test(path.basename(command))) {
        await processes.holds.get('latex')
        const output = args.find(arg => arg.startsWith('-output-directory='))?.slice('-output-directory='.length) ?? ''
        const stem = String(args.at(-1)).replace(/\.tex$/, '')
        const build = path.resolve(options.cwd ?? '.', output)
        if (/biber|bibtex/.test(path.basename(command))) return ok('')
        if (processes.compileFails || !output) return { code: 1, stdout: '! Undefined control sequence.', stderr: '' }
        if (processes.missingSty) { processes.missingSty = false; return { code: 1, stdout: '! LaTeX Error: File `venue.sty\' not found.', stderr: '' } }
        if (processes.passesBeforeFailure === 0) return { code: 1, stdout: '! Emergency stop.', stderr: '' }
        if (processes.passesBeforeFailure !== undefined) processes.passesBeforeFailure--
        const source = await read(path.resolve(options.cwd ?? '.', `${stem}.tex`), 'utf8')
        if (source.includes('biblatex')) await write(path.join(build, `${stem}.bcf`), 'bcf')
        else if (source.includes('\\bibliography')) await write(path.join(build, `${stem}.aux`), '\\bibdata{refs}')
        await write(path.join(build, `${stem}.pdf`), '%PDF')
        if (!processes.noLog) await write(path.join(build, `${stem}.log`), 'LaTeX Warning: Citation `x\' undefined\nOverfull \\hbox')
        return ok('')
      }
      return ok('')
    },
  }
})

const { default: ResearchWorkbench, IMAGE_CREDENTIAL } = await import('../src/index.ts')
const AgentTools = await import('../src/agent-tools.ts')
const { default: SkillRegistry } = await import('@deepseek-ai/dsh-skill')

let ctx: Context | undefined
let root: string | undefined
const signal = new AbortController().signal
beforeEach(() => {
  processes.calls.length = 0; processes.runner = { status: 'completed', metrics: { accuracy: 0.8123 } }
  processes.compileFails = false; processes.launchFails = false; processes.holds.clear()
  processes.missingSty = false; processes.passesBeforeFailure = undefined; processes.noLog = false
  processes.ssh = undefined; processes.extracted = undefined
})

/** Hold every process of one kind until the returned release is called. */
function hold(kind: string): () => void {
  let release = (): void => {}
  processes.holds.set(kind, new Promise<void>((resolve) => { release = resolve }))
  return () => { processes.holds.delete(kind); release() }
}
afterEach(async () => {
  vi.unstubAllGlobals()
  await ctx?.fiber.dispose(); ctx = undefined
  if (root) await rm(root, { recursive: true, force: true }); root = undefined
})

interface Harness {
  service: InstanceType<typeof ResearchWorkbench>
  registry: Map<string, unknown>
  prompts: unknown[]
  sessions: string[]
  credentials: Map<string, string>
}

async function boot(pool: MemoryMediaPool, options: { componentRoot?: boolean } = {}): Promise<Harness> {
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root ?? '').href + '/'
  const registry = new Map<string, unknown>()
  const prompts: unknown[] = []
  const sessions: string[] = []
  const credentials = new Map<string, string>()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['storage', Storage], ['domain', DomainPlugin], ['research', ResearchWorkbench], ['research-tools', AgentTools], ['skills', SkillRegistry],
    ['adapters', { inject: ['storage'], apply(c: Context) {
      const backend = new MemoryStorageBackend(pool)
      c.storage.backend.register('memory', backend)
      c.provide(storageBackendServiceKey('memory'), backend)
      c.provide('workspaceRegistry', { create: async () => ({ id: 'workspace' as WorkspaceId }) } as unknown as Context['workspaceRegistry'])
      c.provide('sessionController', {
        create: async () => { const id = `session-${sessions.length + 1}`; sessions.push(id); return { sessionId: id as SessionId } },
        selectModel: async () => {},
        prompt: async (request: unknown) => { prompts.push(request) },
      } as unknown as Context['sessionController'])
      c.provide('credentials', {
        set: async (ref: string, value: string) => { credentials.set(ref, value) },
        resolve: async (ref: string) => credentials.has(ref) ? { value: credentials.get(ref) } : undefined,
      } as unknown as Context['credentials'])
      c.provide('llm', {} as Context['llm'])
      c.provide('tools', { register: (tool: { name: string }) => { registry.set(tool.name, tool); return () => registry.delete(tool.name) } } as unknown as Context['tools'])
    } }],
  ])
  ctx.loader.internal = { version: 'v2', async import(name: string) { if (!modules.has(name)) throw new Error(name); return modules.get(name) } } as unknown as NonNullable<typeof ctx.loader.internal>
  const configuration = join(root ?? '', 'cordis.yml')
  await writeFile(configuration, [
    '- name: storage', '- name: adapters', '- name: domain', '  config:', '    backend: memory',
    '- name: skills',
    '- name: research-tools',
    '- name: research', '  config:', '    maxSourceBytes: 100000', '    pollIntervalMs: 500', '    maxReviewPages: 4',
    ...options.componentRoot === false ? [] : [`    componentRoot: ${JSON.stringify(join(root ?? '', 'components'))}`],
  ].join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configuration).href } })
  await ctx.loader.await()
  return { service: ctx.research, registry, prompts, sessions, credentials }
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

describe('the research service records; it never drives the agent', () => {
  it('creates and reopens projects without prompting any session, and restores after a restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-loader-'))
    const pool = new MemoryMediaPool(), first = await boot(pool)
    expect([...first.registry.keys()].sort()).toEqual([
      'research_artifact', 'research_check', 'research_environment', 'research_evidence', 'research_experiment', 'research_media', 'research_project', 'research_task',
    ])
    const announced: unknown[] = []
    ctx!.on('research/mode', (event) => { announced.push(event) })
    const p = await first.service.create({ title: 'Study', root: join(root, 'paper'), brief: 'One small spark', mode: 'spark-to-paper' })
    expect(p).toMatchObject({ sessionId: 'session-1', mode: 'spark-to-paper', route: 'proposal', autonomy: 'checkpoints' })
    expect(announced).toEqual([{ projectId: p.id, root: p.root, mode: 'spark-to-paper', route: 'proposal' }])
    await expect(first.service.create({ title: 'x', root: join(root, 'x'), brief: '', mode: 'nope' })).rejects.toThrow(/Unknown mode nope; installed modes: general, spark-to-paper/)
    await expect(first.service.create({ title: 'x', root: join(root, 'x'), brief: '', mode: 'spark-to-paper', route: 'nope' })).rejects.toThrow(/has no route nope/)
    await expect(first.service.create({ title: 'x', root: join(root, 'x'), brief: '', route: 'idea' })).rejects.toThrow(/Mode general has no routes/)
    expect((await first.service.snapshot()).modes.map(mode => mode.id)).toEqual(['general', 'spark-to-paper'])
    for (const directory of ['paper', 'figures', 'code', 'data', '.research', 'exports']) expect(existsSync(join(p.root, directory))).toBe(true)
    expect((await first.service.create({ title: p.title, root: p.root, brief: p.brief })).sessionId).toBe('session-1')
    const bound = await first.service.createProject({ title: 'Bound', root: join(root, 'bound'), brief: '' }, 'agent-session')
    expect(bound.sessionId).toBe('agent-session')
    await expect(first.service.create({ title: 'x', root: 'relative/path', brief: '' })).rejects.toThrow(/absolute/)
    // A failed creation does not hold up the next, and two creations of one folder yield one project.
    await expect(first.service.create({ title: 'x', root: parse(root).root, brief: '' })).rejects.toThrow()
    const [twin, again] = await Promise.all([first.service.create({ title: 'Twin', root: join(root, 'twin'), brief: '' }), first.service.create({ title: 'Twin', root: join(root, 'twin'), brief: '' })])
    expect(again.id).toBe(twin.id)
    expect(first.prompts).toEqual([])
    await ctx!.fiber.dispose(); ctx = undefined
    const second = await boot(pool)
    expect((await second.service.snapshot()).projects.map(item => item.title).sort()).toEqual(['Bound', 'Study', 'Twin'])
    expect(second.prompts).toEqual([])
    expect(await second.service.projectAt(join(p.root, 'paper', 'nested'))).toBeUndefined()
    expect((await second.service.projectAt(join(p.root, 'figures')))?.id).toBe(p.id)
    expect(() => second.service.getProject('missing' as never)).toThrow(/not found/)
  })

  it('shows a project\'s sessions the skills of its mode, and swaps them when the mode changes', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-skills-'))
    const { service } = await boot(new MemoryMediaPool())
    const names = async (cwd?: string): Promise<string[]> => (await ctx!.skills.list({ cwd })).map(skill => skill.name).sort()
    const p = await service.create({ title: 'Skills', root: join(root, 'p'), brief: '' })
    // The general mode adds no skills of its own; nothing outside a project gets mode skills either.
    expect(await names(p.root)).toEqual([])
    expect(await names(join(root, 'elsewhere'))).toEqual([])
    expect(await names()).toEqual([])
    await service.execute({ projectId: p.id, action: 'set-mode', mode: 'spark-to-paper', route: 'idea' }, signal, 'agent')
    expect(await names(join(p.root, 'paper'))).toEqual(['ts-idea2story', 'ts-paper', 'ts-paper-plan'])
    const loaded = await ctx!.skills.get('ts-paper', { cwd: p.root })
    expect(loaded).toMatchObject({ name: 'ts-paper', provider: 'research-modes', source: 'bundled', resourceBase: { kind: 'directory' } })
    expect(loaded?.content).toMatch(/^\s*# spark-to-paper/)
    expect(loaded?.content).not.toMatch(/^---/)
    await service.execute({ projectId: p.id, action: 'set-mode', mode: 'general' }, signal, 'user')
    expect(await names(p.root)).toEqual([])
    // A new project in a pack mode lists that pack's skills at once.
    const q = await service.create({ title: 'Direct', root: join(root, 'q'), brief: '', mode: 'spark-to-paper' })
    expect(await names(q.root)).toContain('ts-paper')
    const { modeSkillDefinition } = await import('../src/mode-skills.ts')
    expect(await modeSkillDefinition({ name: 'gone', description: 'd', directory: join(root, 'gone') })).toBeUndefined()
    await write(join(root, 'extra', 'SKILL.md'), '---\nname: extra\ndescription: An extra skill.\n---\nBody')
    expect(await modeSkillDefinition({ name: 'extra', description: 'An extra skill.', whenToUse: 'Rarely', directory: join(root, 'extra') }))
      .toMatchObject({ whenToUse: 'Rarely', content: 'Body' })
  })

  it('keeps managed tools in the product home unless a component root is configured', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-home-'))
    const { service } = await boot(new MemoryMediaPool(), { componentRoot: false })
    expect(service.components.root).toBe(join(resolveDshHome(), 'research', 'components'))
  })

  it('migrates a stored version-1 project on open', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-migrate-'))
    const pool = new MemoryMediaPool()
    const first = await boot(pool)
    const p = await first.service.create({ title: 'Old', root: join(root, 'old'), brief: '' })
    await ctx!.fiber.dispose(); ctx = undefined
    for (const [, medium] of pool.media) {
      const table = medium.tables.get('projects')
      const stored = table?.get(p.id) as Record<string, unknown> | undefined
      if (!table || !stored) continue
      const { decisions: _decisions, autonomy: _autonomy, ...legacy } = stored
      table.set(p.id, { ...legacy, mode: 'evidence', paused: false, stages: [{ id: 'question', summary: 'Q', confirmedRevision: 1, confirmedAt: '2026-01-01T00:00:00.000Z' }] })
    }
    const second = await boot(pool)
    expect(second.service.getProject(p.id)).toMatchObject({ mode: 'spark-to-paper', route: 'data', autonomy: 'checkpoints', decisions: [{ answer: 'Q', by: 'user' }] })
  })

  it('keeps evidence text out of the stored ledger and restores it after a restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-text-'))
    const pool = new MemoryMediaPool()
    const tables = () => [...pool.media.values()].map(medium => medium.tables.get('projects')).filter(table => table !== undefined)
    const stored = (id: string) => tables().map(table => table.get(id) as ResearchProject | undefined).find(Boolean)!
    const first = await boot(pool)
    const p = await first.service.create({ title: 'Text', root: join(root, 'p'), brief: '' })
    const run = (service: Harness['service'], request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    await write(join(p.root, 'notes.md'), 'a distinctive phrase')
    await write(join(p.root, 'other.md'), 'second source')
    await run(first.service, { action: 'import', paths: ['notes.md', 'other.md'] })
    expect(stored(p.id).evidence.map(e => e.chunks)).toEqual([[], []])
    const [notes, other] = first.service.getProject(p.id).evidence
    expect(notes!.chunks[0]?.text).toBe('a distinctive phrase')
    await ctx!.fiber.dispose(); ctx = undefined

    await writeFile(join(p.root, `.research/chunks/${other!.id}/1.json`), 'not json')
    const second = await boot(pool)
    expect(JSON.parse((await run(second.service, { action: 'search-evidence', query: 'distinctive' })).content ?? '[]')).toHaveLength(1)
    expect(second.service.getProject(p.id).evidence.find(e => e.id === other!.id)?.chunks).toEqual([])
    await ctx!.fiber.dispose(); ctx = undefined

    // A record stored before the text moved out still carries it inline, and is rewritten without it.
    for (const table of tables()) {
      const legacy = table.get(p.id) as ResearchProject
      table.set(p.id, { ...legacy, evidence: legacy.evidence.map(e => ({ ...e, chunks: [{ text: 'inline text', locator: { line: 1 } }] })) })
    }
    await rm(join(p.root, '.research/chunks'), { recursive: true })
    const third = await boot(pool)
    expect(stored(p.id).evidence.map(e => e.chunks)).toEqual([[], []])
    expect(existsSync(join(p.root, `.research/chunks/${notes!.id}/1.json`))).toBe(true)
    expect(JSON.parse((await run(third.service, { action: 'search-evidence', query: 'inline' })).content ?? '[]')).toHaveLength(2)
    // Text the service never loaded reads as empty rather than failing the project.
    ;(third.service as unknown as { evidenceText: Map<string, unknown> }).evidenceText.clear()
    expect(third.service.getProject(p.id).evidence.map(e => e.chunks)).toEqual([[], []])
  })

  it('routes, decides, checks and records files for the agent and the desktop alike', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-ledger-'))
    const { service } = await boot(new MemoryMediaPool())
    const p = await service.create({ title: 'Ledger', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>, actor: 'user' | 'agent' = 'agent') => service.execute({ projectId: p.id, ...request } as never, signal, actor)
    const announced: { mode: string; route?: string }[] = []
    ctx!.on('research/mode', (event) => { announced.push(event) })
    expect((await run({ action: 'set-mode', mode: 'spark-to-paper', route: 'data', reason: 'CSV results exist' })).message)
      .toBe('Mode spark-to-paper (data): data → plan → cite → write → refine → review → figures → latex → submission')
    expect(service.getProject(p.id)).toMatchObject({ mode: 'spark-to-paper', route: 'data', modeReason: 'CSV results exist', modeSetBy: 'agent' })
    await expect(run({ action: 'set-mode', mode: 'spark-to-paper', route: 'sideways' })).rejects.toThrow(/has no route sideways/)
    expect((await run({ action: 'set-mode', mode: 'general' }, 'user')).message).toBe('Mode General: no pipeline; run checks when useful')
    expect('modeReason' in service.getProject(p.id) || 'route' in service.getProject(p.id)).toBe(false)
    expect(announced.map(event => [event.mode, event.route])).toEqual([['spark-to-paper', 'data'], ['general', undefined]])
    await run({ action: 'set-autonomy', autonomy: 'automatic' }, 'user')
    await run({ action: 'record-decision', question: 'Which dataset?', answer: 'CIFAR-10', rationale: '  small and standard ' })
    expect(service.getProject(p.id)).toMatchObject({ autonomy: 'automatic', decisions: [{ question: 'Which dataset?', answer: 'CIFAR-10', by: 'agent', rationale: 'small and standard' }] })
    await run({ action: 'record-decision', question: 'Go?', answer: 'Yes' }, 'user')
    expect(service.getProject(p.id).decisions[1]).toMatchObject({ by: 'user', rationale: '' })
    // The agent records the user's checkpoint answer in the user's name.
    await run({ action: 'record-decision', question: 'Run it?', answer: 'Yes', decidedBy: 'user' })
    expect(service.getProject(p.id).decisions[2]).toMatchObject({ question: 'Run it?', by: 'user' })
    const check = await run({ action: 'check' })
    expect(check.message).toMatch(/Not done yet/)
    expect(check.check?.clean).toBe(false)
    expect(service.getProject(p.id).lastCheck?.scope).toBe('all')
    const saved = await run({ action: 'save-artifact', path: 'paper/main.tex', content: '\\documentclass{article}\n\\begin{document}x\\end{document}', kind: 'manuscript' })
    expect(saved.message).toMatch(/revision 1/)
    const artifactId = service.getProject(p.id).artifacts[0]!.id
    expect((await run({ action: 'read-artifact', artifactId })).content).toContain('documentclass')
    await expect(run({ action: 'read-artifact', artifactId: 'nope' })).rejects.toThrow(/not found/)
    await write(join(p.root, 'figures/plot.png'), 'png')
    await run({ action: 'register-artifact', path: 'figures/plot.png', kind: 'figure' })
    const imageId = service.getProject(p.id).artifacts.find(a => a.path === 'figures/plot.png')!.id
    expect((await run({ action: 'read-artifact', artifactId: imageId })).content).toBe('')
    await run({ action: 'claim', claim: { id: 'h', text: 'It helps', kind: 'hypothesis', state: 'proposed', evidence: [], artifactIds: [] } })
    expect(service.getProject(p.id).claims).toHaveLength(1)
    const clean = await run({ action: 'check', scope: 'figures' })
    expect(clean.message).toBe('Clean')
  })

  it('imports sources and templates, verifies literature and searches evidence', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-evidence-'))
    const { service } = await boot(new MemoryMediaPool())
    await service.configure({ python: 'python' })
    const p = await service.create({ title: 'Evidence', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>, actor: 'user' | 'agent' = 'agent') => service.execute({ projectId: p.id, ...request } as never, signal, actor)
    await write(join(p.root, 'data/results.csv'), 'metric,value\naccuracy,0.8123\n')
    await write(join(p.root, 'notes.md'), 'accuracy discussion')
    await run({ action: 'import', paths: ['data/results.csv', 'notes.md', 'notes.md'] })
    expect(service.getProject(p.id).evidence.map(e => e.coverage).sort()).toEqual(['data', 'full-text'])
    expect(await readdir(join(p.root, '.research/sources'))).toHaveLength(2)
    const hits = await run({ action: 'search-evidence', query: 'accuracy' })
    expect(JSON.parse(hits.content ?? '[]')).toHaveLength(2)
    const notes = service.getProject(p.id).evidence.find(e => e.title === 'notes.md')!
    await write(join(p.root, 'notes.md'), 'changed discussion')
    await run({ action: 'refresh-evidence', evidenceId: notes.id })
    expect(service.getProject(p.id).evidence.find(e => e.id === notes.id)?.revision).toBe(2)
    await run({ action: 'refresh-evidence', evidenceId: notes.id })
    await write(join(p.root, 'notes.md'), 'changed again')
    await Promise.all([run({ action: 'refresh-evidence', evidenceId: notes.id }), run({ action: 'refresh-evidence', evidenceId: notes.id })])
    expect(service.getProject(p.id).evidence.find(e => e.id === notes.id)?.revision).toBe(3)
    await expect(run({ action: 'refresh-evidence', evidenceId: 'nope' })).rejects.toThrow(/no refreshable/)
    await write(join(root, 'tpl/venue.cls'), 'class')
    expect((await run({ action: 'import-template', paths: [join(root, 'tpl')] })).content).toBe('template/venue.cls')
    const item = { id: '10.1/x', provider: 'crossref', title: 'Real', authors: ['A'], year: 2024, doi: '10.1/x', url: 'https://doi.org/10.1/x', abstract: 'About', bibtex: '' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/works/')
      ? { message: { DOI: '10.1/x', title: ['Real'], author: [{ given: 'A', family: 'B' }], published: { 'date-parts': [[2024]] }, abstract: 'About' } }
      : { message: { items: [{ DOI: '10.1/x', title: ['Real'] }] } }))))
    expect((await run({ action: 'literature-search', provider: 'crossref', query: 'real' })).literature).toHaveLength(1)
    const imported = await run({ action: 'literature-import', item })
    expect(imported.content).toContain('@article{crossref_10_1_x')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: { DOI: '10.2/y', title: ['T'] } }))))
    await run({ action: 'literature-import', item: { ...item, abstract: '' } })
    expect(service.getProject(p.id).evidence.filter(e => e.kind === 'literature').map(e => e.coverage)).toEqual(['abstract', 'metadata'])
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const doi = /works\/(10\.\d+%2F\w+)$/.exec(url)?.[1]
      if (doi) return new Response(JSON.stringify({ message: { DOI: decodeURIComponent(doi), title: [`Paper ${decodeURIComponent(doi)}`], abstract: 'Open abstract' } }))
      if (url.endsWith('doi:10.1234/open')) return new Response(JSON.stringify({ best_oa_location: { pdf_url: 'https://oa.example/open.pdf' } }))
      if (url.endsWith('doi:10.5555/landing')) return new Response(JSON.stringify({ best_oa_location: { pdf_url: 'https://oa.example/landing' } }))
      return new Response(url.endsWith('.pdf') ? '%PDF-1.7 body' : '<html>')
    }))
    expect((await run({ action: 'literature-import', item: { ...item, id: '10.1234/open', doi: '10.1234/open' } })).message).toMatch(/with its open-access full text/)
    const open = service.getProject(p.id).evidence.find(e => e.title === 'Paper 10.1234/open')!
    expect(open).toMatchObject({ coverage: 'full-text', fullTextPath: `.research/sources/${open.id}/fulltext.pdf` })
    expect(open.chunks.map(chunk => chunk.locator.key ?? chunk.locator.line)).toEqual(['abstract', 1, 'bibtex'])
    expect((await run({ action: 'literature-import', item: { ...item, id: '10.5555/landing', doi: '10.5555/landing' } })).message).toMatch(/without full text \(The open-access location did not return a PDF\)/)
    const cancelled = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://api.crossref.org/works/')) return new Response(JSON.stringify({ message: { DOI: '10.6789/cut', title: ['Cut'] } }))
      cancelled.abort()
      throw new Error('aborted')
    }))
    await expect(service.execute({ projectId: p.id, action: 'literature-import', item: { ...item, id: '10.6789/cut', doi: '10.6789/cut' } } as never, cancelled.signal, 'agent')).rejects.toThrow()
    expect(service.getProject(p.id).evidence.some(e => e.title === 'Cut')).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('https://export.arxiv.org/')
      ? new Response('<feed><entry><id>http://arxiv.org/abs/2401.00001</id><title>Arxiv paper</title><summary>S</summary></entry></feed>')
      : new Response('%PDF-1.7 body')))
    expect((await run({ action: 'literature-import', item: { ...item, provider: 'arxiv', id: 'https://arxiv.org/abs/2401.00001', doi: undefined } })).message).toMatch(/open-access full text/)
    expect(service.getProject(p.id).evidence.find(e => e.title === 'Arxiv paper')).toMatchObject({ coverage: 'full-text', sourceUrl: 'https://arxiv.org/abs/2401.00001' })
    await write(join(p.root, 'data/big.pdf'), '%PDF')
    processes.extracted = JSON.stringify([{ text: 'x'.repeat(100001), locator: { page: 1 } }])
    await expect(run({ action: 'import', paths: ['data/big.pdf'] })).rejects.toThrow(/text limit/)
    processes.extracted = undefined
    const job = await run({ action: 'import', paths: ['notes.md'] }, 'user')
    expect(job.jobId).toBeDefined()
    await vi.waitFor(() => { expect(service.tasks().find(task => task.id === job.jobId)?.status).toBe('completed') })
    const failed = await run({ action: 'import', paths: ['missing.md'] }, 'user')
    await vi.waitFor(() => { expect(service.tasks().find(task => task.id === failed.jobId)?.status).toBe('failed') })
  })

  it('creates environments, runs experiments to completion, collects results and waits without polling', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-runs-'))
    const { service } = await boot(new MemoryMediaPool())
    await service.configure({ python: 'python', uv: 'uv' })
    const p = await service.create({ title: 'Runs', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    await run({ action: 'environment', environment: { name: 'env', kind: 'uv', target: 'local', python: '', requirements: ['numpy'], isDefault: true } })
    await run({ action: 'environment', environment: { name: 'second', kind: 'existing', target: 'local', python: 'C:/py/python.exe', requirements: [], isDefault: true } })
    const environments = service.getProject(p.id).environments
    expect(environments.map(e => e.isDefault)).toEqual([false, true])
    await write(join(p.root, 'code/train.py'), 'print(1)')
    await write(join(p.root, 'code/__pycache__/x.pyc'), 'cache')
    const spec = { environmentId: environments[1]!.id, name: 'train', argv: ['{python}', 'code/train.py'], cwd: '.', seed: 1, maxSeconds: 60, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' }
    const requestId = '11111111-1111-4111-8111-111111111111'
    const submitted = await run({ action: 'experiment', requestId, spec })
    expect(submitted.runs?.[0]).toMatchObject({ status: 'running' })
    const inputs = JSON.parse(await readFile(join(p.root, '.research/runs', requestId, 'inputs.json'), 'utf8')) as { inputs: { path: string }[] }
    expect(inputs.inputs.map(input => input.path)).toEqual(['code/train.py'])
    expect((await run({ action: 'experiment', requestId, spec })).message).toMatch(/Existing experiment/)
    await expect(run({ action: 'experiment', requestId, spec: { ...spec, seed: 2 } })).rejects.toThrow(/different experiment/)
    await expect(run({ action: 'experiment-dismiss', runId: requestId })).rejects.toThrow(/unknown/)
    const waited = await run({ action: 'experiment-wait', runIds: [requestId], timeoutSeconds: 5 })
    expect(waited.runs?.[0]).toMatchObject({ status: 'completed', metrics: { accuracy: 0.8123 } })
    const project = service.getProject(p.id)
    expect(project.experiments[0]?.collected).toBe(true)
    expect(project.evidence.some(e => e.kind === 'experiment' && e.coverage === 'data')).toBe(true)
    // Seeds of one configuration share a name, so the metrics evidence carries the seed.
    expect(project.evidence.find(e => e.path.endsWith(`${requestId}/metrics.json`))?.title).toBe(`${spec.name} · seed ${spec.seed}`)
    await expect(run({ action: 'experiment-wait', runIds: ['nope'], timeoutSeconds: 1 })).rejects.toThrow(/Unknown run/)
    expect((await run({ action: 'experiment-logs', runId: requestId })).message).toBe('Experiment logs')
    await expect(run({ action: 'experiment-logs', runId: 'nope' })).rejects.toThrow(/not found/)
    expect((await run({ action: 'experiment-refresh', runId: requestId })).message).toBe('completed')
    await expect(run({ action: 'experiment-cancel', runId: 'nope' })).rejects.toThrow(/not found/)
    processes.runner = { status: 'running' }
    const second = '22222222-2222-4222-8222-222222222222'
    await run({ action: 'experiment', requestId: second, spec: { ...spec, codePaths: ['code/train.py'] } })
    const still = await run({ action: 'experiment-wait', runIds: [second], timeoutSeconds: 1 })
    expect(still.message).toMatch(/Still running/)
    processes.runner = { status: 'unknown', message: 'lost' }
    await run({ action: 'experiment-refresh', runId: second })
    expect((await run({ action: 'experiment-dismiss', runId: second })).runs?.[0]).toMatchObject({ status: 'interrupted' })
    await expect(run({ action: 'experiment-dismiss', runId: 'nope' })).rejects.toThrow(/not found/)
    processes.runner = { status: 'completed' }
    const third = '88888888-8888-4888-8888-888888888888'
    await run({ action: 'experiment', requestId: third, spec })
    await run({ action: 'experiment-wait', runIds: [third], timeoutSeconds: 5 })
    expect(service.getProject(p.id).experiments.find(r => r.id === third)).toMatchObject({ collected: true, metrics: {} })
    expect((await run({ action: 'export' })).path).toMatch(/draft-\d+\.zip$/)
  })

  it('compiles to a PDF, renders pages for the agent to look at, exports, and records failures without refusing', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-compile-'))
    const { service } = await boot(new MemoryMediaPool())
    await service.configure({ python: 'python', texBin: join(root, 'tex') })
    const p = await service.create({ title: 'Compile', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>, actor: 'user' | 'agent' = 'agent') => service.execute({ projectId: p.id, ...request } as never, signal, actor)
    await expect(run({ action: 'compile', engine: 'pdflatex' })).rejects.toThrow(/No LaTeX manuscript/)
    await expect(run({ action: 'render-pages' })).rejects.toThrow(/compile first/)
    await write(join(p.root, 'paper/main.tex'), '\\documentclass{article}\\bibliography{refs}')
    await write(join(p.root, 'paper/refs.bib'), '')
    await write(join(p.root, 'notes.txt'), 'x')
    await expect(run({ action: 'compile', path: 'notes.txt', engine: 'pdflatex' })).rejects.toThrow(/LaTeX manuscript/)
    const compiled = await run({ action: 'compile', engine: 'xelatex' })
    expect(compiled.message).toMatch(/PDF built/)
    expect(compiled.content).toMatch(/Overfull/)
    const project = service.getProject(p.id)
    expect(project.artifacts.map(a => a.path)).toContain('paper/main.tex')
    const env = processes.calls.find(call => call.command.endsWith(`xelatex${process.platform === 'win32' ? '.exe' : ''}`))?.options as { env: Record<string, string> }
    expect(env.env.TEXINPUTS).not.toMatch(/\.research/)
    expect(env.env.BSTINPUTS).toBe(env.env.BIBINPUTS)
    const rendered = await run({ action: 'render-pages', maxPages: 2 })
    expect(rendered.paths).toHaveLength(1)
    expect(service.getProject(p.id).visualReviews.at(-1)).toMatchObject({ status: 'rendered' })
    const artifactId = project.artifacts[0]!.id
    expect((await run({ action: 'compile', artifactId, engine: 'pdflatex' })).message).toMatch(/PDF built/)
    await expect(run({ action: 'compile', artifactId: 'nope', engine: 'pdflatex' })).rejects.toThrow(/LaTeX manuscript/)
    processes.compileFails = true
    const failed = await run({ action: 'compile', path: 'paper/main.tex', engine: 'pdflatex' })
    expect(failed.message).toMatch(/No PDF was produced/)
    processes.compileFails = false
    const exported = await run({ action: 'export' })
    expect(exported.message).toMatch(/Draft exported/)
    expect(exported.check?.clean).toBe(false)
    const job = await run({ action: 'export' }, 'user')
    await vi.waitFor(() => { expect(service.tasks().find(task => task.id === job.jobId)?.result?.path).toMatch(/draft-/) })
    expect(service.tasks().find(task => task.id === job.jobId)?.result?.project?.evidence).toBeDefined()

    // A finished paper, compiled and looked at, exports as a submission.
    const clean = await service.create({ title: 'Clean', root: join(root, 'clean'), brief: '', mode: 'general' })
    const tidy = (request: Record<string, unknown>) => service.execute({ projectId: clean.id, ...request } as never, signal, 'agent')
    await write(join(clean.root, 'paper/main.tex'), '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n')
    await tidy({ action: 'compile', engine: 'pdflatex' })
    await tidy({ action: 'render-pages' })
    const submission = await tidy({ action: 'export' })
    expect(submission.message).toBe('Submission package exported')
    expect(submission.path).toMatch(/submission-\d+\.zip$/)

    // Bibliography engines, a missing style fetched on the way, a later pass that fails, a missing final log.
    const installs = vi.spyOn(service.components, 'installTexPackage').mockResolvedValue(undefined)
    await write(join(p.root, 'paper/main.tex'), '\\documentclass{article}\\usepackage{biblatex}\\addbibresource{refs.bib}')
    processes.missingSty = true
    expect((await run({ action: 'compile', engine: 'pdflatex' })).message).toMatch(/PDF built/)
    expect(installs.mock.calls[0]?.[0]).toBe('venue.sty')
    expect(processes.calls.some(call => call.command.includes('biber'))).toBe(true)
    await write(join(p.root, 'paper/main.tex'), '\\documentclass{article}\\bibliography{refs}')
    processes.passesBeforeFailure = 1
    processes.noLog = true
    const partial = await run({ action: 'compile', engine: 'pdflatex' })
    expect(partial.message).toMatch(/PDF built/)
    expect(partial.content).toMatch(/Emergency stop/)
    expect(processes.calls.some(call => call.command.includes('bibtex'))).toBe(true)
    processes.passesBeforeFailure = undefined
    processes.noLog = false
    await write(join(p.root, 'main.tex'), '\\documentclass{article}')
    expect((await run({ action: 'compile', path: 'main.tex', engine: 'pdflatex' })).path).toMatch(/\.pdf$/)
  })

  it('sends pages to a separate vision model only when one is configured, and generates images under the fixed credential', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-media-'))
    const harness = await boot(new MemoryMediaPool())
    const { service } = harness
    await service.configure({ python: 'python', texBin: join(root, 'tex') })
    const p = await service.create({ title: 'Media', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    await write(join(p.root, 'paper/main.tex'), '\\documentclass{article}')
    await write(join(p.root, 'figures/a.png'), 'png')
    await write(join(p.root, 'figures/a.svg'), '<svg/>')
    await run({ action: 'register-artifact', path: 'figures/a.png', kind: 'figure' })
    await run({ action: 'register-artifact', path: 'figures/a.svg', kind: 'figure' })
    const [png, svg] = service.getProject(p.id).artifacts
    await write(join(p.root, 'figures/b.jpg'), 'jpg')
    await write(join(p.root, 'figures/c.webp'), 'webp')
    await run({ action: 'register-artifact', path: 'figures/b.jpg', kind: 'figure' })
    await run({ action: 'register-artifact', path: 'figures/c.webp', kind: 'figure' })
    const photos = service.getProject(p.id).artifacts.filter(a => /\.(jpg|webp)$/.test(a.path))
    expect((await run({ action: 'visual-review', artifactId: png!.id })).message).toMatch(/No separate vision model/)
    await expect(run({ action: 'visual-review', artifactId: 'nope' })).rejects.toThrow(/not found/)
    await service.configure({ python: 'python', texBin: join(root, 'tex'), vision: { provider: 'p', model: 'v' } })
    const started = await run({ action: 'visual-review', artifactId: png!.id })
    expect(started.content).toBe('session-2')
    expect(JSON.stringify(harness.prompts.at(-1))).toMatch(/complete-visual-review/)
    await expect(run({ action: 'visual-review', artifactId: svg!.id })).rejects.toThrow(/Compile the manuscript/)
    await run({ action: 'compile', engine: 'pdflatex' })
    const manuscript = service.getProject(p.id).artifacts.find(a => a.kind === 'manuscript')!
    await run({ action: 'visual-review', artifactId: manuscript.id })
    for (const photo of photos) await run({ action: 'visual-review', artifactId: photo.id })
    expect(JSON.stringify(harness.prompts.slice(-2))).toMatch(/image\/jpeg.*image\/webp/s)
    await expect(run({ action: 'complete-visual-review', artifactId: png!.id, artifactRevision: 9, sessionId: 'session-2', findings: 'x' })).rejects.toThrow(/not pending/)
    await run({ action: 'complete-visual-review', artifactId: png!.id, artifactRevision: 1, sessionId: 'session-2', findings: 'Legible' })
    expect(service.getProject(p.id).visualReviews.find(r => r.sessionId === 'session-2')?.status).toBe('reviewed')
    await run({ action: 'visual-review', artifactId: png!.id })
    await run({ action: 'visual-review', artifactId: png!.id })
    const pngReviews = service.getProject(p.id).visualReviews.filter(r => r.artifactId === png!.id)
    expect(pngReviews.map(r => r.status)).toEqual(['not-configured', 'reviewed', 'failed', 'pending'])
    expect(pngReviews[2]?.findings).toMatch(/Superseded/)

    await expect(run({ action: 'generate-image', prompt: 'x', path: 'figures/g.png' })).rejects.toThrow(/Configure an image/)
    await expect(service.setImageCredential('key')).rejects.toThrow(/Configure the image provider/)
    await service.configure({ python: 'python', image: { baseUrl: 'https://img.example/v1/', model: 'm', size: '1024x1024' } })
    await expect(service.setImageCredential('  ')).rejects.toThrow(/empty/)
    await expect(run({ action: 'generate-image', prompt: 'x', path: 'figures/g.png' })).rejects.toThrow(/credential has not been configured/)
    await service.setImageCredential(' secret ')
    expect([...harness.credentials.entries()]).toEqual([[IMAGE_CREDENTIAL, 'secret']])
    const fetches: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      fetches.push(url)
      if (init?.method === 'POST') return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }))
      return new Response('bytes')
    }))
    await expect(run({ action: 'generate-image', prompt: 'x', path: 'figures/g.gif' })).rejects.toThrow(/\.png/)
    expect((await run({ action: 'generate-image', prompt: 'x', path: 'figures/g.png' })).path).toBe('figures/g.png')
    expect(fetches[0]).toBe('https://img.example/v1/images/generations')
    expect(await readFile(join(p.root, 'figures/g.png'), 'utf8')).toBe('image')
    await expect(run({ action: 'generate-image', prompt: 'x', path: 'figures/g.png' })).rejects.toThrow(/new image path/)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Response(JSON.stringify({ data: [{ url: 'https://img.example/file.png' }] }))
      : new Response('downloaded')))
    await run({ action: 'generate-image', prompt: 'x', path: 'figures/h.png' })
    expect(await readFile(join(p.root, 'figures/h.png'), 'utf8')).toBe('downloaded')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{}] }))))
    await expect(run({ action: 'generate-image', prompt: 'x', path: 'figures/i.png' })).rejects.toThrow(/no image/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    await expect(run({ action: 'generate-image', prompt: 'x', path: 'figures/i.png' })).rejects.toThrow(/HTTP 500/)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Response(JSON.stringify({ data: [{ url: 'https://img.example/file.png' }] }))
      : new Response('x', { status: 404 })))
    await expect(run({ action: 'generate-image', prompt: 'x', path: 'figures/i.png' })).rejects.toThrow(/could not be retrieved/)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => new Response(init?.method === 'POST' ? JSON.stringify({ data: [{ b64_json: Buffer.alloc(200001).toString('base64') }] }) : '')))
    await expect(run({ action: 'generate-image', prompt: 'x', path: 'figures/i.png' })).rejects.toThrow(/size limit/)
    expect(basename(join(p.root, 'figures/i.png'))).toBe('i.png')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-length': String(10 ** 9) } })))
    await expect(run({ action: 'generate-image', prompt: 'x', path: 'figures/j.png' })).rejects.toThrow(/size limit/)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Response(JSON.stringify({ data: [{ url: 'https://img.example/file.png' }] }))
      : new Response('x', { headers: { 'content-length': String(10 ** 9) } })))
    await expect(run({ action: 'generate-image', prompt: 'x', path: 'figures/j.png' })).rejects.toThrow(/size limit/)
  })

  it('observes running experiments in the background and survives one failing project', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-poll-'))
    const { service } = await boot(new MemoryMediaPool())
    await service.configure({ python: 'python', uv: 'uv' })
    const p = await service.create({ title: 'Poll', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    await run({ action: 'environment', environment: { name: 'env', kind: 'uv', target: 'local', python: '', requirements: [], isDefault: true } })
    await write(join(p.root, 'code/train.py'), 'print(1)')
    const environmentId = service.getProject(p.id).environments[0]!.id
    const requestId = '33333333-3333-4333-8333-333333333333'
    // While one poll is stuck on a slow observation, the next tick skips instead of piling on.
    const release = hold('status')
    await run({ action: 'experiment', requestId, spec: { environmentId, name: 't', argv: ['{python}', 'code/train.py'], cwd: '.', seed: 0, maxSeconds: 5, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' } })
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(processes.calls.filter(call => call.args[1] === 'status')).toHaveLength(1)
    release()
    await vi.waitFor(() => { expect(service.getProject(p.id).experiments[0]?.status).toBe('completed') }, { timeout: 5000 })
  })

  it('marks interrupted work, restores legacy sessions and finds the innermost project after a restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-restart-'))
    const pool = new MemoryMediaPool()
    const first = await boot(pool)
    await first.service.configure({ texBin: join(root, 'tex') })
    const a = await first.service.create({ title: 'A', root: join(root, 'a'), brief: '' })
    const b = await first.service.create({ title: 'B', root: join(root, 'b'), brief: '' })
    const inner = await first.service.create({ title: 'Inner', root: join(a.root, 'inner'), brief: '' })
    await mkdir(join(inner.root, 'deep'), { recursive: true })
    expect((await first.service.projectAt(join(inner.root, 'deep')))?.id).toBe(inner.id)
    // A desktop job still running when the app shuts down ends as interrupted, not failed.
    await write(join(a.root, 'paper/main.tex'), '\\documentclass{article}')
    const release = hold('latex')
    const job = await first.service.command({ action: 'compile', projectId: a.id, engine: 'pdflatex' } as never, signal)
    await vi.waitFor(() => { expect(processes.calls.some(call => call.command.includes('pdflatex'))).toBe(true) })
    const disposing = ctx!.fiber.dispose(); ctx = undefined
    release()
    await disposing
    // What a killed app and an older build leave behind: a task still marked running, projects without a session.
    for (const medium of pool.media.values()) {
      medium.tables.get('tasks')?.set('killed', { id: 'killed', kind: 'compile', projectId: a.id, status: 'running', message: 'compile', createdAt: '2026-09-23T00:00:00.000Z' })
      const projects = medium.tables.get('projects')
      for (const id of [a.id, b.id]) {
        const { sessionId: _session, ...legacy } = (projects?.get(id) ?? {}) as Record<string, unknown>
        if (projects?.has(id)) projects.set(id, legacy)
      }
    }
    const second = await boot(pool)
    expect(second.service.tasks().find(task => task.id === job.jobId)?.status).toBe('interrupted')
    const killed = second.service.tasks().find(task => task.id === 'killed')
    expect(killed?.status).toBe('interrupted')
    expect(killed?.message).toMatch(/restarted/)
    expect((await second.service.create({ title: 'A', root: a.root, brief: '' })).sessionId).toBe('session-1')
    expect((await second.service.createProject({ title: 'B', root: b.root, brief: '' }, 'agent-b')).sessionId).toBe('agent-b')
  })

  it('installs components as jobs, answers desktop commands, and keeps a failed change from blocking the next', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-components-'))
    await write(join(root, 'components/drawio/.complete'), 'pinned')
    const { service } = await boot(new MemoryMediaPool())
    await service.configure({ uv: 'uv' })
    const drawio = await service.installComponent('drawio')
    const uv = await service.installComponent('uv')
    await vi.waitFor(() => { expect(service.tasks().find(task => task.id === uv.jobId)?.result?.path).toBe('uv') })
    await vi.waitFor(() => { expect(service.tasks().find(task => task.id === drawio.jobId)?.result?.path).toBe(join(root!, 'components/drawio')) })
    const p = await service.create({ title: 'Queue', root: join(root, 'p'), brief: '' })
    const [refused, recorded] = await Promise.allSettled([
      service.command({ action: 'save-artifact', projectId: p.id, path: '.research/x', content: 'x', kind: 'code', evidence: [], claimIds: [], inputArtifacts: [] } as never, signal),
      service.command({ action: 'record-decision', projectId: p.id, question: 'Q', answer: 'A' } as never, signal),
    ])
    expect(refused.status).toBe('rejected')
    expect(recorded.status).toBe('fulfilled')
    expect(service.getProject(p.id).decisions).toMatchObject([{ answer: 'A', by: 'user' }])
  })

  it('collects remote results, records collection failures, and keeps observing past a broken project', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-remote-'))
    const pool = new MemoryMediaPool()
    const firstBoot = await boot(pool)
    const broken = await firstBoot.service.create({ title: 'Broken', root: join(root, 'broken'), brief: '' })
    await ctx!.fiber.dispose(); ctx = undefined
    const ghost = {
      id: 'ghost-run', status: 'running', createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z', directory: 'ghost-dir', inputRevision: 1,
      environmentFingerprint: 'ghost', metrics: {}, message: '', snapshotPath: 'ghost/inputs.json', collected: false,
      spec: { environmentId: 'ghost', name: 'g', argv: ['{python}'], cwd: '.', seed: 0, maxSeconds: 1, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'm' },
    }
    for (const medium of pool.media.values()) {
      const projects = medium.tables.get('projects')
      const stored = projects?.get(broken.id) as ResearchProject | undefined
      if (projects && stored) projects.set(broken.id, { ...stored, experiments: [ghost] })
    }
    const { service } = await boot(pool)
    const reply = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: '' })
    processes.ssh = (args) => {
      if (args.some(arg => arg.includes('importlib.metadata'))) return reply('{"executable":"/usr/bin/python3"}')
      if (args.some(arg => arg.endsWith('experiment_runner.py'))) return reply(args.includes('launch') ? '{"status":"running"}' : '{"status":"completed","message":"done"}')
      return reply(args.some(arg => arg.includes('rglob')) ? 'not json' : '{}')
    }
    const p = await service.create({ title: 'Remote', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    await run({ action: 'environment', environment: { name: 'gpu', kind: 'existing', target: 'ssh', python: '/usr/bin/python3', sshHost: 'gpu', remoteRoot: '/data/research', requirements: [], isDefault: true } })
    const environmentId = service.getProject(p.id).environments[0]!.id
    const requestId = '66666666-6666-4666-8666-666666666666'
    await run({ action: 'experiment', requestId, spec: { environmentId, name: 'remote', argv: ['{python}', 'train.py'], cwd: '.', seed: 0, maxSeconds: 5, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' } })
    const waited = await run({ action: 'experiment-wait', runIds: [requestId], timeoutSeconds: 5 })
    expect(waited.runs?.[0]?.status).toBe('completed')
    const collected = service.getProject(p.id).experiments[0]!
    expect(collected.collected).toBe(true)
    expect(collected.message).toMatch(/^done; outputs could not be collected/)
    processes.ssh = (args) => {
      if (args.some(arg => arg.includes('importlib.metadata'))) return reply('{"executable":"/usr/bin/python3"}')
      if (args.some(arg => arg.endsWith('experiment_runner.py'))) return reply(args.includes('launch') ? '{"status":"running"}' : '{"status":"completed"}')
      return reply(args.some(arg => arg.includes('rglob')) ? 'not json' : '{}')
    }
    const silent = '99999999-9999-4999-8999-999999999999'
    await run({ action: 'experiment', requestId: silent, spec: { environmentId, name: 'silent', argv: ['{python}', 'train.py'], cwd: '.', seed: 0, maxSeconds: 5, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' } })
    await run({ action: 'experiment-wait', runIds: [silent], timeoutSeconds: 5 })
    expect(service.getProject(p.id).experiments.find(r => r.id === silent)?.message).toMatch(/^outputs could not be collected/)
    // A background poll passes over the project whose run lost its environment, and the service keeps running.
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(service.getProject(broken.id).experiments[0]?.status).toBe('running')
    const cancelled = new AbortController()
    processes.ssh = args => reply(args.some(arg => arg.endsWith('experiment_runner.py')) ? '{"status":"running"}' : '{}')
    const second = '77777777-7777-4777-8777-777777777777'
    await run({ action: 'experiment', requestId: second, spec: { environmentId, name: 'long', argv: ['{python}', 'train.py'], cwd: '.', seed: 0, maxSeconds: 5, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' } })
    const waiting = service.execute({ projectId: p.id, action: 'experiment-wait', runIds: [second], timeoutSeconds: 30 } as never, cancelled.signal, 'agent')
    setTimeout(() => { cancelled.abort() }, 50)
    await expect(waiting).rejects.toThrow(/cancelled/)
  })

  it('keeps the project responsive while slow work runs outside its lock', async () => {
    root = await mkdtemp(join(tmpdir(), 'research-lock-'))
    const { service } = await boot(new MemoryMediaPool())
    await service.configure({ python: 'python', uv: 'uv', texBin: join(root, 'tex') })
    const p = await service.create({ title: 'Lock', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    await write(join(p.root, 'paper/main.tex'), '\\documentclass{article}')
    const releaseCompile = hold('latex')
    const compiling = run({ action: 'compile', engine: 'pdflatex' })
    await vi.waitFor(() => { expect(processes.calls.some(call => call.command.includes('pdflatex'))).toBe(true) })
    expect((await run({ action: 'save-artifact', path: 'paper/notes.md', content: 'while compiling', kind: 'supplement' })).message).toMatch(/revision 1/)
    releaseCompile()
    expect((await compiling).message).toMatch(/PDF built/)
    expect(service.getProject(p.id).compilations).toHaveLength(1)
    expect(service.getProject(p.id).artifacts.map(a => a.path).sort()).toEqual(['paper/main.tex', 'paper/notes.md'])

    await run({ action: 'environment', environment: { name: 'env', kind: 'uv', target: 'local', python: '', requirements: [], isDefault: true } })
    await write(join(p.root, 'code/train.py'), 'print(1)')
    await run({ action: 'register-artifact', path: 'code/train.py', kind: 'code' })
    const code = service.getProject(p.id).artifacts.find(a => a.path === 'code/train.py')!
    await write(join(p.root, 'code/train.py'), 'print(2)')
    const environmentId = service.getProject(p.id).environments[0]!.id
    const spec = { environmentId, name: 't', argv: ['{python}', 'code/train.py'], cwd: '.', seed: 0, maxSeconds: 5, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [code.id], metricsPath: 'metrics.json' }
    const requestId = '44444444-4444-4444-8444-444444444444'
    processes.runner = { status: 'running' }
    const releaseLaunch = hold('launch')
    const submitting = run({ action: 'experiment', requestId, spec })
    await vi.waitFor(() => { expect(processes.calls.some(call => call.args[1] === 'launch')).toBe(true) })
    // The edit made outside the research tools is adopted when the run is admitted.
    expect(service.getProject(p.id).artifacts.find(a => a.id === code.id)?.revision).toBe(2)
    await expect(run({ action: 'experiment-dismiss', runId: requestId })).rejects.toThrow(/being submitted/)
    await expect(run({ action: 'experiment-refresh', runId: requestId })).rejects.toThrow(/being submitted/)
    // A background poll passes while the launch is under way and leaves the run alone.
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(processes.calls.some(call => call.args[1] === 'status')).toBe(false)
    releaseLaunch()
    expect((await submitting).runs?.[0]).toMatchObject({ status: 'running' })

    processes.runner = { status: 'unknown', message: 'lost' }
    await run({ action: 'experiment-refresh', runId: requestId })
    processes.runner = { status: 'running' }
    const releaseStatus = hold('status')
    const refreshing = run({ action: 'experiment-refresh', runId: requestId })
    await run({ action: 'experiment-dismiss', runId: requestId })
    releaseStatus()
    // The observation made before the dismissal does not bring the run back.
    expect((await refreshing).runs?.[0]).toMatchObject({ status: 'interrupted' })

    processes.launchFails = true
    const failed = await run({ action: 'experiment', requestId: '55555555-5555-4555-8555-555555555555', spec })
    expect(failed.runs?.[0]).toMatchObject({ status: 'unknown' })
    expect(failed.runs?.[0]?.message).toMatch(/requires inspection/)
    processes.runner = { status: 'cancelled' }
    expect((await run({ action: 'experiment-cancel', runId: '55555555-5555-4555-8555-555555555555' })).message).toBe('cancelled')
    await run({ action: 'environment', environment: { name: 'spare', kind: 'existing', target: 'local', python: 'C:/py/python.exe', requirements: [], isDefault: false } })
    expect(service.getProject(p.id).environments.map(e => e.isDefault)).toEqual([true, false])
  })
})
