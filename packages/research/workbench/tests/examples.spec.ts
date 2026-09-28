import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MessageId, type Message } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appendExampleConversation, exampleDirectory, initializeResearchExamples } from '../src/examples.ts'
import type { ExampleRegistration, ResearchExample } from '../src/examples.ts'
import { runtimeAsset } from '../src/components.ts'
import { isExampleRoot, isInside, projectPath } from '../src/files.ts'
import { researchDomain } from '../src/schema.ts'
import type { ProjectId, ResearchProject } from '../src/types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const assets = runtimeAsset('examples/v1')
const directories: string[] = []
const links: string[] = []
const contexts: Context[] = []

async function temporary(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scipaper-example-test-')))
  directories.push(root)
  return root
}

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const path of links.splice(0)) await unlink(path)
  for (const root of directories.splice(0)) {
    if (!isInside(resolve(tmpdir()), root) || !root.includes('scipaper-example-test-')) throw new Error('Unowned fixture directory')
    await rm(root, { recursive: true })
  }
})

/** Record the events returned by the official append boundary, including constructor resume markers. */
const appendReceipts = vi.spyOn(Session.prototype, 'append')
const inherited = new WeakMap<Session, readonly SessionEvent[]>()
function history(session: Session): readonly SessionEvent[] {
  return [...inherited.get(session) ?? [], ...appendReceipts.mock.results.flatMap((result, index) =>
    appendReceipts.mock.contexts[index] === session && result.type === 'return' ? [result.value] : [])]
}

function messages(events: readonly SessionEvent[]): Message[] {
  return events.flatMap((event): Message[] => {
    if (event.type === 'user/message') return [event.data]
    if (event.type === 'assistant/message') return [event.data.message]
    return []
  })
}

function registration(): {
  records: Map<ProjectId, ResearchProject>
  sessions: Map<string, Session>
  workspace: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
  api: ExampleRegistration
} {
  const records = new Map<ProjectId, ResearchProject>()
  const sessions = new Map<string, Session>()
  const workspace = vi.fn(async (root: string) => `workspace:${root}` as WorkspaceId)
  const put = vi.fn(async (project: ResearchProject) => { records.set(project.id, project) })
  const api: ExampleRegistration = {
    find: root => [...records.values()].find(project => project.root === root), workspace, put,
    conversation: async (project, material) => {
      if (project.sessionId === undefined) throw new Error('No example conversation')
      const session = sessions.get(project.sessionId) ?? Session.create(project.sessionId)
      sessions.set(session.id, session)
      appendExampleConversation(session, history(session), material)
    },
  }
  return { records, sessions, workspace, put, api }
}

