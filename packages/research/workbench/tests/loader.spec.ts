import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ResearchKnowledge from '../src/knowledge-plugin.ts'
import ResearchKnowledgeMap, { MAX_LIBRARY } from '../src/knowledge-map-plugin.ts'
import { appendRecall } from '../src/knowledge-recall-log.ts'
import { PROJECT_GRAPH } from '../src/knowledge.ts'
import ResearchKnowledgeEvidence from '../src/knowledge-evidence-plugin.ts'
import ResearchKnowledgeMemory from '../src/knowledge-memory-plugin.ts'
import ResearchKnowledgeRelations from '../src/knowledge-relations-plugin.ts'
import type { CarriedMemory } from '../src/knowledge-memory.ts'
import { pathToFileURL } from 'node:url'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as DomainPlugin from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, parse, toNamespacedPath } from 'node:path'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionCreateRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { ProcessOptions, ProcessResult } from '../src/process.ts'
import type { ResearchProject } from '../src/types.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { draftFolderName } from '../src/drafts.ts'
import { RESEARCH_TOOL_MODULES, type ResearchToolModule } from '../src/tools.ts'

/** Every child process the service starts, answered by a scripted stand-in. */
const processes = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[]; options?: unknown }[],
  runner: { status: 'completed', metrics: { accuracy: 0.8123 } } as Record<string, unknown>,
  launch: { status: 'running' } as Record<string, unknown>,
  compileFails: false,
  launchFails: false,
  /** Compile variants: a missing style on the first pass, a pass that fails, no final log. */
  missingSty: false,
  /** Outputs of the next failing engine passes, and of the next bibtex runs. */
  latexFailures: [] as string[],
  bibtexOutputs: [] as string[],
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
      if (args[0] === '--version' && /bibtex/.test(path.basename(command))) return ok('BibTeX 0.99d (TeX Live 2026)')
      if (args[0] === '--version' && /latex/.test(path.basename(command))) {
        const engine = path.basename(command).startsWith('xe') ? 'XeTeX' : path.basename(command).startsWith('lua') ? 'LuaHBTeX' : 'pdfTeX'
        return ok(`${engine} (TeX Live 2026)`)
      }
      if (args[0] === '-c' && joined.includes('importlib.metadata')) return ok(JSON.stringify({ executable: command, version: '3.12' }))
      if (args[0] === '-c') return ok('ready')
      if (joined.includes('experiment_runner.py')) {
        await processes.holds.get(String(args[1]))
        if (args[1] === 'launch' && processes.launchFails) throw new Error('spawn failed')
        const state = args[1] === 'launch' ? processes.launch : processes.runner
        return ok(JSON.stringify(state))
      }
      if (joined.includes('documents.py') && args[1] === 'render') {
        const destination = String(args[args.indexOf('--output') + 1])
        await make(destination, { recursive: true })
        await write(path.join(destination, 'page-001.png'), 'png')
        return ok(JSON.stringify([path.join(destination, 'page-001.png')]))
      }
      if (joined.includes('documents.py')) return ok(processes.extracted ?? JSON.stringify([{ text: 'metric,value\naccuracy,0.8123', locator: { line: 1 } }]))
      if (joined.includes('run_gate.py')) return ok(JSON.stringify({ findings: [{ severity: 'error', message: `${String(args[4])} found a problem`, file: 'blueprint.json' }] }))
      if (joined.includes('audit_svg.py')) {
        const target = String(args[args.indexOf('--json') + 1])
        await make(path.dirname(target), { recursive: true })
        const clean = !joined.includes('messy')
        await write(target, JSON.stringify({ ok: clean, svg: 'abs', stats: {}, errors: clean ? [] : [{ code: 'text_overlap', detail: 'd' }], warnings: [] }))
        return { code: clean ? 0 : 1, stdout: '', stderr: '' }
      }
      if (joined.includes('export_figure.py')) {
        const bare = joined.includes('bare')
        return ok(JSON.stringify({
          pdf: args[5], previews: [path.join(String(args[6]), 'x.1440.png')], fonts: bare ? [] : ['Times-Roman'],
          embedded: joined.includes('arch.svg'), text: !bare, images: 0, markers: bare ? 0 : 1,
        }))
      }
      if (joined.includes('assemble_paper.py')) return { code: 0, stdout: '{"ok": true}', stderr: 'copied ts_iieta.sty' }
      if (joined.includes('blueprint_lint.py')) return { code: 1, stdout: '{"ok": false}', stderr: '' }
      if (/latex|biber|bibtex/.test(path.basename(command))) {
        await processes.holds.get('latex')
        const output = args.find(arg => arg.startsWith('-output-directory='))?.slice('-output-directory='.length) ?? ''
        const stem = String(args.at(-1)).replace(/\.tex$/, '')
        const build = path.resolve(options.cwd ?? '.', output)
        if (/biber|bibtex/.test(path.basename(command))) return ok(processes.bibtexOutputs.shift() ?? '')
        if (processes.compileFails || !output) return { code: 1, stdout: '! Undefined control sequence.', stderr: '' }
        if (processes.missingSty) { processes.missingSty = false; return { code: 1, stdout: '! LaTeX Error: File `venue.sty\' not found.', stderr: '' } }
        const failure = processes.latexFailures.shift()
        if (failure !== undefined) return { code: 1, stdout: failure, stderr: '' }
        if (processes.passesBeforeFailure === 0) return { code: 1, stdout: '! Emergency stop.', stderr: '' }
        if (processes.passesBeforeFailure !== undefined) processes.passesBeforeFailure--
        const source = await read(path.resolve(options.cwd ?? '.', `${stem}.tex`), 'utf8')
        if (source.includes('biblatex')) await write(path.join(build, `${stem}.bcf`), 'bcf')
        else if (source.includes('\\bibliography')) await write(path.join(build, `${stem}.aux`), '\\bibdata{refs}')
        await write(path.join(build, `${stem}.pdf`), '%PDF-1.7\nfixture content\n%%EOF\n')
        if (!processes.noLog) await write(path.join(build, `${stem}.log`), 'LaTeX Warning: Citation `x\' undefined\nOverfull \\hbox')
        return ok('')
      }
      return ok('')
    },
  }
})

/** Makes removing a discarded draft's empty folders fail, as a folder another program holds open does. */
const draftFolders = vi.hoisted(() => ({ removeFails: false }))
vi.mock('../src/drafts.ts', async (original) => {
  const actual = await original<typeof import('../src/drafts.ts')>()
  return {
    ...actual,
    removeEmptyScaffold: async (root: string, createdRoot: boolean) => {
      if (draftFolders.removeFails) throw new Error('EBUSY: resource busy or locked')
      await actual.removeEmptyScaffold(root, createdRoot)
    },
  }
})

const { default: ResearchWorkbench, EMBEDDING_CREDENTIAL, IMAGE_CREDENTIAL } = await import('../src/index.ts')
const AgentTools = await import('../src/agent-tools.ts')
const ModeSkills = await import('../src/mode-skills.ts')
const { default: SkillRegistry } = await import('@deepseek-ai/dsh-skill')

let ctx: Context | undefined
let root: string | undefined
const signal = new AbortController().signal

/** Projects use the same canonical, non-system roots accepted by the real service. */
async function temporaryRoot(prefix: string): Promise<string> {
  const parent = process.platform === 'win32' ? tmpdir() : homedir()
  return realpath(await mkdtemp(join(parent, prefix)))
}
beforeEach(() => {
  processes.calls.length = 0; processes.runner = { status: 'completed', metrics: { accuracy: 0.8123 } }
  processes.launch = { status: 'running' }
  processes.compileFails = false; processes.launchFails = false; processes.holds.clear()
  processes.missingSty = false; processes.passesBeforeFailure = undefined; processes.noLog = false
  processes.latexFailures.length = 0; processes.bibtexOutputs.length = 0
  processes.ssh = undefined; processes.extracted = undefined
  draftFolders.removeFails = false
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
  vi.unstubAllEnvs()
  if (root) await rm(root, { recursive: true }); root = undefined
})

/** A registered folder as the research service sees it. */
interface FakeWorkspace { id: WorkspaceId; title: string; setTitle(title: string): Promise<void> }
/** A live session as the research service reads it: its id and header. */
interface FakeSession { id: string; header: { cwd?: string; origin?: 'subagent' } }
/** A live agent as the research service reads it: its session. */
interface FakeAgent { session: FakeSession }

interface Harness {
  service: InstanceType<typeof ResearchWorkbench>
  registry: Map<string, unknown>
  prompts: unknown[]
  sessions: string[]
  /** Preset explicitly requested for every newly created research conversation. */
  sessionPresets: (string | undefined)[]
  credentials: Map<string, string>
  /** Registered folders by id, one per project root. */
  workspaces: Map<WorkspaceId, FakeWorkspace>
  /** The live agents, and the goal (or the error) the goal service answers for each session. */
  agents: FakeAgent[]
  goals: Map<string, GoalView | Error>
  /** The permission preset last applied to each session, by session id. */
  applied: Map<string, string>
  /** Publish a session, as the session store does: it becomes live and `session/created` is emitted. */
  open: (session: FakeSession) => void
  /** Sessions whose first turn has started, so the session list reads them as not blank. */
  turns: Set<string>
  /** Sessions archived through the Workspace registry, in order. */
  archived: string[]
  /** Set to make the session list fail, as a persistence read can. */
  listing: { failure?: Error | undefined }
  /** A late archive failure and an optional restoration failure. */
  archiving: { failOn?: string; restoreFailOn?: string }
}

interface BootOptions {
  knowledge?: boolean
  /** Whether the domain map and evidence graph rows are in the composition; both are by default. */
  knowledgeMap?: boolean
  knowledgeEvidence?: boolean
  knowledgeMemory?: boolean
  knowledgeRelations?: boolean
  componentRoot?: boolean
  /** Sessions already live when the service starts. */
  live?: FakeSession[]
  /** The presets the permission row configures. */
  presets?: string[]
  /** The service's configured research home. */
  researchHome?: string
  /** Independent tool-family plugin declarations. */
  toolModules?: ResearchToolModule[][]
  /** Explicit home alias used to exercise protected legacy locations on restart. */
  dataHome?: string
  /** Runs while the initializer's private request identity is outstanding. */
  beforeExampleCreate?: (request: SessionCreateRequest, context: Context) => Promise<void>
}

/** Seed histories persist between Loader restarts, independent of attached Session instances. */
const exampleHistories = new WeakMap<MemoryMediaPool, Map<string, readonly SessionEvent[]>>()
/** Observe official append results instead of invoking deprecated synchronous Session history readers. */
const exampleAppendReceipts = vi.spyOn(Session.prototype, 'append')

async function boot(pool: MemoryMediaPool, options: BootOptions = {}): Promise<Harness> {
  if (root === undefined) throw new Error('Loader fixture needs an isolated root')
  vi.stubEnv('DSH_HOME', options.dataHome ?? join(root, 'dsh-home'))
  for (const engine of ['pdflatex', 'xelatex', 'lualatex']) {
    await write(join(root, 'tex', process.platform === 'win32' ? `${engine}.exe` : engine), '')
  }
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root ?? '').href + '/'
  const messages: typeof logs = []
  logs = messages
  // The default exporter keeps errors and information only; warnings are kept here too.
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { messages.push(message) } })
  const prompts: unknown[] = []
  const sessions: string[] = []
  const sessionPresets: (string | undefined)[] = []
  const credentials = new Map<string, string>()
  const workspaces = new Map<WorkspaceId, FakeWorkspace>()
  const agents: FakeAgent[] = []
  const goals = new Map<string, GoalView | Error>()
  const live: FakeSession[] = [...options.live ?? []]
  const attachedExamples = new Map<string, Session>()
  const initialPrefixes = new WeakMap<Session, readonly SessionEvent[]>()
  const histories = exampleHistories.get(pool) ?? new Map<string, readonly SessionEvent[]>()
  exampleHistories.set(pool, histories)
  const exampleEvents = (session: Session): readonly SessionEvent[] => [
    ...initialPrefixes.get(session) ?? [],
    ...exampleAppendReceipts.mock.results.flatMap((result, index) =>
      exampleAppendReceipts.mock.contexts[index] === session && result.type === 'return' ? [result.value] : []),
  ]
  const applied = new Map<string, string>()
  const turns = new Set<string>()
  const archived: string[] = []
  const listing: Harness['listing'] = {}
  const archiving: Harness['archiving'] = {}
  let open = (_session: FakeSession): void => {}
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['storage', Storage], ['domain', DomainPlugin], ['research', ResearchWorkbench], ['research-tools', AgentTools], ['research-mode-skills', ModeSkills], ['research-knowledge-provider', ResearchKnowledge],
    ['research-knowledge-map', ResearchKnowledgeMap], ['research-knowledge-evidence', ResearchKnowledgeEvidence],
    ['research-knowledge-memory', ResearchKnowledgeMemory], ['research-knowledge-relations', ResearchKnowledgeRelations],
    ['skills', SkillRegistry], ['system-prompt', SystemPrompt], ['tools', ToolRuntime],
    ['adapters', { inject: ['storage'], apply(c: Context) {
      const backend = new MemoryStorageBackend(pool)
      c.storage.backend.register('memory', backend)
      c.provide(storageBackendServiceKey('memory'), backend)
      c.provide('workspaceRegistry', {
        create: async (path: string, title: string) => {
          const workspace: FakeWorkspace = { id: `workspace:${path}` as WorkspaceId, title, setTitle: async (next) => { workspace.title = next } }
          workspaces.set(workspace.id, workspace)
          return workspace
        },
        get: (id: WorkspaceId) => workspaces.get(id),
        list: () => [...workspaces.values()],
        delete: async (id: WorkspaceId) => workspaces.delete(id),
        // As the registry does: archiving an archived session, or unarchiving one that is not, writes nothing.
        archiveSession: async (id: string) => {
          if (id === archiving.failOn) throw new Error('Session became active')
          if (!archived.includes(id)) archived.push(id)
        },
        unarchiveSession: async (id: string) => {
          if (id === archiving.restoreFailOn) throw new Error('Archive storage is unavailable')
          if (archived.includes(id)) archived.splice(archived.indexOf(id), 1)
        },
        get archivedSessionIds() { return [...archived] },
      } as unknown as Context['workspaceRegistry'])
      c.provide('agents', { list: () => agents } as unknown as Context['agents'])
      c.provide('goals', {
        get: (agent: FakeAgent) => {
          const goal = goals.get(agent.session.id)
          if (goal instanceof Error) throw goal
          return goal
        },
      } as unknown as Context['goals'])
      open = (session) => {
        live.push(session)
        c.emit('session/created', session as unknown as Session)
      }
      c.provide('sessions', {
        list: () => [...live],
        get: (id: string) => attachedExamples.get(id),
        flush: async (session: Session) => {
          histories.set(session.id, exampleEvents(session))
          return true
        },
      } as unknown as Context['sessions'])
      c.provide('permissionPresets', {
        names: options.presets ?? ['read-only', 'workspace-write', 'research-auto'],
        set: (session: FakeSession, name: string) => {
          if (session.id === 'unreadable') throw new Error('permission: permissions session projection is not registered')
          applied.set(session.id, name)
        },
      } as unknown as Context['permissionPresets'])
      c.provide('sessionController', {
        create: async (request: SessionCreateRequest) => {
          const { workspaceId, agentPreset, sessionId } = request
          const cwd = workspaceId?.slice('workspace:'.length) ?? request.cwd ?? root!
          const header: SessionHeader | undefined = sessionId === undefined ? undefined : {
            version: SESSION_FORMAT_VERSION, id: sessionId, cwd, createdAt: 1, isSeeded: false,
          }
          if (sessionId !== undefined) await options.beforeExampleCreate?.(request, c)
          const existing = sessionId === undefined ? undefined
            : attachedExamples.get(sessionId)?.header ?? (histories.has(sessionId) ? header : undefined)
          await c.waterfall('api-session/command-admission', {
            operation: 'create', sessionId: sessionId ?? SessionId(`session-${sessions.length + 1}`), cwd, request,
            ...(existing === undefined ? {} : { existing }),
          }, () => Promise.resolve())
          if (sessionId !== undefined) {
            if (!attachedExamples.has(sessionId)) {
              const session = Session.create(sessionId, histories.get(sessionId), header)
              initialPrefixes.set(session, histories.get(sessionId) ?? [])
              attachedExamples.set(sessionId, session)
              open(session)
            }
            return { sessionId }
          }
          const id = `session-${sessions.length + 1}`
          sessions.push(id)
          sessionPresets.push(agentPreset)
          open({ id, header: { cwd } })
          return { sessionId: id as SessionId }
        },
        inspect: async (id: string) => {
          const session = attachedExamples.get(id)
          if (session === undefined) throw new Error(`No fixture Session: ${id}`)
          return { meta: session.header, events: exampleEvents(session) }
        },
        selectModel: async () => {},
        prompt: async (request: unknown) => { prompts.push(request) },
        list: async () => {
          if (listing.failure) throw listing.failure
          return {
            items: live.map(session => ({
              sessionId: session.id, updatedAt: 0, running: false, blank: !turns.has(session.id),
              ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
              ...(session.header.origin === undefined ? {} : { origin: session.header.origin }),
            })),
          }
        },
      } as unknown as Context['sessionController'])
      c.provide('credentials', {
        set: async (ref: string, value: string) => { credentials.set(ref, value) },
        resolve: async (ref: string) => credentials.has(ref) ? { value: credentials.get(ref) } : undefined,
      } as unknown as Context['credentials'])
      c.provide('llm', {} as Context['llm'])
    } }],
  ])
  ctx.loader.internal = { version: 'v2', async import(name: string) { if (!modules.has(name)) throw new Error(name); return modules.get(name) } } as unknown as NonNullable<typeof ctx.loader.internal>
  const configuration = join(root ?? '', 'cordis.yml')
  await writeFile(configuration, [
    '- name: storage', '- name: adapters', '- name: domain', '  config:', '    backend: memory',
    '- name: skills', '- name: system-prompt', '- name: tools',
    ...(options.knowledge === false ? [] : ['- id: knowledge-provider', '  name: research-knowledge-provider']),
    ...(options.knowledgeMap === false ? [] : ['- id: knowledge-map', '  name: research-knowledge-map']),
    ...(options.knowledgeEvidence === false ? [] : ['- id: knowledge-evidence', '  name: research-knowledge-evidence']),
    ...(options.knowledgeMemory === false ? [] : ['- id: knowledge-memory', '  name: research-knowledge-memory']),
    ...(options.knowledgeRelations === false ? [] : ['- id: knowledge-relations', '  name: research-knowledge-relations', '  config:', '    pauseMs: 1']),
    ...(options.toolModules ?? [[...RESEARCH_TOOL_MODULES]]).flatMap((modules, index) => [
      `- id: research-tools-${index}`, '  name: research-tools', '  config:', `    modules: ${JSON.stringify(modules)}`,
    ]),
    '- id: research-mode-skills', '  name: research-mode-skills',
    '- name: research', '  config:', '    maxSourceBytes: 100000', '    pollIntervalMs: 500', '    maxReviewPages: 4',
    ...options.componentRoot === false ? [] : [`    componentRoot: ${JSON.stringify(join(root ?? '', 'components'))}`],
    ...options.researchHome === undefined ? [] : [`    researchHome: ${JSON.stringify(options.researchHome)}`],
  ].join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configuration).href } })
  await ctx.loader.await()
  return {
    service: ctx.research, registry: new Map(ctx.tools.schemas().map(tool => [tool.name, tool])),
    prompts, sessions, sessionPresets, credentials, workspaces, agents, goals, applied,
    open: (session) => { open(session) }, turns, archived, listing, archiving,
  }
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** Every message the current context logged, whatever its level. */
let logs: { type: string; args: unknown[] }[] = []

/** Whether the current context logged a message of this type whose arguments, joined, contain the text. */
function logged(type: 'warn' | 'error', text: string): boolean {
  return logs.some(message => message.type === type && message.args.map(String).join(' ').includes(text))
}

