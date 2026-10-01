/**
 * The relation graph of a research project: typed, directed relations between
 * the methods, tasks, datasets, metrics and papers of the project, each resting
 * on recorded grounds. A ground is a quotation of one revision of an evidence
 * record, completed project runs, or a citation record from OpenAlex or
 * Crossref; knowledge-relations-grounding.ts checks the first two, and this
 * module matches citation records to the project's papers. A relation whose
 * grounds all rest on changed sources reads as stale, the way a claim does;
 * people and the agent can reject a relation or one of its grounds, and a
 * person's rejection stands until a person restores it. A project keeps its
 * relations in .research/kg/relations.json. The design, the rules and their
 * evaluation are in the Agent Note
 * .agents/notes/proposed/feature/2026-10-01-knowledge-graph-relations.md.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { atomicWrite, errorText, projectPath } from './files.ts'
import { isOutdated } from './knowledge-evidence.ts'
import {
  ENTITY_KINDS, MAX_SETTING_LENGTH, RELATION_KINDS, RELATION_RULES, foldText, groundQuote, groundRun, nameKey, nameKeys,
  type EntityKind, type GroundingCode, type GroundingEnd, type Introduction, type RelationKind,
} from './knowledge-relations-grounding.ts'
import { locatorSchema } from './locator-schema.ts'
import type { EvidenceRecord, ResearchProject } from './types.ts'

/** Project-relative file holding a project's relation graph. */
export const RELATIONS_FILE = '.research/kg/relations.json'
/** Format version this build reads and writes. */
export const RELATIONS_VERSION = 1
/** Most entities a project keeps. */
export const MAX_ENTITIES = 2000
/** Most relations a project keeps, rejected ones included. */
export const MAX_RELATIONS = 5000
/** Most grounds one relation keeps. */
export const MAX_GROUNDS = 12
/** Most aliases of one entity. */
export const MAX_ALIASES = 16
/** Longest entity name or alias, after whitespace is collapsed. */
export const MAX_NAME_LENGTH = 120
/** Longest reason given with a rejection. */
export const MAX_REASON_LENGTH = 280
/** Most relations one proposal call carries. */
export const MAX_PROPOSALS = 50
/** Most references kept per reference list. */
export const MAX_REFERENCES = 2000
/**
 * Byte ceiling of the relations file, both as written and as read. A quoted
 * relation takes about a kilobyte, so the relation limit binds before this one.
 */
export const MAX_RELATIONS_BYTES = 8 * 1024 * 1024
/** Problems listed one by one before the rest are only counted. */
const LISTED_PROBLEMS = 10
/** Longest stored quotation: the source's own words may run longer than the folded limit the grounding check enforces. */
const MAX_STORED_QUOTE = 1000

const authorSchema = z.enum(['user', 'agent'])
/** Who made an entry: the person or the agent. */
export type Author = z.infer<typeof authorSchema>
const timeSchema = z.iso.datetime()
const shortId = z.string().min(1).max(256)
const oneLine = (max: number): z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString> =>
  z.string().transform(text => text.replace(/\s+/g, ' ').trim()).pipe(z.string().min(1).max(max))
const nameSchema = oneLine(MAX_NAME_LENGTH)

const decisionSchema = z.object({ by: authorSchema, at: timeSchema, reason: z.string().min(1).max(MAX_REASON_LENGTH).optional() })
/** A rejection: who rejected, when, and why. */
export type Decision = z.infer<typeof decisionSchema>

const runGroundSchema = z.object({ runId: shortId, evidenceId: shortId, revision: z.number().int().nonnegative() })
const quoteGroundSchema = z.object({
  id: shortId, type: z.literal('quote'), evidenceId: shortId, revision: z.number().int().nonnegative(), locator: locatorSchema,
  quote: z.string().min(1).max(MAX_STORED_QUOTE), setting: z.string().min(1).max(MAX_SETTING_LENGTH).optional(),
  /** The `introduces` relation a self-reference relied on. */
  via: shortId.optional(),
  warnings: z.array(z.string().max(600)).max(8).optional(),
  by: authorSchema, at: timeSchema, rejected: decisionSchema.optional(),
})
const runRecordSchema = runGroundSchema.extend({
  id: shortId, type: z.literal('run'), labels: z.object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) }),
  baseline: runGroundSchema.optional(), setting: z.string().min(1).max(MAX_SETTING_LENGTH).optional(),
  by: authorSchema, at: timeSchema, rejected: decisionSchema.optional(),
})
const citationGroundSchema = z.object({
  id: shortId, type: z.literal('citation'), provider: z.enum(['openalex', 'crossref']),
  /** The citing work as the provider names it: an OpenAlex work id or a DOI. */
  citing: shortId,
  /** The cited work as the provider's reference list names it. */
  cited: shortId,
  at: timeSchema, rejected: decisionSchema.optional(),
})
const groundSchema = z.discriminatedUnion('type', [quoteGroundSchema, runRecordSchema, citationGroundSchema])
/** A quotation of one revision of an evidence record, in the source's own words. */
export type QuoteGround = z.infer<typeof quoteGroundSchema>
/** Completed project runs: the run, the words naming each end, and for a comparison the baseline's run. */
export type RunGroundRecord = z.infer<typeof runRecordSchema>
/** A provider's record that one project paper cites another. */
export type CitationGround = z.infer<typeof citationGroundSchema>
/** What one relation rests on. */
export type Ground = z.infer<typeof groundSchema>

const entitySchema = z.object({
  id: shortId, kind: z.enum(ENTITY_KINDS), name: z.string().min(1).max(MAX_NAME_LENGTH),
  aliases: z.array(z.string().min(1).max(MAX_NAME_LENGTH)).max(MAX_ALIASES),
  /** A paper's literature records: one, or more after two records of one paper were merged. */
  evidenceIds: z.array(shortId).min(1).max(8).optional(),
  /** Ids of entities merged into this one, which keep resolving to it. */
  formerIds: z.array(shortId).max(64).optional(),
  by: authorSchema, createdAt: timeSchema, updatedAt: timeSchema,
}).refine(entity => (entity.kind === 'paper') === (entity.evidenceIds !== undefined), 'a paper, and only a paper, names its evidence records')
/** A node of the relation graph. */
export type RelationEntity = z.infer<typeof entitySchema>

const relationSchema = z.object({
  id: shortId, kind: z.enum(RELATION_KINDS), from: shortId, to: shortId,
  grounds: z.array(groundSchema).min(1).max(MAX_GROUNDS),
  rejected: decisionSchema.optional(),
  by: authorSchema, createdAt: timeSchema, updatedAt: timeSchema,
})
/** A directed relation `from <kind> to` with its grounds. */
export type Relation = z.infer<typeof relationSchema>

const citationWorkSchema = z.object({
  evidenceId: shortId, provider: z.enum(['openalex', 'crossref']),
  /** The work's OpenAlex id (`W…`), when the provider is OpenAlex. */
  work: shortId.optional(),
  /** The work's DOI, lower case, without a resolver prefix. */
  doi: shortId.optional(),
  /** OpenAlex work ids of the works it references, or, from Crossref, their lower-case DOIs. */
  references: z.array(shortId).max(MAX_REFERENCES),
  fetchedAt: timeSchema,
})
/** One project paper's reference list as one provider returned it. */
export type CitationWork = z.infer<typeof citationWorkSchema>

/** A project's relation graph as stored. */
export interface RelationsFile {
  version: typeof RELATIONS_VERSION
  /** Ordered by id. */
  entities: RelationEntity[]
  /** Ordered by id. */
  relations: Relation[]
  /** The cached reference lists, at most one per paper record and provider, ordered by evidence id and provider. */
  citations: CitationWork[]
}

/**
 * An empty relation graph.
 * @returns a graph without entities, relations or cached reference lists.
 */
export function emptyRelations(): RelationsFile {
  return { version: RELATIONS_VERSION, entities: [], relations: [], citations: [] }
}

// ── Reading and writing the store ───────────────────────────────────────────

const storedSchema = z.object({
  version: z.number(), entities: z.array(z.unknown()), relations: z.array(z.unknown()), citations: z.array(z.unknown()).optional(),
})

/** The graph as loaded; `damaged` keeps what could be read and is rewritten on the next change, `newer` is never rewritten. */
type Stored =
  | { state: 'missing' | 'sound' | 'damaged'; file: RelationsFile; problems: string[] }
  | { state: 'newer'; file: RelationsFile; problems: [string] }

