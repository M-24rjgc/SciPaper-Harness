import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_ENTITIES, MAX_GROUNDS, MAX_PROPOSALS, MAX_RELATIONS, MAX_RELATIONS_BYTES, RELATIONS_FILE, RELATION_TUNING,
  applyCitationWorks, applyProposals, citationQueries, createCitationFetcher, emptyRelations, entityKeys, mergeEntities, mergeSuggestions,
  readRelations, regroundRelations, rejectRelation, relationGraph, relationId, restoreRelation, updateRelations, upsertEntity,
  type CitationWork, type EntityRef, type JsonGetter, type ProposalOutcome, type Relation, type RelationEntity, type RelationProject,
  type RelationProposal, type RelationsFile,
} from '../src/knowledge-relations.ts'
import type { EvidenceId, EvidenceRecord, ExperimentId, ExperimentRecord, SourceLocator } from '../src/types.ts'

const fsHarness = vi.hoisted(() => ({
  nextStatError: undefined as NodeJS.ErrnoException | undefined,
  nextCopyError: undefined as NodeJS.ErrnoException | undefined,
}))

// Permission failures cannot be produced portably on a temporary directory, so the next stat or copy can be made to fail.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const failing = <F extends (...args: never[]) => Promise<unknown>>(key: 'nextStatError' | 'nextCopyError', original: F): F => (async (...args: Parameters<F>) => {
    const error = fsHarness[key]
    if (error !== undefined) {
      fsHarness[key] = undefined
      throw error
    }
    return original(...args)
  }) as F
  return { ...actual, stat: failing('nextStatError', actual.stat), copyFile: failing('nextCopyError', actual.copyFile) }
})

const roots: string[] = []
afterEach(async () => {
  fsHarness.nextStatError = undefined
  fsHarness.nextCopyError = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'research relations '))
  roots.push(root)
  return root
}

const NOW = new Date('2026-10-01T12:00:00.000Z')
const later = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000)
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code })

function literature(id: string, chunks: [SourceLocator, string][], extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: id as EvidenceId, title: `${id.toUpperCase()}: A Paper About ${id}`, kind: 'literature', path: `.research/sources/${id}/reference.json`, sha256: 'x',
    revision: 1, importedAt: '2026-10-01T00:00:00.000Z', chunks: chunks.map(([locator, text]) => ({ locator, text })), coverage: 'full-text',
    verified: true, stale: false, ...extra,
  }
}

