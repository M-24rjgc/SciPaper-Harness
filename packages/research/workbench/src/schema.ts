/** Validation for durable records and incoming research commands. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { CheckId, ProjectId, ResearchProject, ResearchPreferences, ResearchTask } from './types.ts'

const id = z.string().min(1)
const integer = z.number().int().nonnegative()

export const locatorSchema = z.object({
  page: integer.optional(),
  paragraph: integer.optional(),
  line: integer.optional(),
  key: z.string().optional(),
})
export const evidenceLinkSchema = z.object({ evidenceId: id, revision: integer, locator: locatorSchema, quote: z.string() })
export const artifactKinds = ['manuscript', 'diagram', 'figure', 'code', 'bibliography', 'supplement', 'image'] as const
export const autonomies = ['checkpoints', 'automatic'] as const
/** The base checks; mode packs add gates under their own ids. */
export const checkIds = ['cite', 'numbers', 'placeholders', 'figures', 'compile', 'visual', 'review', 'stale', 'claims', 'structure'] as const satisfies readonly CheckId[]
const dependency = z.object({ id, revision: integer })

export const experimentSpecSchema = z.object({
  environmentId: id,
  name: z.string().min(1),
  argv: z.array(z.string()).min(1),
  cwd: z.string(),
  seed: integer,
  maxSeconds: z.number().int().positive(),
  gpuIds: z.array(z.string()),
  dataEvidenceIds: z.array(id),
  codeArtifactIds: z.array(id),
  codePaths: z.array(z.string().min(1)).max(50).optional(),
  metricsPath: z.string().min(1),
})
export const environmentSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['uv', 'existing', 'conda']),
  target: z.enum(['local', 'ssh']),
  python: z.string(),
  sshHost: z.string().optional(),
  remoteRoot: z.string().optional(),
  requirements: z.array(z.string()),
  isDefault: z.boolean(),
})
export const claimSchema = z.object({
  id,
  text: z.string().min(1),
  kind: z.enum(['hypothesis', 'method', 'literature', 'empirical']),
  state: z.enum(['proposed', 'supported', 'contradicted', 'stale']),
  evidence: z.array(evidenceLinkSchema),
  artifactIds: z.array(id),
})
export const literatureSchema = z.object({
  id,
  provider: z.enum(['crossref', 'openalex', 'arxiv']),
  title: z.string().min(1),
  authors: z.array(z.string()),
  year: integer.optional(),
  doi: z.string().optional(),
  url: z.url(),
  abstract: z.string(),
  bibtex: z.string(),
})
const model = z.object({ provider: id, model: id })
/** Unknown keys (such as a free-form `credentialRef` from earlier versions) are dropped on parse. */
export const preferencesSchema = z.object({
  main: model.optional(),
  vision: model.optional(),
  image: z.object({
    baseUrl: z.url(), model: id, size: id,
    quality: z.enum(['low', 'medium', 'high', 'auto']).optional(), apiStyle: z.enum(['images', 'chat']).optional(),
  }).optional(),
  embedding: z.object({ baseUrl: z.url(), model: id }).optional(),
  python: z.string().optional(),
  uv: z.string().optional(),
  texBin: z.string().optional(),
}) satisfies z.ZodType<ResearchPreferences>

const evidenceSchema = z.object({
  id, title: z.string(), kind: z.enum(['file', 'literature', 'experiment']), path: z.string(),
  originalPath: z.string().optional(), sha256: id, revision: integer, importedAt: id,
  chunks: z.array(z.object({ text: z.string(), locator: locatorSchema })),
  sourceUrl: z.string().optional(), doi: z.string().optional(), fullTextPath: z.string().optional(),
  coverage: z.enum(['full-text', 'abstract', 'metadata', 'data']),
  verified: z.boolean(), stale: z.boolean(),
})
const artifactSchema = z.object({
  id, path: id, kind: z.enum(artifactKinds), revision: integer, sha256: id,
  evidence: z.array(evidenceLinkSchema), claimIds: z.array(id), inputArtifacts: z.array(dependency),
  stale: z.boolean(), updatedAt: id, author: z.enum(['user', 'agent', 'experiment']),
})
const experimentSchema = z.object({
  id, spec: experimentSpecSchema,
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown']),
  createdAt: id, updatedAt: id, directory: id, inputRevision: integer, environmentFingerprint: z.string(),
  metrics: z.record(z.string(), z.number()),
  exitCode: z.number().int().optional(), message: z.string(), snapshotPath: z.string(), collected: z.boolean(),
  startedAt: id.optional(), finishedAt: id.optional(),
  observeFailures: integer.optional(), nextObserveAt: z.number().optional(),
})
const compilationSchema = z.object({
  artifactId: id, artifactRevision: integer, inputDigest: id,
  engine: z.enum(['pdflatex', 'xelatex', 'lualatex']),
  status: z.enum(['completed', 'failed']),
  pdfPath: z.string(), logPath: z.string(), diagnostics: z.array(z.string()), createdAt: id,
})
const visualReviewSchema = z.object({
  artifactId: id, artifactRevision: integer,
  status: z.enum(['not-configured', 'pending', 'reviewed', 'failed', 'rendered']),
  inputDigest: z.string().optional(),
  sessionId: z.string().optional(), findings: z.string(), createdAt: id,
})
const decisionSchema = z.object({
  id, question: z.string().min(1), answer: z.string().min(1), by: z.enum(['user', 'agent']), rationale: z.string(), at: id,
})
// Mode, route, phase and check ids are stored as plain strings: which packs are
// installed is the registry's business, and a record must still open when a
// pack it names has gone.
const findingSchema = z.object({
  check: id, severity: z.enum(['error', 'warning']), message: z.string(),
  file: z.string().optional(), line: integer.optional(),
})
const checkReportSchema = z.object({
  clean: z.boolean(), scope: z.string(), mode: z.string().optional(), route: z.string().optional(),
  phases: z.array(z.object({ id, done: z.boolean(), missing: z.array(z.string()) })),
  findings: z.array(findingSchema), checkedAt: id,
})