function listed(problems: string[]): string[] {
  if (problems.length <= LISTED_PROBLEMS) return problems
  return [...problems.slice(0, LISTED_PROBLEMS), `and ${problems.length - LISTED_PROBLEMS} more problems`]
}

function issues(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')
}

function citationKey(work: Pick<CitationWork, 'evidenceId' | 'provider'>): string { return `${work.evidenceId}|${work.provider}` }

/** Read the records of one array, keeping the later of two with one key. */
function records<T>(raw: unknown[], schema: z.ZodType<T>, key: (item: T) => string, noun: string, problems: string[]): Map<string, T> {
  const kept = new Map<string, T>()
  raw.forEach((value, at) => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      problems.push(`${noun} ${at + 1} is malformed (${issues(parsed.error)}) and is not honored`)
      return
    }
    if (kept.has(key(parsed.data))) problems.push(`${noun} ${at + 1} repeats ${key(parsed.data)}; the later one is honored`)
    kept.set(key(parsed.data), parsed.data)
  })
  return kept
}

function parseStored(text: string): Stored {
  const damaged = (problem: string): Stored => ({ state: 'damaged', file: emptyRelations(), problems: [problem] })
  let data: unknown
  try { data = JSON.parse(text) } catch (error) {
    return damaged(`${RELATIONS_FILE} is not valid JSON (${errorText(error)}); none of its relations are honored`)
  }
  const stored = storedSchema.safeParse(data)
  if (!stored.success) return damaged(`${RELATIONS_FILE} is not a relations file; none of its relations are honored`)
  const { version } = stored.data
  if (version > RELATIONS_VERSION) {
    return {
      state: 'newer', file: emptyRelations(),
      problems: [`${RELATIONS_FILE} has format version ${version}, written by a newer SciPaper Harness; its relations are neither honored nor changed`],
    }
  }
  if (version !== RELATIONS_VERSION) return damaged(`${RELATIONS_FILE} has unknown format version ${version}; none of its relations are honored`)
  const problems: string[] = []
  const entities = records(stored.data.entities, entitySchema, item => item.id, 'entity', problems)
  const relations = records(stored.data.relations, relationSchema, item => item.id, 'relation', problems)
  for (const [id, relation] of relations) {
    const missing = [relation.from, relation.to].filter(end => !entities.has(end))
    if (missing.length === 0) continue
    problems.push(`relation ${id} names the missing entity ${missing.join(' and ')} and is not honored`)
    relations.delete(id)
  }
  const citations = records(stored.data.citations ?? [], citationWorkSchema, citationKey, 'reference list', problems)
  const file = sorted([...entities.values()], [...relations.values()], [...citations.values()])
  return { state: problems.length > 0 ? 'damaged' : 'sound', file, problems: listed(problems) }
}

function compare(a: string, b: string): number { return Number(a > b) - Number(a < b) }

function sorted(entities: RelationEntity[], relations: Relation[], citations: CitationWork[]): RelationsFile {
  return {
    version: RELATIONS_VERSION,
    entities: entities.sort((a, b) => compare(a.id, b.id)),
    relations: relations.sort((a, b) => compare(a.id, b.id)),
    citations: citations.sort((a, b) => compare(citationKey(a), citationKey(b))),
  }
}

async function load(path: string): Promise<Stored> {
  let size: number
  try { size = (await stat(path)).size } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', file: emptyRelations(), problems: [] }
    throw error
  }
  if (size > MAX_RELATIONS_BYTES) {
    return { state: 'damaged', file: emptyRelations(), problems: [`${RELATIONS_FILE} is larger than ${MAX_RELATIONS_BYTES} bytes; none of its relations are honored`] }
  }
  return parseStored(await readFile(path, 'utf8'))
}

/** A project's relation graph as read, and what was wrong with the stored file. */
export interface RelationsRead {
  file: RelationsFile
  /** Each problem names what it keeps from being honored; empty for a sound or missing file. */
  problems: string[]
}

/**
 * Read a project's relation graph without a lock: writers replace the file in
 * one rename, so a reader sees one complete version. A damaged file yields what
 * could be read and its problems, and stays as it is until the next change.
 * @param root - the project directory.
 * @returns the graph and the problems found; an unreadable file is a problem, not a failure.
 */
export async function readRelations(root: string): Promise<RelationsRead> {
  try {
    const { file, problems } = await load(await projectPath(root, RELATIONS_FILE))
    return { file, problems }
  } catch (error) {
    return { file: emptyRelations(), problems: [`${RELATIONS_FILE} could not be read (${errorText(error)}); no relations are honored`] }
  }
}

/** The result of one pure change to a relation graph. */
export interface RelationEdit<T> {
  file: RelationsFile
  /** Whether `file` differs from the graph the change started from. */
  changed: boolean
  result: T
}

/** What one stored change did. */
export interface RelationsChange<T> {
  result: T
  changed: boolean
  /** Problems of the stored file this change repaired by rewriting it. */
  problems: string[]
  /** Project-relative copy of the damaged file, kept before it was rewritten. */
  backup?: string | undefined
}