describe('product-owned research examples', () => {
  it('installs two complete research examples with valid records, files, evidence and conversations in a fresh home', async () => {
    const root = await temporary(), home = join(root, 'home'), fixture = registration()
    await initializeResearchExamples(home, assets, fixture.api)
    const catalog = JSON.parse(await readFile(join(assets, 'catalog.json'), 'utf8')) as ResearchExample[]
    expect(catalog).toHaveLength(2)
    expect(fixture.records.size).toBe(2)
    for (const example of catalog) {
      const project = [...fixture.records.values()].find(record => record.root.endsWith(example.id))!
      expect(project.id).toBe(`example-v1-${example.id}`)
      expect(project.sessionId).toBe(`scipaper-example-v1-${example.id}`)
      expect(isExampleRoot(project.root, home)).toBe(true)
      expect(researchDomain.tables.projects.valueSchema.parse(project)).toEqual(project)
      expect(project.evidence.length).toBeGreaterThanOrEqual(3)
      expect(project.artifacts.length).toBeGreaterThanOrEqual(6)
      for (const path of example.files) {
        const bytes = await readFile(await projectPath(project.root, path))
        expect(bytes).toEqual(await readFile(join(assets, example.id, path)))
      }
      const pdf = await readFile(join(project.root, 'paper/main.pdf'))
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
      expect(pdf.length).toBeGreaterThan(4000)
      const session = fixture.sessions.get(project.sessionId!)!
      expect(messages(history(session)).map(message => message.content)).toEqual([
        [{ type: 'text', text: example.conversation.question }], [{ type: 'text', text: example.conversation.answer }],
      ])
      expect(history(session).filter(event => event.type === 'turn/end')).toHaveLength(1)
    }
  })

  it('preserves all existing bytes and records, repairs missing material, and repeats without new events or registrations', async () => {
    const home = join(await temporary(), 'home'), fixture = registration()
    await initializeResearchExamples(home, assets, fixture.api)
    const project = [...fixture.records.values()][0]!
    const before = structuredClone([...fixture.records]), histories = [...fixture.sessions].map(([id, session]) => [id, history(session)])
    const marker = await stat(join(exampleDirectory(home), 'catalog.json'))
    await writeFile(join(project.root, 'README.md'), 'A pre-existing local file; keep these exact bytes.\n')
    await rm(join(project.root, 'paper/main.pdf'))
    const text = `.research/chunks/${project.evidence[0]!.id}/1.json`
    await rm(join(project.root, text))
    await initializeResearchExamples(home, assets, fixture.api)
    expect(await readFile(join(project.root, 'README.md'), 'utf8')).toBe('A pre-existing local file; keep these exact bytes.\n')
    expect(await readFile(join(project.root, 'paper/main.pdf'))).toEqual(await readFile(join(assets, 'ccfa-sparse-attention/paper/main.pdf')))
    const chunks = JSON.parse(await readFile(join(project.root, text), 'utf8')) as { text: string }[]
    expect(chunks[0]!.text).toContain('accuracy_percent')
    expect([...fixture.records]).toEqual(before)
    expect([...fixture.sessions].map(([id, session]) => [id, history(session)])).toEqual(histories)
    expect(fixture.workspace).toHaveBeenCalledTimes(2)
    expect(fixture.put).toHaveBeenCalledTimes(2)
    expect((await stat(join(exampleDirectory(home), 'catalog.json'))).mtimeMs).toBe(marker.mtimeMs)
  })

  it('resumes after registration is interrupted and serializes simultaneous installers', async () => {
    const home = join(await temporary(), 'home'), fixture = registration()
    const conversation = (project: ResearchProject, material: ResearchExample['conversation']) => fixture.api.conversation(project, material)
    let interrupted = true
    const interruptedApi: ExampleRegistration = { ...fixture.api, conversation: async (project, material) => {
      if (interrupted) { interrupted = false; throw new Error('Interrupted before conversation creation') }
      await conversation(project, material)
    } }
    await expect(initializeResearchExamples(home, assets, interruptedApi)).rejects.toThrow('Interrupted before conversation creation')
    expect(fixture.records.size).toBe(1)
    const preserved = structuredClone([...fixture.records][0])
    await Promise.all(Array.from({ length: 4 }, () => initializeResearchExamples(home, assets, fixture.api)))
    expect(fixture.records.size).toBe(2)
    expect([...fixture.records][0]).toEqual(preserved)
    expect(fixture.workspace).toHaveBeenCalledTimes(2)
    expect(fixture.put).toHaveBeenCalledTimes(2)
    for (const session of fixture.sessions.values()) {
      expect(history(session).filter(event => event.type === 'user/message')).toHaveLength(1)
      expect(history(session).filter(event => event.type === 'assistant/message')).toHaveLength(1)
    }
  })

  it('leaves legacy demo material and unrelated research records unchanged in an existing trial home', async () => {
    const home = join(await temporary(), 'home'), fixture = registration()
    await mkdir(join(home, 'demo/old'), { recursive: true })
    await writeFile(join(home, 'demo/old/notes.md'), 'legacy bytes\n')
    await initializeResearchExamples(home, assets, fixture.api)
    expect(await readFile(join(home, 'demo/old/notes.md'), 'utf8')).toBe('legacy bytes\n')
    expect(fixture.records.size).toBe(2)
    expect([...fixture.records.values()].every(project => !project.root.includes(join(home, 'demo')))).toBe(true)
  })

  it('protects canonical roots when the selected home is an alias and rejects junctions inside the owned example directory', async () => {
    const root = await temporary(), home = join(root, 'home'), alias = join(root, 'alias'), fixture = registration()
    await mkdir(home)
    await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir')
    links.push(alias)
    vi.stubEnv('DSH_HOME', alias)
    await initializeResearchExamples(alias, assets, fixture.api)
    for (const project of fixture.records.values()) {
      expect(isExampleRoot(project.root)).toBe(true)
      expect(isExampleRoot(join(alias, 'research/examples/v1', project.root.split(/[\\/]/).at(-1)!))).toBe(true)
    }
    expect(isExampleRoot(join(root, 'research/examples/v1/copy'))).toBe(false)
    const other = join(root, 'other'), redirected = join(other, 'research'), outside = join(root, 'outside')
    await mkdir(other); await mkdir(outside)
    await writeFile(join(outside, 'sentinel'), 'untouched')
    await symlink(outside, redirected, process.platform === 'win32' ? 'junction' : 'dir')
    links.push(redirected)
    await expect(initializeResearchExamples(other, assets, registration().api)).rejects.toThrow('not an owned directory')
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched')
  })

  it('fails explicitly for invalid catalog paths before touching the home', async () => {
    const root = await temporary(), bad = join(root, 'assets'), home = join(root, 'home')
    await mkdir(bad)
    const catalog = JSON.parse(await readFile(join(assets, 'catalog.json'), 'utf8')) as ResearchExample[]
    catalog[0]!.files[0] = '../escape.md'
    await writeFile(join(bad, 'catalog.json'), JSON.stringify(catalog))
    await expect(initializeResearchExamples(home, bad, registration().api)).rejects.toThrow('relative example file')
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('official example conversation persistence', () => {
  it('persists and reopens authored content with exact streams, then adds no events on reinitialization', async () => {
    const root = await temporary(), context = new Context()
    contexts.push(context)
    await context.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await context.plugin(SessionStore)
    const catalog = JSON.parse(await readFile(join(assets, 'catalog.json'), 'utf8')) as ResearchExample[]
    const prefixes = new Map<string, readonly SessionEvent[]>()
    for (const example of catalog) {
      const id = SessionId(`scipaper-example-v1-${example.id}`)
      const session = context.sessions.create(id, { meta: { cwd: root, agentPreset: 'research' } })
      const writer = await context.sessionPersistence.create(session.header)
      appendExampleConversation(session, history(session), example.conversation)
      expect(await context.sessions.flush(session)).toBe(true)
      await writer.close()
      prefixes.set(id, history(session))
    }
    await context.fiber.dispose()
    contexts.splice(contexts.indexOf(context), 1)
    const reopened = new Context()
    contexts.push(reopened)
    await reopened.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    for (const example of catalog) {
      const id = SessionId(`scipaper-example-v1-${example.id}`), reader = await reopened.sessionPersistence.open(id, 'read')
      try {
        const read = await reader.read()
        expect(read.events).toEqual(prefixes.get(id))
        const session = Session.create(id, read.events, reader.header)
        inherited.set(session, read.events)
        const before = history(session)
        const answer = read.events.find(event => event.type === 'assistant/message')
        expect(answer?.type === 'assistant/message' ? answer.data.message.source : undefined)
          .toEqual({ kind: 'model', provider: 'scipaper-example', model: 'authored-example' })
        expect(answer?.type === 'assistant/message' ? answer.data.stream : undefined).toMatchObject([
          { type: 'chunk', chunk: { type: 'block-start', blockType: 'text' } },
          { type: 'text-chunks', dt: [], texts: [example.conversation.answer] },
          { type: 'chunk', chunk: { type: 'block-end', block: { type: 'text', text: example.conversation.answer } } },
          { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } },
        ])
        appendExampleConversation(session, read.events, example.conversation)
        expect(history(session)).toEqual(before)
        expect(messages(read.events).map(message => ({ role: message.role, content: message.content })))
          .toMatchSnapshot(example.id)
      } finally { await reader.close() }
    }
  })

  it('closes an interrupted prefix without duplicating its question and refuses foreign message content', () => {
    const id = SessionId('scipaper-example-interrupted'), session = Session.create(id)
    const material = { question: 'Synthetic study of a matched comparison.', answer: 'Synthetic data have no empirical authority.' }
    session.append('turn/start', { turn: 1 })
    session.append('user/message', {
      id: MessageId(`${id}-question`), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: material.question }],
    }, { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    appendExampleConversation(session, history(session), material)
    expect(history(session).filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(history(session).filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(history(session).filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['interrupted', 'completed'])
    const other = Session.create(SessionId('foreign'))
    other.append('user/message', {
      id: MessageId('foreign-content'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Existing material.' }],
    }, { surfaceOp: 'append' })
    const before = history(other)
    expect(() => { appendExampleConversation(other, before, material) }).toThrow('contains other material')
    expect(history(other)).toEqual(before)
  })
})