function experiment(id: string, name: string, metrics: Record<string, number>): ExperimentRecord {
  return {
    id: id as ExperimentId,
    spec: { environmentId: 'env' as ExperimentRecord['spec']['environmentId'], name, argv: [], cwd: '.', seed: 1, maxSeconds: 60, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' },
    status: 'completed', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics, message: '', snapshotPath: '', collected: true,
  }
}

const results = (runId: string, extra: Partial<EvidenceRecord> = {}): EvidenceRecord =>
  literature(`results-${runId}`, [], { kind: 'experiment', path: `.research/runs/${runId}/metrics.json`, coverage: 'data', ...extra })

const MOBA_TEXT = 'We introduce MoBA, a block attention method. MoBA outperforms full attention on RULER. We evaluate our method on LongBench. '
  + 'MoBA is evaluated on RULER at 128K.'
const NSA_TEXT = 'We present NSA, a sparse attention method. NSA outperforms full attention on LongBench.'

function sample(): RelationProject {
  return {
    evidence: [
      literature('moba', [[{ page: 1 }, MOBA_TEXT]], { doi: '10.1000/moba' }),
      literature('nsa', [[{ page: 1 }, NSA_TEXT]], { sourceUrl: 'https://openalex.org/W200' }),
      literature('lone', [[{ key: 'abstract' }, 'MoBA is evaluated on RULER here.']], { coverage: 'abstract' }),
      { ...literature('notes', [[{ line: 1 }, 'MoBA is a block attention method from Kimi.']]), kind: 'file' },
      results('dyn'), results('full'),
    ],
    experiments: [experiment('dyn', 'ruler-dynamic', { accuracy: 0.8 }), experiment('full', 'ruler-full', { accuracy: 0.82 })],
  }
}

const moba: EntityRef = { kind: 'method', name: 'MoBA' }
const full: EntityRef = { kind: 'method', name: 'full attention' }
const ruler: EntityRef = { kind: 'dataset', name: 'RULER' }
const quote = (evidenceId: string, text: string, revision = 1): Extract<RelationProposal['ground'], { type: 'quote' }> =>
  ({ type: 'quote', evidenceId, revision, quote: text })
const propose = (kind: RelationProposal['kind'], from: EntityRef, to: EntityRef, ground: RelationProposal['ground'], by: 'user' | 'agent' = 'agent'): RelationProposal =>
  ({ kind, from, to, ground, by })
const improves = propose('improves-on', moba, full, quote('moba', 'MoBA outperforms full attention on RULER.'))
const status = (outcome: ProposalOutcome | undefined): string => outcome === undefined ? 'none' : outcome.status === 'refused' ? outcome.code : outcome.status

/** The refusal's message, or an empty string for an outcome that is not a refusal. */
const said = (outcome: ProposalOutcome | undefined): string => outcome?.status === 'refused' ? outcome.message : ''

function apply(
  file: RelationsFile, proposals: RelationProposal[], at: Date = NOW, data: RelationProject = sample(),
): { file: RelationsFile; outcomes: ProposalOutcome[] } {
  const edit = applyProposals(file, data, proposals, at)
  return { file: edit.file, outcomes: edit.result }
}

describe('the relations file', () => {
  it('reads an empty graph without a file, and writes and reads back a change', async () => {
    const root = await project()
    expect(await readRelations(root)).toEqual({ file: emptyRelations(), problems: [] })
    const change = await updateRelations(root, NOW, file => applyProposals(file, sample(), [improves], NOW))
    expect(change).toMatchObject({ changed: true, problems: [] })
    const read = await readRelations(root)
    expect(read.problems).toEqual([])
    expect(read.file.relations.map(item => item.id)).toEqual(['improves-on:method:moba>method:full-attention'])
    expect((await readFile(join(root, RELATIONS_FILE), 'utf8')).endsWith('}\n')).toBe(true)
    const again = await updateRelations(root, later(1), file => applyProposals(file, sample(), [improves], later(1)))
    expect(again.changed).toBe(false)
  })

  it('reports damage, honours what can be read, and keeps a copy before rewriting', async () => {
    const root = await project()
    await mkdir(join(root, '.research', 'kg'), { recursive: true })
    const path = join(root, RELATIONS_FILE)
    const good = apply(emptyRelations(), [improves]).file
    const entity = good.entities[0] as RelationEntity
    const relation = good.relations[0] as Relation
    await writeFile(path, JSON.stringify({
      version: 1,
      entities: [...good.entities, entity, { id: 'broken' }],
      relations: [relation, { ...relation, id: 'orphan', from: 'method:missing' }, 7],
      citations: [{ evidenceId: 'moba', provider: 'openalex', references: [], fetchedAt: NOW.toISOString() }, {}],
    }))
    const read = await readRelations(root)
    expect(read.file.relations.map(item => item.id)).toEqual([relation.id])
    expect(read.file.citations).toHaveLength(1)
    expect(read.problems).toEqual([
      `entity 3 repeats ${entity.id}; the later one is honored`,
      expect.stringMatching(/^entity 4 is malformed \(.+\) and is not honored$/),
      expect.stringMatching(/^relation 3 is malformed/),
      'relation orphan names the missing entity method:missing and is not honored',
      expect.stringMatching(/^reference list 2 is malformed/),
    ])
    const change = await updateRelations(root, NOW, file => ({ file, changed: false, result: null }))
    expect(change.backup).toBe(`${RELATIONS_FILE}.20261001T120000Z.bak`)
    await writeFile(path, '{')
    const second = await updateRelations(root, NOW, file => ({ file, changed: false, result: null }))
    expect(second.backup).toBe(`${RELATIONS_FILE}.20261001T120000Z-2.bak`)
    expect((await readdir(join(root, '.research', 'kg'))).filter(name => name.endsWith('.bak'))).toHaveLength(2)
  })

  it('lists at most ten problems and counts the rest', async () => {
    const root = await project()
    await mkdir(join(root, '.research', 'kg'), { recursive: true })
    const broken = Array.from({ length: 12 }, () => ({}))
    await writeFile(join(root, RELATIONS_FILE), JSON.stringify({ version: 1, entities: broken, relations: [] }))
    const { problems } = await readRelations(root)
    expect(problems).toHaveLength(11)
    expect(problems.at(-1)).toBe('and 2 more problems')
  })

  it('names what is wrong with a file it cannot use', async () => {
    const root = await project()
    await mkdir(join(root, '.research', 'kg'), { recursive: true })
    const path = join(root, RELATIONS_FILE)
    const problem = async (content: string): Promise<string | undefined> => {
      await writeFile(path, content)
      return (await readRelations(root)).problems[0]
    }
    expect(await problem('not json')).toMatch(/is not valid JSON/)
    expect(await problem('{"version":1}')).toMatch(/is not a relations file/)
    expect(await problem('{"version":0,"entities":[],"relations":[]}')).toMatch(/unknown format version 0/)
    expect(await problem('{"version":2,"entities":[],"relations":[]}')).toMatch(/format version 2, written by a newer SciPaper Harness/)
    await expect(updateRelations(root, NOW, file => ({ file, changed: true, result: null }))).rejects.toThrow(/newer SciPaper Harness/)
    await writeFile(path, ' '.repeat(MAX_RELATIONS_BYTES + 1))
    expect((await readRelations(root)).problems[0]).toMatch(/is larger than/)
    fsHarness.nextStatError = errno('EACCES')
    expect((await readRelations(root)).problems[0]).toMatch(/could not be read \(EACCES: injected\)/)
  })

  it('refuses a change that would exceed the byte ceiling, and passes on a failed backup', async () => {
    const root = await project()
    const huge = { ...emptyRelations(), entities: [{ id: 'x', kind: 'method' as const, name: 'x'.repeat(MAX_RELATIONS_BYTES), aliases: [], by: 'user' as const, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }] }
    await expect(updateRelations(root, NOW, () => ({ file: huge, changed: true, result: null }))).rejects.toThrow(/would exceed/)
    await mkdir(join(root, '.research', 'kg'), { recursive: true })
    await writeFile(join(root, RELATIONS_FILE), '{')
    fsHarness.nextCopyError = errno('EPERM')
    await expect(updateRelations(root, NOW, file => ({ file, changed: true, result: null }))).rejects.toThrow(/EPERM/)
  })
})

describe('entities', () => {
  it('creates an entity, adds aliases, and treats spelling variants as the same name', () => {
    const created = upsertEntity(emptyRelations(), { kind: 'method', name: 'Block-Sparse Attention', aliases: ['块稀疏注意力', 'block sparse attentions'], by: 'agent' }, NOW)
    expect(created.result).toMatchObject({ status: 'created', entity: { id: 'method:block-sparse-attention', aliases: ['块稀疏注意力'] } })
    const same = upsertEntity(created.file, { kind: 'method', name: 'blocksparse attention', by: 'user' }, NOW)
    expect(same).toMatchObject({ changed: false, result: { status: 'unchanged' } })
    const alias = upsertEntity(created.file, { kind: 'method', name: 'block sparse attention', aliases: ['BSA'], by: 'user' }, later(1))
    expect(alias.result).toMatchObject({ status: 'updated', entity: { aliases: ['块稀疏注意力', 'BSA'], updatedAt: later(1).toISOString() } })
    expect(upsertEntity(created.file, { kind: 'task', name: 'Block sparse attention', by: 'user' }, NOW).result).toMatchObject({ status: 'created', entity: { id: 'task:block-sparse-attention' } })
    expect(upsertEntity(created.file, { kind: 'method', name: '!!!', by: 'user' }, NOW).result).toMatchObject({ code: 'invalid-entity' })
    expect(upsertEntity(created.file, { kind: 'method', name: 'our method', by: 'user' }, NOW).result).toMatchObject({ code: 'invalid-entity' })
    expect(upsertEntity(emptyRelations(), { kind: 'method', name: '方法', by: 'user' }, NOW).result).toMatchObject({ code: 'invalid-entity' })
    const other = upsertEntity(alias.file, { kind: 'method', name: 'MoBA', by: 'user' }, NOW)
    expect(upsertEntity(other.file, { kind: 'method', name: 'MoBA', aliases: ['BSA'], by: 'user' }, NOW).result).toMatchObject({ code: 'ambiguous-entity' })
    expect(entityKeys({ name: 'TRUE', aliases: ['true benchmark'] })).toEqual(new Map([['true', true], ['truebenchmark', false]]))
  })

  it('stops at the entity and alias limits', () => {
    const at = NOW.toISOString()
    const many: RelationsFile = {
      ...emptyRelations(),
      entities: Array.from({ length: MAX_ENTITIES }, (_, i) => ({ id: `method:m${i}`, kind: 'method' as const, name: `m${i}`, aliases: [], by: 'user' as const, createdAt: at, updatedAt: at })),
    }
    expect(upsertEntity(many, { kind: 'method', name: 'one more', by: 'user' }, NOW).result).toMatchObject({ code: 'full' })
    const crowded: RelationsFile = { ...emptyRelations(), entities: [{ id: 'method:x', kind: 'method', name: 'x', aliases: Array.from({ length: 16 }, (_, i) => `x${i}`), by: 'user', createdAt: at, updatedAt: at }] }
    expect(upsertEntity(crowded, { kind: 'method', name: 'x', aliases: ['another'], by: 'user' }, NOW).result).toMatchObject({ status: 'unchanged' })
  })

  it('gives a new entity an unused id when its name\'s id is taken by a merged one', () => {
    const at = NOW.toISOString()
    const merged: RelationsFile = { ...emptyRelations(), entities: [{ id: 'method:a', kind: 'method', name: 'A', aliases: [], formerIds: ['method:b'], by: 'user', createdAt: at, updatedAt: at }] }
    expect(upsertEntity(merged, { kind: 'method', name: 'B', by: 'user' }, NOW).result).toMatchObject({ entity: { id: 'method:b-2' } })
    expect(upsertEntity(emptyRelations(), { kind: 'method', name: 'Ω', by: 'user' }, NOW).result).toMatchObject({ entity: { id: 'method:ω' } })
  })
})

describe('proposals', () => {
  it('adds a relation with its new entities, then a second ground, and leaves a repeated ground unchanged', () => {
    const first = apply(emptyRelations(), [improves])
    expect(first.outcomes[0]).toMatchObject({ status: 'added', created: ['method:moba', 'method:full-attention'], restored: false })
    const second = apply(first.file, [improves, propose('improves-on', { kind: 'method', name: 'MoBA', aliases: ['Mixture of Block Attention'] }, full, quote('moba', 'MoBA outperforms full attention'))])
    expect(second.outcomes.map(status)).toEqual(['unchanged', 'added'])
    expect(second.file.relations[0]?.grounds).toHaveLength(2)
    expect(second.file.entities.find(item => item.id === 'method:moba')?.aliases).toEqual(['Mixture of Block Attention'])
    const tooMany = Array.from({ length: MAX_PROPOSALS + 1 }, () => improves)
    expect(() => applyProposals(emptyRelations(), sample(), tooMany, NOW)).toThrow(/at most 50/)
  })

  it('names papers by their literature record and entities by id, including merged ids', () => {
    const intro = propose('introduces', { kind: 'paper', evidenceId: 'moba' }, moba, quote('moba', 'We introduce MoBA, a block attention method.'))
    const first = apply(emptyRelations(), [intro])
    expect(first.outcomes[0]).toMatchObject({ status: 'added', created: ['paper:moba', 'method:moba'] })
    expect(first.file.entities.find(item => item.kind === 'paper')).toMatchObject({ name: 'MOBA: A Paper About moba', aliases: ['MOBA'], evidenceIds: ['moba'] })
    const byId = apply(first.file, [propose('introduces', { id: 'paper:moba' }, { id: 'method:moba' }, quote('moba', 'We introduce MoBA, a block attention method.'))])
    expect(byId.outcomes.map(status)).toEqual(['unchanged'])
    const again = apply(first.file, [intro])
    expect(again.outcomes.map(status)).toEqual(['unchanged'])
    expect(apply(first.file, [propose('introduces', { id: 'paper:nope' }, moba, quote('moba', 'x'))]).outcomes.map(status)).toEqual(['unknown-entity'])
    expect(apply(first.file, [propose('introduces', { kind: 'paper', evidenceId: 'notes' }, moba, quote('moba', 'x'))]).outcomes.map(status)).toEqual(['not-a-paper'])
  })

  it('refuses ends that are one entity, of the wrong kinds, or named ambiguously', () => {
    const base = apply(emptyRelations(), [improves]).file
    const outcomes = apply(base, [
      propose('improves-on', moba, { kind: 'method', name: 'moba' }, quote('moba', 'x')),
      propose('improves-on', { kind: 'method', name: 'New one' }, { kind: 'method', name: 'new ones' }, quote('moba', 'x')),
      propose('cites', { kind: 'paper', evidenceId: 'moba' }, { kind: 'paper', evidenceId: 'moba' }, quote('moba', 'x')),
      propose('evaluated-on', moba, full, quote('moba', 'x')),
      propose('is-a', moba, ruler, quote('moba', 'x')),
      propose('improves-on', { kind: 'method', name: 'MoBA', aliases: ['full attention'] }, full, quote('moba', 'x')),
      propose('improves-on', { kind: 'method', name: 'method' }, full, quote('moba', 'x')),
      propose('improves-on', moba, { kind: 'method', name: 'our method' }, quote('moba', 'x')),
    ]).outcomes
    expect(outcomes.map(status)).toEqual(['self-relation', 'self-relation', 'self-relation', 'kind-mismatch', 'kind-mismatch', 'ambiguous-entity', 'invalid-entity', 'invalid-entity'])
  })

  it('accepts only the grounds and settings the kind allows', () => {
    const outcomes = apply(emptyRelations(), [
      propose('improves-on', moba, full, { type: 'run', runId: 'dyn', from: 'dynamic', to: 'full' }),
      propose('compares-with', moba, full, { type: 'quote', evidenceId: 'moba', revision: 1, quote: 'MoBA outperforms full attention on RULER.', setting: '128K' }),
      propose('cites', { kind: 'paper', evidenceId: 'moba' }, { kind: 'paper', evidenceId: 'nsa' }, quote('moba', 'x')),
      propose('evaluated-on', moba, ruler, { type: 'quote', evidenceId: 'moba', revision: 1, quote: 'MoBA is evaluated on RULER at 128K.', setting: '128K' }),
    ]).outcomes
    expect(outcomes.map(status)).toEqual(['ground-not-allowed', 'ground-not-allowed', 'ground-not-allowed', 'added'])
  })

  it('records run grounds with their labels and baseline', () => {
    const data = sample()
    const dynamic: EntityRef = { kind: 'method', name: 'dynamic selection' }
    const { file, outcomes } = apply(emptyRelations(), [
      propose('compares-with', dynamic, full, { type: 'run', runId: 'dyn', from: 'dynamic', to: 'full', baselineRunId: 'full' }),
      propose('evaluated-on', dynamic, ruler, { type: 'run', runId: 'dyn', from: 'dynamic', to: 'ruler', setting: '32K' }),
      propose('evaluated-on', dynamic, ruler, { type: 'run', runId: 'nope', from: 'dynamic', to: 'ruler' }),
    ], NOW, { ...data, experiments: data.experiments.map(run => run.id === 'dyn' ? { ...run, spec: { ...run.spec, argv: ['--context', '32k'] } } : run) })
    expect(outcomes.map(status)).toEqual(['added', 'added', 'unknown-run'])
    expect(file.relations.find(item => item.kind === 'compares-with')?.grounds[0]).toMatchObject({
      type: 'run', runId: 'dyn', evidenceId: 'results-dyn', labels: { from: 'dynamic', to: 'full' }, baseline: { runId: 'full', evidenceId: 'results-full', revision: 1 },
    })
    expect(file.relations.find(item => item.kind === 'evaluated-on')?.grounds[0]).toMatchObject({ setting: '32K' })
  })

  it('keeps a person\'s quotation that misses a rule, with the warnings', () => {
    const { outcomes, file } = apply(emptyRelations(), [propose('is-a', moba, full, quote('moba', 'MoBA outperforms full attention on RULER.'), 'user')])
    expect(outcomes[0]).toMatchObject({ status: 'added', warnings: [expect.stringContaining('must say how the two relate')] })
    expect(file.relations[0]?.grounds[0]).toMatchObject({ by: 'user', warnings: [expect.stringContaining('must say how the two relate')] })
  })

  it('does not let a self-reference rest on an introduction whose ground is rejected', () => {
    const intro = propose('introduces', { kind: 'paper', evidenceId: 'moba' }, moba, quote('moba', 'We introduce MoBA, a block attention method.'))
    const { file } = apply(emptyRelations(), [intro])
    const ground = file.relations[0]?.grounds[0]?.id as string
    const rejected = rejectRelation(file, { relation: 'introduces:paper:moba>method:moba', ground, by: 'user' }, NOW).file
    expect(apply(rejected, [propose('evaluated-on', moba, { kind: 'dataset', name: 'LongBench' }, quote('moba', 'We evaluate our method on LongBench.'))]).outcomes.map(status))
      .toEqual(['missing-mention'])
  })

  it('corrects the locator and stores a self-reference\'s introduction', () => {
    const intro = propose('introduces', { kind: 'paper', evidenceId: 'moba' }, moba, quote('moba', 'We introduce MoBA, a block attention method.'))
    const longbench: EntityRef = { kind: 'dataset', name: 'LongBench' }
    const { outcomes, file } = apply(emptyRelations(), [intro, propose('evaluated-on', moba, longbench, { ...quote('moba', 'We evaluate our method on LongBench.'), locator: { page: 4 } })])
    expect(outcomes[1]).toMatchObject({ status: 'added', locatorCorrected: true })
    expect(file.relations.find(item => item.kind === 'evaluated-on')?.grounds[0]).toMatchObject({ locator: { page: 1 }, via: 'introduces:paper:moba>method:moba' })
  })

  it('stops at the relation, ground and entity limits', () => {
    const base = apply(emptyRelations(), [improves]).file
    const relation = base.relations[0] as Relation
    const fullGrounds: RelationsFile = { ...base, relations: [{ ...relation, grounds: Array.from({ length: MAX_GROUNDS }, (_, i) => ({ ...relation.grounds[0] as Relation['grounds'][number], id: `g${i}` })) }] }
    expect(apply(fullGrounds, [improves]).outcomes.map(status)).toEqual(['full'])
    const manyRelations: RelationsFile = { ...base, relations: Array.from({ length: MAX_RELATIONS }, (_, i) => ({ ...relation, id: `r${i}` })) }
    expect(apply(manyRelations, [propose('compares-with', moba, full, quote('moba', 'MoBA outperforms full attention on RULER.'))]).outcomes.map(status)).toEqual(['full'])
    const at = NOW.toISOString()
    const manyEntities: RelationsFile = { ...emptyRelations(), entities: Array.from({ length: MAX_ENTITIES - 1 }, (_, i) => ({ id: `method:m${i}`, kind: 'method' as const, name: `m${i}`, aliases: [], by: 'user' as const, createdAt: at, updatedAt: at })) }
    expect(apply(manyEntities, [improves]).outcomes.map(status)).toEqual(['full'])
  })
})

describe('rejections', () => {
  const base = (): RelationsFile => apply(emptyRelations(), [improves]).file
  const id = 'improves-on:method:moba>method:full-attention'

  it('honours the person\'s rejection against the agent and lets the person restore it', () => {
    const rejected = rejectRelation(base(), { relation: id, by: 'user', reason: '  measured on a\n different task ' }, NOW)
    expect(rejected.result).toMatchObject({ status: 'changed', relation: { rejected: { by: 'user', at: NOW.toISOString(), reason: 'measured on a different task' } } })
    const refused = apply(rejected.file, [improves]).outcomes[0]
    expect([status(refused), said(refused)]).toEqual(['rejected', expect.stringContaining('rejected by the person on 2026-10-01 (measured on a different task)')])
    expect(rejectRelation(rejected.file, { relation: id, by: 'agent' }, NOW).result).toMatchObject({ status: 'unchanged' })
    expect(restoreRelation(rejected.file, { relation: id, by: 'agent' }, NOW).result).toMatchObject({ code: 'not-yours' })
    const restored = restoreRelation(rejected.file, { relation: id, by: 'user' }, later(5))
    expect(restored.result).toMatchObject({ status: 'changed' })
    expect(restored.file.relations[0]?.rejected).toBeUndefined()
    expect(restoreRelation(restored.file, { relation: id, by: 'user' }, NOW).result).toMatchObject({ status: 'unchanged' })
    const byPerson = apply(rejected.file, [{ ...improves, by: 'user' }])
    expect(byPerson.outcomes[0]).toMatchObject({ status: 'added', restored: true })
  })

  it('rejects one ground, which the agent then cannot add again, and treats a relation whose grounds are all rejected as rejected', () => {
    const file = base()
    const ground = (file.relations[0] as Relation).grounds[0]?.id as string
    const rejected = rejectRelation(file, { relation: id, ground, by: 'user', reason: '' }, NOW)
    expect(rejected.file.relations[0]?.grounds[0]?.rejected).toEqual({ by: 'user', at: NOW.toISOString() })
    const refused = apply(rejected.file, [improves]).outcomes[0]
    expect([status(refused), said(refused)]).toEqual(['rejected', expect.stringContaining('This ground was rejected')])
    expect(relationGraph(rejected.file, sample()).relations.get(id)).toMatchObject({ status: 'rejected', confidence: 0 })
    const agentRejected = rejectRelation(file, { relation: id, by: 'agent' }, NOW)
    expect(apply(agentRejected.file, [improves]).outcomes[0]).toMatchObject({ status: 'added', restored: true })
    expect(rejectRelation(file, { relation: 'nope', by: 'user' }, NOW).result).toMatchObject({ code: 'unknown-relation' })
    expect(rejectRelation(file, { relation: id, ground: 'nope', by: 'user' }, NOW).result).toMatchObject({ code: 'unknown-ground' })
  })
})

describe('merging', () => {
  it('moves names, ids, records and relations to the survivor, combining relations and their rejections', () => {
    const data = sample()
    const proposals = [
      propose('improves-on', moba, full, quote('moba', 'MoBA outperforms full attention on RULER.')),
      propose('improves-on', { kind: 'method', name: 'Mixture of Block Attention' }, full, { type: 'quote', evidenceId: 'notes', revision: 1, quote: 'MoBA is a block attention method from Kimi.' }, 'user'),
      propose('introduces', { kind: 'paper', evidenceId: 'moba' }, moba, quote('moba', 'We introduce MoBA, a block attention method.')),
      propose('evaluated-on', moba, { kind: 'dataset', name: 'LongBench' }, quote('moba', 'We evaluate our method on LongBench.')),
      propose('is-a', moba, { kind: 'method', name: 'Mixture of Block Attention' }, { type: 'quote', evidenceId: 'notes', revision: 1, quote: 'MoBA is a block attention method from Kimi.' }, 'user'),
    ]
    let { file } = apply(emptyRelations(), proposals, NOW, data)
    file = rejectRelation(file, { relation: 'improves-on:method:mixture-of-block-attention>method:full-attention', by: 'agent' }, NOW).file
    file = rejectRelation(file, { relation: 'improves-on:method:moba>method:full-attention', by: 'agent' }, later(3)).file
    const merged = mergeEntities(file, { from: 'method:mixture-of-block-attention', into: 'method:moba', by: 'user' }, later(9))
    expect(merged.result).toMatchObject({ status: 'merged', entity: { id: 'method:moba', aliases: ['Mixture of Block Attention'], formerIds: ['method:mixture-of-block-attention'] }, dropped: ['is-a:method:moba>method:mixture-of-block-attention'] })
    const relation = merged.file.relations.find(item => item.id === 'improves-on:method:moba>method:full-attention') as Relation
    expect(relation.grounds).toHaveLength(2)
    expect(relation.rejected).toEqual({ by: 'agent', at: later(3).toISOString() })
    const viaGround = merged.file.relations.find(item => item.kind === 'evaluated-on')?.grounds[0]
    expect(viaGround).toMatchObject({ via: 'introduces:paper:moba>method:moba' })
    expect(apply(merged.file, [propose('improves-on', { id: 'method:mixture-of-block-attention' }, full, quote('moba', 'MoBA outperforms full attention on RULER.'), 'user')]).outcomes[0])
      .toMatchObject({ status: 'added', relation: 'improves-on:method:moba>method:full-attention', restored: true })
  })

  it('prefers the person\'s rejection and renames the self-references of a merged introduction', () => {
    const data = sample()
    const second = literature('moba2', [[{ page: 1 }, MOBA_TEXT]])
    const both = { ...data, evidence: [...data.evidence, second] }
    let { file } = apply(emptyRelations(), [
      propose('introduces', { kind: 'paper', evidenceId: 'moba2' }, moba, quote('moba2', 'We introduce MoBA, a block attention method.')),
      propose('evaluated-on', moba, { kind: 'dataset', name: 'LongBench' }, quote('moba2', 'We evaluate our method on LongBench.')),
      propose('improves-on', moba, full, quote('moba', 'MoBA outperforms full attention on RULER.')),
      propose('improves-on', { kind: 'method', name: 'MoBA v2' }, full, quote('moba', 'MoBA outperforms full attention on RULER.'), 'user'),
    ], NOW, both)
    file = rejectRelation(file, { relation: 'improves-on:method:moba>method:full-attention', by: 'agent' }, later(5)).file
    file = rejectRelation(file, { relation: 'improves-on:method:moba-v2>method:full-attention', by: 'user' }, NOW).file
    const papers = mergeEntities(file, { from: 'paper:moba2', into: 'paper:moba', by: 'user' }, NOW)
    expect(papers.result).toMatchObject({ status: 'refused', code: 'unknown-entity' })
    const withPaper = apply(file, [propose('introduces', { kind: 'paper', evidenceId: 'moba' }, moba, quote('moba', 'We introduce MoBA, a block attention method.'))], NOW, both).file
    const mergedPapers = mergeEntities(withPaper, { from: 'paper:moba2', into: 'paper:moba', by: 'user' }, NOW)
    expect(mergedPapers.result).toMatchObject({ status: 'merged', entity: { evidenceIds: ['moba', 'moba2'] } })
    expect(mergedPapers.file.relations.find(item => item.kind === 'evaluated-on')?.grounds[0]).toMatchObject({ via: 'introduces:paper:moba>method:moba' })
    const methods = mergeEntities(withPaper, { from: 'method:moba-v2', into: 'method:moba', by: 'user' }, NOW)
    expect(methods.file.relations.find(item => item.id === 'improves-on:method:moba>method:full-attention')?.rejected).toMatchObject({ by: 'user' })
    const reversed = mergeEntities(withPaper, { from: 'method:moba', into: 'method:moba-v2', by: 'user' }, NOW)
    expect(reversed.file.relations.find(item => item.id === 'improves-on:method:moba-v2>method:full-attention')?.rejected).toMatchObject({ by: 'user' })
  })

  it('refuses a merge of an entity into itself or another kind', () => {
    const { file } = apply(emptyRelations(), [improves, propose('evaluated-on', moba, ruler, quote('moba', 'MoBA is evaluated on RULER at 128K.'))])
    expect(mergeEntities(file, { from: 'method:moba', into: 'method:moba', by: 'user' }, NOW).result).toMatchObject({ code: 'self-relation' })
    expect(mergeEntities(file, { from: 'method:moba', into: 'dataset:ruler', by: 'user' }, NOW).result).toMatchObject({ code: 'kind-mismatch' })
    expect(mergeEntities(file, { from: 'nope', into: 'method:moba', by: 'user' }, NOW).result).toMatchObject({ code: 'unknown-entity' })
  })

  it('keeps the survivor\'s earlier creation time and its alias limit', () => {
    const at = (s: number): string => later(s).toISOString()
    const entity = (id: string, name: string, aliases: string[], created: number): RelationEntity => ({ id, kind: 'method', name, aliases, by: 'user', createdAt: at(created), updatedAt: at(created) })
    const relation = (id: string, from: string, created: number): Relation => ({
      id, kind: 'compares-with', from, to: 'method:c', by: 'user', createdAt: at(created), updatedAt: at(created),
      grounds: [{ id: `g-${id}`, type: 'citation', provider: 'openalex', citing: 'W1', cited: 'W2', at: at(created) }],
    })
    const file: RelationsFile = {
      ...emptyRelations(),
      entities: [entity('method:a', 'A', Array.from({ length: 16 }, (_, i) => `a${i}`), 0), entity('method:b', 'B', [], 0), entity('method:c', 'C', [], 0)],
      relations: [relation('compares-with:method:a>method:c', 'method:a', 10), relation('compares-with:method:b>method:c', 'method:b', 2)],
    }
    const merged = mergeEntities(file, { from: 'method:b', into: 'method:a', by: 'user' }, later(20))
    expect(merged.result.status === 'merged' ? merged.result.entity.aliases : []).not.toContain('B')
    expect(merged.file.relations[0]).toMatchObject({ createdAt: at(2), grounds: [{ id: 'g-compares-with:method:a>method:c' }, { id: 'g-compares-with:method:b>method:c' }] })
    const [kept, moved] = file.relations as [Relation, Relation]
    const bothRejected: RelationsFile = { ...file, relations: [{ ...kept, rejected: { by: 'agent', at: at(1) } }, { ...moved, rejected: { by: 'agent', at: at(4), reason: 'later' } }] }
    expect(mergeEntities(bothRejected, { from: 'method:b', into: 'method:a', by: 'user' }, later(20)).file.relations[0]?.rejected).toEqual({ by: 'agent', at: at(4), reason: 'later' })
  })

  it('suggests acronym and one-letter-apart pairs within a kind', () => {
    const at = NOW.toISOString()
    const entity = (id: string, kind: RelationEntity['kind'], name: string, aliases: string[] = []): RelationEntity => ({ id, kind, name, aliases, by: 'user', createdAt: at, updatedAt: at, ...kind === 'paper' ? { evidenceIds: ['p'] } : {} })
    const file: RelationsFile = {
      ...emptyRelations(),
      entities: [
        entity('method:moe', 'method', 'MoE'), entity('method:mixture-of-experts', 'method', 'mixture of experts'), entity('task:moe', 'task', 'MoE'),
        entity('method:longformer', 'method', 'Longformer'), entity('method:longfromer', 'method', 'Lngformer', ['Long-former']), entity('method:nsa', 'method', 'NSA'),
        entity('method:native', 'method', 'Native Sparse Attention'), entity('paper:p', 'paper', 'MoE paper'), entity('method:abc', 'method', 'abcdefgh'), entity('method:abd', 'method', 'abcdefgx'),
      ],
    }
    expect(mergeSuggestions(file)).toEqual([
      { a: 'method:mixture-of-experts', b: 'method:moe', reason: 'acronym', names: ['mixture of experts', 'MoE'] },
      { a: 'method:longformer', b: 'method:longfromer', reason: 'spelling', names: ['Longformer', 'Lngformer'] },
      { a: 'method:native', b: 'method:nsa', reason: 'acronym', names: ['Native Sparse Attention', 'NSA'] },
      { a: 'method:abc', b: 'method:abd', reason: 'spelling', names: ['abcdefgh', 'abcdefgx'] },
    ])
  })
})

describe('the derived view and staleness', () => {
  it('reads a ground on a changed source as outdated and its relation as stale, the way claims are', () => {
    const { file } = apply(emptyRelations(), [improves])
    const data = sample()
    const changed = { ...data, evidence: data.evidence.map(record => record.id === 'moba' ? { ...record, revision: 2 } : record) }
    const view = relationGraph(file, changed).relations.get('improves-on:method:moba>method:full-attention')
    expect(view).toMatchObject({ status: 'stale', confidence: 0.45, grounds: [{ status: 'outdated', source: 'full-text', weight: 0.45 }] })
    const gone = relationGraph(file, { ...data, evidence: data.evidence.filter(record => record.id !== 'moba') })
    expect(gone.relations.get('improves-on:method:moba>method:full-attention')?.grounds[0]).toMatchObject({ status: 'outdated', title: 'moba' })
    expect(relationGraph(file, data).relations.get('improves-on:method:moba>method:full-attention')).toMatchObject({ status: 'active', confidence: 0.9 })
    expect(relationGraph(file, data, { ...RELATION_TUNING, fullText: 0.5 }).relations.get('improves-on:method:moba>method:full-attention')?.confidence).toBe(0.5)
  })

  it('combines sources by noisy-or, counts one source once, and classifies abstract, file, run and citation grounds', () => {
    const data = sample()
    const { file } = apply(emptyRelations(), [
      improves,
      propose('improves-on', moba, full, quote('moba', 'MoBA outperforms full attention')),
      propose('compares-with', moba, full, { type: 'quote', evidenceId: 'notes', revision: 1, quote: 'MoBA is a block attention method from Kimi.' }, 'user'),
      propose('compares-with', moba, full, { type: 'run', runId: 'dyn', from: 'moba', to: 'full', baselineRunId: 'full' }),
    ], NOW, { ...data, experiments: data.experiments.map(run => run.id === 'dyn' ? { ...run, spec: { ...run.spec, name: 'ruler-moba' } } : run) })
    const graph = relationGraph(file, { ...data, experiments: data.experiments.map(run => run.id === 'dyn' ? { ...run, spec: { ...run.spec, name: 'ruler-moba' } } : run) })
    expect(graph.relations.get('improves-on:method:moba>method:full-attention')?.confidence).toBe(0.9)
    expect(graph.relations.get('compares-with:method:moba>method:full-attention')).toMatchObject({
      confidence: 0.97, grounds: [{ source: 'file', title: 'NOTES: A Paper About notes' }, { source: 'run', title: 'ruler-moba · seed 1' }],
    })
    expect(graph.touching.get('method:moba')?.map(view => view.relation.id)).toEqual(['compares-with:method:moba>method:full-attention', 'improves-on:method:moba>method:full-attention'])
    const unknownRun = relationGraph(file, { ...data, experiments: [] })
    expect(unknownRun.relations.get('compares-with:method:moba>method:full-attention')?.grounds[1]?.title).toBe('dyn')
    const staleBaseline = relationGraph(file, { ...data, evidence: data.evidence.map(record => record.id === 'results-full' ? { ...record, stale: true } : record) })
    expect(staleBaseline.relations.get('compares-with:method:moba>method:full-attention')?.grounds[1]?.status).toBe('outdated')
    const abstract = apply(emptyRelations(), [propose('evaluated-on', moba, ruler, { type: 'quote', evidenceId: 'lone', revision: 1, quote: 'MoBA is evaluated on RULER here.' })])
    expect(abstract.outcomes.map(status)).toEqual(['added'])
    expect(relationGraph(abstract.file, data).relations.get('evaluated-on:method:moba>dataset:ruler')?.grounds[0]).toMatchObject({ source: 'abstract', weight: 0.8 })
  })

  it('lapses a self-referring ground when its introduction is rejected, and a citation when a paper is gone', () => {
    const data = sample()
    const { file } = apply(emptyRelations(), [
      propose('introduces', { kind: 'paper', evidenceId: 'moba' }, moba, quote('moba', 'We introduce MoBA, a block attention method.')),
      propose('evaluated-on', moba, { kind: 'dataset', name: 'LongBench' }, quote('moba', 'We evaluate our method on LongBench.')),
    ])
    const rejected = rejectRelation(file, { relation: 'introduces:paper:moba>method:moba', by: 'user' }, NOW).file
    expect(relationGraph(rejected, data).relations.get('evaluated-on:method:moba>dataset:longbench')).toMatchObject({ status: 'stale' })
    const cited = applyCitationWorks(file, data, [{ evidenceId: 'moba', provider: 'crossref', doi: '10.1000/moba', references: ['10.1000/nsa'], fetchedAt: NOW.toISOString() }], NOW)
    const withNsaDoi = { ...data, evidence: data.evidence.map(record => record.id === 'nsa' ? { ...record, doi: '10.1000/NSA' } : record) }
    const citing = applyCitationWorks(file, withNsaDoi, [{ evidenceId: 'moba', provider: 'crossref', doi: '10.1000/moba', references: ['10.1000/nsa'], fetchedAt: NOW.toISOString() }], NOW)
    expect(cited.result.added).toBe(0)
    expect(citing.result.added).toBe(1)
    const graph = relationGraph(citing.file, { ...withNsaDoi, evidence: withNsaDoi.evidence.filter(record => record.id !== 'nsa') })
    expect(graph.entities.get('paper:nsa')?.status).toBe('orphaned')
    expect(graph.relations.get('cites:paper:moba>paper:nsa')).toMatchObject({ status: 'stale', grounds: [{ status: 'outdated', source: 'citation', title: 'MOBA: A Paper About moba' }] })
  })

  it('moves quotations that still hold in a new revision and counts those that lapse', () => {
    const data = sample()
    const { file } = apply(emptyRelations(), [
      improves,
      propose('introduces', { kind: 'paper', evidenceId: 'moba' }, moba, quote('moba', 'We introduce MoBA, a block attention method.')),
      propose('evaluated-on', moba, { kind: 'dataset', name: 'LongBench' }, quote('moba', 'We evaluate our method on LongBench.')),
      propose('evaluated-on', moba, ruler, quote('moba', 'MoBA is evaluated on RULER at 128K.')),
      propose('is-a', moba, { kind: 'method', name: 'block attention' }, quote('moba', 'We introduce MoBA, a block attention method.')),
    ])
    const dropped = rejectRelation(rejectRelation(file, { relation: 'is-a:method:moba>method:block-attention', by: 'user' }, NOW).file,
      { relation: 'evaluated-on:method:moba>dataset:ruler', ground: file.relations.find(item => item.id === 'evaluated-on:method:moba>dataset:ruler')?.grounds[0]?.id, by: 'user' }, NOW).file
    const revised = { ...data, evidence: data.evidence.map(record => record.id === 'moba' ? { ...record, revision: 2, chunks: [{ locator: { page: 3 }, text: 'We introduce MoBA, a block attention method. We evaluate our method on LongBench.' }] } : record) }
    const edit = regroundRelations(dropped, revised, later(60))
    expect(edit.result).toEqual({ regrounded: 2, lapsed: 1 })
    expect(edit.file.relations.find(item => item.kind === 'evaluated-on' && item.to === 'dataset:longbench')?.grounds[0]).toMatchObject({ revision: 2, locator: { page: 3 }, via: 'introduces:paper:moba>method:moba' })
    expect(relationGraph(edit.file, revised).relations.get('improves-on:method:moba>method:full-attention')?.status).toBe('stale')
    expect(regroundRelations(edit.file, revised, later(61)).result).toEqual({ regrounded: 0, lapsed: 1 })
    const notes = apply(emptyRelations(), [propose('compares-with', moba, full, { type: 'quote', evidenceId: 'notes', revision: 1, quote: 'MoBA is a block attention method from Kimi.' }, 'user')]).file
    const notesRevised = { ...data, evidence: data.evidence.map(record => record.id === 'notes' ? { ...record, revision: 2, chunks: [{ locator: { line: 1 }, text: 'MoBA is a block attention method from Kimi, compared with full attention.' }] } : record) }
    expect(regroundRelations(notes, notesRevised, NOW).file.relations[0]?.grounds[0]).not.toHaveProperty('via')
    expect(regroundRelations(notes, { ...data, evidence: data.evidence.map(record => record.id === 'notes' ? { ...record, revision: 2, stale: true } : record) }, NOW).result).toEqual({ regrounded: 0, lapsed: 0 })
    // Before re-grounding, the introduction is stale, so "our method" cannot stand for MoBA; proposing the introduction again moves it.
    const selfReference = propose('evaluated-on', moba, { kind: 'dataset', name: 'LongBench' }, quote('moba', 'We evaluate our method on LongBench.', 2))
    expect(applyProposals(file, revised, [selfReference], NOW).result.map(status)).toEqual(['missing-mention'])
    const introduction = propose('introduces', { kind: 'paper', evidenceId: 'moba' }, moba, quote('moba', 'We introduce MoBA, a block attention method.', 2))
    expect(applyProposals(file, revised, [introduction, selfReference], NOW).result.map(status)).toEqual(['regrounded', 'regrounded'])
  })
})

describe('citations', () => {
  const data = (): RelationProject => sample()

  it('asks for the papers without a fresh cached list, by DOI or OpenAlex work', () => {
    const file: RelationsFile = { ...emptyRelations(), citations: [
      { evidenceId: 'nsa', provider: 'openalex', work: 'W200', references: [], fetchedAt: NOW.toISOString() },
    ] }
    expect(citationQueries(file, data(), later(10), 30)).toEqual([{ evidenceId: 'moba', doi: '10.1000/moba' }])
    expect(citationQueries(file, data(), new Date(NOW.getTime() + 31 * 86_400_000), 30)).toEqual([
      { evidenceId: 'moba', doi: '10.1000/moba' }, { evidenceId: 'nsa', openalex: 'W200' },
    ])
    expect(citationQueries(emptyRelations(), { evidence: [literature('x', [], { doi: 'not a doi', sourceUrl: 'https://example.org/x' })] }, NOW, 30)).toEqual([])
    const cachedDoi: RelationsFile = { ...emptyRelations(), citations: [{ evidenceId: 'x', provider: 'crossref', doi: '10.1/x', references: [], fetchedAt: '2020-01-01T00:00:00.000Z' }] }
    expect(citationQueries(cachedDoi, { evidence: [literature('x', [])] }, NOW, 30)).toEqual([{ evidenceId: 'x', doi: '10.1/x' }])
  })

  it('fetches OpenAlex fifty papers a request, pauses between requests, and falls back to Crossref', async () => {
    const urls: string[] = []
    const sleeps: number[] = []
    const papers = Array.from({ length: 51 }, (_, i) => ({ evidenceId: `p${i}`, doi: `10.1000/p${i}` }))
    const get: JsonGetter = (url) => {
      urls.push(url)
      if (url === 'https://api.crossref.org/works/10.1000%2Fp1') return Promise.resolve({ message: { reference: [{ DOI: '10.1000/P0' }, {}, { DOI: 'junk' }] } })
      if (url === 'https://api.crossref.org/works/10.1000%2Fp2') return Promise.reject(new Error('HTTP 503'))
      if (url.startsWith('https://api.crossref.org')) return Promise.resolve({ message: {} })
      if (url.includes('openalex:')) return Promise.resolve({ results: [{ id: 'https://openalex.org/W9', doi: null, referenced_works: ['https://openalex.org/W1'] }] })
      if (url.includes('p50')) return Promise.reject(new Error('HTTP 429'))
      return Promise.resolve({
        results: [
          { id: 'https://openalex.org/W100', doi: 'https://doi.org/10.1000/P0', referenced_works: ['https://openalex.org/W101', 'nonsense'] },
          { id: 'https://openalex.org/W101', doi: 'https://doi.org/10.1000/p1', referenced_works: [] },
          { id: 'https://openalex.org/W102', doi: 'https://doi.org/10.1000/p2' },
          { id: 'https://openalex.org/W999', doi: 'https://doi.org/10.1000/unknown', referenced_works: [] },
          { id: 'not-a-work', doi: 'https://doi.org/10.1000/p3', referenced_works: [] },
        ],
      })
    }
    const sleep = (ms: number): Promise<void> => { sleeps.push(ms); return Promise.resolve() }
    const fetcher = createCitationFetcher(get, { pauseMs: 120, sleep, now: () => NOW })
    const { works, failures } = await fetcher.fetch([...papers, { evidenceId: 'w', openalex: 'W9' }], new AbortController().signal)
    expect(urls[0]).toBe(`https://api.openalex.org/works?filter=doi:${papers.slice(0, 50).map(paper => paper.doi).join('|')}&select=id,doi,referenced_works&per-page=50`)
    expect(urls[1]).toContain('filter=doi:10.1000/p50&')
    expect(urls[2]).toBe('https://api.openalex.org/works?filter=openalex:W9&select=id,doi,referenced_works&per-page=50')
    expect(sleeps.every(ms => ms === 120) && sleeps.length === urls.length - 1).toBe(true)
    expect(works.map(work => [work.evidenceId, work.provider, work.work ?? '', work.references.join(',')])).toEqual([
      ['p0', 'openalex', 'W100', 'W101'], ['p1', 'openalex', 'W101', ''], ['p2', 'openalex', 'W102', ''], ['w', 'openalex', 'W9', 'W1'],
      ['p1', 'crossref', '', '10.1000/p0'],
    ])
    expect(failures).toEqual(['OpenAlex lookup of 1 papers by doi failed: HTTP 429', 'Crossref lookup of 10.1000/p2 failed: HTTP 503'])
    expect(urls.filter(url => url.startsWith('https://api.crossref.org')).length).toBe(51 - 3 + 2)
  })

  it('records citations among the project\'s papers, matched by work id or DOI, once', () => {
    const works: CitationWork[] = [
      { evidenceId: 'moba', provider: 'openalex', work: 'W100', doi: '10.1000/moba', references: ['W200', 'W200', 'W100', 'W999'], fetchedAt: NOW.toISOString() },
      { evidenceId: 'nsa', provider: 'openalex', work: 'W200', references: ['W100'], fetchedAt: NOW.toISOString() },
      { evidenceId: 'gone', provider: 'openalex', work: 'W300', references: ['W100'], fetchedAt: NOW.toISOString() },
      { evidenceId: 'nsa', provider: 'crossref', doi: '10.1000/nsa', references: ['10.1000/moba'], fetchedAt: NOW.toISOString() },
    ]
    const first = applyCitationWorks(emptyRelations(), data(), works, NOW)
    expect(first.result).toEqual({ works: 4, added: 3, unchanged: 0, rejected: 0 })
    expect(first.file.relations.map(item => [item.id, item.grounds.map(ground => ground.type === 'citation' ? ground.provider : '')])).toEqual([
      ['cites:paper:moba>paper:nsa', ['openalex']], ['cites:paper:nsa>paper:moba', ['crossref', 'openalex']],
    ])
    expect(applyCitationWorks(first.file, data(), [], NOW).result).toEqual({ works: 4, added: 0, unchanged: 3, rejected: 0 })
    const rejected = rejectRelation(first.file, { relation: 'cites:paper:moba>paper:nsa', by: 'user' }, NOW).file
    const groundRejected = rejectRelation(rejected, { relation: 'cites:paper:nsa>paper:moba', ground: first.file.relations[1]?.grounds[1]?.id, by: 'user' }, NOW).file
    expect(applyCitationWorks(groundRejected, data(), [], NOW).result).toEqual({ works: 4, added: 0, unchanged: 1, rejected: 2 })
    const anonymous = applyCitationWorks(emptyRelations(), data(), [{ evidenceId: 'nsa', provider: 'crossref', references: ['10.1000/moba'], fetchedAt: NOW.toISOString() }], NOW)
    expect(anonymous.file.relations[0]?.grounds[0]).toMatchObject({ type: 'citation', citing: 'nsa', cited: '10.1000/moba' })
  })

  it('stops at the relation and ground limits', () => {
    const works: CitationWork[] = [{ evidenceId: 'moba', provider: 'openalex', work: 'W100', references: ['W200'], fetchedAt: NOW.toISOString() }, { evidenceId: 'nsa', provider: 'openalex', work: 'W200', references: [], fetchedAt: NOW.toISOString() }]
    const at = NOW.toISOString()
    const filler: Relation = { id: 'r', kind: 'compares-with', from: 'method:a', to: 'method:b', grounds: [{ id: 'g', type: 'citation', provider: 'openalex', citing: 'W1', cited: 'W2', at }], by: 'user', createdAt: at, updatedAt: at }
    const entities: RelationEntity[] = ['method:a', 'method:b'].map(id => ({ id, kind: 'method', name: id, aliases: [], by: 'user', createdAt: at, updatedAt: at }))
    const crowded: RelationsFile = { ...emptyRelations(), entities, relations: Array.from({ length: MAX_RELATIONS }, (_, i) => ({ ...filler, id: `r${i}` })) }
    expect(applyCitationWorks(crowded, data(), works, NOW).result.added).toBe(0)
    const seeded = applyCitationWorks(emptyRelations(), data(), works, NOW).file
    const cites = seeded.relations[0] as Relation
    const fullGrounds: RelationsFile = { ...seeded, relations: [{ ...cites, grounds: Array.from({ length: MAX_GROUNDS }, (_, i) => ({ ...filler.grounds[0] as Relation['grounds'][number], id: `x${i}` })) }] }
    expect(applyCitationWorks(fullGrounds, data(), [{ ...works[0] as CitationWork, provider: 'crossref', doi: '10.1000/moba', references: ['10.1000/nsa'] }], NOW).result.added).toBe(0)
  })
})

describe('ids', () => {
  it('names a relation by its kind and ends', () => {
    expect(relationId('cites', 'paper:a', 'paper:b')).toBe('cites:paper:a>paper:b')
  })
})