const projectSchema = z.object({
  id, workspaceId: id, title: id, root: id,
  mode: id, route: z.string().optional(), venue: z.string().optional(),
  modeReason: z.string().optional(), modeSetBy: z.enum(['user', 'agent']).optional(),
  autonomy: z.enum(autonomies), brief: z.string(),
  revision: integer, researchRevision: integer,
  createdAt: id, updatedAt: id,
  evidence: z.array(evidenceSchema),
  claims: z.array(claimSchema),
  artifacts: z.array(artifactSchema),
  decisions: z.array(decisionSchema),
  environments: z.array(environmentSchema.extend({ id, fingerprint: z.string(), status: z.enum(['pending', 'ready', 'failed']), details: z.string() })),
  experiments: z.array(experimentSchema),
  compilations: z.array(compilationSchema),
  visualReviews: z.array(visualReviewSchema),
  lastCheck: checkReportSchema.optional(),
  sessionId: z.string().optional(),
})

/**
 * Carry a stored record of any earlier shape into the current one. Each step
 * leaves current-shape records untouched, so the chain can run on every read.
 * @param value - one stored project document.
 * @returns the document in the current shape, still to be validated.
 */
export function migrateProject(value: unknown): unknown {
  return migrateModes(migrateStages(value))
}

/** Modes that were built into the service before modes became packs. */
const LEGACY_MODES: Record<string, { mode: string; route?: string }> = {
  'paper-first': { mode: 'spark-to-paper', route: 'proposal' },
  'from-results': { mode: 'spark-to-paper', route: 'data' },
  'free': { mode: 'general' },
}

/**
 * Map a built-in mode onto the pack that succeeded it: both pipelines were
 * spark-to-paper's routes all along, and an unrouted or free project is a
 * general one. Its last check named phases of the old pipeline, so it goes;
 * the next check writes a new one.
 */
function migrateModes(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  const mode = typeof record.mode === 'string' ? record.mode : undefined
  if (mode !== undefined && !Object.hasOwn(LEGACY_MODES, mode)) return value
  const { lastCheck: _lastCheck, ...rest } = record
  return { ...rest, ...(mode === undefined ? { mode: 'general' } : LEGACY_MODES[mode]) }
}

/**
 * Version 1 drove a stage machine: its stages, pending prompt, pause flag and
 * experiment budget have no successor, and settled stage confirmations become
 * user decisions so nothing the user decided is lost.
 */
function migrateStages(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('stages' in value)) return value
  const legacy = value as Record<string, unknown> & {
    mode?: string
    stages?: { id: string; summary?: string; confirmedAt?: string; confirmedRevision?: number }[]
  }
  const { stages, pendingPrompt: _pending, paused: _paused, budget: _budget, mode, ...rest } = legacy
  const decisions = (stages ?? [])
    .filter(stage => stage.confirmedRevision !== undefined)
    .map(stage => ({
      id: `stage-${stage.id}`,
      question: `Confirm the ${stage.id} proposal`,
      answer: stage.summary?.trim() || 'Confirmed',
      by: 'user' as const,
      rationale: '',
      at: stage.confirmedAt ?? (typeof rest.updatedAt === 'string' ? rest.updatedAt : new Date(0).toISOString()),
    }))
  return {
    ...rest,
    ...(mode === 'spark' ? { mode: 'paper-first', modeSetBy: 'user' } : mode === 'evidence' ? { mode: 'from-results', modeSetBy: 'user' } : {}),
    autonomy: 'checkpoints',
    decisions,
  }
}

const initialPreferences: ResearchPreferences = {}

/**
 * Research metadata is committed as one record to keep graph mutations atomic.
 * The format version stays 1: the single-document layout rejects any other
 * stamped version on open, so earlier records are carried forward by the
 * table schema's {@link migrateProject} step and rewritten on the next save.
 */