async function keepBackup(path: string, now: Date): Promise<string> {
  const stamp = now.toISOString().replace(/[-:]|\.\d+/g, '')
  for (let copy = 1; ; copy++) {
    const name = `${stamp}${copy === 1 ? '' : `-${copy}`}.bak`
    try {
      await copyFile(path, `${path}.${name}`, constants.COPYFILE_EXCL)
      return `${RELATIONS_FILE}.${name}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/**
 * Apply one pure change under the file's writer lock and commit it by atomic
 * replacement. A damaged file is copied aside, then rewritten with what could
 * be read; a newer format is refused. Nothing is written when the change
 * changes nothing and the file is sound.
 * @param root - the project directory; refusing example projects is the caller's.
 * @param now - the time recorded on a backup.
 * @param edit - the change, given the graph as stored.
 * @returns the change's result, whether the stored graph changed, and the repair done.
 */
export async function updateRelations<T>(
  root: string, now: Date, edit: (file: RelationsFile) => RelationEdit<T>,
): Promise<RelationsChange<T>> {
  const path = await projectPath(root, RELATIONS_FILE)
  await mkdir(dirname(path), { recursive: true })
  return withFileLock(path, async () => {
    const stored = await load(path)
    if (stored.state === 'newer') throw new Error(stored.problems[0])
    const { file, changed, result } = edit(stored.file)
    const change: RelationsChange<T> = { result, changed, problems: stored.problems }
    if (!changed && stored.state !== 'damaged') return change
    const text = `${JSON.stringify(file, null, 1)}\n`
    if (Buffer.byteLength(text) > MAX_RELATIONS_BYTES) throw new Error(`The relation graph would exceed ${MAX_RELATIONS_BYTES} bytes; reject or merge some entries first`)
    if (stored.state === 'damaged') change.backup = await keepBackup(path, now)
    await atomicWrite(path, text)
    return change
  })
}

// ── Entities ────────────────────────────────────────────────────────────────

/** Names too general to identify an entity: `method`, `our model`, `数据集` … */
const GENERIC = new Set([
  'model', 'method', 'approach', 'baseline', 'task', 'dataset', 'data', 'metric', 'score', 'system', 'framework', 'network', 'algorithm',
  'technique', 'paper', 'work', 'we', 'our', 'this', 'it', 'result', 'experiment', 'benchmark', 'our method', 'our model', 'our approach',
  '方法', '模型', '任务', '数据集', '指标', '基线', '我们', '本文',
].map(nameKey))

const NAMED_KINDS = ['method', 'task', 'dataset', 'metric'] as const

/** A node a proposal names: by id, by a paper's literature record, or by kind and name. */
export const entityRefSchema = z.union([
  z.object({ id: shortId }).strict(),
  z.object({ kind: z.literal('paper'), evidenceId: shortId }).strict(),
  z.object({ kind: z.enum(NAMED_KINDS), name: nameSchema, aliases: z.array(nameSchema).max(MAX_ALIASES).optional() }).strict(),
])
/** A node as a proposal names it. */
export type EntityRef = z.input<typeof entityRefSchema>

/** The relation graph being changed by one pure operation, indexed for lookups. */
class Draft {
  readonly entities: Map<string, RelationEntity>
  readonly relations: Map<string, Relation>
  /** By {@link citationKey}. */
  readonly citations: Map<string, CitationWork>
  /** `kind|name key` → entity id, for every name and alias. */
  readonly names = new Map<string, string>()
  /** Former id, or `evidence:<id>` of a paper's record → entity id. */
  readonly redirects = new Map<string, string>()
  changed = false

  constructor(file: RelationsFile) {
    this.entities = new Map(file.entities.map(entity => [entity.id, structuredClone(entity)]))
    this.relations = new Map(file.relations.map(relation => [relation.id, structuredClone(relation)]))
    this.citations = new Map(file.citations.map(work => [citationKey(work), structuredClone(work)]))
    for (const entity of this.entities.values()) this.index(entity)
  }

  index(entity: RelationEntity): void {
    for (const name of [entity.name, ...entity.aliases]) this.names.set(`${entity.kind}|${nameKey(name)}`, entity.id)
    for (const former of entity.formerIds ?? []) this.redirects.set(former, entity.id)
    for (const evidenceId of entity.evidenceIds ?? []) this.redirects.set(`evidence:${evidenceId}`, entity.id)
  }

  entity(id: string): RelationEntity | undefined {
    return this.entities.get(id) ?? this.entities.get(this.redirects.get(id) ?? '')
  }

  paperOf(evidenceId: string): RelationEntity | undefined { return this.entities.get(this.redirects.get(`evidence:${evidenceId}`) ?? '') }

  byName(kind: EntityKind, name: string): RelationEntity | undefined { return this.entities.get(this.names.get(`${kind}|${nameKey(name)}`) ?? '') }

  /** Give a new entity a readable, unused id (its kind and its name in lower case with dashes) and add it. */
  add(entity: RelationEntity, slugSource: string): void {
    const slug = slugSource.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
    // A name with no letters or digits is refused before an entity is made, so the slug is never empty.
    const base = `${entity.kind}:${slug}`
    entity.id = base
    for (let n = 2; this.entity(entity.id) !== undefined; n++) entity.id = `${base}-${n}`
    this.entities.set(entity.id, entity)
    this.index(entity)
    this.changed = true
  }

  file(): RelationsFile { return sorted([...this.entities.values()], [...this.relations.values()], [...this.citations.values()]) }

  edit<T>(result: T): RelationEdit<T> { return { file: this.file(), changed: this.changed, result } }
}

/** The short name before a title's colon, kept as an alias of a paper: `MoBA` for `MoBA: Mixture of Block Attention …`. */
function shortTitle(title: string): string[] {
  const head = title.split(/\s*:\s/)[0] as string
  return head !== title && head.length >= 2 && head.length <= 40 ? [head.trim()] : []
}

/** Why a name cannot identify an entity, or undefined when it can. */
function nameProblem(name: string): string | undefined {
  const key = nameKey(name)
  if (key === '') return `"${name}" has no letters or digits`
  return GENERIC.has(key) ? `"${name}" is too general to identify one entity; use its proper name` : undefined
}

function newPaper(record: EvidenceRecord, by: Author, at: string): RelationEntity {
  const name = record.title.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH)
  return { id: '', kind: 'paper', name, aliases: shortTitle(name), evidenceIds: [record.id], by, createdAt: at, updatedAt: at }
}

/** A resolved end: an existing entity, or a new one (id assigned when it is added), with aliases to add to an existing one. */
interface Resolved { entity: RelationEntity; isNew: boolean; addAliases: string[]; slugSource: string }

/** Why an operation was refused that is not about a ground. */
export type EditCode =
  | 'unknown-entity' | 'not-a-paper' | 'invalid-entity' | 'ambiguous-entity' | 'kind-mismatch' | 'self-relation'
  | 'ground-not-allowed' | 'rejected' | 'unknown-relation' | 'unknown-ground' | 'not-yours' | 'full'
/** Why a proposal or a correction was refused. */
export type RefusalCode = GroundingCode | EditCode

/** A refusal with the message the proposer reads. */
export interface Refusal { status: 'refused'; code: RefusalCode; message: string }

function refusal(code: RefusalCode, message: string): Refusal { return { status: 'refused', code, message } }

/** The parts of a project record the relation graph reads. */
export type RelationProject = Pick<ResearchProject, 'evidence' | 'experiments'>

function resolve(draft: Draft, project: RelationProject, ref: z.infer<typeof entityRefSchema>, by: Author, at: string): Resolved | Refusal {
  if ('id' in ref) {
    const entity = draft.entity(ref.id)
    if (entity === undefined) return refusal('unknown-entity', `No entity of the relation graph has the id ${ref.id}.`)
    return { entity, isNew: false, addAliases: [], slugSource: '' }
  }
  if (ref.kind === 'paper') {
    const record = project.evidence.find(item => item.id === ref.evidenceId)
    if (record?.kind !== 'literature') return refusal('not-a-paper', `${ref.evidenceId} is not a literature record of this project; import the paper first.`)
    const entity = draft.paperOf(record.id)
    return entity === undefined
      ? { entity: newPaper(record, by, at), isNew: true, addAliases: [], slugSource: record.id }
      : { entity, isNew: false, addAliases: [], slugSource: '' }
  }
  const names = [ref.name, ...(ref.aliases ?? []).filter(alias => nameKey(alias) !== nameKey(ref.name))]
  for (const name of names) {
    const problem = nameProblem(name)
    if (problem !== undefined) return refusal('invalid-entity', problem)
  }
  const matches = [...new Set(names.flatMap(name => draft.byName(ref.kind, name)?.id ?? []))]
  if (matches.length > 1) {
    return refusal('ambiguous-entity', `${names.map(name => `"${name}"`).join(', ')} name the different entities ${matches.join(' and ')}; merge them first, or name one.`)
  }
  const existing = matches[0] === undefined ? undefined : draft.entity(matches[0])
  if (existing !== undefined) {
    const known = new Set([existing.name, ...existing.aliases].map(nameKey))
    const addAliases = [...new Map(names.filter(name => !known.has(nameKey(name))).map(name => [nameKey(name), name])).values()]
    return { entity: existing, isNew: false, addAliases, slugSource: '' }
  }
  const aliases = [...new Map(names.slice(1).map(name => [nameKey(name), name])).values()]
  return { entity: { id: '', kind: ref.kind, name: ref.name, aliases, by, createdAt: at, updatedAt: at }, isNew: true, addAliases: [], slugSource: ref.name }
}

/** Whether two resolved ends would be one entity once added. */
function sameEnd(a: Resolved, b: Resolved): boolean {
  if (!a.isNew || !b.isNew) return a.entity.id === b.entity.id && !a.isNew && !b.isNew
  if (a.entity.kind !== b.entity.kind) return false
  const keys = new Set([a.entity.name, ...a.entity.aliases].map(nameKey))
  return [b.entity.name, ...b.entity.aliases].some(name => keys.has(nameKey(name)))
    || (a.entity.evidenceIds?.[0] !== undefined && a.entity.evidenceIds[0] === b.entity.evidenceIds?.[0])
}

function commitEntity(draft: Draft, resolved: Resolved, at: string): void {
  if (resolved.isNew) {
    draft.add(resolved.entity, resolved.slugSource)
    return
  }
  const added = resolved.addAliases.slice(0, Math.max(0, MAX_ALIASES - resolved.entity.aliases.length))
  if (added.length === 0) return
  resolved.entity.aliases.push(...added)
  resolved.entity.updatedAt = at
  draft.index(resolved.entity)
  draft.changed = true
}

/** A new method, task, dataset or metric, or aliases for one. */
export const entityInputSchema = z.object({
  kind: z.enum(NAMED_KINDS),
  name: nameSchema,
  aliases: z.array(nameSchema).max(MAX_ALIASES).optional(),
  by: authorSchema,
})
/** The fields of an entity to create, or of aliases to add to the entity one of its names already names. */
export type EntityInput = z.input<typeof entityInputSchema>

/** What an entity change did. */
export type EntityOutcome = { status: 'created' | 'updated' | 'unchanged'; entity: RelationEntity } | Refusal

/**
 * Create an entity, or add aliases to the one its name or an alias already
 * names. A name is matched by nameKey within its kind, so case, spacing,
 * hyphens and plural endings never create a second entity; an acronym is a
 * different name until it is given as an alias or the two entities are
 * merged. Names that name two different entities are refused.
 * @param file - the graph.
 * @param input - the kind, name, aliases and author; validated here.
 * @param now - the time recorded on a new or changed entity.
 * @returns the changed graph and the entity, or the refusal.
 */
export function upsertEntity(file: RelationsFile, input: EntityInput, now: Date): RelationEdit<EntityOutcome> {
  const { kind, name, aliases, by } = entityInputSchema.parse(input)
  const draft = new Draft(file)
  const at = now.toISOString()
  const resolved = resolve(draft, { evidence: [], experiments: [] }, { kind, name, ...aliases === undefined ? {} : { aliases } }, by, at)
  if ('status' in resolved) return draft.edit(resolved)
  if (resolved.isNew && draft.entities.size >= MAX_ENTITIES) return draft.edit(refusal('full', `A project keeps at most ${MAX_ENTITIES} entities.`))
  commitEntity(draft, resolved, at)
  return draft.edit({ status: resolved.isNew ? 'created' : draft.changed ? 'updated' : 'unchanged', entity: resolved.entity })
}

// ── Relations ───────────────────────────────────────────────────────────────

/**
 * The id of the relation `from <kind> to`; a graph holds at most one relation per kind and ordered pair.
 * @param kind - the relation kind.
 * @param from - the `from` entity id.
 * @param to - the `to` entity id.
 * @returns `<kind>:<from>><to>`.
 */
export function relationId(kind: RelationKind, from: string, to: string): string {
  return `${kind}:${from}>${to}`
}

function hash(text: string): string { return createHash('sha256').update(text).digest('hex').slice(0, 16) }

const RANK: Record<Author, number> = { agent: 1, user: 2 }
/** Whether `by` may undo a decision taken by `decider`: the person undoes anyone's, the agent only the agent's. */
function outranks(by: Author, decider: Author): boolean { return RANK[by] >= RANK[decider] }

/** A ground as a proposal offers it. */
export const groundInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('quote'), evidenceId: shortId, revision: z.number().int().nonnegative(), quote: z.string().min(1).max(2000),
    locator: locatorSchema.optional(), setting: oneLine(MAX_SETTING_LENGTH).optional(),
  }).strict(),
  z.object({
    type: z.literal('run'), runId: shortId, from: oneLine(64), to: oneLine(64),
    baselineRunId: shortId.optional(), setting: oneLine(MAX_SETTING_LENGTH).optional(),
  }).strict(),
])
/** A ground as a proposal offers it: a quotation or project runs. Citation grounds come only from {@link applyCitationWorks}. */
export type GroundInput = z.input<typeof groundInputSchema>

/** One relation the agent or a person proposes, with the ground it rests on. */
export const proposalSchema = z.object({
  kind: z.enum(RELATION_KINDS),
  from: entityRefSchema,
  to: entityRefSchema,
  ground: groundInputSchema,
  by: authorSchema,
})
/** A proposed relation. */
export type RelationProposal = z.input<typeof proposalSchema>

/**
 * What one proposal did: added a relation or a ground to it, found the ground
 * already recorded, or moved an outdated one to the current revision.
 */
export type ProposalOutcome =
  | {
    status: 'added' | 'unchanged' | 'regrounded'
    relation: string
    ground: string
    /** Entities this proposal created. */
    created: string[]
    /** The proposer's locator did not hold the quotation and was replaced. */
    locatorCorrected: boolean
    /** Rules a person's quotation did not meet. */
    warnings: string[]
    /** The proposal lifted an earlier rejection of the relation or of this ground. */
    restored: boolean
  }
  | Refusal

/**
 * Whether a quote or run ground's sources are at the revisions it was checked against; rejections and self-reference lapses are
 * the caller's to judge.
 */
function groundCurrent(ground: QuoteGround | RunGroundRecord, project: RelationProject): boolean {
  if (isOutdated(ground, project.evidence.find(item => item.id === ground.evidenceId))) return false
  const baseline = ground.type === 'run' ? ground.baseline : undefined
  return baseline === undefined || !isOutdated(baseline, project.evidence.find(item => item.id === baseline.evidenceId))
}

/** Active `introduces` relations into an entity, one entry per record of the introducing paper. */
function introductions(draft: Draft, project: RelationProject, entity: RelationEntity): Introduction[] {
  return [...draft.relations.values()]
    .filter(relation => relation.kind === 'introduces' && relation.to === entity.id && relation.rejected === undefined
      && relation.grounds.some(ground => ground.rejected === undefined && ground.type !== 'citation' && groundCurrent(ground, project)))
    // The from end of an introduction is a paper, which names its records.
    .flatMap((relation) => {
      const records = (draft.entity(relation.from) as RelationEntity).evidenceIds as string[]
      return records.map(evidenceId => ({ evidenceId, relation: relation.id }))
    })
}

function groundingEnd(draft: Draft, project: RelationProject, entity: RelationEntity): GroundingEnd {
  return {
    kind: entity.kind, names: [entity.name, ...entity.aliases], records: entity.evidenceIds ?? [],
    introducedBy: entity.id === '' ? [] : introductions(draft, project, entity),
  }
}

type Checked = { ground: Ground; locatorCorrected: boolean; warnings: string[] } | Refusal

function checkGround(
  draft: Draft, project: RelationProject, proposal: z.infer<typeof proposalSchema>, from: RelationEntity, to: RelationEntity, at: string,
): Checked {
  const rule = RELATION_RULES[proposal.kind]
  const { ground } = proposal
  if (!rule.grounds.includes(ground.type)) {
    return refusal('ground-not-allowed', `A ${proposal.kind} relation rests on ${rule.grounds.join(' or ')}, not on a ${ground.type}.`)
  }
  if (ground.setting !== undefined && !rule.setting) return refusal('ground-not-allowed', `A setting qualifies only evaluated-on relations, not ${proposal.kind}.`)
  const ends = { from: groundingEnd(draft, project, from), to: groundingEnd(draft, project, to) }
  const setting = ground.setting === undefined ? {} : { setting: ground.setting }
  if (ground.type === 'quote') {
    const checked = groundQuote({
      kind: proposal.kind, ...ends, evidence: project.evidence.find(item => item.id === ground.evidenceId), revision: ground.revision,
      quote: ground.quote, locator: ground.locator, setting: ground.setting, strict: proposal.by === 'agent',
    })
    if (!checked.ok) return refusal(checked.code, checked.message)
    const stored: QuoteGround = {
      id: hash(`quote|${ground.evidenceId}|${foldText(checked.quote)}|${ground.setting ?? ''}`), type: 'quote', evidenceId: ground.evidenceId,
      revision: ground.revision, locator: checked.locator, quote: checked.quote.slice(0, MAX_STORED_QUOTE), ...setting,
      ...checked.via === undefined ? {} : { via: checked.via },
      ...checked.warnings.length > 0 ? { warnings: checked.warnings.slice(0, 8) } : {},
      by: proposal.by, at,
    }
    return { ground: stored, locatorCorrected: checked.locatorCorrected, warnings: checked.warnings }
  }
  const checked = groundRun({
    kind: proposal.kind, ...ends, runs: project.experiments, evidence: project.evidence, runId: ground.runId, fromLabel: ground.from,
    toLabel: ground.to, baselineRunId: ground.baselineRunId, setting: ground.setting,
  })
  if (!checked.ok) return refusal(checked.code, checked.message)
  const stored: RunGroundRecord = {
    id: hash(`run|${ground.runId}|${ground.baselineRunId ?? ''}|${nameKey(ground.from)}|${nameKey(ground.to)}|${ground.setting ?? ''}`), type: 'run',
    ...checked.run, labels: { from: ground.from, to: ground.to }, ...setting,
    ...checked.baseline === undefined ? {} : { baseline: checked.baseline },
    by: proposal.by, at,
  }
  return { ground: stored, locatorCorrected: false, warnings: [] }
}

/** A rejection as a refusal names it; only the person's rejections ever refuse a proposal, since the agent may undo its own. */
function decided(decision: Decision): string {
  return `the person on ${decision.at.slice(0, 10)}${decision.reason === undefined ? '' : ` (${decision.reason})`}`
}

function propose(draft: Draft, project: RelationProject, raw: RelationProposal, at: string): ProposalOutcome {
  const proposal = proposalSchema.parse(raw)
  const rule = RELATION_RULES[proposal.kind]
  const from = resolve(draft, project, proposal.from, proposal.by, at)
  if ('status' in from) return from
  const to = resolve(draft, project, proposal.to, proposal.by, at)
  if ('status' in to) return to
  if (sameEnd(from, to)) return refusal('self-relation', 'A relation joins two different entities.')
  const kinds = { from: from.entity.kind, to: to.entity.kind }
  if (!rule.from.includes(kinds.from) || !rule.to.includes(kinds.to) || (rule.sameKind && kinds.from !== kinds.to)) {
    return refusal('kind-mismatch', `${proposal.kind} joins ${rule.from.join('/')} to ${rule.sameKind ? 'the same kind' : rule.to.join('/')}, `
      + `not ${from.entity.kind} to ${to.entity.kind}.`)
  }
  // Only relations between existing entities can already exist.
  const existing = from.isNew || to.isNew ? undefined : draft.relations.get(relationId(proposal.kind, from.entity.id, to.entity.id))
  if (existing?.rejected !== undefined && !outranks(proposal.by, existing.rejected.by)) {
    return refusal('rejected', `This relation was rejected by ${decided(existing.rejected)}; only the person can restore it.`)
  }
  const checked = checkGround(draft, project, proposal, from.entity, to.entity, at)
  if ('status' in checked) return checked
  const previous = existing?.grounds.find(ground => ground.id === checked.ground.id)
  if (previous?.rejected !== undefined && !outranks(proposal.by, previous.rejected.by)) {
    return refusal('rejected', `This ground was rejected by ${decided(previous.rejected)}; only the person can restore it.`)
  }
  const restored = existing?.rejected !== undefined || previous?.rejected !== undefined
  const report = { created: [] as string[], locatorCorrected: checked.locatorCorrected, warnings: checked.warnings, restored }
  const sameRevision = previous?.type !== 'quote' || checked.ground.type !== 'quote' || previous.revision === checked.ground.revision
  if (existing !== undefined && previous !== undefined && !restored && previous.type !== 'citation' && groundCurrent(previous, project) && sameRevision) {
    return { status: 'unchanged', relation: existing.id, ground: previous.id, ...report }
  }
  if (existing === undefined && draft.relations.size >= MAX_RELATIONS) return refusal('full', `A project keeps at most ${MAX_RELATIONS} relations.`)
  if (existing !== undefined && previous === undefined && existing.grounds.length >= MAX_GROUNDS) {
    return refusal('full', `This relation already rests on ${MAX_GROUNDS} grounds; reject one before adding another.`)
  }
  if (draft.entities.size + Number(from.isNew) + Number(to.isNew) > MAX_ENTITIES) return refusal('full', `A project keeps at most ${MAX_ENTITIES} entities.`)
  commitEntity(draft, from, at)
  commitEntity(draft, to, at)
  report.created = [from, to].filter(end => end.isNew).map(end => end.entity.id)
  const id = relationId(proposal.kind, from.entity.id, to.entity.id)
  const relation: Relation = existing
    ?? { id, kind: proposal.kind, from: from.entity.id, to: to.entity.id, grounds: [], by: proposal.by, createdAt: at, updatedAt: at }
  delete relation.rejected
  relation.grounds = [...relation.grounds.filter(ground => ground.id !== checked.ground.id), checked.ground]
  relation.updatedAt = at
  draft.relations.set(id, relation)
  draft.changed = true
  return { status: previous === undefined || restored ? 'added' : 'regrounded', relation: id, ground: checked.ground.id, ...report }
}

/**
 * Check and record proposed relations, each on its own: a refused proposal
 * changes nothing and does not stop the others. A proposal names its ends by
 * id, by a paper's literature record, or by kind and name (resolved as
 * {@link upsertEntity} resolves names); new entities are created only when
 * the proposal is accepted. The ground is checked by groundQuote or
 * groundRun, strictly for the agent. A relation or ground rejected by the
 * person is refused to the agent; a person's proposal restores it. A ground
 * already recorded changes nothing, unless it rested on an older revision,
 * when it moves to the current one.
 * @param file - the graph.
 * @param project - the record, with evidence text loaded.
 * @param proposals - at most {@link MAX_PROPOSALS}, validated here.
 * @param now - the time recorded on what is added.
 * @returns the changed graph and one outcome per proposal, in order.
 */
export function applyProposals(
  file: RelationsFile, project: RelationProject, proposals: readonly RelationProposal[], now: Date,
): RelationEdit<ProposalOutcome[]> {
  if (proposals.length > MAX_PROPOSALS) throw new Error(`Propose at most ${MAX_PROPOSALS} relations at once`)
  const draft = new Draft(file)
  const at = now.toISOString()
  return draft.edit(proposals.map(proposal => propose(draft, project, proposal, at)))
}

/** A rejection or restoration of a relation, or of one of its grounds. */
export const decisionInputSchema = z.object({
  relation: shortId, ground: shortId.optional(), by: authorSchema,
  reason: z.string().transform(text => text.replace(/\s+/g, ' ').trim()).pipe(z.string().max(MAX_REASON_LENGTH)).optional(),
})
/** The relation (and ground) to reject or restore, who decides, and why. */
export type DecisionInput = z.input<typeof decisionInputSchema>

/** What a rejection or restoration did. */
export type DecisionOutcome = { status: 'changed' | 'unchanged'; relation: Relation } | Refusal

function decide(file: RelationsFile, raw: DecisionInput, now: Date, reject: boolean): RelationEdit<DecisionOutcome> {
  const input = decisionInputSchema.parse(raw)
  const draft = new Draft(file)
  const relation = draft.relations.get(input.relation)
  if (relation === undefined) return draft.edit(refusal('unknown-relation', `No relation has the id ${input.relation}.`))
  let target: Relation | Ground = relation
  if (input.ground !== undefined) {
    const ground = relation.grounds.find(item => item.id === input.ground)
    if (ground === undefined) return draft.edit(refusal('unknown-ground', `Relation ${relation.id} has no ground ${input.ground}.`))
    target = ground
  }
  const current = target.rejected
  if (current !== undefined && !outranks(input.by, current.by)) {
    if (reject) return draft.edit({ status: 'unchanged', relation })
    return draft.edit(refusal('not-yours', `The person rejected this on ${current.at.slice(0, 10)}; only the person can restore it.`))
  }
  if (!reject && current === undefined) return draft.edit({ status: 'unchanged', relation })
  if (reject) target.rejected = { by: input.by, at: now.toISOString(), ...input.reason === undefined || input.reason === '' ? {} : { reason: input.reason } }
  else delete target.rejected
  relation.updatedAt = now.toISOString()
  draft.changed = true
  return draft.edit({ status: 'changed', relation })
}

/**
 * Reject a relation, or one of its grounds, with an optional reason. A
 * rejected relation stays recorded so that it is honored: the agent cannot
 * propose it again, and a rejection by the person stands until the person
 * restores it. The agent's rejection of something the person already
 * rejected changes nothing.
 * @param file - the graph.
 * @param input - the relation, the ground when only one ground is wrong, the author and the reason.
 * @param now - the time recorded on the rejection.
 * @returns the changed graph and the relation.
 */
export function rejectRelation(file: RelationsFile, input: DecisionInput, now: Date): RelationEdit<DecisionOutcome> {
  return decide(file, input, now, true)
}

/**
 * Lift the rejection of a relation or of one of its grounds. The agent may lift
 * only the agent's rejections.
 * @param file - the graph.
 * @param input - the relation, the ground, and who restores it.
 * @param now - the time recorded on the relation.
 * @returns the changed graph and the relation, or the refusal.
 */
export function restoreRelation(file: RelationsFile, input: DecisionInput, now: Date): RelationEdit<DecisionOutcome> {
  return decide(file, input, now, false)
}

/** A merge of two entities of one kind. */
export const mergeInputSchema = z.object({ from: shortId, into: shortId, by: authorSchema })
/** The entity to merge, the one it becomes, and who merges. */
export type MergeInput = z.input<typeof mergeInputSchema>

/** What a merge did: the surviving entity, and the relations that would have joined it to itself and were dropped. */
export type MergeOutcome = { status: 'merged'; entity: RelationEntity; dropped: string[] } | Refusal

/** The weightier of two rejections: the person's over the agent's, then the later one. */
function heavier(a: Decision | undefined, b: Decision | undefined): Decision | undefined {
  if (a === undefined || b === undefined) return a ?? b
  if (a.by !== b.by) return a.by === 'user' ? a : b
  return a.at >= b.at ? a : b
}

/**
 * Merge one entity into another of the same kind: the survivor takes the
 * other's names as aliases (up to {@link MAX_ALIASES}), its id as a former id
 * that keeps resolving, a paper's evidence records, and its relations. Two
 * relations that become one keep both sets of grounds and the weightier
 * rejection; a relation from the survivor to itself is dropped. A merge is not
 * undone by any operation.
 * @param file - the graph.
 * @param input - the merged entity, the survivor and the author.
 * @param now - the time recorded on the survivor.
 * @returns the changed graph, the survivor and the dropped relations.
 */
export function mergeEntities(file: RelationsFile, input: MergeInput, now: Date): RelationEdit<MergeOutcome> {
  const { from: fromId, into: intoId } = mergeInputSchema.parse(input)
  const draft = new Draft(file)
  const from = draft.entity(fromId), into = draft.entity(intoId)
  if (from === undefined || into === undefined) return draft.edit(refusal('unknown-entity', `No entity has the id ${from === undefined ? fromId : intoId}.`))
  if (from.id === into.id) return draft.edit(refusal('self-relation', 'An entity cannot be merged into itself.'))
  if (from.kind !== into.kind) return draft.edit(refusal('kind-mismatch', `A ${from.kind} cannot be merged into a ${into.kind}.`))
  const at = now.toISOString()
  const known = new Set([into.name, ...into.aliases].map(nameKey))
  for (const name of [from.name, ...from.aliases]) {
    if (known.has(nameKey(name)) || into.aliases.length >= MAX_ALIASES) continue
    into.aliases.push(name)
    known.add(nameKey(name))
  }
  into.formerIds = [...new Set([...into.formerIds ?? [], from.id, ...from.formerIds ?? []])].slice(-64)
  // Entities of one kind: when the survivor is a paper, so is the merged entity, and both name their records.
  if (into.evidenceIds !== undefined) into.evidenceIds = [...new Set([...into.evidenceIds, ...from.evidenceIds as string[]])].slice(0, 8)
  into.updatedAt = at
  draft.entities.delete(from.id)
  draft.index(into)
  const renamed = new Map<string, string>()
  const dropped: string[] = []
  for (const relation of [...draft.relations.values()].filter(item => item.from === from.id || item.to === from.id)) {
    draft.relations.delete(relation.id)
    const ends = { from: relation.from === from.id ? into.id : relation.from, to: relation.to === from.id ? into.id : relation.to }
    if (ends.from === ends.to) { dropped.push(relation.id); continue }
    const id = relationId(relation.kind, ends.from, ends.to)
    renamed.set(relation.id, id)
    const other = draft.relations.get(id)
    const kept = other?.grounds ?? []
    const grounds = [...kept, ...relation.grounds.filter(ground => !kept.some(item => item.id === ground.id))].slice(0, MAX_GROUNDS)
    const merged: Relation = { ...other ?? relation, ...ends, id, grounds, updatedAt: at }
    if (other !== undefined && relation.createdAt < other.createdAt) merged.createdAt = relation.createdAt
    const rejected = heavier(other?.rejected, relation.rejected)
    if (rejected === undefined) delete merged.rejected
    else merged.rejected = rejected
    draft.relations.set(id, merged)
  }
  for (const relation of draft.relations.values()) {
    for (const ground of relation.grounds) {
      const target = ground.type === 'quote' && ground.via !== undefined ? renamed.get(ground.via) : undefined
      if (target !== undefined && ground.type === 'quote') ground.via = target
    }
  }
  draft.changed = true
  return draft.edit({ status: 'merged', entity: into, dropped })
}

/** Two entities that may be one, for the person or the agent to merge or keep apart. */
export interface MergeSuggestion {
  a: string
  b: string
  /** `acronym`: one's name is the initials of the other's; `spelling`: their names differ in one letter. */
  reason: 'acronym' | 'spelling'
  /** The two names that matched. */
  names: [string, string]
}

const FUNCTION_WORDS = new Set(['of', 'for', 'and', 'the', 'a', 'an', 'in', 'on', 'to', 'with', 'via'])

/** The initials of a name's words, with and without short function words: `mixture of experts` → moe and me. */
function initials(name: string): string[] {
  const words = name.toLowerCase().split(/[\s\p{Pd}]+/u).filter(word => /^\p{L}/u.test(word))
  const all = words.map(word => word.charAt(0)).join('')
  const content = words.filter(word => !FUNCTION_WORDS.has(word)).map(word => word.charAt(0)).join('')
  return [...new Set([all, content])].filter(item => item.length >= 2)
}

/** Whether two keys differ by one inserted, deleted or replaced character. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (a[i] === b[i]) i++
  return a.slice(i + (a.length >= b.length ? 1 : 0)) === b.slice(i + (b.length >= a.length ? 1 : 0))
}

/**
 * Pairs of entities of one kind that may name one thing: one's name or alias
 * is the initials of the other's (`MoE` and `mixture of experts`), or two
 * names of eight or more characters differ in one letter. Nothing is merged;
 * an acronym that a source defines is honored in quotations without a merge.
 * @param file - the graph.
 * @returns the suggestions, ordered by the two ids; at most 100.
 */
export function mergeSuggestions(file: RelationsFile): MergeSuggestion[] {
  const found = new Map<string, MergeSuggestion>()
  const entities = file.entities.filter(entity => entity.kind !== 'paper')
  for (const a of entities) {
    for (const b of entities) {
      if (a.kind !== b.kind || a.id >= b.id) continue
      for (const x of [a.name, ...a.aliases]) {
        for (const y of [b.name, ...b.aliases]) {
          const kx = nameKey(x), ky = nameKey(y)
          const acronym = (!/\s/.test(x) && initials(y).includes(kx)) || (!/\s/.test(y) && initials(x).includes(ky))
          const spelling = kx.length >= 8 && ky.length >= 8 && oneEditApart(kx, ky)
          const pair = `${a.id}|${b.id}`
          if ((acronym || spelling) && !found.has(pair)) found.set(pair, { a: a.id, b: b.id, reason: acronym ? 'acronym' : 'spelling', names: [x, y] })
        }
      }
    }
  }
  return [...found.values()].slice(0, 100)
}

// ── Staleness and the derived view ──────────────────────────────────────────

/**
 * The weights relation queries give grounds. {@link RELATION_TUNING} holds the
 * values the Agent Note argues for; another value is for evaluation only.
 */
export interface RelationTuning {
  /** A quotation of a literature record's pages. */
  fullText: number
  /** A quotation of a provider abstract or title, which nothing checked against the paper. */
  abstract: number
  /** A quotation of a project file: the researcher's notes, data or design. */
  file: number
  /** Completed project runs. */
  run: number
  /** A provider's citation record: one paper cites another, which says little about how their methods relate. */
  citation: number
  /** Factor on the weight of a ground whose source changed. */
  stale: number
  /** Cost added for every hop of a path, so that a shorter explanation wins among equally supported ones. */
  hop: number
}

/** The ground weights the queries use. */
export const RELATION_TUNING: Readonly<RelationTuning> = Object.freeze({
  fullText: 0.9, abstract: 0.8, file: 0.7, run: 0.9, citation: 0.5, stale: 0.5, hop: 0.25,
})

/** Where a ground comes from, for weights and for the gap matrix's counts. */
export type GroundSource = 'full-text' | 'abstract' | 'file' | 'run' | 'citation'

/** A ground as the queries read it. */
export interface GroundView {
  ground: Ground
  /** `current` while its source holds the revision it was checked against, `outdated` once the source changed, `rejected` once rejected. */
  status: 'current' | 'outdated' | 'rejected'
  source: GroundSource
  /** What it rests on, for display: the evidence record's title, the run's name and seed, or the citing paper. */
  title: string
  /** Its source kind's weight, multiplied by the stale factor while outdated; 0 when rejected. */
  weight: number
}

/** A relation as the queries read it. */
export interface RelationView {
  relation: Relation
  /**
   * `rejected` when the relation or every ground is rejected; `active` while
   * a ground is current; `stale` when every remaining ground rests on a
   * changed source, the way a claim citing a changed source is.
   */
  status: 'active' | 'stale' | 'rejected'
  /** 1 − Π(1 − w) over its sources, each counted by its weightiest ground; outdated grounds count only when none is current. */
  confidence: number
  grounds: GroundView[]
}

/** An entity as the queries read it: `orphaned` for a paper none of whose records the project still holds. */
export interface EntityView {
  entity: RelationEntity
  status: 'active' | 'orphaned'
}

/** The graph derived from the stored file and the current record; never stored. */
export interface RelationGraphView {
  entities: Map<string, EntityView>
  relations: Map<string, RelationView>
  /** Every relation that touches an entity, by entity id, in relation id order. */
  touching: Map<string, RelationView[]>
}

/**
 * The source a ground counts as, so that two grounds from one source count once: the evidence record of a quotation, the run of
 * a run ground, and one source for every citation record.
 * @param ground - a ground.
 * @returns the evidence id, `run:<run id>`, or `citation`.
 */
export function sourceKey(ground: Ground): string {
  if (ground.type === 'quote') return ground.evidenceId
  return ground.type === 'run' ? `run:${ground.runId}` : 'citation'
}

/**
 * The setting a ground states, such as a context length.
 * @param ground - a ground.
 * @returns the setting, or undefined for a ground without one and for a citation.
 */
export function groundSetting(ground: Ground): string | undefined {
  return 'setting' in ground ? ground.setting : undefined
}

function sourceOf(ground: Ground, record: EvidenceRecord | undefined): GroundSource {
  if (ground.type !== 'quote') return ground.type
  if (record?.kind === 'file') return 'file'
  return ground.locator.key === undefined ? 'full-text' : 'abstract'
}

/**
 * Derive each relation's status and confidence from the stored graph and the
 * current record; this is the staleness recomputation, and it runs on every
 * read. A quote or run ground is outdated when its source is gone, recorded
 * stale, or at another revision than the one it was checked against (the test
 * claims get, isOutdated), and when the `introduces` relation its
 * self-reference relied on is no longer active. A citation ground is outdated
 * when either paper is orphaned.
 * @param file - the stored graph.
 * @param project - the current record.
 * @param tuning - ground weights; production callers pass none.
 * @returns the view the queries read.
 */
export function relationGraph(file: RelationsFile, project: RelationProject, tuning: RelationTuning = RELATION_TUNING): RelationGraphView {
  const entities = new Map<string, EntityView>()
  for (const entity of file.entities) {
    const orphaned = entity.evidenceIds !== undefined && !entity.evidenceIds.some(id => project.evidence.some(record => record.id === id))
    entities.set(entity.id, { entity, status: orphaned ? 'orphaned' : 'active' })
  }
  const weights: Record<GroundSource, number> = {
    'full-text': tuning.fullText, 'abstract': tuning.abstract, 'file': tuning.file, 'run': tuning.run, 'citation': tuning.citation,
  }
  const relations = new Map<string, RelationView>()
  const title = (ground: Ground, relation: Relation): string => {
    if (ground.type === 'citation') return (entities.get(relation.from) as EntityView).entity.name
    if (ground.type === 'quote') return project.evidence.find(item => item.id === ground.evidenceId)?.title ?? ground.evidenceId
    const run = project.experiments.find(item => item.id === ground.runId)
    return run === undefined ? ground.runId : `${run.spec.name} · seed ${run.spec.seed}`
  }
  const derive = (relation: Relation): RelationView => {
    const grounds = relation.grounds.map((ground): GroundView => {
      const source = sourceOf(ground, ground.type === 'quote' ? project.evidence.find(item => item.id === ground.evidenceId) : undefined)
      let status: GroundView['status'] = 'current'
      if (ground.rejected !== undefined) status = 'rejected'
      else if (ground.type === 'citation' ? [relation.from, relation.to].some(end => entities.get(end)?.status !== 'active') : !groundCurrent(ground, project)) status = 'outdated'
      else if (ground.type === 'quote' && ground.via !== undefined && relations.get(ground.via)?.status !== 'active') status = 'outdated'
      const weight = status === 'rejected' ? 0 : status === 'outdated' ? weights[source] * tuning.stale : weights[source]
      return { ground, status, source, title: title(ground, relation), weight }
    })
    const live = grounds.filter(item => item.status === 'current')
    const counted = live.length > 0 ? live : grounds.filter(item => item.status === 'outdated')
    const best = new Map<string, number>()
    for (const item of counted) best.set(sourceKey(item.ground), Math.max(best.get(sourceKey(item.ground)) ?? 0, item.weight))
    if (relation.rejected !== undefined || counted.length === 0) return { relation, status: 'rejected', confidence: 0, grounds }
    const miss = [...best.values()].reduce((product, weight) => product * (1 - weight), 1)
    return { relation, status: live.length > 0 ? 'active' : 'stale', confidence: Math.round((1 - miss) * 1000) / 1000, grounds }
  }
  // An `introduces` relation never rests on a self-reference, so those are derived first and the others read their status.
  for (const relation of file.relations.filter(item => item.kind === 'introduces')) relations.set(relation.id, derive(relation))
  for (const relation of file.relations.filter(item => item.kind !== 'introduces')) relations.set(relation.id, derive(relation))
  const touching = new Map<string, RelationView[]>()
  for (const view of [...relations.values()].sort((a, b) => compare(a.relation.id, b.relation.id))) {
    for (const end of [view.relation.from, view.relation.to]) touching.set(end, [...touching.get(end) ?? [], view])
  }
  return { entities, relations, touching }
}

/** What re-grounding did. */
export interface RegroundOutcome {
  /** Quotations found again in their source's current revision and moved to it. */
  regrounded: number
  /** Quotations whose source changed and that no longer hold in the current revision. */
  lapsed: number
}

/**
 * Check every quotation whose source moved to a new revision against that
 * revision, by the rule it was accepted under (strict for the agent's), and
 * move the ones that still hold. Rejected grounds, stale sources and runs are
 * left as they are: a run whose input changed needs a new run.
 * @param file - the graph.
 * @param project - the current record, with evidence text loaded.
 * @param now - the time recorded on the relations that changed.
 * @returns the changed graph and the counts.
 */
export function regroundRelations(file: RelationsFile, project: RelationProject, now: Date): RelationEdit<RegroundOutcome> {
  const draft = new Draft(file)
  const outcome: RegroundOutcome = { regrounded: 0, lapsed: 0 }
  // `introduces` relations move first: a self-reference in another quotation is checked against the introduction's new revision.
  const relations = [...draft.relations.values()].sort((a, b) => Number(b.kind === 'introduces') - Number(a.kind === 'introduces'))
  for (const relation of relations) {
    if (relation.rejected !== undefined) continue
    const ends = { from: draft.entity(relation.from) as RelationEntity, to: draft.entity(relation.to) as RelationEntity }
    for (const ground of relation.grounds) {
      if (ground.type !== 'quote' || ground.rejected !== undefined) continue
      const record = project.evidence.find(item => item.id === ground.evidenceId)
      if (record === undefined || record.stale || record.revision === ground.revision) continue
      const checked = groundQuote({
        kind: relation.kind, from: groundingEnd(draft, project, ends.from), to: groundingEnd(draft, project, ends.to), evidence: record,
        revision: record.revision, quote: ground.quote, locator: ground.locator, setting: ground.setting, strict: ground.by === 'agent',
      })
      if (!checked.ok) { outcome.lapsed++; continue }
      ground.revision = record.revision
      ground.locator = checked.locator
      ground.quote = checked.quote
      if (checked.via === undefined) delete ground.via
      else ground.via = checked.via
      relation.updatedAt = now.toISOString()
      outcome.regrounded++
      draft.changed = true
    }
  }
  return draft.edit(outcome)
}

// ── Citations ───────────────────────────────────────────────────────────────

/** A project paper whose reference list is to be fetched. */
export interface CitationQuery {
  evidenceId: string
  /** Lower case, without a resolver prefix. */
  doi?: string | undefined
  /** OpenAlex work id, `W…`. */
  openalex?: string | undefined
}

/** What a fetch returned: the reference lists, and one message per request that failed. */
export interface CitationFetch {
  works: CitationWork[]
  failures: string[]
}

/** Fetches project papers' reference lists from scholarly providers. */
export interface CitationFetcher {
  /**
   * Fetch the reference lists of the given papers. A paper the providers do not know is left out of `works`.
   * @param papers - the papers.
   * @param signal - cancellation.
   * @returns the lists fetched and the failures.
   */
  fetch(papers: readonly CitationQuery[], signal: AbortSignal): Promise<CitationFetch>
}

const DOI = /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/

function doiOf(value: string | null | undefined): string | undefined {
  const doi = (value ?? '').trim().toLowerCase().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/, '')
  return DOI.test(doi) ? doi : undefined
}

function openalexOf(value: string | null | undefined): string | undefined {
  return /(?:^|\/)(W\d+)$/.exec((value ?? '').trim())?.[1]
}

/**
 * The project papers whose reference lists are missing from the cache or older
 * than `maxAgeDays`: every literature record, by its DOI, or by the OpenAlex
 * work its cached list or its source URL names.
 * @param file - the graph with its cached lists.
 * @param project - the record.
 * @param now - the current time.
 * @param maxAgeDays - how long a fetched list is kept before it is fetched again.
 * @returns the papers to fetch, in record order.
 */
export function citationQueries(file: RelationsFile, project: Pick<ResearchProject, 'evidence'>, now: Date, maxAgeDays: number): CitationQuery[] {
  return project.evidence.filter(record => record.kind === 'literature').flatMap((record) => {
    const cached = file.citations.filter(work => work.evidenceId === record.id)
    if (cached.some(work => now.getTime() - Date.parse(work.fetchedAt) < maxAgeDays * 86_400_000)) return []
    const doi = doiOf(record.doi) ?? cached.map(work => work.doi).find(item => item !== undefined)
    const openalex = cached.map(work => work.work).find(item => item !== undefined) ?? openalexOf(record.sourceUrl)
    if (doi === undefined && openalex === undefined) return []
    return [{ evidenceId: record.id, ...doi === undefined ? {} : { doi }, ...openalex === undefined ? {} : { openalex } }]
  })
}

/** Reads one JSON document; the caller owns timeouts, headers and HTTP errors. */
export type JsonGetter = (url: string, signal: AbortSignal) => Promise<unknown>

const openalexPage = z.object({
  results: z.array(z.object({ id: z.string(), doi: z.string().nullable().optional(), referenced_works: z.array(z.string()).default([]) })),
})
const crossrefWork = z.object({ message: z.object({ reference: z.array(z.object({ DOI: z.string().optional() })).default([]) }) })

/** How the reference fetcher paces itself. */
export interface CitationFetcherOptions {
  /** Pause between two requests; OpenAlex allows ten a second without a key. */
  pauseMs: number
  /** Waits; tests pass one that returns at once. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  /** The clock for `fetchedAt`. */
  now: () => Date
}

/** Papers per OpenAlex filter request: its `|` filter takes up to fifty values, the most one page returns. */
const OPENALEX_BATCH = 50

/**
 * A reference fetcher over OpenAlex and Crossref. Papers are looked up in
 * OpenAlex fifty at a time, by DOI and then by work id, selecting only `id`,
 * `doi` and `referenced_works`. A paper OpenAlex lists without references, or
 * does not know, is asked of Crossref by DOI, one request each, and its
 * Crossref list is kept beside the OpenAlex one. Requests run one after
 * another with a pause; no e-mail address or key is sent. A failed request is
 * reported and the others go on.
 * @param get - reads one JSON document.
 * @param options - pacing and clock.
 * @returns the fetcher.
 */
export function createCitationFetcher(get: JsonGetter, options: CitationFetcherOptions): CitationFetcher {
  return {
    async fetch(papers, signal) {
      const works: CitationWork[] = []
      const failures: string[] = []
      let requests = 0
      const request = async (url: string): Promise<unknown> => {
        if (requests++ > 0) await options.sleep(options.pauseMs, signal)
        return get(url, signal)
      }
      const crossref: CitationQuery[] = []
      const remaining = new Map(papers.map(paper => [paper.evidenceId, paper]))
      for (const field of ['doi', 'openalex'] as const) {
        const asked = [...remaining.values()].filter(paper => paper[field] !== undefined)
        for (let start = 0; start < asked.length; start += OPENALEX_BATCH) {
          const batch = asked.slice(start, start + OPENALEX_BATCH)
          const values = batch.map(paper => paper[field] as string).join('|')
          let page: z.infer<typeof openalexPage>
          try {
            page = openalexPage.parse(await request(`https://api.openalex.org/works?filter=${field}:${values}&select=id,doi,referenced_works&per-page=${OPENALEX_BATCH}`))
          } catch (error) {
            failures.push(`OpenAlex lookup of ${batch.length} papers by ${field} failed: ${errorText(error)}`)
            continue
          }
          for (const result of page.results) {
            const work = openalexOf(result.id), doi = doiOf(result.doi)
            const paper = batch.find(item => remaining.has(item.evidenceId) && (field === 'doi' ? item.doi === doi : item.openalex === work))
            if (paper === undefined || work === undefined) continue
            remaining.delete(paper.evidenceId)
            const references = result.referenced_works.flatMap(id => openalexOf(id) ?? []).slice(0, MAX_REFERENCES)
            works.push({ evidenceId: paper.evidenceId, provider: 'openalex', work, ...doi === undefined ? {} : { doi }, references, fetchedAt: options.now().toISOString() })
            if (references.length === 0 && paper.doi !== undefined) crossref.push(paper)
          }
        }
      }
      for (const paper of [...crossref, ...[...remaining.values()].filter(item => item.doi !== undefined)]) {
        const doi = paper.doi as string
        let references: string[]
        try {
          references = crossrefWork.parse(await request(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)).message.reference
            .flatMap(item => doiOf(item.DOI) ?? []).slice(0, MAX_REFERENCES)
        } catch (error) {
          failures.push(`Crossref lookup of ${doi} failed: ${errorText(error)}`)
          continue
        }
        if (references.length > 0) works.push({ evidenceId: paper.evidenceId, provider: 'crossref', doi, references, fetchedAt: options.now().toISOString() })
      }
      return { works, failures }
    },
  }
}

