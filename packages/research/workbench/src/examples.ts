/** Product-owned, offline research examples, installed without replacing existing material. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm, link, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { MessageId, type AssistantMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { artifactKinds } from './schema.ts'
import { hashBytes, projectPath } from './files.ts'
import { newProject } from './project.ts'
import type { ArtifactId, EvidenceId, ProjectId, ResearchProject } from './types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** Product example generation; a new generation never replaces its predecessor. */
export const EXAMPLE_GENERATION = 'v1'

const relativeFile = z.string().min(1).refine(path => !path.startsWith('/') && !path.includes('\\')
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..') && !path.includes(':'), 'relative example file')
const exampleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/), title: z.string().min(1), brief: z.string().min(1),
  mode: z.string().min(1), route: z.string().min(1),
  files: z.array(relativeFile).min(1),
  evidence: z.array(z.object({ path: relativeFile, title: z.string().min(1) })),
  artifacts: z.array(z.object({ path: relativeFile, kind: z.enum(artifactKinds) })).min(1),
  conversation: z.object({ question: z.string().min(1), answer: z.string().min(1) }),
})
/** A bundled example's final material and its existing research-record fields. */
export type ResearchExample = z.infer<typeof exampleSchema>

/** Existing product services used to register an offline example. */
export interface ExampleRegistration {
  /** Find the durable record already owning this canonical root. */
  find(root: string): ResearchProject | undefined
  /** Register the folder through the normal Workspace registry. */
  workspace(root: string, title: string): Promise<WorkspaceId>
  /** Commit a new example record; existing records are never rewritten. */
  put(project: ResearchProject): Promise<void>
  /** Ensure a readable, durable conversation through the Session API. */
  conversation(project: ResearchProject, material: ResearchExample['conversation']): Promise<void>
}

/**
 * Location reserved for this product's shipped examples, outside the legacy demo directory.
 * @param home - Harness data home.
 * @returns versioned example directory.
 */
export function exampleDirectory(home: string): string {
  return join(home, 'research', 'examples', EXAMPLE_GENERATION)
}