export const researchDomain = defineDomain({
  name: 'research_workbench', version: 1,
  global: { schema: preferencesSchema, initial: initialPreferences },
  tables: {
    projects: domainTable<ProjectId, ResearchProject>(z.preprocess(migrateProject, projectSchema) as unknown as z.ZodType<ResearchProject>),
    tasks: domainTable<string, ResearchTask>(z.object({
      id, kind: id, projectId: id.optional(),
      status: z.enum(['running', 'completed', 'failed', 'interrupted']),
      message: z.string(), createdAt: id, result: z.unknown().optional(),
    }) as unknown as z.ZodType<ResearchTask>),
  },
})

const base = { projectId: id }
const artifact = {
  path: id, kind: z.enum(artifactKinds),
  evidence: z.array(evidenceLinkSchema).default([]),
  claimIds: z.array(id).default([]),
  inputArtifacts: z.array(dependency).default([]),
}
const runRef = { ...base, runId: id }

export const commandSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('set-mode'), mode: id, route: id.optional(), reason: z.string().optional() }),
  z.object({ ...base, action: z.literal('set-autonomy'), autonomy: z.enum(autonomies) }),
  z.object({
    ...base, action: z.literal('record-decision'), question: z.string().trim().min(1), answer: z.string().trim().min(1),
    rationale: z.string().optional(), decidedBy: z.enum(['user', 'agent']).optional(),
  }),
  z.object({ ...base, action: z.literal('check'), scope: z.string().optional() }),
  z.object({ ...base, action: z.literal('import'), paths: z.array(id).min(1).max(100) }),
  z.object({ ...base, action: z.literal('import-template'), paths: z.array(id).min(1).max(20) }),
  z.object({ ...base, action: z.literal('refresh-evidence'), evidenceId: id }),
  z.object({ ...base, action: z.literal('search-evidence'), query: id }),
  z.object({ ...base, action: z.literal('literature-search'), query: id, provider: z.enum(['crossref', 'openalex', 'arxiv']) }),
  z.object({ ...base, action: z.literal('literature-import'), item: literatureSchema }),
  z.object({ ...base, action: z.literal('claim'), claim: claimSchema }),
  z.object({ ...base, ...artifact, action: z.literal('save-artifact'), content: z.string(), expectedRevision: integer.optional() }),
  z.object({ ...base, ...artifact, action: z.literal('register-artifact') }),
  z.object({ ...base, action: z.literal('read-artifact'), artifactId: id }),
  z.object({ ...base, action: z.literal('environment'), environment: environmentSchema }),
  z.object({ ...base, action: z.literal('experiment'), spec: experimentSpecSchema, requestId: z.uuid() }),
  z.object({ ...runRef, action: z.literal('experiment-refresh') }),
  z.object({ ...runRef, action: z.literal('experiment-cancel') }),
  z.object({ ...runRef, action: z.literal('experiment-dismiss') }),
  z.object({ ...runRef, action: z.literal('experiment-logs') }),
  z.object({ ...base, action: z.literal('experiment-wait'), runIds: z.array(id).min(1).max(20), timeoutSeconds: z.number().int().min(1).max(1800) }),
  z.object({ ...base, action: z.literal('compile'), artifactId: id.optional(), path: id.optional(), engine: z.enum(['pdflatex', 'xelatex', 'lualatex']) }),
  z.object({ ...base, action: z.literal('render-pages'), artifactId: id.optional(), maxPages: z.number().int().min(1).max(60).optional() }),  z.object({ ...base, action: z.literal('visual-review'), artifactId: id }),
  z.object({ ...base, action: z.literal('complete-visual-review'), artifactId: id, artifactRevision: integer, sessionId: id, findings: id }),
  z.object({
    ...base, action: z.literal('generate-image'), prompt: id, path: id,
    size: z.string().regex(/^(\d{3,4}x\d{3,4}|auto)$/, 'a size such as 1536x1024, or auto').optional(),
    quality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
    background: z.enum(['transparent', 'opaque', 'auto']).optional(),
    references: z.array(id).max(4).optional(),
  }),
  z.object({
    ...base, action: z.literal('fetch-reference-figures'),
    arxivIds: z.array(z.string().regex(/^\d{4}\.\d{4,5}(v\d+)?$/, 'a new-style arXiv identifier such as 1706.03762')).min(1).max(6),
    label: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase words joined by hyphens'),
  }),
  z.object({ ...base, action: z.literal('run-script'), script: id, args: z.array(z.string()).max(40).optional() }),
  z.object({ ...base, action: z.literal('export') }),
  z.object({ ...base, action: z.literal('list-venues'), query: z.string().optional() }),
  z.object({ ...base, action: z.literal('apply-template'), venue: id, stage: z.enum(['review', 'final']).optional() }),
  z.object({ ...base, action: z.literal('graph-status') }),
  z.object({ ...base, action: z.literal('recall'), query: id, topK: z.number().int().min(1).max(20).optional(), path: id.optional() }),
  z.object({ ...base, action: z.literal('novelty'), story: id.optional(), path: id.optional() }),
  z.object({ ...base, action: z.literal('build-graph'), papers: id, domain: id }),
  z.object({ ...base, action: z.literal('name-patterns'), names: id.optional() }),
])