describe('the research service records; it never drives the agent', () => {
  it('admits only the initializer request and existing registered example adoptions', async () => {
    root = await temporaryRoot('research-example-session-admission-')
    const pool = new MemoryMediaPool()
    let races = 0
    const first = await boot(pool, {
      beforeExampleCreate: async (request, context) => {
        races++
        const cwd = request.workspaceId?.slice('workspace:'.length) ?? request.cwd!
        await expect(context.waterfall('api-session/command-admission', {
          operation: 'create', sessionId: request.sessionId!, cwd,
          request: { ...request },
        }, () => Promise.resolve())).rejects.toMatchObject({ code: 'session/read-only' })
      },
    })
    const examples = (await first.service.snapshot()).projects.filter(project => project.example === true)
    expect(examples).toHaveLength(2)
    expect(races).toBe(2)
    for (const example of examples) {
      const id = SessionId(example.sessionId!)
      const before = (await ctx!.sessionController.inspect(id)).events
      await expect(ctx!.sessionController.create({ sessionId: id, workspaceId: example.workspaceId, agentPreset: 'research' }))
        .resolves.toEqual({ sessionId: id })
      expect((await ctx!.sessionController.inspect(id)).events).toEqual(before)
      await expect(ctx!.sessionController.create({ workspaceId: example.workspaceId, agentPreset: 'research' }))
        .rejects.toMatchObject({ code: 'session/read-only' })
      await expect(ctx!.sessionController.create({ sessionId: SessionId(`${id}-forged`), cwd: example.root }))
        .rejects.toMatchObject({ code: 'session/read-only' })
      for (const operation of ['fork', 'rename', 'prompt', 'updateQueue'] as const) {
        await expect(ctx!.waterfall('api-session/command-admission', {
          operation, sessionId: id, cwd: example.root,
        }, () => Promise.resolve())).rejects.toMatchObject({ code: 'session/read-only', details: { sessionId: id } })
      }
      // An existing Session from another root cannot adopt a project's registered identity.
      await expect(ctx!.waterfall('api-session/command-admission', {
        operation: 'create', sessionId: id, cwd: example.root, request: { sessionId: id, cwd: example.root },
        existing: { ...ctx!.sessions.get(id)!.header, cwd: join(root, 'ordinary') },
      }, () => Promise.resolve())).rejects.toMatchObject({ code: 'session/read-only' })
    }
    const ordinary = await first.service.create({ title: 'Ordinary', root: join(root, 'ordinary'), brief: '' })
    for (const operation of ['fork', 'rename', 'prompt', 'updateQueue'] as const) {
      await expect(ctx!.waterfall('api-session/command-admission', {
        operation, sessionId: SessionId('scipaper-example-forged-prefix'), cwd: ordinary.root,
      }, () => Promise.resolve())).resolves.toBeUndefined()
    }
    const missing = examples[0]!
    exampleHistories.get(pool)!.delete(missing.sessionId!)
    await ctx!.fiber.dispose(); ctx = undefined
    const second = await boot(pool)
    const restored = await second.service.snapshot()
    expect(restored.projects.filter(project => project.example === true).map(project => project.id))
      .toEqual(examples.map(project => project.id))
    const recovered = (await ctx!.sessionController.inspect(SessionId(missing.sessionId!))).events
    expect(recovered.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(recovered.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect((await second.service.snapshot()).projects).toEqual(restored.projects)
    expect((await ctx!.sessionController.inspect(SessionId(missing.sessionId!))).events).toEqual(recovered)
  })

  it('seeds complete examples despite a hidden preference, protects an aliased home, and recovers on restart without duplicate messages', async () => {
    root = await temporaryRoot('research-shipped-examples-')
    const home = join(root, 'home'), alias = join(root, 'selected-home'), pool = new MemoryMediaPool()
    await mkdir(home)
    await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const first = await boot(pool, { dataHome: alias })
      await first.service.configure({ showExamples: false })
      const snapshots = await Promise.all(Array.from({ length: 4 }, () => first.service.snapshot()))
      const projects = snapshots[0]!.projects
      expect(projects).toHaveLength(2)
      for (const snapshot of snapshots) {
        expect(snapshot.projects.map(project => project.id)).toEqual(projects.map(project => project.id))
        expect(snapshot.preferences.showExamples).toBe(false)
      }
      const inspected = new Map<string, readonly SessionEvent[]>()
      for (const project of projects) {
        expect(project.example).toBe(true)
        expect(first.applied.get(project.sessionId!)).toBe('read-only')
        const events = (await ctx!.sessionController.inspect(SessionId(project.sessionId!))).events
        inspected.set(project.sessionId!, events)
        expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
        expect(events.filter(event => event.type === 'user/message')).toHaveLength(1)
        const artifactId = project.artifacts.find(artifact => artifact.path === 'paper/paper.zh.md')!.id
        expect((await first.service.execute({ action: 'read-artifact', projectId: project.id, artifactId }, signal, 'user')).content)
          .toContain('合成')
        for (const actor of ['user', 'agent'] as const) {
          await expect(first.service.execute({ action: 'rename', projectId: project.id, title: 'Changed' }, signal, actor))
            .rejects.toThrow(/read-only/)
        }
      }
      await first.service.configure({ showExamples: true })
      expect((await first.service.snapshot()).projects.map(project => project.id)).toEqual(projects.map(project => project.id))
      for (const [id, events] of inspected) expect((await ctx!.sessionController.inspect(id as SessionId)).events).toEqual(events)
      const removed = projects[0]!
      await rm(join(removed.root, 'paper/main.pdf'))
      await ctx!.fiber.dispose(); ctx = undefined
      const second = await boot(pool, { dataHome: alias })
      const restored = await second.service.snapshot()
      expect(restored.preferences.showExamples).toBe(true)
      expect(restored.projects.map(project => project.id)).toEqual(projects.map(project => project.id))
      expect((await readFile(join(removed.root, 'paper/main.pdf'))).subarray(0, 5).toString()).toBe('%PDF-')
      for (const project of restored.projects) {
        expect(project.example).toBe(true)
        const events = (await ctx!.sessionController.inspect(SessionId(project.sessionId!))).events
        expect(events.filter(event => event.type === 'user/message' || event.type === 'assistant/message'))
          .toEqual(inspected.get(project.sessionId!)!.filter(event => event.type === 'user/message' || event.type === 'assistant/message'))
      }
    } finally {
      await ctx?.fiber.dispose(); ctx = undefined
      await unlink(alias)
    }
  })

  it('does not rewrite legacy example ledger or inline evidence while adding examples to an existing trial home', async () => {
    root = await temporaryRoot('research-legacy-example-')
    const pool = new MemoryMediaPool(), first = await boot(pool)
    const legacy = await first.service.create({ title: 'Legacy example', root: join(root, 'demo/old'), brief: 'Existing material' })
    await write(join(legacy.root, 'notes.md'), 'legacy source\n')
    await first.service.execute({ action: 'import', projectId: legacy.id, paths: ['notes.md'] }, signal, 'agent')
    await ctx!.fiber.dispose(); ctx = undefined
    const tables = [...pool.media.values()].flatMap((medium) => {
      const table = medium.tables.get('projects')
      return table === undefined ? [] : [table]
    })
    const stored = tables[0]!.get(legacy.id) as ResearchProject
    const inline = { ...stored, evidence: stored.evidence.map(evidence => ({ ...evidence, chunks: [{ text: 'legacy inline text', locator: { line: 1 } }] })) }
    for (const table of tables) table.set(legacy.id, inline)
    await rm(join(legacy.root, '.research/chunks'), { recursive: true })
    const second = await boot(pool, { dataHome: root })
    const snapshot = await second.service.snapshot()
    expect(snapshot.projects.filter(project => project.example === true)).toHaveLength(3)
    for (const table of tables) expect(table.get(legacy.id)).toEqual(inline)
    expect(existsSync(join(legacy.root, '.research/chunks'))).toBe(false)
    expect(await readFile(join(legacy.root, 'notes.md'), 'utf8')).toBe('legacy source\n')
    expect((await second.service.execute({ action: 'search-evidence', projectId: legacy.id, query: 'legacy inline' }, signal, 'user')).content)
      .toContain('legacy inline text')
    await expect(second.service.execute({ action: 'set-mode', projectId: legacy.id, mode: 'general' }, signal, 'user'))
      .rejects.toThrow(/read-only/)
  })

  it('loads independent tool families and removes only a disabled plugin contribution', async () => {
    root = await temporaryRoot('research-modules-')
    const { service } = await boot(new MemoryMediaPool(), { toolModules: [['project'], ['evidence'], ['checks']] })
    const names = () => ctx!.tools.schemas().map(tool => tool.name).sort()
    expect(names()).toEqual(['research_check', 'research_evidence', 'research_project'])
    const project = await service.create({ title: 'Modes', root: join(root, 'paper'), brief: '', mode: 'spark-to-paper' })
    expect((await ctx!.skills.list({ cwd: project.root })).map(skill => skill.name)).toContain('ts-paper')
    const evidence = [...ctx!.loader.entries()].find(entry => entry.options.id === 'research-tools-1')!
    await evidence.update({ disabled: true })
    await ctx!.loader.await()
    expect(names()).toEqual(['research_check', 'research_project'])
    expect(service.getProject(project.id).title).toBe('Modes')
    const provider = [...ctx!.loader.entries()].find(entry => entry.options.id === 'research-mode-skills')!
    await provider.update({ disabled: true })
    await ctx!.loader.await()
    expect(await ctx!.skills.list({ cwd: project.root })).toEqual([])
    expect(names()).toEqual(['research_check', 'research_project'])
    await evidence.update({ disabled: false })
    await ctx!.loader.await()
    expect(names()).toEqual(['research_check', 'research_evidence', 'research_project'])
  })

  it('creates and reopens projects without prompting any session, and restores after a restart', async () => {
    root = await temporaryRoot('research-loader-')
    const pool = new MemoryMediaPool(), first = await boot(pool)
    expect([...first.registry.keys()].sort()).toEqual([
      'research_artifact', 'research_board', 'research_check', 'research_environment', 'research_evidence', 'research_experiment', 'research_knowledge', 'research_media',
      'research_project', 'research_task',
    ])
    const announced: unknown[] = []
    ctx!.on('research/mode', (event) => { announced.push(event) })
    const p = await first.service.create({ title: 'Study', root: join(root, 'paper'), brief: 'One small spark', mode: 'spark-to-paper' })
    expect(p).toMatchObject({ sessionId: 'session-1', mode: 'spark-to-paper', route: 'proposal', autonomy: 'checkpoints' })
    expect(first.sessionPresets).toEqual(['research'])
    expect(announced).toEqual([{ projectId: p.id, root: p.root, mode: 'spark-to-paper', route: 'proposal' }])
    await expect(first.service.create({ title: 'x', root: join(root, 'x'), brief: '', mode: 'nope' })).rejects.toThrow(/Unknown mode nope; installed modes: general, spark-to-paper, ccfa/)
    await expect(first.service.create({ title: 'x', root: join(root, 'x'), brief: '', mode: 'spark-to-paper', route: 'nope' })).rejects.toThrow(/has no route nope/)
    await expect(first.service.create({ title: 'x', root: join(root, 'x'), brief: '', route: 'idea' })).rejects.toThrow(/Mode general has no routes/)
    expect((await first.service.snapshot()).modes.map(mode => mode.id)).toEqual(['general', 'spark-to-paper', 'ccfa'])
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
    expect((await second.service.snapshot()).projects.filter(item => item.example !== true).map(item => item.title).sort())
      .toEqual(['Bound', 'Study', 'Twin'])
    expect(second.prompts).toEqual([])
    expect(await second.service.projectAt(join(p.root, 'paper', 'nested'))).toBeUndefined()
    expect((await second.service.projectAt(join(p.root, 'figures')))?.id).toBe(p.id)
    expect(() => second.service.getProject('missing' as never)).toThrow(/not found/)
  })

  it('shares enabled graph tools and methods across every research mode', async () => {
    root = await temporaryRoot('research-graph-modes-')
    const { service } = await boot(new MemoryMediaPool())
    const project = await service.create({ title: 'Shared graph', root: join(root, 'paper'), brief: '' })
    const skills = async () => (await ctx!.skills.list({ cwd: project.root })).map(skill => skill.name)
    for (const mode of ['general', 'ccfa', 'spark-to-paper']) {
      await service.execute({ action: 'set-mode', projectId: project.id, mode }, signal, 'user')
      expect(ctx!.tools.schemas().map(tool => tool.name)).toContain('research_knowledge')
      expect(await skills()).toContain('research-knowledge')
      const result = await service.execute({ action: 'novelty', projectId: project.id,
        claim: 'Compare sparse attention kernels', references: [{ title: 'Attention', text: 'Sparse attention kernels' }],
        path: `novelty-${mode}.json` }, signal, 'agent')
      expect(result.content).toContain('lexical')
    }
  })

  it('withdraws optional graph tools and methods on disable, cancels work and preserves data through re-enable and restart', async () => {
    root = await temporaryRoot('research-graph-lifecycle-')
    const pool = new MemoryMediaPool()
    const { service } = await boot(pool)
    const project = await service.create({ title: 'Graph lifecycle', root: join(root, 'paper'), brief: '' })
    const marker = join(project.root, '.research/kg/keep.txt')
    await write(marker, 'retained research data')
    const tools = () => ctx!.tools.schemas().map(tool => tool.name)
    const skills = async () => (await ctx!.skills.list({ cwd: project.root })).map(skill => skill.name)
    const provider = [...ctx!.loader.entries()].find(entry => entry.options.id === 'knowledge-provider')!
    expect(tools()).toContain('research_knowledge')
    expect(await skills()).toContain('research-knowledge')
    const started = Promise.withResolvers<boolean>()
    const inFlight = ctx!.researchKnowledge.run(signal, async (_engine, workSignal) => new Promise<void>((_resolve, reject) => {
      workSignal.addEventListener('abort', () => { reject(new Error(String(workSignal.reason))) }, { once: true })
      started.resolve(true)
    }))
    const cancelled = expect(inFlight).rejects.toThrow(/disabled/)
    await started.promise
    await provider.update({ disabled: true }); await ctx!.loader.await()
    await cancelled
    expect(tools()).not.toContain('research_knowledge')
    expect(tools()).toContain('research_project')
    expect(await skills()).not.toContain('research-knowledge')
    // The domain map builds on the engine and goes with it; the evidence graph reads only the record and stays.
    expect((await service.snapshot()).knowledge)
      .toEqual({ enabled: false, modules: { map: false, evidence: true, memory: true, relations: true } })
    await expect(service.execute({ action: 'graph-view', projectId: project.id }, signal, 'agent')).rejects.toThrow(/disabled|enable/i)
    expect(await readFile(marker, 'utf8')).toBe('retained research data')
    await provider.update({ disabled: false }); await ctx!.loader.await()
    expect(tools()).toContain('research_knowledge')
    expect(await skills()).toContain('research-knowledge')
    expect((await service.execute({ action: 'graph-view', projectId: project.id, query: 'attention' }, signal, 'user')).knowledgeGraph?.nodes.length).toBeGreaterThan(0)
    expect(await readFile(marker, 'utf8')).toBe('retained research data')
    await ctx!.fiber.dispose(); ctx = undefined
    const restarted = await boot(pool, { knowledge: false })
    expect(restarted.service.knowledgeEnabled).toBe(false)
    expect(tools()).not.toContain('research_knowledge')
    expect((await restarted.service.snapshot()).projects.some(item => item.id === project.id)).toBe(true)
    expect(await readFile(marker, 'utf8')).toBe('retained research data')
  })

  it('mounts the domain map and the evidence graph as rows of their own and refuses each one\'s commands by name while it is off', async () => {
    root = await temporaryRoot('research-graph-modules-')
    const { service } = await boot(new MemoryMediaPool())
    const project = await service.create({ title: 'Modules', root: join(root, 'paper'), brief: 'Does it scale?' })
    const marker = join(project.root, '.research/kg/keep.txt')
    await write(marker, 'retained research data')
    const toggle = async (id: string, disabled: boolean): Promise<void> => {
      await [...ctx!.loader.entries()].find(entry => entry.options.id === id)!.update({ disabled })
      await ctx!.loader.await()
    }
    const run = (action: 'evidence-graph' | 'map-view' | 'map-overlay' | 'graph-status') => service.execute({ action, projectId: project.id }, signal, 'user')
    const modules = async () => (await service.snapshot()).knowledge
    expect(await modules()).toEqual({ enabled: true, modules: { map: true, evidence: true, memory: true, relations: true } })
    expect(JSON.parse((await run('graph-status')).content ?? '{}')).toMatchObject({ modules: { map: true, evidence: true } })
    expect((await run('evidence-graph')).evidenceGraph).toMatchObject({ question: 'Does it scale?', claims: [], sources: [] })
    const view = (await run('map-view')).mapView
    expect(view).toMatchObject({ built: true, graph: { name: 'ai', papers: 29240 } })
    if (!view?.built) throw new Error('the map is built')
    expect(Buffer.from(view.points, 'base64')).toHaveLength(29240 * 4)
    expect(Buffer.from(view.regionOf, 'base64')).toHaveLength(29240)
    expect(view.regions.length).toBeGreaterThan(10)
    // Without a recall the brief stands for the idea; nothing is imported, recalled or marked yet.
    expect((await run('map-overlay')).mapOverlay).toMatchObject({ built: true, idea: { text: 'Does it scale?', source: 'brief' }, library: [], recalled: [], marks: [] })
    const papers = await service.execute({ action: 'map-papers', projectId: project.id, indices: [0, 99999] }, signal, 'user')
    expect(papers.mapPapers).toEqual([expect.objectContaining({ index: 0, title: expect.any(String) as unknown })])
    // A search lands on the map without being recorded as the research's idea.
    const query = 'block sparse attention for long context'
    const search = (await service.execute({ action: 'map-search', projectId: project.id, query }, signal, 'user')).mapSearch
    expect(search).toMatchObject({ query, basis: 'lexical', placement: { confidence: expect.any(Number) as number } })
    expect(search?.papers.length).toBeGreaterThan(0)
    expect(search?.patterns.length).toBeGreaterThan(0)
    expect((await run('map-overlay')).mapOverlay).toMatchObject({ idea: { source: 'brief' } })

    await toggle('knowledge-evidence', true)
    expect(await modules()).toEqual({ enabled: true, modules: { map: true, evidence: false, memory: true, relations: true } })
    await expect(run('evidence-graph')).rejects.toThrow(/Evidence graph plugin is disabled/)
    expect((await run('map-view')).mapView).toMatchObject({ built: true })
    await toggle('knowledge-evidence', false)

    await toggle('knowledge-map', true)
    expect(await modules()).toEqual({ enabled: true, modules: { map: false, evidence: true, memory: true, relations: true } })
    for (const action of ['map-view', 'map-overlay'] as const) await expect(run(action)).rejects.toThrow(/Domain map plugin is disabled/)
    await expect(service.execute({ action: 'map-papers', projectId: project.id, indices: [0] }, signal, 'user')).rejects.toThrow(/Domain map plugin is disabled/)
    await expect(service.execute({ action: 'map-search', projectId: project.id, query: 'x' }, signal, 'user')).rejects.toThrow(/Domain map plugin is disabled/)
    expect((await run('evidence-graph')).evidenceGraph?.question).toBe('Does it scale?')
    await toggle('knowledge-map', false)

    // Map work in flight is cancelled with its plugin.
    const started = Promise.withResolvers<boolean>()
    const inFlight = ctx!.researchKnowledgeMap.run(signal, async (_engine, workSignal) => new Promise<void>((_resolve, reject) => {
      workSignal.addEventListener('abort', () => { reject(new Error(String(workSignal.reason))) }, { once: true })
      started.resolve(true)
    }))
    const cancelled = expect(inFlight).rejects.toThrow(/domain map plugin was disabled/)
    await started.promise
    await toggle('knowledge-map', true)
    await cancelled
    await toggle('knowledge-map', false)

    // Without the engine the map goes too, because it injects the engine; the evidence graph reads only the record and stays.
    await toggle('knowledge-provider', true)
    expect(await modules()).toEqual({ enabled: false, modules: { map: false, evidence: true, memory: true, relations: true } })
    await expect(run('map-view')).rejects.toThrow(/Domain map plugin is disabled/)
    await expect(run('graph-status')).rejects.toThrow(/Knowledge graph plugin is disabled/)
    expect((await run('evidence-graph')).evidenceGraph).toBeDefined()
    await toggle('knowledge-provider', false)
    expect(await modules()).toEqual({ enabled: true, modules: { map: true, evidence: true, memory: true, relations: true } })
    expect(await readFile(marker, 'utf8')).toBe('retained research data')
  })

  it('places the agent\'s recall, the library and the person\'s marks over the domain map', async () => {
    root = await temporaryRoot('research-map-overlay-')
    const { service } = await boot(new MemoryMediaPool())
    const project = await service.create({ title: 'Overlay', root: join(root, 'paper'), brief: '' })
    const map = ctx!.researchKnowledgeMap
    // Without a recall or a brief there is no idea to place.
    expect(await map.overlay({ root: project.root, brief: '', evidence: [] }, undefined, signal)).toEqual({ built: true, library: [], recalled: [], marks: [], honour: true })
    const recall = await service.execute({ action: 'recall', projectId: project.id, query: 'block sparse attention long context accuracy' }, signal, 'agent')
    const hits = (JSON.parse(recall.content ?? '{}') as { closestPapers: { id: string; title: string }[] }).closestPapers
    const first = hits[0]!
    const overlay = await map.overlay({ root: project.root, brief: 'ignored once a recall exists', evidence: [] }, undefined, signal)
    if (!overlay.built) throw new Error('the map is built')
    expect(overlay.idea).toMatchObject({ text: 'block sparse attention long context accuracy', source: 'recall', placement: { confidence: expect.any(Number) as number } })
    expect(overlay.recalled.length).toBeGreaterThan(0)
    expect(overlay.recalled[0]?.query).toBe('block sparse attention long context accuracy')

    // Marks are recorded with who made them, named, and shown on the map.
    const marked = await service.execute({ action: 'mark', projectId: project.id, target: { kind: 'paper', graph: 'ai', id: first.id }, verdict: 'pin', note: 'closest' }, signal, 'user')
    expect(marked.marks).toEqual([expect.objectContaining({ id: `ai:paper:${first.id}`, verdict: 'pin', by: 'user', note: 'closest', title: first.title, index: expect.any(Number) as number })])
    expect((await service.execute({ action: 'mark', projectId: project.id, target: { kind: 'paper', graph: 'ai', id: first.id }, verdict: 'pin', note: 'closest' }, signal, 'user')).message).toMatch(/^Already marked/)
    await expect(service.execute({ action: 'mark', projectId: project.id, target: { kind: 'paper', graph: 'ai', id: 'no-such-paper' }, verdict: 'irrelevant' }, signal, 'agent'))
      .rejects.toThrow(/No paper "no-such-paper" in the built-in graph/)
    await expect(service.execute({ action: 'mark', projectId: project.id, target: { kind: 'pattern', graph: 'project', id: 'p' }, verdict: 'pin' }, signal, 'agent'))
      .rejects.toThrow(/in the project graph/)
    expect((await map.overlay({ root: project.root, brief: '', evidence: [] }, undefined, signal) as { marks: unknown[] }).marks).toHaveLength(1)
    expect((await service.execute({ action: 'marks', projectId: project.id }, signal, 'agent')).message).toBe('1 mark(s)')
    // Only the person pauses the marks: the agent is told, the map shows it, and the marks stay.
    await expect(service.execute({ action: 'honour-marks', projectId: project.id, honour: false }, signal, 'agent')).rejects.toThrow(/person's switch/)
    expect(await service.execute({ action: 'honour-marks', projectId: project.id, honour: false }, signal, 'user')).toMatchObject({ honour: false, message: expect.stringMatching(/paused/) as string })
    expect(await service.execute({ action: 'marks', projectId: project.id }, signal, 'agent')).toMatchObject({ honour: false, message: expect.stringMatching(/^1 mark\(s\); the person paused them/) as string })
    expect(await map.overlay({ root: project.root, brief: '', evidence: [] }, undefined, signal)).toMatchObject({ honour: false, marks: [expect.anything()] })
    const quiet = JSON.parse((await service.execute({ action: 'recall', projectId: project.id, query: 'block sparse attention long context accuracy' }, signal, 'agent')).content ?? '{}') as { annotations?: unknown; note: string }
    expect(quiet.annotations).toBeUndefined()
    expect(quiet.note).toMatch(/paused their marks/)
    expect(await service.execute({ action: 'honour-marks', projectId: project.id, honour: true }, signal, 'user')).toMatchObject({ honour: true, message: expect.stringMatching(/follows/) as string })
    expect(await service.execute({ action: 'marks', projectId: project.id }, signal, 'agent')).toMatchObject({ honour: true, message: '1 mark(s)' })
    expect((await service.execute({ action: 'unmark', projectId: project.id, id: `ai:paper:${first.id}` }, signal, 'user')).marks).toEqual([])
    expect((await service.execute({ action: 'unmark', projectId: project.id, id: `ai:paper:${first.id}` }, signal, 'user')).message).toMatch(/^No mark/)

    // A reference the built-in graph holds sits on its paper; another is placed from its words; only literature is placed.
    const literature = (id: string, title: string, text: string) => ({
      id, title, kind: 'literature' as const, path: `.research/sources/${id}.json`, sha256: 'x', revision: 1, importedAt: '', coverage: 'abstract' as const,
      verified: true, stale: false, chunks: text === '' ? [] : [{ text, locator: {} }],
    })
    await mkdir(join(root, 'fresh'), { recursive: true })
    const library = await map.overlay({ root: join(root, 'fresh'), brief: '', evidence: [
      literature('a', first.title, ''),
      literature('b', 'Our own note', 'block sparse attention selects blocks by content to keep long context accuracy'),
      { ...literature('c', 'Data table', 'numbers'), kind: 'file' },
    ] as never }, undefined, signal)
    if (!library.built) throw new Error('the map is built')
    expect(library.library.map(item => item.evidenceId)).toEqual(['a', 'b'])
    expect(library.library[0]?.placement).toMatchObject({ exact: true, confidence: 1 })
    expect(library.library[1]?.placement?.exact).toBeUndefined()
    expect(library.library[1]?.placement?.nearest.length).toBeGreaterThan(0)

    // Words the map does not hold place nothing, and say why; past MAX_LIBRARY a reference is listed unplaced.
    const words = join(root, 'words')
    await mkdir(words, { recursive: true })
    const unplaced = await map.overlay({ root: words, brief: '只用中文写的想法', evidence: [
      literature('zh', '中文标题', '中文摘要'),
      ...Array.from({ length: MAX_LIBRARY }, (_, at) => literature(`n${at}`, `Reference ${at}`, 'sparse attention')),
    ] as never }, undefined, signal)
    if (!unplaced.built) throw new Error('the map is built')
    expect(unplaced.idea).toMatchObject({ source: 'brief', note: expect.stringMatching(/too few words/) as string })
    expect(unplaced.idea).not.toHaveProperty('placement')
    expect(unplaced.library[0]).not.toHaveProperty('placement')
    expect(unplaced.library.at(-1)).not.toHaveProperty('placement')
    expect(unplaced.library[1]?.placement).toBeDefined()
    // A brief the map can place stands for the idea until the agent recalls.
    const placed = await map.overlay({ root: words, brief: 'block sparse attention for long context', evidence: [] }, undefined, signal)
    expect(placed).toMatchObject({ idea: { source: 'brief', placement: { confidence: expect.any(Number) as number } } })

    // A recall that matched nothing leaves the idea unplaced; papers repeated across recalls, or gone from the graph, show once.
    await appendRecall(words, 'zzqx', { papers: [], patterns: [] })
    expect((await map.overlay({ root: words, brief: '', evidence: [] }, undefined, signal) as { idea: unknown }).idea).toEqual({ text: 'zzqx', source: 'recall' })
    await appendRecall(words, 'twice', { papers: [{ index: 3, score: 2 }, { index: 3, score: 1 }, { index: 999999, score: 1 }], patterns: [{ index: 99999, score: 1 }] })
    expect((await map.overlay({ root: words, brief: '', evidence: [] }, undefined, signal) as { recalled: unknown[] }).recalled).toHaveLength(1)

    // Marks on the project's own graph are named from it.
    await write(join(words, PROJECT_GRAPH), JSON.stringify({ version: 1, name: 'project', description: 'own', domains: ['d'],
      patterns: [{ id: 'own0', name: 'Own pattern', domain: 0, subDomains: [], size: 1, coherence: null, tier: '', summary: '', details: '', ideas: [], exemplars: [0], works: [] }],
      papers: [{ id: 'q0', title: 'Own paper', pattern: 0, domain: 0, idea: '', problem: '', solution: '', story: '', score: null, similar: [] }] }))
    const words2 = await service.create({ title: 'Words', root: words, brief: '' })
    await service.execute({ action: 'mark', projectId: words2.id, target: { kind: 'pattern', graph: 'project', id: 'own0' }, verdict: 'pin' }, signal, 'user')
    expect((await map.overlay({ root: words, brief: '', evidence: [] }, undefined, signal) as { marks: { title?: string }[] }).marks[0]?.title).toBe('Own pattern')

    // A damaged map asset fails the read and is loaded again on the next one.
    const asset = Reflect.get(map, 'assetPath') as string
    Object.defineProperty(map, 'assetPath', { value: join(root, 'missing.bin'), configurable: true })
    Reflect.set(map, 'map', undefined); Reflect.set(map, 'encoded', undefined)
    await expect(map.view(signal)).rejects.toThrow(/ENOENT/)
    Object.defineProperty(map, 'assetPath', { value: asset, configurable: true })
    expect(await map.view(signal)).toMatchObject({ built: true })
  })

  it('composes without the sub-plugins: the snapshot reports them off and the project is untouched', async () => {
    root = await temporaryRoot('research-graph-no-modules-')
    const { service } = await boot(new MemoryMediaPool(), {
      knowledgeMap: false, knowledgeEvidence: false, knowledgeMemory: false, knowledgeRelations: false,
    })
    const project = await service.create({ title: 'Plain', root: join(root, 'paper'), brief: '' })
    expect((await service.snapshot()).knowledge)
      .toEqual({ enabled: true, modules: { map: false, evidence: false, memory: false, relations: false } })
    await expect(service.execute({ action: 'evidence-graph', projectId: project.id }, signal, 'user')).rejects.toThrow(/Evidence graph plugin is disabled/)
    await expect(service.execute({ action: 'map-view', projectId: project.id }, signal, 'user')).rejects.toThrow(/Domain map plugin is disabled/)
    await expect(service.execute({ action: 'memory', projectId: project.id }, signal, 'user')).rejects.toThrow(/Research memory plugin is disabled/)
  })

  it('reads what the researches on this computer left, keeps the person\'s switches, and gives the agent only what is carried', async () => {
    root = await temporaryRoot('research-memory-')
    const pool = new MemoryMediaPool()
    let { service } = await boot(pool)
    const alpha = await service.create({ title: 'Alpha', root: join(root, 'alpha'), brief: 'First' })
    const beta = await service.create({ title: 'Beta', root: join(root, 'beta'), brief: 'Second' })
    const gamma = await service.create({ title: 'Gamma', root: join(root, 'gamma'), brief: 'Third' })
    await ctx!.fiber.dispose(); ctx = undefined
    const source = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
      id, title, kind: 'literature', path: `.research/sources/${id}.json`, sha256: 'x', revision: 1, importedAt: '2026-08-01T00:00:00.000Z',
      chunks: [], coverage: 'abstract', verified: true, stale: false, ...patch,
    })
    const environment = (id: string, patch: Record<string, unknown> = {}) => ({
      id, name: id, kind: 'uv', target: 'local', python: '', requirements: [], fingerprint: '', status: 'ready', details: '', isDefault: false, ...patch,
    })
    const experiment = (id: string, name: string, patch: Record<string, unknown> = {}) => ({
      id, status: 'completed', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z', directory: `runs/${id}`, inputRevision: 1,
      environmentFingerprint: '', metrics: {}, message: '', snapshotPath: '', collected: true,
      spec: { environmentId: 'e', name, argv: ['{python}', 'code/train.py'], cwd: '.', seed: 1, maxSeconds: 60, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'm.json' },
      ...patch,
    })
    const edits: Record<string, Partial<ResearchProject>> = {
      [alpha.id]: {
        createdAt: '2026-08-01T00:00:00.000Z', venue: 'aaai',
        // A whole-paper check that is clean and later than every file marks the research as finished.
        progress: { mode: 'general', phases: {}, findings: {}, full: { clean: true, errors: 0, warnings: 0, checkedAt: '2999-01-01T00:00:00.000Z' } },
        evidence: [
          source('a1', 'Longformer: The Long-Document Transformer', { doi: '10.1/long' }), source('a2', 'Big Bird'),
          source('a3', 'data.csv', { kind: 'file', coverage: 'data' }),
        ] as never,
        environments: [environment('ea', { kind: 'existing', target: 'ssh', sshHost: 'gpu', python: '/usr/bin/python3' }), environment('eb', { requirements: ['numpy'] })] as never,
        experiments: [
          experiment('ra', 'ruler-32k-full', { metrics: { accuracy: 0.9 } }),
          experiment('rb', 'ruler-32k-fixed', { status: 'failed', message: 'CUDA out of memory', exitCode: 1, finishedAt: '2026-08-03T00:00:00.000Z' }),
        ] as never,
        decisions: [
          { id: 'd1', question: '模式与路线', answer: 'general', by: 'user', rationale: '', at: '2026-08-01T00:00:00.000Z', key: 'mode' },
          { id: 'd2', question: 'Which dataset?', answer: 'RULER', by: 'user', rationale: 'standard', at: '2026-08-04T00:00:00.000Z' },
        ],
      },
      [beta.id]: {
        createdAt: '2026-08-10T00:00:00.000Z', venue: 'neurips',
        evidence: [source('b1', 'Longformer - the long document transformer'), source('b2', 'Reformer')] as never,
        environments: [environment('ec', { requirements: ['torch'] })] as never,
        experiments: [experiment('rc', 'ruler-64k', { metrics: { accuracy: 0.7 }, updatedAt: '2026-08-12T00:00:00.000Z' })] as never,
      },
      [gamma.id]: { createdAt: '2026-09-01T00:00:00.000Z', evidence: [source('g1', 'Gamma only paper')] as never },
    }
    for (const medium of pool.media.values()) {
      const projects = medium.tables.get('projects')
      for (const [id, patch] of Object.entries(edits)) {
        const stored = projects?.get(id) as ResearchProject | undefined
        if (projects && stored) projects.set(id, { ...stored, ...patch })
      }
    }
    service = (await boot(pool)).service
    // Seeding the shipped examples first: they leave no memory.
    await service.snapshot()
    const user = (request: Record<string, unknown>) => service.execute({ projectId: alpha.id, ...request } as never, signal, 'user')
    const agent = (request: Record<string, unknown>) => service.execute({ projectId: gamma.id, ...request } as never, signal, 'agent')

    const { memory } = await user({ action: 'memory' })
    if (memory === undefined) throw new Error('the page is served')
    expect(memory.researches.map(item => [item.title, item.finished, item.literature, item.runs])).toEqual([
      ['Alpha', true, 2, 1], ['Beta', false, 2, 1], ['Gamma', false, 1, 0],
    ])
    expect(memory.researches.map(item => item.venue))
      .toEqual([expect.stringMatching(/AAAI/i), expect.stringMatching(/NeurIPS/i), undefined])
    expect(memory.literature.items.map(item => item.title))
      .toEqual(['Longformer: The Long-Document Transformer', 'Big Bird', 'Reformer', 'Gamma only paper'])
    expect(memory.literature.items[0]?.researches).toEqual([alpha.id, beta.id])
    expect(memory.runs.items.map(item => item.name)).toEqual(['ruler-64k', 'ruler-32k-full'])
    expect(memory.environments.items.map(item => [item.name, item.target, item.researches.length])).toEqual([['eb', 'local', 2], ['ea', 'ssh', 1]])
    expect(memory.writing.items.map(item => item.venue)).toEqual(['aaai', 'neurips'])
    expect(memory.lessons.items.map(item => item.kind)).toEqual(['decision', 'failed-run'])
    expect(memory.carry).toEqual({ literature: true, runs: true, environments: true, writing: true })

    // The person's switches are saved in the preferences and survive the plugin being switched off and on.
    const off = await user({ action: 'memory-carry', kind: 'literature', on: false })
    expect(off.memory?.carry).toEqual({ literature: false, runs: true, environments: true, writing: true })
    expect((await user({ action: 'memory-carry', kind: 'runs', on: false })).message).toMatch(/no longer carry runs/)
    expect((await user({ action: 'memory-carry', kind: 'runs', on: true })).message).toMatch(/carry runs/)
    expect((await service.snapshot()).preferences.memoryCarry).toEqual({ literature: false, runs: true })
    await expect(user({ action: 'memory-carry', kind: 'datasets', on: true })).rejects.toThrow()

    // The agent reads the kinds that are on, from the researches other than the one it works in, and cannot move a switch.
    const read = await agent({ action: 'memory' })
    expect(read.memory).toBeUndefined()
    expect(read.message).toBe('Memory of 2 earlier research(es); kinds switched on: ["runs","environments","writing"]')
    const carried = JSON.parse(read.content ?? '{}') as CarriedMemory
    expect(carried).toMatchObject({
      carried: ['runs', 'environments', 'writing'], researches: [{ title: 'Alpha', finished: true }, { title: 'Beta', finished: false }],
    })
    expect(carried).not.toHaveProperty('literature')
    expect(carried).not.toHaveProperty('lessons')
    expect(carried.runs?.items.map(item => [item.name, item.from])).toEqual([['ruler-64k', ['Beta']], ['ruler-32k-full', ['Alpha']]])
    expect(carried.writing?.items.map(item => [item.venue, item.from])).toEqual([['aaai', ['Alpha']], ['neurips', ['Beta']]])
    await expect(agent({ action: 'memory-carry', kind: 'runs', on: false })).rejects.toThrow(/person's switch/)

    const toggle = async (disabled: boolean): Promise<void> => {
      await [...ctx!.loader.entries()].find(entry => entry.options.id === 'knowledge-memory')!.update({ disabled })
      await ctx!.loader.await()
    }
    await toggle(true)
    expect((await service.snapshot()).knowledge?.modules).toEqual({ map: true, evidence: true, memory: false, relations: true })
    for (const request of [{ action: 'memory' }, { action: 'memory-carry', kind: 'runs', on: false }]) {
      await expect(user(request)).rejects.toThrow(/Research memory plugin is disabled/)
    }
    await expect(agent({ action: 'memory' })).rejects.toThrow(/Research memory plugin is disabled/)
    await toggle(false)
    expect((await user({ action: 'memory' })).memory?.carry.literature).toBe(false)
    // Nothing was deleted by switching the plugin off: the researches' own records are untouched.
    expect(service.getProject(alpha.id).evidence).toHaveLength(3)
  })

  it('mounts the relation graph as a row of its own: grounded proposals, queries, corrections, the person\'s commands, and cancellation', async () => {
    root = await temporaryRoot('research-relations-')
    const { service } = await boot(new MemoryMediaPool())
    const project = await service.create({ title: 'Relations', root: join(root, 'paper'), brief: '' })
    const toggle = async (disabled: boolean): Promise<void> => {
      await [...ctx!.loader.entries()].find(entry => entry.options.id === 'knowledge-relations')!.update({ disabled })
      await ctx!.loader.await()
    }
    const user = (request: Record<string, unknown>) => service.execute({ projectId: project.id, ...request } as never, signal, 'user')
    const agent = (request: Record<string, unknown>) => service.execute({ projectId: project.id, ...request } as never, signal, 'agent')
    expect((await service.snapshot()).knowledge?.modules.relations).toBe(true)
    expect(JSON.parse((await agent({ action: 'graph-status' })).content ?? '{}')).toMatchObject({ modules: { relations: true } })

    // A real imported source: the relations below are quotations of it at its current revision.
    await write(join(project.root, 'paper.md'), 'Alpha outperforms Beta on Bench at 32K. Alpha is evaluated on Bench. Gamma outperforms Beta on Bench. '
      + 'Gamma Method is a variant of Gamma. Alpha is a kind of sparse attention.')
    await agent({ action: 'import', paths: ['paper.md'] })
    const source = service.getProject(project.id).evidence[0]!
    const quote = (text: string, setting?: string) => ({ type: 'quote', evidenceId: source.id, revision: source.revision, quote: text, ...setting === undefined ? {} : { setting } })
    const method = (name: string) => ({ kind: 'method', name })
    const alpha = {
      kind: 'improves-on', from: method('Alpha'), to: method('Beta'), ground: quote('Alpha outperforms Beta on Bench at 32K.'),
      // The author is the caller's, never the input's.
      by: 'user',
    }
    const proposals = [
      alpha,
      { kind: 'improves-on', from: method('Gamma'), to: method('Beta'), ground: quote('Gamma outperforms Beta on Bench.') },
      { kind: 'evaluated-on', from: method('Alpha'), to: { kind: 'dataset', name: 'Bench' }, ground: quote('Alpha is evaluated on Bench.') },
      { kind: 'improves-on', from: method('Beta'), to: method('Alpha'), ground: quote('Beta clearly beats Alpha on every benchmark we ran.') },
    ]
    const proposed = await agent({ action: 'relations-propose', proposals })
    expect(proposed.message).toBe('4 proposal(s): 3 grounded, 1 refused')
    expect(proposed.relationOutcomes).toBeUndefined()
    expect(proposed.content?.split('\n').map(line => line.replace(/\[ground [0-9a-f]+\]/, '[ground]'))).toEqual([
      '1. added improves-on:method:alpha>method:beta [ground]',
      '2. added improves-on:method:gamma>method:beta [ground]',
      '3. added evaluated-on:method:alpha>dataset:bench [ground]',
      expect.stringMatching(/^4\. refused \(quote-not-found\): /),
    ])
    const around = (entity: string) => user({ action: 'relations-graph', entity })
    const beta = (await around('Beta')).relations
    expect(beta).toMatchObject({ match: 'found', counts: { entities: 4, relations: 3, stale: 0, rejected: 0 } })
    expect(beta?.neighbourhood?.edges.filter(edge => edge.kind === 'improves-on').map(edge => [edge.id, edge.by, edge.grounds[0]?.by, edge.best.source, edge.best.quote])).toEqual([
      ['improves-on:method:alpha>method:beta', 'agent', 'agent', 'file', 'Alpha outperforms Beta on Bench at 32K.'],
      ['improves-on:method:gamma>method:beta', 'agent', 'agent', 'file', 'Gamma outperforms Beta on Bench.'],
    ])
    // The agent reads the neighbourhood as text, with the relation ids it can reject.
    const read = await agent({ action: 'relations-graph', entity: 'beta' })
    expect(read.relations).toBeUndefined()
    expect(read.content).toContain('Alpha (method) —improves-on→ Beta (method), 0.7, paper.md [improves-on:method:alpha>method:beta]')

    const paths = (await user({ action: 'relations-paths', from: 'Alpha', to: 'Gamma' })).relationPaths
    expect(paths?.paths[0]?.hops.map(hop => [hop.kind, hop.direction, hop.grounds[0]?.quote])).toEqual([
      ['improves-on', 'forward', 'Alpha outperforms Beta on Bench at 32K.'], ['improves-on', 'backward', 'Gamma outperforms Beta on Bench.'],
    ])
    expect((await agent({ action: 'relations-paths', from: 'Alpha', to: 'Gamma' })).content).toContain('Alpha —improves-on→ Beta')

    // The gap matrix speaks of this project's sources only; a project file is not a paper.
    const gaps = (await user({ action: 'relations-gaps', axis: 'dataset', rows: ['Alpha', 'Gamma'], columns: ['Bench'] })).relationGaps
    expect(gaps?.cells.map(row => row.map(cell => [cell.state, cell.files]))).toEqual([[['project-only', 1]], [['mentioned', 0]]])
    expect(gaps?.basis).toEqual({ literature: 0, fullText: 0, abstractOnly: 0, metadataOnly: 0, files: 1 })
    expect((await agent({ action: 'relations-gaps', axis: 'dataset' })).content).toContain('only in this project\'s own runs or files: Alpha × Bench')
    // Subtypes are not counted unless asked.
    await user({ action: 'relations-propose', proposals: [{
      kind: 'is-a', from: method('Alpha'), to: method('sparse attention'), ground: quote('Alpha is a kind of sparse attention.'),
    }] })
    expect((await user({ action: 'relations-gaps', axis: 'dataset', rows: ['sparse attention'], columns: ['Bench'] })).relationGaps?.cells[0]?.[0]?.state).toBe('mentioned')
    expect((await user({ action: 'relations-gaps', axis: 'dataset', rows: ['sparse attention'], columns: ['Bench'], rollUp: true })).relationGaps?.cells[0]?.[0]?.state).toBe('project-only')

    // The person's rejection stands against the agent until the person lifts it.
    const rejected = 'improves-on:method:gamma>method:beta'
    expect((await user({ action: 'relations-reject', relation: rejected, reason: 'the table is another dataset' })).relationOutcomes).toEqual([{ status: 'changed', relation: rejected }])
    expect((await agent({ action: 'relations-reject', relation: rejected })).message).toBe(`Nothing changed: ${rejected} was already rejected`)
    expect((await agent({ action: 'relations-restore', relation: rejected })).message).toMatch(/only the person can restore it/)
    expect((await agent({ action: 'relations-propose', proposals: [proposals[1]] })).content).toMatch(/refused \(rejected\): .*only the person can restore it/)
    expect((await user({ action: 'relations-graph' })).relations?.rejected.map(item => item.id)).toEqual([rejected])
    expect((await user({ action: 'relations-restore', relation: rejected })).message).toBe(`${rejected} restored`)
    expect((await user({ action: 'relations-restore', relation: rejected })).message).toBe(`Nothing changed: ${rejected} was already standing`)
    expect((await agent({ action: 'relations-reject', relation: 'cites:a>b' })).message).toMatch(/No relation has the id/)

    // Entities, merging and re-checking are the person's.
    await user({ action: 'relations-entity', kind: 'method', name: 'Gamma Method' })
    await user({ action: 'relations-entity', kind: 'method', name: 'GM' })
    expect((await agent({ action: 'relations-suggestions' })).content).toContain('Gamma Method (method:gamma-method) and GM (method:gm): acronym')
    expect((await user({ action: 'relations-suggestions' })).relationSuggestions).toEqual([{ a: 'method:gamma-method', b: 'method:gm', reason: 'acronym', names: ['Gamma Method', 'GM'] }])
    expect((await user({ action: 'relations-entity', kind: 'method', name: 'GM', aliases: ['Generalized Method'] })).relationEntity).toMatchObject({ status: 'updated' })
    expect((await user({ action: 'relations-merge', from: 'method:gm', into: 'method:gamma-method' })).message).toBe('Merged method:gm into method:gamma-method')
    expect((await user({ action: 'relations-merge', from: 'method:gm', into: 'method:gamma-method' })).message).toBe('An entity cannot be merged into itself.')
    for (const request of [
      { action: 'relations-entity', kind: 'method', name: 'Delta' }, { action: 'relations-merge', from: 'method:alpha', into: 'method:beta' },
      { action: 'relations-reground' }, { action: 'relations-citations' },
    ]) await expect(agent(request)).rejects.toThrow(/is the person's command/)
    expect((await user({ action: 'relations-reground' })).relationReground).toEqual({ regrounded: 0, lapsed: 0 })
    expect((await user({ action: 'relations-entity', kind: 'method', name: 'method' })).message).toMatch(/too general to identify one entity/)
    // A damaged file is copied aside before it is rewritten, and the person is told.
    const stored = join(project.root, '.research', 'kg', 'relations.json')
    const intact = await readFile(stored, 'utf8')
    await write(stored, '{ not json')
    const repaired = await user({ action: 'relations-propose', proposals: [alpha] })
    expect(repaired.message).toMatch(/^1 proposal\(s\): 1 grounded, 0 refused; .*relations\.json.*; The damaged file was copied to /)
    expect(repaired.message).toMatch(/\.research\/kg\/relations\.json\..*\.bak before it was rewritten\.$/)
    expect((await readdir(join(project.root, '.research', 'kg'))).some(name => name.endsWith('.bak'))).toBe(true)
    await write(stored, intact)
    await write(join(project.root, 'paper.md'), 'Alpha outperforms Beta on Bench at 32K. Alpha is evaluated on Bench. Gamma Method is a variant of Gamma. Alpha is a kind of sparse attention.')
    await agent({ action: 'refresh-evidence', evidenceId: source.id })
    expect((await around('Beta')).relations?.neighbourhood?.edges.map(edge => edge.status)).toEqual(['stale', 'stale', 'stale', 'stale'])
    expect((await user({ action: 'relations-reground' })).message).toBe('3 quotation(s) moved to the current revision, 1 no longer hold')

    // Reference lists are fetched as the person's job; the providers are the only thing mocked.
    const providers = Promise.withResolvers<undefined>()
    let hold = false
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { signal: AbortSignal }) => {
      const doi = /works\/(10\.\d+%2F\w+)$/.exec(url)?.[1]
      if (doi) return new Response(JSON.stringify({ message: { DOI: decodeURIComponent(doi), title: [`Paper ${decodeURIComponent(doi)}`], abstract: 'Open abstract' } }))
      if (url.includes('/works/doi:')) return new Response(JSON.stringify({ best_oa_location: null }))
      if (hold) {
        providers.resolve(undefined)
        return new Promise<Response>((_resolve, reject) => { init.signal.addEventListener('abort', () => { reject(init.signal.reason as Error) }, { once: true }) })
      }
      if (down) return new Response('unavailable', { status: 503 })
      const wanted = decodeURIComponent(url).match(/filter=doi:([^&]*)/)?.[1] ?? ''
      const known: Record<string, { id: string; referenced_works: string[] }> = {
        '10.1000/a': { id: 'https://openalex.org/W1', referenced_works: ['https://openalex.org/W2'] }, '10.1000/b': { id: 'https://openalex.org/W2', referenced_works: [] },
      }
      return new Response(JSON.stringify({ results: wanted.split('|').flatMap(doi => known[doi] === undefined ? [] : [{ ...known[doi], doi: `https://doi.org/${doi}` }]) }))
    }))
    let down = false
    const item = (doi: string) => ({ id: doi, provider: 'crossref', title: 'T', authors: [], doi, url: `https://doi.org/${doi}`, abstract: 'About', bibtex: '' })
    await agent({ action: 'literature-import', item: item('10.1000/a') })
    await agent({ action: 'literature-import', item: item('10.1000/b') })
    const job = await user({ action: 'relations-citations' })
    expect(job).toMatchObject({ message: 'relations-citations started' })
    await vi.waitFor(() => { expect(service.tasks().find(task => task.id === job.jobId)?.status).toBe('completed') })
    expect(service.tasks().find(task => task.id === job.jobId)?.result).toMatchObject({
      message: '1 citation(s) recorded from 2 reference list(s)', relationCitations: { asked: 2, works: 2, added: 1, failures: [] },
    })
    expect((await user({ action: 'relations-graph' })).relations?.counts.citationLists).toBe(2)

    // A provider that is down fails its requests, not the job; the papers stay due.
    await agent({ action: 'literature-import', item: item('10.1000/c') })
    down = true
    const failing = await user({ action: 'relations-citations' })
    await vi.waitFor(() => { expect(service.tasks().find(task => task.id === failing.jobId)?.status).toBe('completed') })
    expect(service.tasks().find(task => task.id === failing.jobId)?.result).toMatchObject({
      message: '0 citation(s) recorded from 2 reference list(s); 1 request(s) failed', relationCitations: { asked: 1, failures: [expect.stringContaining('HTTP 503')] },
    })
    down = false

    // Disabling the plugin cancels the job in flight and removes the commands; the file stays.
    hold = true
    const stuck = await user({ action: 'relations-citations' })
    await providers.promise
    await toggle(true)
    await vi.waitFor(() => { expect(service.tasks().find(task => task.id === stuck.jobId)).toMatchObject({ status: 'failed', message: 'The relation graph plugin was disabled' }) })
    expect((await service.snapshot()).knowledge?.modules.relations).toBe(false)
    for (const request of [{ action: 'relations-graph' }, { action: 'relations-paths', from: 'a', to: 'b' }, { action: 'relations-gaps', axis: 'task' }, { action: 'relations-suggestions' }, { action: 'relations-citations' }]) {
      await expect(user(request)).rejects.toThrow(/Relation graph plugin is disabled/)
    }
    await expect(agent({ action: 'relations-propose', proposals: [alpha] })).rejects.toThrow(/Relation graph plugin is disabled/)
    expect((await readFile(join(project.root, '.research', 'kg', 'relations.json'), 'utf8')).includes('Alpha outperforms Beta')).toBe(true)
    await toggle(false)
    expect((await user({ action: 'relations-graph', entity: 'Beta' })).relations?.match).toBe('found')
  })

  it('answers the relation graph of an example research and refuses to change it', async () => {
    root = await temporaryRoot('research-relations-example-')
    const { service } = await boot(new MemoryMediaPool())
    const example = await service.create({ title: 'Example', root: join(root, 'demo', 'shipped'), brief: '' })
    vi.stubEnv('DSH_HOME', root)
    try {
      const run = (request: Record<string, unknown>, actor: 'user' | 'agent') => service.execute({ projectId: example.id, ...request } as never, signal, actor)
      for (const actor of ['user', 'agent'] as const) {
        const read = await run({ action: 'relations-graph' }, actor)
        expect(actor === 'user' ? read.message : read.content).toMatch(/no relations yet/)
        expect((await run({ action: 'relations-suggestions' }, actor)).message).toBe('0 pair(s) of entities that may be one')
        await expect(run({ action: 'relations-propose', proposals: [{
          kind: 'is-a', from: { kind: 'method', name: 'Alpha' }, to: { kind: 'method', name: 'Beta' }, ground: { type: 'quote', evidenceId: 'x', revision: 1, quote: 'Alpha is a Beta.' },
        }] }, actor)).rejects.toThrow('这是示例研究，只能查看 / This is an example research and is read-only')
        await expect(run({ action: 'relations-reject', relation: 'x' }, actor)).rejects.toThrow(/read-only/)
      }
      for (const request of [{ action: 'relations-entity', kind: 'method', name: 'Alpha' }, { action: 'relations-reground' }, { action: 'relations-citations' }, { action: 'relations-merge', from: 'a', into: 'b' }]) {
        await expect(run(request, 'user')).rejects.toThrow(/read-only/)
      }
      expect(existsSync(join(example.root, '.research', 'kg', 'relations.json'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('shows a project\'s sessions the skills of its mode, and swaps them when the mode changes', async () => {
    root = await temporaryRoot('research-skills-')
    const { service } = await boot(new MemoryMediaPool())
    const names = async (cwd?: string): Promise<string[]> => (await ctx!.skills.list({ cwd })).map(skill => skill.name).sort()
    const p = await service.create({ title: 'Skills', root: join(root, 'p'), brief: '' })
    // The graph skill is shared; mode-specific skills still follow the current project's mode.
    expect(await names(p.root)).toEqual(['research-knowledge'])
    expect(await names(join(root, 'elsewhere'))).toEqual(['research-knowledge'])
    expect(await names()).toEqual(['research-knowledge'])
    await service.execute({ projectId: p.id, action: 'set-mode', mode: 'spark-to-paper', route: 'idea' }, signal, 'agent')
    expect(await names(join(p.root, 'paper'))).toEqual([
      'research-knowledge',
      'ts-figure-svg', 'ts-idea2story', 'ts-kg-build', 'ts-paper', 'ts-paper-cite', 'ts-paper-data', 'ts-paper-experiment',
      'ts-paper-figure', 'ts-paper-latex', 'ts-paper-plan', 'ts-paper-refine', 'ts-paper-review', 'ts-paper-write',
    ])
    const loaded = await ctx!.skills.get('ts-paper', { cwd: p.root })
    expect(loaded).toMatchObject({ name: 'ts-paper', provider: 'research-modes', source: 'bundled', resourceBase: { kind: 'directory' } })
    expect(loaded?.content).toMatch(/^\s*# spark-to-paper/)
    expect(loaded?.content).not.toMatch(/^---/)
    await service.execute({ projectId: p.id, action: 'set-mode', mode: 'general' }, signal, 'user')
    expect(await names(p.root)).toEqual(['research-knowledge'])
    // A new project in a pack mode lists that pack's skills at once.
    const q = await service.create({ title: 'Direct', root: join(root, 'q'), brief: '', mode: 'spark-to-paper' })
    expect(await names(q.root)).toContain('ts-paper')
    const { modeSkillDefinition } = await import('../src/mode-skills.ts')
    expect(await modeSkillDefinition({ name: 'gone', description: 'd', directory: join(root, 'gone') })).toBeUndefined()
    await write(join(root, 'extra', 'SKILL.md'), '---\nname: extra\ndescription: An extra skill.\n---\nBody')
    expect(await modeSkillDefinition({ name: 'extra', description: 'An extra skill.', whenToUse: 'Rarely', directory: join(root, 'extra') }))
      .toMatchObject({ whenToUse: 'Rarely', content: 'Body' })
  })

  it('runs a mode\'s gates in a check and its declared scripts on request, with the platform Python', async () => {
    root = await temporaryRoot('research-scripts-')
    const { service } = await boot(new MemoryMediaPool())
    const p = await service.create({ title: 'Scripts', root: join(root, 'p'), brief: '', mode: 'spark-to-paper', route: 'data' })
    const run = (request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    // A check never installs Python: without it a gate reports, and no process starts.
    const without = await run({ action: 'check', scope: 'plan' })
    expect(without.check?.findings.filter(f => f.check === 'template-lint').map(f => f.message)).toEqual([expect.stringMatching(/needs the platform Python/)])
    expect(processes.calls.some(call => call.args.join(' ').includes('run_gate.py'))).toBe(false)
    const python = join(root, 'python.exe')
    await write(python, '')
    await service.configure({ python })
    const checked = await run({ action: 'check', scope: 'plan' })
    // The gate names blueprint.json, which the project does not have yet, so the finding links to no file.
    expect(checked.check?.findings.filter(f => f.check === 'blueprint-lint')).toEqual([{ check: 'blueprint-lint', severity: 'error', message: 'blueprint found a problem' }])
    expect(checked.check?.gatesRun).toEqual(['template-lint', 'blueprint-lint'])
    const gate = processes.calls.find(call => call.args.includes('blueprint'))!
    expect(gate).toMatchObject({ command: toNamespacedPath(python), options: { cwd: p.root } })
    expect(gate.args.slice(0, 3)).toEqual(['-I', '-X', 'utf8'])
    // A declared script runs with the agent's extra arguments; its exit code and both streams come back.
    const assembled = await run({ action: 'run-script', script: 'assemble-paper', args: ['--backup'] })
    expect(assembled).toMatchObject({ message: 'assemble-paper finished', content: '{"ok": true}\n[stderr]\ncopied ts_iieta.sty' })
    expect(processes.calls.at(-1)?.args.slice(-3)).toEqual([p.root, '--no-compile', '--backup'])
    expect(await run({ action: 'run-script', script: 'blueprint-fix' })).toMatchObject({ message: 'blueprint-fix exited with code 1; see its output', content: '{"ok": false}' })
    // Scripts are the mode's own, and route-limited ones only exist on their routes.
    await expect(run({ action: 'run-script', script: 'recompute-results' })).rejects.toThrow(/Mode spark-to-paper has no script recompute-results; its scripts: blueprint-fix, /)
    await run({ action: 'set-mode', mode: 'general' })
    await expect(run({ action: 'run-script', script: 'assemble-paper' })).rejects.toThrow(/^Mode general has no script assemble-paper$/)
  })

  it('recalls from the built-in graph, checks novelty and builds a project graph, semantically once an embedding key is stored', async () => {
    root = await temporaryRoot('research-knowledge-')
    const harness = await boot(new MemoryMediaPool())
    const { service } = harness
    const p = await service.create({ title: 'Knowledge', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    const status = JSON.parse((await run({ action: 'graph-status' })).content ?? '{}') as { builtin: { patterns: number }; embedding: { configured: boolean } }
    expect(status.builtin.patterns).toBeGreaterThan(300)
    expect(status.embedding.configured).toBe(false)
    const recalled = await run({ action: 'recall', query: 'continual category discovery for e-commerce agents', topK: 3, path: 'recall.json' })
    expect(recalled).toMatchObject({ message: '3 pattern(s) recalled (lexical); saved to recall.json', path: 'recall.json' })
    expect(JSON.parse(await readFile(join(p.root, 'recall.json'), 'utf8'))).toMatchObject({ query: 'continual category discovery for e-commerce agents', basis: 'lexical' })
    expect((await run({ action: 'recall', query: 'graph neural networks' })).message).toBe('8 pattern(s) recalled (lexical)')
    await write(join(p.root, 'story.json'), JSON.stringify({ title: 'Continual category discovery', abstract: 'New product categories appear over time' }))
    const novelty = await run({ action: 'novelty' })
    expect(novelty).toMatchObject({ path: 'novelty_report.json', message: expect.stringMatching(/^Novelty risk unknown \(lexical/) as unknown })
    // With an embedding endpoint and its key, the same actions rank semantically.
    await expect(service.setCredential('embedding', 'key')).rejects.toThrow(/Configure the embedding provider/)
    await service.configure({ embedding: { baseUrl: 'https://emb.example/v1', model: 'emb-small' } })
    expect((await run({ action: 'recall', query: 'agents', topK: 1 })).message).toMatch(/\(lexical\)/)
    await service.setCredential('embedding', ' emb-secret ')
    expect(harness.credentials.get(EMBEDDING_CREDENTIAL)).toBe('emb-secret')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { input } = JSON.parse(init.body as string) as { input: string[] }
      return new Response(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: [text.length % 7, 1, text.includes('soil') ? 5 : 0] })) }))
    }))
    expect((await run({ action: 'novelty', story: 'story.json', path: 'reports/novelty.json' })).message).toMatch(/^Novelty risk (high|medium|low) \(semantic \(emb-small\)/)
    const corpus = ['a', 'b', 'c'].map(id => JSON.stringify({ paper_id: id, title: `Soil ${id}`, story: `soil story ${id}`, base_problem: 'soil', solution_pattern: 'soil' }))
    await write(join(p.root, 'papers.jsonl'), corpus.join('\n'))
    const built = await run({ action: 'build-graph', papers: 'papers.jsonl', domain: 'soil' })
    expect(built).toMatchObject({ path: '.research/kg/clusters.json', message: expect.stringMatching(/cluster\(s\) from 3 papers \(embedding\)$/) as unknown })
    const clusters = (JSON.parse(built.content ?? '{}') as { clusters: { id: string }[] }).clusters
    await write(join(p.root, 'cluster_meta.json'), JSON.stringify(Object.fromEntries(clusters.map(cluster => [cluster.id, { name: 'Soil as a ledger', summary: 's', tier: 'A' }]))))
    expect(await run({ action: 'name-patterns' })).toMatchObject({ path: '.research/kg/graph.json', message: 'Project graph written and valid' })
    await write(join(p.root, 'bad.json'), JSON.stringify({ ghost: { name: 'x' } }))
    expect((await run({ action: 'name-patterns', names: 'bad.json' })).message).toMatch(/^Project graph written with \d+ problem\(s\) to fix$/)
  })

  it('keeps managed tools in the product home unless a component root is configured', async () => {
    root = await temporaryRoot('research-home-')
    const { service } = await boot(new MemoryMediaPool(), { componentRoot: false })
    expect(service.components.root).toBe(join(resolveDshHome(), 'research', 'components'))
  })

  it('migrates a stored version-1 project on open', async () => {
    root = await temporaryRoot('research-migrate-')
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
    root = await temporaryRoot('research-text-')
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

  it('keeps an example research read-only, whoever asks, and still lets it be read and checked', async () => {
    root = await temporaryRoot('research-example-')
    const { service } = await boot(new MemoryMediaPool())
    // Made before the data home points here; from then on it lies in `<data home>/demo`, as the shipped examples do.
    const example = await service.create({ title: 'Example', root: join(root, 'demo', 'shipped'), brief: '' })
    const own = await service.create({ title: 'Own', root: join(root, 'own'), brief: '' })
    await write(join(example.root, 'notes.md'), 'an example note')
    await service.execute({ projectId: example.id, action: 'import', paths: ['notes.md'] } as never, signal, 'agent')
    vi.stubEnv('DSH_HOME', root)
    try {
      const run = (request: Record<string, unknown>, actor: 'user' | 'agent' = 'agent') =>
        service.execute({ projectId: example.id, ...request } as never, signal, actor)
      const before = structuredClone(service.getProject(example.id))
      const snapshot = await service.snapshot()
      expect(snapshot.projects.find(p => p.id === example.id)?.example).toBe(true)
      expect(snapshot.projects.find(p => p.id === own.id)).not.toHaveProperty('example')
      for (const actor of ['user', 'agent'] as const) {
        await expect(run({ action: 'record-decision', question: 'Q?', answer: 'A' }, actor)).rejects.toThrow('这是示例研究，只能查看 / This is an example research and is read-only')
        await expect(run({ action: 'set-autonomy', autonomy: 'automatic' }, actor)).rejects.toThrow(/read-only/)
      }
      await expect(run({ action: 'board-update', board: { sections: [] } })).rejects.toThrow(/read-only/)
      await expect(run({ action: 'board-refresh' })).rejects.toThrow(/read-only/)
      // Reading still works; a board read asked to refresh shows the last one and writes nothing.
      expect(JSON.parse((await run({ action: 'search-evidence', query: 'example' })).content ?? '[]')).toHaveLength(1)
      expect((await run({ action: 'board-view', refresh: true })).board).toBeDefined()
      expect(existsSync(join(example.root, '.research', 'board', 'snapshot.json'))).toBe(false)
      // A check runs and answers, and is not stored.
      expect((await run({ action: 'check' })).check).toBeDefined()
      expect(service.getProject(example.id)).toEqual(before)
      // The last guard: nothing that reaches the record changes it, and background observation passes examples by.
      const internals = service as unknown as { mutate(id: string, work: () => void): Promise<void>; refreshRunning(): Promise<void> }
      await expect(internals.mutate(example.id, () => {})).rejects.toThrow(/read-only/)
      await internals.refreshRunning()
      // Opening an example returns it unbound; nothing new is made among the examples, not even a folder.
      expect((await service.create({ title: 'Again', root: example.root, brief: '' })).id).toBe(example.id)
      await expect(service.create({ title: 'New', root: join(root, 'demo', 'mine'), brief: '' })).rejects.toThrow(/read-only/)
      expect(existsSync(join(root, 'demo', 'mine'))).toBe(false)
      // The agent's brief says so.
      const { projectBrief } = await import('../src/tools.ts')
      type Brief = { example?: boolean; guide: string[] }
      const briefOf = async (id: ResearchProject['id']): Promise<Brief> => {
        const project = service.getProject(id)
        return projectBrief(project, service.modes.resolve(project), await service.standing(project)) as Brief
      }
      const brief = await briefOf(example.id)
      expect(brief.example).toBe(true)
      expect(brief.guide[0]).toMatch(/^This is an example research shipped with the app, and it is read-only/)
      const ownBrief = await briefOf(own.id)
      expect(ownBrief).not.toHaveProperty('example')
      expect(ownBrief.guide[0]).not.toMatch(/example/)
      // The own research beside it records as before.
      await service.execute({ projectId: own.id, action: 'record-decision', question: 'Q?', answer: 'A' } as never, signal, 'user')
      expect(service.getProject(own.id).decisions).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('routes, decides, checks and records files for the agent and the desktop alike', async () => {
    root = await temporaryRoot('research-ledger-')
    const { service } = await boot(new MemoryMediaPool())
    const p = await service.create({ title: 'Ledger', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>, actor: 'user' | 'agent' = 'agent') => service.execute({ projectId: p.id, ...request } as never, signal, actor)
    const announced: { mode: string; route?: string | undefined }[] = []
    ctx!.on('research/mode', (event) => { announced.push(event) })
    expect((await run({ action: 'set-mode', mode: 'spark-to-paper', route: 'data', reason: 'CSV results exist' })).message)
      .toBe('Mode spark-to-paper (data): data → plan → cite → write → refine → review → figures → latex → submission')
    expect(service.getProject(p.id)).toMatchObject({ mode: 'spark-to-paper', route: 'data', modeReason: 'CSV results exist', modeSetBy: 'agent' })
    await expect(run({ action: 'set-mode', mode: 'spark-to-paper', route: 'sideways' })).rejects.toThrow(/has no route sideways/)
    expect((await run({ action: 'set-mode', mode: 'general' }, 'user')).message).toBe('Mode General: no pipeline; run checks when useful')
    // A switch without a new reason keeps the one on record.
    expect(service.getProject(p.id)).toMatchObject({ mode: 'general', modeReason: 'CSV results exist', modeSetBy: 'user' })
    expect('route' in service.getProject(p.id)).toBe(false)
    expect(announced.map(event => [event.mode, event.route])).toEqual([['spark-to-paper', 'data'], ['general', undefined]])
    await run({ action: 'set-autonomy', autonomy: 'automatic' }, 'user')
    await run({ action: 'record-decision', question: 'Which dataset?', answer: 'CIFAR-10', rationale: '  small and standard ' })
    expect(service.getProject(p.id)).toMatchObject({ autonomy: 'automatic' })
    expect(service.getProject(p.id).decisions.at(-1)).toMatchObject({ question: 'Which dataset?', answer: 'CIFAR-10', by: 'agent', rationale: 'small and standard' })
    await run({ action: 'record-decision', question: 'Go?', answer: 'Yes' }, 'user')
    expect(service.getProject(p.id).decisions.at(-1)).toMatchObject({ by: 'user', rationale: '' })
    // The agent records the user's checkpoint answer in the user's name.
    await run({ action: 'record-decision', question: 'Run it?', answer: 'Yes', decidedBy: 'user' })
    expect(service.getProject(p.id).decisions.at(-1)).toMatchObject({ question: 'Run it?', by: 'user' })
    const check = await run({ action: 'check' })
    expect(check.message).toMatch(/Not done yet/)
    expect(check.check?.clean).toBe(false)
    expect(service.getProject(p.id).lastCheck?.scope).toBe('all')
    const saved = await run({ action: 'save-artifact', path: 'paper/main.tex', content: '\\documentclass{article}\n\\begin{document}x\\end{document}', kind: 'manuscript' })
    expect(saved.message).toMatch(/revision 1/)
    const artifactId = service.getProject(p.id).artifacts[0]!.id
    const text = await run({ action: 'read-artifact', artifactId })
    expect(text.content).toContain('documentclass')
    expect(text).not.toHaveProperty('binary')
    await expect(run({ action: 'read-artifact', artifactId: 'nope' })).rejects.toThrow(/not found/)
    // A binary file reads as no text, and no one can save text over it: the bytes and the record stay as they were.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
    await mkdir(join(p.root, 'figures'), { recursive: true })
    await writeFile(join(p.root, 'figures/plot.png'), png)
    await run({ action: 'register-artifact', path: 'figures/plot.png', kind: 'figure' })
    const image = service.getProject(p.id).artifacts.find(a => a.path === 'figures/plot.png')!
    expect(await run({ action: 'read-artifact', artifactId: image.id })).toMatchObject({ content: '', binary: true, path: 'figures/plot.png' })
    for (const actor of ['user', 'agent'] as const) {
      await expect(run({ action: 'save-artifact', path: 'figures/plot.png', content: '', kind: 'figure', expectedRevision: image.revision }, actor))
        .rejects.toThrow(/Refusing to save text over the binary file figures\/plot\.png/)
    }
    expect(await readFile(join(p.root, 'figures/plot.png'))).toEqual(png)
    expect(service.getProject(p.id).artifacts.find(a => a.path === 'figures/plot.png')).toEqual(image)
    // Under a name that says nothing, the bytes decide.
    const weights = Buffer.from([1, 2, 0, 3])
    await mkdir(join(p.root, 'data'), { recursive: true })
    await writeFile(join(p.root, 'data/weights.bin'), weights)
    await run({ action: 'register-artifact', path: 'data/weights.bin', kind: 'supplement' })
    const blob = service.getProject(p.id).artifacts.find(a => a.path === 'data/weights.bin')!
    expect(await run({ action: 'read-artifact', artifactId: blob.id })).toMatchObject({ content: '', binary: true })
    await expect(run({ action: 'save-artifact', path: 'data/weights.bin', content: 'text', kind: 'supplement' }, 'user')).rejects.toThrow(/binary file data\/weights\.bin/)
    expect(await readFile(join(p.root, 'data/weights.bin'))).toEqual(weights)
    await run({ action: 'claim', claim: { id: 'h', text: 'It helps', kind: 'hypothesis', state: 'proposed', evidence: [], artifactIds: [] } })
    expect(service.getProject(p.id).claims).toHaveLength(1)
    const clean = await run({ action: 'check', scope: 'figures' })
    expect(clean.message).toBe('Clean')
  })

  it('leaves the mode unchosen until someone chooses it, records each choice, and restarts progress for a new mode', async () => {
    root = await temporaryRoot('research-mode-')
    const { service } = await boot(new MemoryMediaPool())
    // Created without naming a mode: general, and not chosen yet. Naming one, even general, is a choice.
    const p = await service.create({ title: 'Unchosen', root: join(root, 'p'), brief: '' })
    expect(p).toMatchObject({ mode: 'general' })
    expect(p).not.toHaveProperty('modeSetBy')
    expect(await service.create({ title: 'Named', root: join(root, 'named'), brief: '', mode: 'general' })).toMatchObject({ modeSetBy: 'user' })
    const run = (request: Record<string, unknown>, actor: 'user' | 'agent' = 'agent') => service.execute({ projectId: p.id, ...request } as never, signal, actor)
    await run({ action: 'check' })
    expect(service.getProject(p.id).progress?.full).toBeDefined()
    // The agent records the user's answer at a checkpoint in the user's name, with the reason.
    await run({ action: 'set-mode', mode: 'spark-to-paper', route: 'data', reason: ' Results exist ', decidedBy: 'user' })
    const chosen = service.getProject(p.id)
    expect(chosen).toMatchObject({ modeSetBy: 'user', modeReason: 'Results exist', progress: { mode: 'spark-to-paper', route: 'data', phases: {}, findings: {} } })
    expect(chosen.progress).not.toHaveProperty('full')
    expect(chosen.decisions).toEqual([{
      id: expect.any(String) as unknown, question: '模式与路线', answer: 'spark-to-paper · data', by: 'user', rationale: 'Results exist',
      at: expect.any(String) as string, key: 'mode',
    }])
    // Choosing the same mode and route again keeps what was checked; its decision still records who chose it.
    await run({ action: 'check', scope: 'data' })
    const checked = service.getProject(p.id).progress
    await run({ action: 'set-mode', mode: 'spark-to-paper', route: 'data' })
    expect(service.getProject(p.id)).toMatchObject({ progress: checked, modeReason: 'Results exist', modeSetBy: 'agent' })
    expect(service.getProject(p.id).decisions.at(-1)).toMatchObject({ answer: 'spark-to-paper · data', by: 'agent', rationale: '', key: 'mode' })
    // A mode without routes is recorded by its id alone.
    await run({ action: 'set-mode', mode: 'general' }, 'user')
    expect(service.getProject(p.id)).toMatchObject({ progress: { mode: 'general', phases: {}, findings: {} } })
    expect(service.getProject(p.id).progress).not.toHaveProperty('route')
    expect(service.getProject(p.id).decisions.at(-1)).toMatchObject({ answer: 'general', by: 'user' })
  })

  it('renames a research and its folder\'s Workspace, unless another Workspace already has the title', async () => {
    root = await temporaryRoot('research-rename-')
    const { service, workspaces } = await boot(new MemoryMediaPool())
    const p = await service.create({ title: 'Draft', root: join(root, 'p'), brief: '' })
    const other = await service.create({ title: 'Taken title', root: join(root, 'other'), brief: '' })
    const rename = (title: string) => service.execute({ projectId: p.id, action: 'rename', title } as never, signal, 'agent')
    // A placeholder title, as a draft research carries one.
    await (service as unknown as { mutate(id: string, work: (project: ResearchProject) => void): Promise<void> })
      .mutate(p.id, (project) => { project.untitled = true })
    expect(service.getProject(p.id).untitled).toBe(true)
    expect(await rename('  Sparse attention  ')).toMatchObject({ message: 'Research renamed to "Sparse attention"' })
    expect(service.getProject(p.id)).toMatchObject({ title: 'Sparse attention' })
    expect(service.getProject(p.id)).not.toHaveProperty('untitled')
    expect(workspaces.get(p.workspaceId)?.title).toBe('Sparse attention')
    // The same title again changes nothing on the Workspace.
    expect((await rename('Sparse attention')).message).toBe('Research renamed to "Sparse attention"')
    // Workspace titles are unique: the research takes the title, its Workspace keeps its own.
    expect((await rename('Taken title')).message).toMatch(/^Research renamed to "Taken title"; its folder keeps its earlier name .* already called "Taken title"$/)
    expect(service.getProject(p.id).title).toBe('Taken title')
    expect(workspaces.get(p.workspaceId)?.title).toBe('Sparse attention')
    expect(workspaces.get(other.workspaceId)?.title).toBe('Taken title')
    await expect(rename(' ')).rejects.toThrow()
    // A folder whose registration is gone still gets its title.
    workspaces.delete(p.workspaceId)
    expect((await rename('Unregistered')).message).toBe('Research renamed to "Unregistered"')
  })

  it('reads the unfinished goals of a research\'s live conversations through the goal service', async () => {
    root = await temporaryRoot('research-goals-')
    const { service, agents, goals } = await boot(new MemoryMediaPool())
    const p = await service.create({ title: 'Goals', root: join(root, 'p'), brief: '' })
    const nested = await service.create({ title: 'Nested', root: join(root, 'p', 'nested'), brief: '' })
    const goal = (objective: string, phase: GoalView['phase'], updatedAt: number): GoalView => ({
      id: `goal-${objective}` as GoalView['id'], revision: 1, objective, phase, maxGoalRounds: 10, roundsStarted: 2, createdAt: 0, updatedAt, activation: 'armed',
    })
    const live = (id: string, cwd: string | undefined, origin?: 'subagent'): void => {
      agents.push({ session: { id, header: { ...(cwd === undefined ? {} : { cwd }), ...(origin === undefined ? {} : { origin }) } } })
    }
    live('paused', join(p.root, 'paper')); goals.set('paused', goal('paused', 'paused', 5))
    live('older', p.root); goals.set('older', goal('older', 'active', 1))
    live('newer', p.root); goals.set('newer', goal('newer', 'active', 9))
    live('blocked', p.root); goals.set('blocked', goal('blocked', 'blocked', 3))
    // None of these counts: a finished goal, no goal, a replay failure, a subagent, no folder, and a nested research.
    live('done', p.root); goals.set('done', goal('done', 'complete', 20))
    live('none', p.root)
    live('broken', p.root); goals.set('broken', new Error('goal replay failed'))
    live('child', p.root, 'subagent'); goals.set('child', goal('child', 'active', 30))
    live('nowhere', undefined); goals.set('nowhere', goal('nowhere', 'active', 30))
    live('inner', nested.root); goals.set('inner', goal('inner', 'active', 30))
    expect(service.activeGoals(service.getProject(p.id))).toEqual([
      { sessionId: 'newer', objective: 'newer', phase: 'active', roundsStarted: 2, updatedAt: 9 },
      { sessionId: 'older', objective: 'older', phase: 'active', roundsStarted: 2, updatedAt: 1 },
      { sessionId: 'blocked', objective: 'blocked', phase: 'blocked', roundsStarted: 2, updatedAt: 3 },
      { sessionId: 'paused', objective: 'paused', phase: 'paused', roundsStarted: 2, updatedAt: 5 },
    ])
    expect(service.activeGoals(service.getProject(nested.id)).map(item => item.sessionId)).toEqual(['inner'])
    // Each snapshot carries them with their research, in the same order; a research without one carries none.
    const quiet = await service.create({ title: 'Quiet', root: join(root, 'quiet'), brief: '' })
    const listed = (await service.snapshot()).projects
    expect(listed.find(item => item.id === p.id)?.goals?.map(item => item.sessionId)).toEqual(['newer', 'older', 'blocked', 'paused'])
    expect(listed.find(item => item.id === nested.id)?.goals?.map(item => item.sessionId)).toEqual(['inner'])
    expect(listed.find(item => item.id === quiet.id)).not.toHaveProperty('goals')
  })

  it('gives every conversation of a research the permission preset of its autonomy, as it changes and as each one opens', async () => {
    root = await temporaryRoot('research-autonomy-')
    const pool = new MemoryMediaPool()
    const { service, applied, open } = await boot(pool)
    // Its conversation went live before the record existed, and follows the record once it does.
    const p = await service.create({ title: 'Automatic', root: join(root, 'p'), brief: '', autonomy: 'automatic' })
    expect(applied.get(p.sessionId!)).toBe('research-auto')
    // Nested inside p: its conversation opened under p, and takes its own research's preset once that is recorded.
    const nested = await service.create({ title: 'Nested', root: join(root, 'p', 'nested'), brief: '' })
    expect(applied.get(nested.sessionId!)).toBe('workspace-write')
    // A conversation bound to a research follows it wherever its folder is.
    open({ id: 'legacy', header: { cwd: join(root, 'elsewhere') } })
    expect(applied.has('legacy')).toBe(false)
    await service.createProject({ title: 'Bound', root: join(root, 'bound'), brief: '', autonomy: 'automatic' }, 'legacy')
    expect(applied.get('legacy')).toBe('research-auto')
    // Each conversation that opens later takes the preset of the innermost research around it. A delegated child
    // keeps what its delegation fixed, a conversation outside every research is left alone, and a session whose
    // permission cannot be set still opens.
    open({ id: 'second', header: { cwd: join(p.root, 'paper') } })
    open({ id: 'inner', header: { cwd: join(nested.root, 'notes') } })
    open({ id: 'child', header: { cwd: p.root, origin: 'subagent' } })
    open({ id: 'outside', header: { cwd: join(root, 'outside') } })
    open({ id: 'folderless', header: {} })
    open({ id: 'unreadable', header: { cwd: p.root } })
    expect(Object.fromEntries(applied)).toEqual({
      [p.sessionId!]: 'research-auto', [nested.sessionId!]: 'workspace-write', legacy: 'research-auto', second: 'research-auto', inner: 'workspace-write',
    })
    expect(logged('warn', 'research autonomy for session %s: %s unreadable permission: permissions session projection is not registered')).toBe(true)
    // A change of autonomy, by the person or the agent, reaches every live conversation of that research and no other.
    await service.execute({ projectId: nested.id, action: 'set-autonomy', autonomy: 'automatic' } as never, signal, 'agent')
    await service.execute({ projectId: p.id, action: 'set-autonomy', autonomy: 'checkpoints' } as never, signal, 'user')
    expect(Object.fromEntries(applied)).toEqual({
      [p.sessionId!]: 'workspace-write', [nested.sessionId!]: 'research-auto', legacy: 'research-auto', second: 'workspace-write', inner: 'research-auto',
    })

    // An example is never touched: not as its conversations open, not when the service starts beside them.
    const example = await service.create({ title: 'Example', root: join(root, 'demo', 'shipped'), brief: '', autonomy: 'automatic' })
    vi.stubEnv('DSH_HOME', root)
    try {
      applied.clear()
      open({ id: 'demo-reader', header: { cwd: example.root } })
      expect(applied.size).toBe(0)
      // Conversations already live when the service starts are aligned then.
      await ctx!.fiber.dispose(); ctx = undefined
      const restarted = await boot(pool, {
        dataHome: root, live: [{ id: 'resumed', header: { cwd: p.root } }, { id: 'demo-resumed', header: { cwd: example.root } }],
      })
      expect(Object.fromEntries(restarted.applied)).toEqual({ resumed: 'workspace-write' })
    } finally {
      vi.unstubAllEnvs()
    }

    // A permission row without the presets autonomy selects cannot honour it, so the service does not start.
    await ctx!.fiber.dispose(); ctx = undefined
    await boot(pool, { presets: ['workspace-write'] })
    expect(ctx!.get('research')).toBeUndefined()
    expect(logged('error', 'research: autonomy selects the permission presets research-auto, which the permission row does not configure')).toBe(true)
  })

  it('keeps one record of progress that only research_check writes, and derives where each project stands', async () => {
    root = await temporaryRoot('research-progress-')
    const pool = new MemoryMediaPool()
    const first = await boot(pool)
    const p = await first.service.create({ title: 'Progress', root: join(root, 'p'), brief: '', mode: 'spark-to-paper', route: 'data' })
    const run = (service: Harness['service'], request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    const python = join(root, 'python.exe')
    await write(python, '')
    await first.service.configure({ python })
    await write(join(p.root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nText.\n\\end{document}\n')
    const progress = () => first.service.getProject(p.id).progress!

    // A phase check moves only the phases whose gates all ran, and replaces only the findings of the checks it reports on.
    await run(first.service, { action: 'check', scope: 'plan' })
    expect(Object.keys(progress().phases).sort()).toEqual(['data', 'latex', 'plan', 'review'])
    expect(Object.keys(progress().findings)).toEqual(['template-lint', 'blueprint-lint'])
    expect(progress()).toMatchObject({ mode: 'spark-to-paper', route: 'data' })
    expect(progress().full).toBeUndefined()
    // The whole paper: every phase, every check, and the summary.
    const all = (await run(first.service, { action: 'check' })).check!
    expect(Object.keys(progress().phases)).toHaveLength(9)
    expect(Object.keys(progress().findings)).toHaveLength(18)
    expect(progress().full).toEqual({ clean: false, errors: all.findings.filter(f => f.severity === 'error').length, warnings: all.findings.filter(f => f.severity === 'warning').length, checkedAt: all.checkedAt })
    // cite names both a phase and a base check: the phase, with its gate.
    const cite = (await run(first.service, { action: 'check', scope: 'cite' })).check!
    expect(cite.gatesRun).toEqual(['citations-bib'])
    expect(progress().phases.cite?.checkedAt).toBe(cite.checkedAt)
    expect(progress().phases.plan?.checkedAt).toBe(all.checkedAt)
    expect(progress().full?.checkedAt).toBe(all.checkedAt)
    expect(first.service.getProject(p.id).lastCheck?.checkedAt).toBe(cite.checkedAt)
    // An export runs its own check for the package and records nothing.
    const recorded = structuredClone(first.service.getProject(p.id))
    expect((await run(first.service, { action: 'export' })).check?.scope).toBe('all')
    expect(first.service.getProject(p.id)).toMatchObject({ progress: recorded.progress, lastCheck: recorded.lastCheck })

    // The snapshot carries where the project stands, in the pack's words and names.
    const standingOf = async (service: Harness['service']) => (await service.snapshot()).projects.find(item => item.id === p.id)!.standing!
    const standing = await standingOf(first.service)
    expect(standing).toMatchObject({
      next: 'data', hint: { en: 'The measured results are not imported yet', zh: '还没有导入实测结果' },
      finished: false, checkedAt: cite.checkedAt, changedSinceCheck: false,
    })
    expect(standing.phases.map(phase => [phase.id, phase.state])).toEqual([
      ['data', 'current'], ['plan', 'pending'], ['cite', 'pending'], ['write', 'pending'], ['refine', 'pending'], ['review', 'pending'],
      ['figures', 'pending'], ['latex', 'pending'], ['submission', 'pending'],
    ])
    const groups = new Map(standing.issues.map(group => [group.check, group]))
    expect(groups.get('template-lint')).toMatchObject({ label: { en: 'Template check', zh: '模板检查' }, errors: 1, warnings: 0 })
    expect(groups.get('template-lint')).not.toHaveProperty('file')
    expect(groups.get('compile')).toMatchObject({ label: { en: 'Compile', zh: '编译' }, file: 'main.tex' })
    expect(standing.issues.findIndex(group => group.errors === 0)).toBeGreaterThan(standing.issues.findLastIndex(group => group.errors > 0))
    // The brief reads the same standing.
    expect(await first.service.standing(first.service.getProject(p.id))).toEqual(standing)

    // Progress for another route describes nothing on this one, and a recorded deferral defers the phase that allows it.
    await run(first.service, { action: 'set-mode', mode: 'spark-to-paper', route: 'proposal' })
    await run(first.service, { action: 'record-decision', question: 'Run the experiments here?', answer: 'No GPU; the author runs them', decidedBy: 'user', key: 'experiments-deferred' })
    expect(first.service.getProject(p.id).decisions.at(-1)).toMatchObject({ key: 'experiments-deferred', by: 'user' })
    const rerouted = await standingOf(first.service)
    expect(rerouted).toMatchObject({ next: 'plan', finished: false, changedSinceCheck: false, issues: [] })
    expect(rerouted).not.toHaveProperty('checkedAt')
    expect(rerouted.phases.find(phase => phase.id === 'experiments')?.state).toBe('deferred')
    await run(first.service, { action: 'record-decision', question: 'Which venue?', answer: 'NeurIPS' })
    expect(first.service.getProject(p.id).decisions.at(-1)).not.toHaveProperty('key')
    await ctx!.fiber.dispose(); ctx = undefined

    // A record from before progress was stored: its last full check, in words only, stands in for it.
    for (const medium of pool.media.values()) {
      const table = medium.tables.get('projects')
      const stored = table?.get(p.id) as (ResearchProject & Record<string, unknown>) | undefined
      if (!table || !stored) continue
      const { progress: _progress, ...legacy } = stored
      table.set(p.id, {
        ...legacy, route: 'data',
        lastCheck: {
          clean: false, scope: 'all', mode: 'spark-to-paper', route: 'data', checkedAt: '2026-09-01T00:00:00.000Z',
          phases: [
            { id: 'data', done: false, missing: ['1 error(s) in cite', 'Write results.facts.json — the real numbers, produced by a script from the data — and import it as data evidence'] },
            { id: 'plan', done: true, missing: [] },
          ],
          findings: [{ check: 'cite', severity: 'error', message: 'Citation key has no bibliography entry: x', file: 'main.tex', line: 3 }],
        },
      })
    }
    const second = await boot(pool)
    const seeded = await standingOf(second.service)
    expect(second.service.getProject(p.id).progress).toBeUndefined()
    expect(seeded).toMatchObject({
      next: 'data', hint: { en: 'The result numbers are not extracted from the data yet', zh: '还没有从数据里整理出结果数字' },
      checkedAt: '2026-09-01T00:00:00.000Z', changedSinceCheck: true, finished: false,
      issues: [{ check: 'cite', errors: 1, file: 'main.tex', line: 3 }],
    })
    expect(seeded.phases[0]?.hints).toEqual([
      { en: 'The result numbers are not extracted from the data yet', zh: '还没有从数据里整理出结果数字' },
      { en: 'Fix the errors in Citations', zh: '处理「引用」里的错误' },
    ])
    expect(seeded.phases[1]?.state).toBe('done')
    // The next check folds into the progress the old report established.
    await run(second.service, { action: 'check', scope: 'data' })
    expect(second.service.getProject(p.id).progress?.phases.plan).toEqual({ done: true, unmet: [], checkedAt: '2026-09-01T00:00:00.000Z' })
  })

  it('imports sources and templates, verifies literature and searches evidence', async () => {
    root = await temporaryRoot('research-evidence-')
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
    expect(imported.content).toContain('@misc{crossref_10_1_x')
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

  it('commits external revisions despite a refused editor save and recovers orphaned history after restart', async () => {
    root = await temporaryRoot('research-revision-recovery-')
    const pool = new MemoryMediaPool()
    let { service } = await boot(pool)
    const p = await service.create({ title: 'Revisions', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'user')
    const save = { action: 'save-artifact', path: 'paper/main.tex', kind: 'manuscript' }
    await run({ ...save, content: 'first' })
    const artifactId = service.getProject(p.id).artifacts[0]!.id
    await writeFile(join(p.root, 'paper/main.tex'), 'external second')
    await expect(run({ ...save, content: 'stale editor', expectedRevision: 1 })).rejects.toThrow(/revision 2, not 1/)
    expect(service.getProject(p.id).artifacts[0]?.revision).toBe(2)
    const adopted = service.getProject(p.id)
    await expect(run({ ...save, content: 'same stale editor', expectedRevision: 1 })).rejects.toThrow(/revision 2, not 1/)
    expect(service.getProject(p.id)).toEqual(adopted)
    await ctx!.fiber.dispose(); ctx = undefined
    service = (await boot(pool)).service
    expect(await run({ action: 'read-artifact', artifactId })).toMatchObject({ message: 'Revision 2', content: 'external second' })
    await run({ ...save, content: 'merged third', expectedRevision: 2 })
    // A history file from an earlier interrupted write stays immutable and cannot strand future saves.
    await writeFile(join(p.root, `.research/history/${artifactId}/4.tex`), 'orphaned fourth')
    await writeFile(join(p.root, 'paper/main.tex'), 'external fifth')
    await expect(run({ ...save, content: 'old editor', expectedRevision: 3 })).rejects.toThrow(/revision 5, not 3/)
    expect(await run({ action: 'read-artifact', artifactId })).toMatchObject({ message: 'Revision 5', content: 'external fifth' })
    await run({ ...save, content: 'merged sixth', expectedRevision: 5 })
    await writeFile(join(p.root, 'paper/main.tex'), 'registered seventh')
    await run({ action: 'register-artifact', path: 'paper/main.tex', kind: 'manuscript' })
    expect(service.getProject(p.id).artifacts[0]?.revision).toBe(7)
    for (const [revision, text] of [[1, 'first'], [2, 'external second'], [3, 'merged third'], [4, 'orphaned fourth'], [5, 'external fifth'], [6, 'merged sixth'], [7, 'registered seventh']] as const) {
      expect(await readFile(join(p.root, `.research/history/${artifactId}/${revision}.tex`), 'utf8')).toBe(text)
    }
  })

  it('collects a run that completed before submission returned, exactly once across waits, refreshes and restart', async () => {
    root = await temporaryRoot('research-fast-runs-')
    const pool = new MemoryMediaPool()
    let { service } = await boot(pool)
    await service.configure({ python: 'python', uv: 'uv' })
    const p = await service.create({ title: 'Fast run', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    await run({ action: 'environment', environment: { name: 'env', kind: 'uv', target: 'local', python: '', requirements: [], isDefault: true } })
    await write(join(p.root, 'code/train.py'), 'print(1)')
    const environmentId = service.getProject(p.id).environments[0]!.id
    const requestId = '44444444-4444-4444-8444-444444444444'
    const spec = { environmentId, name: 'fast', argv: ['{python}', 'code/train.py'], cwd: '.', seed: 0, maxSeconds: 5, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' }
    processes.launch = { status: 'completed', metrics: { accuracy: 0.8123 } }
    expect((await run({ action: 'experiment', requestId, spec })).runs?.[0]).toMatchObject(processes.launch)
    expect(service.getProject(p.id).experiments[0]?.collected).toBe(true)
    expect(service.getProject(p.id).evidence).toHaveLength(1)
    await run({ action: 'experiment-wait', runIds: [requestId], timeoutSeconds: 1 })
    await run({ action: 'experiment-refresh', runId: requestId })
    await ctx!.fiber.dispose(); ctx = undefined
    service = (await boot(pool)).service
    await run({ action: 'experiment', requestId, spec })
    await run({ action: 'experiment-refresh', runId: requestId })
    const evidence = service.getProject(p.id).evidence
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ kind: 'experiment', coverage: 'data', verified: true, chunks: [{ text: '0.8123', locator: { key: 'accuracy' } }] })
    expect(JSON.parse(await readFile(join(p.root, evidence[0]!.path), 'utf8'))).toEqual({ accuracy: 0.8123 })
    await ctx!.fiber.dispose(); ctx = undefined
    // A completed record written before result collection was fixed can be recovered without relaunching it.
    for (const medium of pool.media.values()) {
      const projects = medium.tables.get('projects')
      const stored = projects?.get(p.id) as ResearchProject | undefined
      if (projects && stored) projects.set(p.id, {
        ...stored, evidence: [], experiments: stored.experiments.map(item => ({ ...item, collected: false })),
      })
    }
    service = (await boot(pool)).service
    await run({ action: 'experiment-wait', runIds: [requestId], timeoutSeconds: 1 })
    expect(service.getProject(p.id).experiments[0]?.collected).toBe(true)
    expect(service.getProject(p.id).evidence).toHaveLength(1)
    expect(processes.calls.filter(call => call.args[1] === 'launch')).toHaveLength(1)
  })

  it('creates environments, runs experiments to completion, collects results and waits without polling', async () => {
    root = await temporaryRoot('research-runs-')
    const { service } = await boot(new MemoryMediaPool())
    await service.configure({ python: 'python', uv: 'uv' })
    const p = await service.create({ title: 'Runs', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>, sessionId?: string) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent', sessionId)
    await run({ action: 'environment', environment: { name: 'env', kind: 'uv', target: 'local', python: '', requirements: ['numpy'], isDefault: true } })
    await run({ action: 'environment', environment: { name: 'second', kind: 'existing', target: 'local', python: 'C:/py/python.exe', requirements: [], isDefault: true } })
    const environments = service.getProject(p.id).environments
    expect(environments.map(e => e.isDefault)).toEqual([false, true])
    await write(join(p.root, 'code/train.py'), 'print(1)')
    await write(join(p.root, 'code/__pycache__/x.pyc'), 'cache')
    const spec = { environmentId: environments[1]!.id, name: 'train', argv: ['{python}', 'code/train.py'], cwd: '.', seed: 1, maxSeconds: 60, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' }
    const requestId = '11111111-1111-4111-8111-111111111111'
    const submitted = await run({ action: 'experiment', requestId, spec }, 'agent-session')
    expect(submitted.runs?.[0]).toMatchObject({ status: 'running' })
    // The run remembers the conversation that submitted it, through launch and observation alike.
    expect(service.getProject(p.id).experiments[0]?.sessionId).toBe('agent-session')
    const inputs = JSON.parse(await readFile(join(p.root, '.research/runs', requestId, 'inputs.json'), 'utf8')) as { inputs: { path: string }[] }
    expect(inputs.inputs.map(input => input.path)).toEqual(['code/train.py'])
    expect((await run({ action: 'experiment', requestId, spec })).message).toMatch(/Existing experiment/)
    await expect(run({ action: 'experiment', requestId, spec: { ...spec, seed: 2 } })).rejects.toThrow(/different experiment/)
    await expect(run({ action: 'experiment-dismiss', runId: requestId })).rejects.toThrow(/unknown/)
    const waited = await run({ action: 'experiment-wait', runIds: [requestId], timeoutSeconds: 5 })
    expect(waited.runs?.[0]).toMatchObject({ status: 'completed', metrics: { accuracy: 0.8123 } })
    const project = service.getProject(p.id)
    expect(project.experiments[0]).toMatchObject({ collected: true, sessionId: 'agent-session' })
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
    // A run the desktop or another caller submitted names no conversation.
    expect(service.getProject(p.id).experiments.find(r => r.id === second)).not.toHaveProperty('sessionId')
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
    root = await temporaryRoot('research-compile-')
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
    const env = processes.calls.find(call => call.command.endsWith(`xelatex${process.platform === 'win32' ? '.exe' : ''}`)
      && call.args[0] !== '--version')?.options as { env: Record<string, string> }
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
    expect(failed.message).toMatch(/PDF compilation failed/)
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
    const installs = vi.spyOn(service.components, 'installTexPackage').mockResolvedValue(true)
    await write(join(p.root, 'paper/main.tex'), '\\documentclass{article}\\usepackage{biblatex}\\addbibresource{refs.bib}')
    processes.missingSty = true
    expect((await run({ action: 'compile', engine: 'pdflatex' })).message).toMatch(/PDF built/)
    expect(installs.mock.calls[0]?.[0]).toBe('venue.sty')
    expect(processes.calls.some(call => call.command.includes('biber'))).toBe(true)
    await write(join(p.root, 'paper/main.tex'), '\\documentclass{article}\\bibliography{refs}')
    processes.passesBeforeFailure = 1
    processes.noLog = true
    const partial = await run({ action: 'compile', engine: 'pdflatex' })
    expect(partial.message).not.toMatch(/PDF built/)
    expect(service.getProject(p.id).compilations.at(-1)?.status).toBe('failed')
    expect(partial.path).toBeUndefined()
    expect(partial.content).toMatch(/Emergency stop/)
    expect(processes.calls.some(call => call.command.includes('bibtex'))).toBe(true)
    processes.passesBeforeFailure = undefined
    processes.noLog = false
    await write(join(p.root, 'main.tex'), '\\documentclass{article}')
    expect((await run({ action: 'compile', path: 'main.tex', engine: 'pdflatex' })).path).toMatch(/\.pdf$/)

    // A bibliography style is installed on request and bibtex runs again; one that cannot be installed is logged.
    installs.mockClear()
    const compileMain = () => run({ action: 'compile', path: 'main.tex', engine: 'pdflatex' })
    await write(join(p.root, 'main.tex'), '\\documentclass{article}\\bibliography{refs}')
    processes.bibtexOutputs.push('I couldn\'t open style file venue.bst\n')
    await compileMain()
    expect(installs.mock.calls.map(call => call[0])).toEqual(['venue.bst'])
    installs.mockRejectedValueOnce(new Error('no such package'))
    processes.bibtexOutputs.push('I couldn\'t open style file other.bst\n')
    await compileMain()
    const logged = service.getProject(p.id).compilations.at(-1)!.logPath
    expect(await readFile(join(p.root, logged), 'utf8')).toMatch(/Could not install other\.bst: no such package/)
    // A missing font is looked up by its metric file. A file no package ships ends the retries,
    // and so does one still missing after its install.
    installs.mockClear()
    installs.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    processes.latexFailures.push(
      '! Font \\T1/LinBiolinumT-TLF/m/n/10=LinBiolinumT-tlf-t1 at 10.0pt not loadable: Metric (TFM) file not found.',
      '! LaTeX Error: File `example-image-plain\' not found.',
    )
    expect((await compileMain()).message).toMatch(/PDF compilation failed/)
    expect(installs.mock.calls.map(call => [call[0], call[2]])).toEqual([['LinBiolinumT-tlf-t1.tfm', false], ['example-image-plain.pdf', false]])
    installs.mockClear()
    processes.latexFailures.push('! LaTeX Error: File `venue.sty\' not found.', '! LaTeX Error: File `venue.sty\' not found.')
    expect((await compileMain()).message).toMatch(/PDF compilation failed/)
    expect(installs.mock.calls.map(call => [call[0], call[2]])).toEqual([['venue.sty', true]])
  })

  it('audits SVG figures and exports them to vector PDFs with previews', async () => {
    root = await temporaryRoot('research-figures-')
    const { service } = await boot(new MemoryMediaPool())
    await service.configure({ python: 'python' })
    const p = await service.create({ title: 'Figures', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    await write(join(p.root, 'figures/arch.svg'), '<svg/>')
    await write(join(p.root, 'figures/messy.svg'), '<svg/>')
    expect(await run({ action: 'audit-svg', path: 'figures/arch.svg' })).toMatchObject({ message: 'SVG audit passed: 0 error(s), 0 warning(s)' })
    const saved = await run({ action: 'audit-svg', path: 'figures/messy.svg', save: true })
    expect(saved).toMatchObject({ message: 'SVG audit failed: 1 error(s), 0 warning(s); report saved to figures/audit_logs/messy.audit.json', path: 'figures/audit_logs/messy.audit.json' })
    expect(JSON.parse(saved.content ?? '{}')).toMatchObject({ ok: false, errors: [{ code: 'text_overlap' }] })
    const exported = await run({ action: 'export-figure', path: 'figures/arch.svg' })
    expect(exported.message).toBe('Vector PDF written to figures/arch.pdf (embedded fonts Times-Roman; 1 marker(s) drawn as shapes); '
      + 'previews figures/previews/x.1440.png: look at them with read_image')
    expect(exported.paths).toEqual(['figures/arch.pdf', 'figures/previews/x.1440.png'])
    await write(join(p.root, 'figures/plain.svg'), '<svg/>')
    expect((await run({ action: 'export-figure', path: 'figures/plain.svg' })).message).toMatch(/\(unembedded fonts Times-Roman;/)
    await write(join(p.root, 'figures/bare.svg'), '<svg/>')
    expect((await run({ action: 'export-figure', path: 'figures/bare.svg', output: 'figures/final/bare.pdf' })).message)
      .toMatch(/^Vector PDF written to figures\/final\/bare\.pdf \(NO live text: the labels were lost or outlined\); previews/)
  })

  it('lists the venue library and applies a venue template, recording the venue', async () => {
    root = await temporaryRoot('research-venues-')
    const { service } = await boot(new MemoryMediaPool())
    const p = await service.create({ title: 'Venue', root: join(root, 'p'), brief: '', mode: 'spark-to-paper' })
    const run = (request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    expect((await run({ action: 'list-venues' })).message).toBe('139 venue(s)')
    const found = await run({ action: 'list-venues', query: 'neurips' })
    expect(found.message).toBe('1 venue(s) match "neurips"')
    expect(JSON.parse(found.content ?? '[]')).toEqual([expect.objectContaining({ id: 'neurips' })])
    const applied = await run({ action: 'apply-template', venue: 'neurips', stage: 'final' })
    expect(applied.message).toMatch(/^NeurIPS template applied for final \(NeurIPS 2026\): /)
    expect(applied.message).toMatch(/template\/neurips\/ holds the kit, its example and GUIDE\.md; template\.json/)
    expect(applied.paths).toEqual(expect.arrayContaining(['template.json', 'main.tex.tmpl', 'neurips_2026.sty']))
    expect(service.getProject(p.id).venue).toBe('neurips')
    expect(JSON.parse(applied.content ?? '{}')).toMatchObject({ venue: 'neurips', kit: 'neurips', stage: 'final' })
    const plain = await run({ action: 'apply-template', venue: 'asiacrypt' })
    expect(plain.message).toMatch(/^ASIACRYPT template applied for review \(Springer LNCS \(llncs\)\): /)
    expect(plain.message).toMatch(/template\/asiacrypt\/ holds the kit; template\.json.*root$/)
    expect((await run({ action: 'apply-template', venue: 'acl' })).message).toMatch(/Notes: Not bundled: acl_natbib\.bst/)
    await expect(run({ action: 'apply-template', venue: 'nowhere' })).rejects.toThrow(/Unknown venue nowhere/)
  })

  it('sends pages to a separate vision model only when one is configured, and generates images under the fixed credential', async () => {
    root = await temporaryRoot('research-media-')
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
    await expect(service.setCredential('image', 'key')).rejects.toThrow(/Configure the image provider/)
    await service.configure({ python: 'python', image: { baseUrl: 'https://img.example/v1/', model: 'm', size: '1024x1024' } })
    await expect(service.setCredential('image', '  ')).rejects.toThrow(/empty/)
    await expect(run({ action: 'generate-image', prompt: 'x', path: 'figures/g.png' })).rejects.toThrow(/credential has not been configured/)
    await service.setCredential('image', ' secret ')
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
    expect(await readFile(join(p.root, 'figures/g.prompt.txt'), 'utf8')).toBe('model: m\nendpoint: generations\nsize: 1024x1024\n\nx\n')
    // Reference images travel with the prompt to the edits endpoint; the prompt file records them.
    await expect(run({ action: 'generate-image', prompt: 'x', path: 'figures/r.png', references: ['figures/a.svg'] })).rejects.toThrow(/reference image must be/)
    await write(join(p.root, 'figures/huge.png'), 'x'.repeat(100001))
    await expect(run({ action: 'generate-image', prompt: 'x', path: 'figures/r.png', references: ['figures/huge.png'] })).rejects.toThrow(/Reference image exceeds/)
    const edited = await run({ action: 'generate-image', prompt: 'Layout like the reference', path: 'figures/r.png', size: '1024x1536', references: ['figures/a.png'] })
    expect(fetches.at(-1)).toBe('https://img.example/v1/images/edits')
    expect(edited.message).toMatch(/through edits/)
    expect(edited.paths).toEqual(['figures/r.png', 'figures/r.prompt.txt'])
    expect(await readFile(join(p.root, 'figures/r.prompt.txt'), 'utf8')).toMatch(/^model: m\nendpoint: edits\nsize: 1024x1536\nreferences: figures\/a\.png\n\nLayout like the reference/)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/images/edits')
      ? new Response('refused', { status: 400 })
      : new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }))))
    expect((await run({ action: 'generate-image', prompt: 'x', path: 'figures/s.webp', references: ['figures/b.jpg', 'figures/c.webp'] })).message)
      .toMatch(/through generations .*Note: the edit with reference images failed/)
    // Reference figures from published papers land under figures/refs.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/fig.png')
      ? new Response('figure')
      : url.startsWith('https://ar5iv.labs.arxiv.org/html/2101')
        ? new Response('<figure><img src="fig.png"><figcaption>Overview of the framework</figcaption></figure>')
        : new Response('none', { status: 404 })))
    const references = await run({ action: 'fetch-reference-figures', arxivIds: ['2101.00001v2', '2102.00002'], label: 'method-overview' })
    expect(references.paths).toEqual(['figures/refs/method-overview.ref_2101.00001_1.png'])
    expect(JSON.parse(references.content ?? '{}')).toMatchObject({ skipped: ['2102.00002: ar5iv returned HTTP 404'] })
    expect(await readFile(join(p.root, 'figures/refs/method-overview.ref_2101.00001_1.png'), 'utf8')).toBe('figure')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>nothing</p>')))
    expect((await run({ action: 'fetch-reference-figures', arxivIds: ['2103.00003'], label: 'method-overview' })).message).toMatch(/No reference figure saved/)
    // The figure gallery: search the shipped index, then save figures with a record of their papers.
    const found = await run({ action: 'find-reference-figures', query: 'diffusion', pattern: 'architecture', tier: 'oral', limit: 2 })
    expect(found.message).toMatch(/gallery figure\(s\) \(keyword\)/)
    expect(found.gallery?.figures).toHaveLength(2)
    const [chosen] = found.gallery!.figures
    const gallerySource = found.gallery!.source
    const figureUrl = `https://raw.githubusercontent.com/qwdwqfwq/topconf-paper-figure-gallery/main/images/${chosen!.venue}/`
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith(figureUrl)
      ? new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))
      : new Response('none', { status: 404 })))
    const saved = await run({ action: 'fetch-reference-figures', galleryIds: [chosen!.id, 'neurips2099-0'], label: 'method-overview' })
    expect(saved.paths).toEqual([`figures/refs/method-overview.gallery_${chosen!.id}.jpg`])
    expect(JSON.parse(saved.content ?? '{}')).toMatchObject({ skipped: ['neurips2099-0: The figure gallery has no figure neurips2099-0'] })
    const record = JSON.parse(await readFile(join(p.root, `figures/refs/method-overview.gallery_${chosen!.id}.source.json`), 'utf8')) as Record<string, unknown>
    expect(record).toMatchObject({ id: chosen!.id, paper: chosen!.paper, gallery: `${gallerySource.repository}@${gallerySource.commit}` })
    expect(record.copyright).toMatch(/authors and publisher/)
    await expect(run({ action: 'fetch-reference-figures', label: 'method-overview' })).rejects.toThrow(/Name galleryIds/)
    const aborting = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => { aborting.abort(); throw new Error('cancelled') }))
    const other = found.gallery!.figures[1]!.id
    await expect(service.execute({ projectId: p.id, action: 'fetch-reference-figures', galleryIds: [other], label: 'x' }, aborting.signal, 'agent')).rejects.toThrow()
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
    root = await temporaryRoot('research-poll-')
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
    root = await temporaryRoot('research-restart-')
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
    root = await temporaryRoot('research-components-')
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
    root = await temporaryRoot('research-remote-')
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
    root = await temporaryRoot('research-lock-')
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

describe('新研究 opens one untouched draft research, which can move and be discarded', () => {
  const PERSON_ONLY = /the person's commands/
  const NOT_A_DRAFT = '这项研究已经开始，不能再更改位置或丢弃 / This research has started, so it can no longer be moved or discarded'
  const today = (n: number): string => draftFolderName(new Date(), n)
  const command = (service: Harness['service'], request: Record<string, unknown>, actor: 'user' | 'agent' = 'user') =>
    service.execute(request as never, signal, actor)
  const startNew = (service: Harness['service']) => command(service, { action: 'start-new' })

  it('creates the draft in the research home and reuses it until something is done in it', async () => {
    root = await temporaryRoot('research-drafts-')
    const home = join(root, 'SciPaper')
    const { service, workspaces, turns, archived } = await boot(new MemoryMediaPool())
    await service.configure({ researchHome: home })
    const first = await startNew(service)
    expect(first.project).toMatchObject({
      title: '新研究', untitled: true, draft: true, createdRoot: true, mode: 'general', autonomy: 'checkpoints', root: join(home, today(1)),
    })
    expect(first.project).not.toHaveProperty('modeSetBy')
    expect(first.sessionId).toBe(first.project?.sessionId)
    // Its folder's Workspace is named after the folder, and the empty scaffold is on disk.
    expect(workspaces.get(first.project!.workspaceId)?.title).toBeUndefined()
    for (const directory of ['paper', 'figures', 'code', 'data', '.research', 'exports']) expect(existsSync(join(first.project!.root, directory))).toBe(true)
    // Two clicks at once, and every click after, open the same draft.
    const [again, twin] = await Promise.all([startNew(service), startNew(service)])
    expect([again.project?.id, twin.project?.id, again.sessionId]).toEqual([first.project?.id, first.project?.id, first.sessionId])
    const snapshot = await service.snapshot()
    expect(snapshot.researchHome).toBe(home)
    expect(snapshot.projects.find(project => project.id === first.project?.id)).toMatchObject({ draft: true })
    // The autonomy is the person's setting for its conversations, not work in it: the research stays the draft.
    const autonomy = await command(service, { action: 'set-autonomy', projectId: first.project!.id, autonomy: 'automatic' })
    expect(autonomy.project).toMatchObject({ draft: true, autonomy: 'automatic' })
    expect((await startNew(service)).project?.id).toBe(first.project?.id)
    // The agent never opens a draft.
    await expect(command(service, { action: 'start-new' }, 'agent')).rejects.toThrow(PERSON_ONLY)

    // A turn started in its conversation: it is a research of its own now, and stays one.
    turns.add(first.sessionId!)
    const second = await startNew(service)
    expect(second.project).toMatchObject({ root: join(home, today(2)), draft: true })
    turns.delete(first.sessionId!)
    expect((await service.snapshot()).projects.find(project => project.id === first.project?.id)).not.toHaveProperty('draft')

    // A file in its folder, or a record change, makes a research of its own too.
    await writeFile(join(second.project!.root, 'notes.md'), 'an idea')
    const third = await startNew(service)
    expect(third.project?.root).toBe(join(home, today(3)))
    await command(service, { action: 'record-decision', projectId: third.project!.id, question: 'Q?', answer: 'A' })
    // Creation times are milliseconds; the next draft is created strictly later than the second.
    await new Promise(resolve => setTimeout(resolve, 5))
    const fourth = await startNew(service)
    expect(fourth.project?.root).toBe(join(home, today(4)))
    // With the file gone, the second is untouched again; the newest draft is the one reopened.
    await rm(join(second.project!.root, 'notes.md'))
    expect((await startNew(service)).project?.id).toBe(fourth.project?.id)
    // Only the newest is the draft: the second reads as a research of its own, which the person may remove from the list.
    const drafted = (await service.snapshot()).projects.filter(project => project.draft === true).map(project => project.id)
    expect(drafted).toEqual([fourth.project?.id])
    expect((await command(service, { action: 'archive-project', projectId: second.project!.id })).project).toMatchObject({ archived: true })

    // A draft whose conversation was removed from the list opens a new blank one; a folder removed by hand comes back.
    archived.push(fourth.sessionId!)
    await rm(fourth.project!.root, { recursive: true })
    const reopened = await startNew(service)
    expect(reopened.project?.id).toBe(fourth.project?.id)
    expect(reopened.sessionId).not.toBe(fourth.sessionId)
    expect(existsSync(join(fourth.project!.root, 'paper'))).toBe(true)
    expect(service.getProject(fourth.project!.id).sessionId).toBe(fourth.sessionId)
  })

  it('takes the research home from the settings, then the configuration, then SciPaper in the profile', async () => {
    root = await temporaryRoot('research-drafts-home-')
    const pool = new MemoryMediaPool()
    const unset = await boot(pool)
    // Only read: nothing is created in the profile.
    expect((await unset.service.snapshot()).researchHome).toBe(join(homedir(), 'SciPaper'))
    await expect(unset.service.configure({ researchHome: 'relative/place' })).rejects.toThrow(/absolute path/)
    await ctx!.fiber.dispose(); ctx = undefined
    const configured = await boot(pool, { researchHome: join(root, 'configured') })
    expect(configured.service.researchHome()).toBe(join(root, 'configured'))
    await configured.service.configure({ researchHome: join(root, 'chosen') })
    expect(configured.service.researchHome()).toBe(join(root, 'chosen'))
    expect((await configured.service.snapshot()).preferences.researchHome).toBe(join(root, 'chosen'))
    await ctx!.fiber.dispose(); ctx = undefined
    await boot(pool, { researchHome: 'relative/place' })
    expect(ctx!.get('research')).toBeUndefined()
    expect(logged('error', 'research: researchHome must be an absolute path, not relative/place')).toBe(true)
  })

  it('never makes a draft among the examples, inside another research or in a system folder', async () => {
    root = await temporaryRoot('research-drafts-refused-')
    const { service } = await boot(new MemoryMediaPool())
    const outer = await service.create({ title: 'Outer', root: join(root, 'outer'), brief: '' })
    await service.configure({ researchHome: outer.root })
    await expect(startNew(service)).rejects.toThrow('研究存放位置在研究「Outer」里面，请在设置里换一个位置 / The research location lies inside the research "Outer"; choose another one in Settings')
    await service.configure({ researchHome: process.platform === 'win32' ? 'C:\\Windows' : '/usr' })
    await expect(startNew(service)).rejects.toThrow(/outside system locations/)
    await service.configure({ researchHome: join(root, 'demo', 'mine') })
    vi.stubEnv('DSH_HOME', root)
    try {
      await expect(startNew(service)).rejects.toThrow(/read-only/)
      await expect(service.configure({ researchHome: join(root, 'demo') })).rejects.toThrow(/read-only/)
      expect(existsSync(join(root, 'demo'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('moves the draft to the folder the person chose, or says what the folder is', async () => {
    root = await temporaryRoot('research-drafts-move-')
    const { service, workspaces, archived, applied } = await boot(new MemoryMediaPool())
    await service.configure({ researchHome: join(root, 'SciPaper') })
    const draft = (await startNew(service)).project!
    await command(service, { action: 'set-autonomy', projectId: draft.id, autonomy: 'automatic' })
    const relocate = (target: string, extra: Record<string, unknown> = {}, actor: 'user' | 'agent' = 'user') =>
      command(service, { action: 'relocate', projectId: draft.id, root: target, ...extra }, actor)
    await expect(relocate(join(root, 'x'), {}, 'agent')).rejects.toThrow(PERSON_ONLY)
    await expect(relocate('relative/folder')).rejects.toThrow(/absolute folder/)
    await expect(relocate(parse(root).root)).rejects.toThrow(/filesystem root/)
    expect(await relocate(draft.root)).toMatchObject({ outcome: 'moved', project: { id: draft.id, draft: true }, sessionId: draft.sessionId })

    const other = await service.create({ title: 'Other', root: join(root, 'other'), brief: '' })
    const existing = await relocate(other.root)
    expect(existing).toMatchObject({ outcome: 'existing', project: { id: other.id }, sessionId: other.sessionId })
    expect(existing.project).not.toHaveProperty('draft')
    expect(await relocate(join(other.root, 'paper', 'deeper'))).toMatchObject({ outcome: 'nested', project: { id: other.id } })
    // The draft cannot move into its own folder.
    expect(await relocate(join(draft.root, 'paper'))).toMatchObject({ outcome: 'nested', project: { id: draft.id, draft: true } })
    await write(join(root, 'busy', 'results.csv'), 'a,b')
    expect(await relocate(join(root, 'busy'))).toEqual({ message: expect.stringMatching(/holds files/) as unknown, outcome: 'needs-confirm' })
    vi.stubEnv('DSH_HOME', root)
    try {
      expect(await relocate(join(root, 'demo', 'shipped'))).toMatchObject({ outcome: 'example' })
    } finally {
      vi.unstubAllEnvs()
    }
    // Nothing was made by any of these.
    expect(service.projects().map(project => project.title).sort()).toEqual(['Other', '新研究'])

    // Into a folder that does not exist yet: the research is created there with the draft's autonomy, and the draft is gone.
    const moved = await relocate(join(root, 'chosen', 'study'))
    expect(moved).toMatchObject({
      outcome: 'moved', project: { root: join(root, 'chosen', 'study'), title: '新研究', untitled: true, draft: true, createdRoot: true, autonomy: 'automatic' },
    })
    expect(moved.sessionId).toBe(moved.project?.sessionId)
    expect(applied.get(moved.sessionId!)).toBe('research-auto')
    expect(() => service.getProject(draft.id)).toThrow(/not found/)
    expect(workspaces.has(draft.workspaceId)).toBe(false)
    expect(archived).toEqual([draft.sessionId])
    expect(existsSync(draft.root)).toBe(false)
    expect(existsSync(join(root, 'SciPaper'))).toBe(true)
    // It is the draft now: 新研究 opens it.
    expect((await startNew(service)).project?.id).toBe(moved.project?.id)

    // Beside files the person confirmed: a research of its own, and the folder it left is removed up to the one it made.
    const beside = await command(service, { action: 'relocate', projectId: moved.project!.id, root: join(root, 'busy'), confirmNonEmpty: true })
    expect(beside).toMatchObject({ outcome: 'moved', project: { root: join(root, 'busy'), untitled: true } })
    expect(beside.project).not.toHaveProperty('draft')
    expect(beside.project).not.toHaveProperty('createdRoot')
    expect(existsSync(join(root, 'busy', 'results.csv'))).toBe(true)
    expect(existsSync(join(root, 'chosen', 'study'))).toBe(false)
    expect(existsSync(join(root, 'chosen'))).toBe(true)
    // A research with files of its own neither moves nor goes; neither does one that does not exist.
    await expect(command(service, { action: 'relocate', projectId: beside.project!.id, root: join(root, 'y') })).rejects.toThrow(NOT_A_DRAFT)
    await expect(command(service, { action: 'discard-draft', projectId: beside.project!.id })).rejects.toThrow(NOT_A_DRAFT)
    await expect(command(service, { action: 'relocate', projectId: 'missing', root: join(root, 'y') })).rejects.toThrow(/not found/)
  })

  it('discards an untouched draft and never a folder that holds anything', async () => {
    root = await temporaryRoot('research-drafts-discard-')
    const { service, workspaces, archived, turns, open } = await boot(new MemoryMediaPool())
    await service.configure({ researchHome: join(root, 'SciPaper') })
    const draft = (await startNew(service)).project!
    // Another blank conversation in its folder goes with it.
    open({ id: 'second-blank', header: { cwd: draft.root } })
    await expect(command(service, { action: 'discard-draft', projectId: draft.id }, 'agent')).rejects.toThrow(PERSON_ONLY)
    expect(await command(service, { action: 'discard-draft', projectId: draft.id })).toEqual({ message: 'The untouched new research was removed' })
    expect(service.projects()).toEqual([])
    expect(workspaces.has(draft.workspaceId)).toBe(false)
    expect(archived).toEqual([draft.sessionId, 'second-blank'])
    expect(existsSync(draft.root)).toBe(false)

    // A draft in a folder that was there before keeps that folder, emptied of the scaffold.
    await mkdir(join(root, 'kept'))
    const chosen = (await command(service, { action: 'relocate', projectId: (await startNew(service)).project!.id, root: join(root, 'kept') })).project!
    expect(chosen).not.toHaveProperty('createdRoot')
    await command(service, { action: 'discard-draft', projectId: chosen.id })
    expect(existsSync(join(root, 'kept'))).toBe(true)
    expect(await readdir(join(root, 'kept'))).toEqual([])

    // A folder that cannot be removed is left, and said so; the record is gone all the same.
    const locked = (await startNew(service)).project!
    draftFolders.removeFails = true
    await command(service, { action: 'discard-draft', projectId: locked.id })
    expect(logged('warn', `research draft folder %s: %s ${locked.root} EBUSY: resource busy or locked`)).toBe(true)
    expect(service.projects()).toEqual([])
    draftFolders.removeFails = false

    // A draft someone began talking in is not discarded, and nothing of it is touched.
    const begun = (await startNew(service)).project!
    turns.add(begun.sessionId!)
    const archivedBefore = [...archived]
    await expect(command(service, { action: 'discard-draft', projectId: begun.id })).rejects.toThrow(NOT_A_DRAFT)
    expect(archived).toEqual(archivedBefore)
    expect(existsSync(join(begun.root, 'paper'))).toBe(true)
  })

  it('shows no draft rather than failing when sessions cannot be listed', async () => {
    root = await temporaryRoot('research-drafts-listing-')
    const { service, listing } = await boot(new MemoryMediaPool())
    await service.configure({ researchHome: join(root, 'SciPaper') })
    const draft = (await startNew(service)).project!
    listing.failure = new Error('persistence unavailable')
    expect((await service.snapshot()).projects[0]).not.toHaveProperty('draft')
    expect(logged('warn', 'research drafts: %s persistence unavailable')).toBe(true)
    // A change already stored is answered; only its draft flag is missing.
    expect((await command(service, { action: 'set-autonomy', projectId: draft.id, autonomy: 'automatic' })).project).not.toHaveProperty('draft')
    // Opening a draft cannot know which one is untouched, so it fails rather than make a second.
    await expect(startNew(service)).rejects.toThrow('persistence unavailable')
    listing.failure = undefined
    expect((await startNew(service)).project?.id).toBe(draft.id)
  })
})

describe('移出列表 removes a research from the list, and 恢复 brings it back', () => {
  const PERSON_ONLY = /the person's commands/
  const command = (service: Harness['service'], request: Record<string, unknown>, actor: 'user' | 'agent' = 'user') =>
    service.execute(request as never, signal, actor)

  it('keeps the entire research visible when a conversation is active', async () => {
    root = await temporaryRoot('research-archive-active-')
    const { service, archived, open } = await boot(new MemoryMediaPool())
    const paper = await service.create({ title: 'Paper', root: join(root, 'paper'), brief: 'An active study' })
    open({ id: 'active', header: { cwd: paper.root } })
    const before = structuredClone(service.getProject(paper.id))
    ctx!.on('workspace/session-activity', async ({ sessionId }, next) => [
      ...sessionId === 'active' ? [{ kind: 'turn' as const }] : [], ...await next(),
    ])
    await expect(command(service, { action: 'archive-project', projectId: paper.id })).rejects.toThrow(/session is active/)
    expect(archived).toEqual([])
    expect(service.getProject(paper.id)).toEqual(before)
  })

  it('reverses a partially completed archive and retains recovery information when reversal fails', async () => {
    root = await temporaryRoot('research-archive-race-')
    const { service, archived, open, archiving } = await boot(new MemoryMediaPool())
    const paper = await service.create({ title: 'Paper', root: join(root, 'paper'), brief: 'A study' })
    open({ id: 'late-active', header: { cwd: paper.root } })
    archiving.failOn = 'late-active'
    await expect(command(service, { action: 'archive-project', projectId: paper.id })).rejects.toThrow('Session became active')
    expect(archived).toEqual([])
    expect(service.getProject(paper.id)).not.toHaveProperty('archivedAt')
    expect(service.getProject(paper.id)).not.toHaveProperty('archivedConversations')

    archiving.restoreFailOn = paper.sessionId!
    await expect(command(service, { action: 'archive-project', projectId: paper.id })).rejects.toThrow(/restore the research/)
    expect(archived).toEqual([paper.sessionId])
    expect(service.getProject(paper.id).archivedConversations).toEqual([paper.sessionId, 'late-active'])
    delete archiving.restoreFailOn
    await command(service, { action: 'unarchive-project', projectId: paper.id })
    expect(archived).toEqual([])
    expect(service.getProject(paper.id)).not.toHaveProperty('archivedAt')
  })

  it('archives the research\'s own conversations, keeps the removal across a restart, and restores exactly what it archived', async () => {
    root = await temporaryRoot('research-archive-')
    const pool = new MemoryMediaPool()
    const { service, archived, open } = await boot(pool)
    const paper = await service.create({ title: 'Paper', root: join(root, 'paper'), brief: '' })
    const inner = await service.create({ title: 'Inner', root: join(paper.root, 'inner'), brief: '' })
    const other = await service.create({ title: 'Other', root: join(root, 'other'), brief: '' })
    // A second conversation in a subfolder, a delegated child, and a conversation the person archived already.
    open({ id: 'second', header: { cwd: join(paper.root, 'code') } })
    open({ id: 'child', header: { cwd: paper.root, origin: 'subagent' } })
    open({ id: 'earlier', header: { cwd: paper.root } })
    archived.push('earlier')
    await write(join(paper.root, 'paper', 'main.tex'), '\\documentclass{article}')
    for (const action of ['archive-project', 'unarchive-project']) {
      await expect(command(service, { action, projectId: paper.id }, 'agent')).rejects.toThrow(PERSON_ONLY)
    }
    await expect(command(service, { action: 'archive-project', projectId: 'missing' })).rejects.toThrow(/not found/)
    expect(archived).toEqual(['earlier'])

    const removed = await command(service, { action: 'archive-project', projectId: paper.id })
    expect(removed.message).toBe('Removed from the list: 2 conversation(s) archived; its folder and runs are untouched')
    expect(removed.project).toMatchObject({ id: paper.id, archived: true, archivedConversations: [paper.sessionId, 'second'] })
    const at = removed.project!.archivedAt!
    expect(Number.isNaN(Date.parse(at))).toBe(false)
    expect(archived).toEqual(['earlier', paper.sessionId, 'second'])
    // Nothing on disk changed; the research nested inside it and the one beside it stay listed.
    expect(await readFile(join(paper.root, 'paper', 'main.tex'), 'utf8')).toBe('\\documentclass{article}')
    const listed = (await service.snapshot()).projects
    expect(listed.find(project => project.id === paper.id)).toMatchObject({ archived: true, archivedAt: at })
    for (const id of [inner.id, other.id]) expect(listed.find(project => project.id === id)).not.toHaveProperty('archived')

    // Removing it again archives only a conversation that began since, and keeps when it was removed.
    await new Promise(resolve => setTimeout(resolve, 5))
    open({ id: 'late', header: { cwd: paper.root } })
    const again = await command(service, { action: 'archive-project', projectId: paper.id })
    expect(again.message).toBe('Removed from the list: 1 conversation(s) archived; its folder and runs are untouched')
    expect(again.project).toMatchObject({ archivedAt: at, archivedConversations: [paper.sessionId, 'second', 'late'] })
    const archivedBefore = [...archived]

    // The record keeps the removal across a restart, as the registry keeps its archive.
    await ctx!.fiber.dispose(); ctx = undefined
    const restarted = await boot(pool)
    restarted.archived.push(...archivedBefore)
    const kept = (await restarted.service.snapshot()).projects.find(project => project.id === paper.id)
    expect(kept).toMatchObject({ archived: true, archivedAt: at })
    const restored = await command(restarted.service, { action: 'unarchive-project', projectId: paper.id })
    expect(restored.message).toBe('Restored to the list: 3 conversation(s) unarchived')
    for (const field of ['archived', 'archivedAt', 'archivedConversations']) expect(restored.project).not.toHaveProperty(field)
    expect(restarted.archived).toEqual(['earlier'])
    // Restoring a research in the list changes nothing.
    const revision = restarted.service.getProject(paper.id).revision
    expect(await command(restarted.service, { action: 'unarchive-project', projectId: paper.id }))
      .toMatchObject({ message: 'The research is in the list', project: { id: paper.id } })
    expect(restarted.service.getProject(paper.id).revision).toBe(revision)
  })

  it('refuses examples and the untouched draft, and never takes a removed research for the draft', async () => {
    root = await temporaryRoot('research-archive-refused-')
    const { service, archived } = await boot(new MemoryMediaPool())
    await service.configure({ researchHome: join(root, 'SciPaper') })
    const draft = (await command(service, { action: 'start-new' })).project!
    await expect(command(service, { action: 'archive-project', projectId: draft.id }))
      .rejects.toThrow('还没开始的新研究不能移出列表 / The untouched new research cannot be removed from the list')
    expect(archived).toEqual([])
    // A file in its folder makes it a research of its own, which can be removed; removed, it is not the draft
    // 新研究 reopens, even once the file is gone.
    await writeFile(join(draft.root, 'notes.md'), 'an idea')
    await command(service, { action: 'archive-project', projectId: draft.id })
    await rm(join(draft.root, 'notes.md'))
    expect((await command(service, { action: 'start-new' })).project?.id).not.toBe(draft.id)
    expect((await service.snapshot()).projects.find(project => project.id === draft.id)).not.toHaveProperty('draft')

    // A research whose conversations the person had all archived records none, and restoring it leaves them archived.
    const quiet = await service.create({ title: 'Quiet', root: join(root, 'quiet'), brief: '' })
    archived.push(quiet.sessionId!)
    const removed = await command(service, { action: 'archive-project', projectId: quiet.id })
    expect(removed.message).toBe('Removed from the list: 0 conversation(s) archived; its folder and runs are untouched')
    expect(removed.project).toMatchObject({ archived: true })
    expect(removed.project).not.toHaveProperty('archivedConversations')
    expect((await command(service, { action: 'unarchive-project', projectId: quiet.id })).message).toBe('Restored to the list: 0 conversation(s) unarchived')
    expect(archived).toContain(quiet.sessionId)

    // Examples are neither removed nor restored: 显示示例研究 hides them.
    const example = await service.create({ title: 'Example', root: join(root, 'demo', 'shipped'), brief: '' })
    vi.stubEnv('DSH_HOME', root)
    try {
      for (const action of ['archive-project', 'unarchive-project']) {
        await expect(command(service, { action, projectId: example.id })).rejects.toThrow(/read-only/)
      }
    } finally {
      vi.unstubAllEnvs()
    }
    expect(service.getProject(example.id)).not.toHaveProperty('archivedAt')
    expect((await service.snapshot()).preferences).not.toHaveProperty('showExamples')
    await service.configure({ researchHome: join(root, 'SciPaper'), showExamples: false })
    expect((await service.snapshot()).preferences).toEqual({ researchHome: join(root, 'SciPaper'), showExamples: false })
    await expect(service.configure({ showExamples: 'no' } as never)).rejects.toThrow()
  })

  it('keeps a removed research\'s runs going unobserved, and observes them again once it is restored', async () => {
    root = await temporaryRoot('research-archive-runs-')
    const { service } = await boot(new MemoryMediaPool())
    await service.configure({ python: 'python', uv: 'uv' })
    const p = await service.create({ title: 'Runs', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    await run({ action: 'environment', environment: { name: 'env', kind: 'uv', target: 'local', python: '', requirements: [], isDefault: true } })
    await write(join(p.root, 'code/train.py'), 'print(1)')
    const environmentId = service.getProject(p.id).environments[0]!.id
    await command(service, { action: 'archive-project', projectId: p.id })
    await run({
      action: 'experiment', requestId: '44444444-4444-4444-8444-444444444444',
      spec: { environmentId, name: 't', argv: ['{python}', 'code/train.py'], cwd: '.', seed: 0, maxSeconds: 5, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' },
    })
    // Two poll intervals pass without a look at the run.
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(processes.calls.filter(call => call.args[1] === 'status')).toHaveLength(0)
    expect(service.getProject(p.id).experiments[0]?.status).toBe('running')
    await command(service, { action: 'unarchive-project', projectId: p.id })
    await vi.waitFor(() => { expect(service.getProject(p.id).experiments[0]?.status).toBe('completed') }, { timeout: 5000 })
  })
})

describe('the experiment board is laid out by the agent and read by scripts', () => {
  it('stores the layout, reports what waits for runs, and reads machines in the background', async () => {
    root = await temporaryRoot('research-board-')
    const { service } = await boot(new MemoryMediaPool())
    const p = await service.create({ title: 'Board', root: join(root, 'p'), brief: '' })
    const run = (request: Record<string, unknown>) => service.execute({ projectId: p.id, ...request } as never, signal, 'agent')
    expect(await run({ action: 'board-get' })).toEqual({ message: 'Board: 0 section(s), 0 collector(s)', content: '{"sections":[],"collectors":[]}' })
    // Nothing to probe and nothing to collect reads cleanly.
    expect((await run({ action: 'board-refresh' })).message).toBe('Board read')
    const plain = await run({ action: 'board-update', board: { title: 'Plain', sections: [{ id: 'note', title: 'Note', blocks: [{ type: 'text', text: 'Why' }] }] } })
    expect(plain.message).toBe('Board saved: 1 section(s), 0 collector(s). Its numbers refresh by themselves; board-refresh runs the collectors now.')
    const saved = await run({
      action: 'board-update',
      board: {
        sections: [{ id: 'main', title: 'Main', blocks: [{ type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ cells: { a: { run: 'main/cifar', metric: 'acc' } } }] }] }],
        collectors: [{ id: 'queue', script: 'board/queue.py' }],
      },
    })
    expect(saved.message).toMatch(/^Board saved: 2 section\(s\), 1 collector\(s\); /)
    expect(saved.message).toMatch(/; collector script\(s\) not written yet: board\/queue\.py; /)
    expect(saved.message).toMatch(/; waiting for runs not submitted yet: main\/cifar\. /)
    await expect(run({ action: 'board-update', board: { sections: [{ id: 'x', title: 'X', blocks: [{ type: 'pie' }] }] } })).rejects.toThrow()
    await run({ action: 'environment', environment: { name: 'here', kind: 'existing', target: 'local', python: 'C:/py/python.exe', requirements: [], isDefault: true } })
    // The probe answers nothing a probe would; the machine reports that, and so does the missing collector script.
    const refreshed = await run({ action: 'board-refresh' })
    expect(refreshed.message).toBe('Board read with 2 problem(s); see each collector\'s and machine\'s error')
    expect(JSON.parse(refreshed.content ?? '{}')).toMatchObject({ machines: [{ key: 'local', gpus: 0 }], collectors: [{ id: 'queue', ok: false }] })
    const view = await run({ action: 'board-view', refresh: true, runs: ['none'] })
    expect(view.board).toMatchObject({ spec: { title: 'Plain' }, refreshing: false, machines: [{ key: 'local' }] })
    expect(view.project).toBeUndefined()
    // A read the board starts itself runs in the background; one that cannot save its result is logged, not thrown.
    const q = await service.create({ title: 'Background', root: join(root, 'q'), brief: '' })
    await write(join(q.root, 'board/q.py'), 'print(1)')
    await write(join(q.root, '.research/board/snapshot.json/blocked'), 'x')
    await service.execute({ projectId: q.id, action: 'board-update', board: { collectors: [{ id: 'q', script: 'board/q.py' }] } }, signal, 'agent')
    expect((await service.execute({ projectId: q.id, action: 'board-view', refresh: true }, signal, 'user')).board?.refreshing).toBe(true)
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await service.execute({ projectId: q.id, action: 'board-view' }, signal, 'user')).board?.refreshing) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect((await service.execute({ projectId: q.id, action: 'board-view' }, signal, 'user')).board?.collected.q).toBeDefined()
  })
})