/** Create owned directories one at a time, refusing existing junctions and symlinks. */
async function directory(root: string, path: string): Promise<string> {
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    try { await mkdir(current) } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Example directory is not an owned directory: ${current}`)
  }
  return current
}

/** Atomically publish a missing file; a pre-existing file always keeps its bytes. */
async function installFile(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined
  if (parent !== undefined) await directory(root, parent)
  const target = await projectPath(root, path)
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Example file is not a regular file: ${target}`)
    return
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const temporary = join(dirname(target), `.scipaper-example-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    try { await link(temporary, target) } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    }
  } finally {
    try { await rm(temporary) } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }
}

/** Build a populated ordinary research record from the files actually installed. */
async function exampleProject(example: ResearchExample, root: string, workspaceId: WorkspaceId): Promise<ResearchProject> {
  const project = newProject({ title: example.title, root, brief: example.brief, mode: example.mode, route: example.route }, workspaceId)
  project.id = `example-${EXAMPLE_GENERATION}-${example.id}` as ProjectId
  project.sessionId = SessionId(`scipaper-example-${EXAMPLE_GENERATION}-${example.id}`)
  for (const [index, source] of example.evidence.entries()) {
    const bytes = await readFile(await projectPath(root, source.path))
    const evidenceId = `${project.id}-source-${index}` as EvidenceId
    project.evidence.push({
      id: evidenceId, title: source.title, kind: 'file', path: source.path, sha256: hashBytes(bytes), revision: 1,
      importedAt: project.createdAt, chunks: [], coverage: 'data', verified: true, stale: false,
    })
  }
  for (const [index, artifact] of example.artifacts.entries()) {
    project.artifacts.push({
      id: `${project.id}-artifact-${index}` as ArtifactId, path: artifact.path, kind: artifact.kind, revision: 1,
      sha256: hashBytes(await readFile(await projectPath(root, artifact.path))), evidence: [], claimIds: [], inputArtifacts: [],
      stale: false, updatedAt: project.updatedAt, author: 'user',
    })
  }
  return project
}

/** Restore missing extracted text only when its source still matches the recorded revision. */
async function ensureEvidenceText(project: ResearchProject): Promise<void> {
  for (const evidence of project.evidence) {
    if (evidence.chunks.length > 0) continue
    const bytes = await readFile(await projectPath(project.root, evidence.path))
    if (hashBytes(bytes) !== evidence.sha256) continue
    const chunks = [{ text: bytes.toString('utf8'), locator: { line: 1 } }]
    await installFile(project.root, `.research/chunks/${evidence.id}/${evidence.revision}.json`, Buffer.from(JSON.stringify(chunks)))
  }
}

/**
 * Install and register the bundled material on fresh or existing product homes.
 * The file lock serializes installation, and durable identities make interrupted registration resumable.
 * @param home - current Harness home; no legacy home is read or modified.
 * @param assets - packaged directory containing catalog.json and final example files.
 * @param registration - ordinary research, Workspace and Session operations.
 */
export async function initializeResearchExamples(home: string, assets: string, registration: ExampleRegistration): Promise<void> {
  const catalog = z.array(exampleSchema).min(2).parse(JSON.parse(await readFile(join(assets, 'catalog.json'), 'utf8')))
  if (new Set(catalog.map(example => example.id)).size !== catalog.length) throw new Error('Duplicate bundled example identity')
  for (const example of catalog) {
    if ([...example.evidence, ...example.artifacts].some(item => !example.files.includes(item.path))) {
      throw new Error(`Bundled example references an unlisted file: ${example.id}`)
    }
  }
  await mkdir(home, { recursive: true })
  const canonical = await realpath(home)
  const destination = await directory(canonical, `research/examples/${EXAMPLE_GENERATION}`)
  await withFileLock(join(destination, 'catalog.json'), async () => {
    for (const example of catalog) {
      const root = await directory(destination, example.id)
      for (const path of example.files) {
        const source = await projectPath(join(assets, example.id), path)
        await installFile(root, path, await readFile(source))
      }
      const existing = registration.find(root)
      const project = existing ?? await exampleProject(example, root, await registration.workspace(root, example.title))
      if (existing === undefined) await registration.put(project)
      await ensureEvidenceText(project)
      await registration.conversation(project, example.conversation)
    }
    const marker = `${JSON.stringify({ generation: EXAMPLE_GENERATION, ids: catalog.map(example => example.id) })}\n`
    await installFile(destination, 'catalog.json', Buffer.from(marker))
  })
}

/**
 * Append a pre-authored example exchange through the validated Session event API.
 * A crash prefix is closed before appending the missing answer, without replacing prior events.
 * @param session - Session created or adopted by the official controller.
 * @param events - official inspection of its current durable or attached prefix.
 * @param material - research content, without model prompts or internal instructions.
 */
export function appendExampleConversation(session: Session, events: readonly SessionEvent[], material: ResearchExample['conversation']): void {
  const questionId = MessageId(`${session.id}-question`), answerId = MessageId(`${session.id}-answer`)
  const sameText = (content: UserMessage['content'], expected: string): boolean =>
    content.length === 1 && content[0]?.type === 'text' && content[0].text === expected
  for (const event of events) {
    if (event.type === 'user/message' && (event.data.id !== questionId || !sameText(event.data.content, material.question))
      || event.type === 'assistant/message' && (event.data.message.id !== answerId
        || !sameText(event.data.message.content, material.answer)
        || event.data.message.source.provider !== 'scipaper-example' || event.data.message.source.model !== 'authored-example')) {
      throw new Error(`Example conversation contains other material: ${session.id}`)
    }
  }
  const lastTurn = events.findLast(event => event.type === 'turn/start')
  const lastEnd = events.findLast(event => event.type === 'turn/end')
  if (lastTurn?.type === 'turn/start' && (lastEnd === undefined || lastEnd.seq < lastTurn.seq)) {
    const step = events.findLast(event => event.type === 'step/start')
    const end = events.findLast(event => event.type === 'step/end')
    if (step?.type === 'step/start' && step.seq > lastTurn.seq && (end === undefined || end.seq < step.seq)) {
      session.append('step/end', step.data)
    }
    session.append('turn/end', { turn: lastTurn.data.turn, reason: { kind: 'interrupted' } })
  }
  if (events.some(event => event.type === 'assistant/message' && event.data.message.id === answerId)) return
  const turn = lastTurn?.type === 'turn/start' ? lastTurn.data.turn + 1 : 1
  const question: UserMessage = { id: questionId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: material.question }] }
  const answer: AssistantMessage = {
    id: answerId, role: 'assistant', source: { kind: 'model', provider: 'scipaper-example', model: 'authored-example' },
    content: [{ type: 'text', text: material.answer }],
  }
  session.append('turn/start', { turn })
  if (!events.some(event => event.type === 'user/message' && event.data.id === questionId)) {
    session.append('user/message', question, { surfaceOp: 'append' })
  }
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn, step: 1, message: answer, stream: [
      { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'text-chunks', time0: 0, index: 0, dt: [], texts: [material.answer] },
      { type: 'chunk', time: 0, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: material.answer } } },
      { type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}