/** What applying fetched reference lists did. */
export interface CitationOutcome {
  /** Reference lists now cached. */
  works: number
  /** `cites` grounds added. */
  added: number
  /** Citations among the project's papers already recorded. */
  unchanged: number
  /** Citations not recorded because the relation or the ground is rejected. */
  rejected: number
}

/**
 * Cache fetched reference lists and record every citation among the project's
 * own papers as a `cites` relation from the citing to the cited paper, with the
 * provider's citation ground. All cached lists are matched again, so a newly
 * imported paper gains the citations older papers make of it without a fetch.
 * A reference is matched to a paper by OpenAlex id (from the paper's own
 * OpenAlex list) or by DOI; a paper never cites itself. Rejected relations and
 * grounds stay rejected, and a citation missing from a newer list keeps the
 * ground recorded while it was listed.
 * @param file - the graph.
 * @param project - the record.
 * @param works - fetched reference lists; each replaces the cached list of its paper and provider.
 * @param now - the time recorded on what is added.
 * @returns the changed graph and the counts.
 */
export function applyCitationWorks(file: RelationsFile, project: Pick<ResearchProject, 'evidence'>, works: readonly CitationWork[], now: Date): RelationEdit<CitationOutcome> {
  const draft = new Draft(file)
  const at = now.toISOString()
  for (const work of works) {
    const parsed = citationWorkSchema.parse(work)
    draft.citations.set(citationKey(parsed), parsed)
    draft.changed = true
  }
  const papers = new Map<string, EvidenceRecord>(project.evidence.filter(record => record.kind === 'literature').map(record => [record.id, record]))
  const byWork = new Map<string, EvidenceRecord[]>()
  const note = (key: string | undefined, record: EvidenceRecord): void => {
    if (key !== undefined && !(byWork.get(key) ?? []).includes(record)) byWork.set(key, [...byWork.get(key) ?? [], record])
  }
  for (const record of papers.values()) note(doiOf(record.doi), record)
  for (const work of draft.citations.values()) {
    const record = papers.get(work.evidenceId)
    if (record === undefined) continue
    note(work.work, record)
    note(work.doi, record)
  }
  const outcome: CitationOutcome = { works: draft.citations.size, added: 0, unchanged: 0, rejected: 0 }
  const paperEntity = (record: EvidenceRecord): RelationEntity => {
    const existing = draft.paperOf(record.id)
    if (existing !== undefined) return existing
    const entity = newPaper(record, 'agent', at)
    draft.add(entity, record.id)
    return entity
  }
  for (const work of [...draft.citations.values()].sort((a, b) => compare(citationKey(a), citationKey(b)))) {
    const citing = papers.get(work.evidenceId)
    if (citing === undefined) continue
    for (const reference of new Set(work.references)) {
      for (const cited of byWork.get(reference) ?? []) {
        if (cited.id === citing.id) continue
        const from = paperEntity(citing), to = paperEntity(cited)
        const id = relationId('cites', from.id, to.id)
        const relation = draft.relations.get(id)
        const groundId = hash(`citation|${work.provider}|${citing.id}|${cited.id}`)
        const previous = relation?.grounds.find(ground => ground.id === groundId)
        if (relation?.rejected !== undefined || previous?.rejected !== undefined) { outcome.rejected++; continue }
        if (previous !== undefined) { outcome.unchanged++; continue }
        if (relation === undefined ? draft.relations.size >= MAX_RELATIONS : relation.grounds.length >= MAX_GROUNDS) continue
        const ground: CitationGround = { id: groundId, type: 'citation', provider: work.provider, citing: work.work ?? work.doi ?? citing.id, cited: reference, at }
        const next: Relation = relation ?? { id, kind: 'cites', from: from.id, to: to.id, grounds: [], by: 'agent', createdAt: at, updatedAt: at }
        next.grounds.push(ground)
        next.updatedAt = at
        draft.relations.set(id, next)
        outcome.added++
      }
    }
  }
  return draft.edit(outcome)
}

/**
 * The name keys of an entity, as the queries' passage scan matches them.
 * @param entity - an entity.
 * @returns the key of its name and of each alias → whether only words in capitals spell it.
 */
export function entityKeys(entity: Pick<RelationEntity, 'name' | 'aliases'>): Map<string, boolean> {
  return nameKeys([entity.name, ...entity.aliases])
}
