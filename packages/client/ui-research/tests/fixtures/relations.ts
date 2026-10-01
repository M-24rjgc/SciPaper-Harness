/**
 * Builders and a fake host for the Relations view's specs: a realistic neighbourhood around block-sparse attention, the
 * pages the host answers with, and a `run` that validates each request against the command schema before it answers.
 */
import { expect, vi } from 'vitest'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type {
  EvidenceRecord, RelationEdgeView, RelationGapCell, RelationGapPage, RelationGroundView, RelationKindId, RelationNodeSummary,
  RelationNodeView, RelationOutcomeView, RelationPathsPage, RelationsPage, ResearchCommand, ResearchResponse, ResearchSnapshot,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkbenchProps } from '../../src/client/contract.ts'
import { zh } from '../../src/client/locales.ts'
import { translate } from './translate.ts'

/** Matches any project id in a request the view sent. */
export const anyId: unknown = expect.any(String)

/** The Chinese dictionary bound as `t`. */
export const t = translate(zh)

/** A node of a neighbourhood; ring 1, outside the core, unless the patch says otherwise. */
export function node(id: string, kind: RelationNodeView['kind'], name: string, patch: Partial<RelationNodeView> = {}): RelationNodeView {
  return { id, kind, name, aliases: [], status: 'active', degree: 1, ring: 1, core: false, slot: 0, ...patch }
}

/** A quotation ground of a literature record's full text. */
export function ground(id: string, patch: Partial<RelationGroundView> = {}): RelationGroundView {
  return {
    id, type: 'quote', source: 'full-text', status: 'current', title: 'Longformer: The Long-Document Transformer', evidenceId: 'e-lf',
    locator: { page: 3 }, quote: 'Longformer combines a sliding window with global attention on a few tokens.', by: 'agent', ...patch,
  }
}

/** A relation with one ground unless the patch lists others. */
export function edge(kind: RelationKindId, from: string, to: string, patch: Partial<RelationEdgeView> = {}): RelationEdgeView {
  const best = patch.best ?? ground(`g-${kind}-${from}-${to}`)
  return {
    id: `${kind}:${from}>${to}`, kind, from, to, status: 'active', confidence: 0.82, sources: { 'full-text': 1, 'abstract': 0, 'file': 0, 'run': 0, 'citation': 0 },
    best, grounds: [best], by: 'agent', ...patch,
  }
}

/** The ground of a completed run. */
export const runGround = ground('g-run', {
  type: 'run', source: 'run', title: 'ruler-32k-dynamic · seed 42', evidenceId: undefined, locator: undefined, quote: undefined, runId: 'run-1', setting: '32K',
})

/** The centre and what hangs around it, as the host lays it out. */
export const NODES: RelationNodeView[] = [
  node('block', 'method', '块稀疏注意力', { ring: 0, core: true, degree: 9 }),
  node('dynamic', 'method', '动态选块', { core: true, slot: 0 }),
  node('fixed', 'method', '固定分块', { core: true, slot: 1 }),
  node('full', 'method', '全注意力', { slot: 2 }),
  node('context', 'task', '长上下文建模', { core: true, slot: 3, aliases: ['long-context modelling'] }),
  node('ruler', 'dataset', 'RULER', { slot: 4 }),
  node('accuracy', 'metric', '准确率', { slot: 5 }),
  node('longformer', 'paper', 'Longformer', { slot: 6, evidenceIds: ['e-lf'] }),
  node('bigbird', 'paper', 'BigBird', { slot: 7, status: 'orphaned' }),
  node('moba', 'paper', 'MoBA', { slot: 8 }),
  node('summary', 'task', '长文档摘要', { ring: 2, parent: 'longformer', slot: 0 }),
]

/** The relations among them. */
export const EDGES: RelationEdgeView[] = [
  edge('is-a', 'dynamic', 'block'),
  edge('is-a', 'fixed', 'block'),
  edge('compares-with', 'block', 'full', {
    best: runGround, grounds: [runGround], sources: { 'full-text': 0, 'abstract': 0, 'file': 0, 'run': 1, 'citation': 0 }, by: 'user',
  }),
  edge('applied-to', 'block', 'context', { best: ground('g-abs', { source: 'abstract', quote: 'We reduce the cost of long inputs.' }) }),
  edge('evaluated-on', 'block', 'ruler', { status: 'stale', best: ground('g-old', { status: 'outdated' }), grounds: [ground('g-old', { status: 'outdated' })] }),
  edge('measured-by', 'block', 'accuracy'),
  edge('introduces', 'longformer', 'fixed'),
  edge('introduces', 'moba', 'dynamic'),
  edge('extends', 'bigbird', 'longformer'),
  edge('cites', 'bigbird', 'longformer', { best: ground('g-cite', { type: 'citation', source: 'citation', locator: undefined, quote: undefined, by: undefined }) }),
  edge('applied-to', 'fixed', 'summary'),
]

/** A node as the lists of hubs and candidates carry it. */
export function summary({ id, kind, name, aliases, status, degree }: RelationNodeView): RelationNodeSummary {
  return { id, kind, name, aliases, status, degree }
}

/** The graph page around block-sparse attention. */
export function relationsPage(patch: Partial<RelationsPage> = {}): RelationsPage {
  const summaries: RelationNodeSummary[] = NODES.slice(0, 4).map(summary)
  return {
    problems: [], counts: { entities: 11, relations: 11, stale: 1, rejected: 1, citationLists: 0 }, match: 'none', hubs: summaries, candidates: [],
    neighbourhood: { center: 'block', nodes: NODES, edges: EDGES, omitted: { nodes: 0, edges: 0 } },
    rejected: [{
      id: 'applied-to:full>context', kind: 'applied-to', from: 'full', to: 'context', fromName: '全注意力', toName: '长上下文建模',
      rejection: { by: 'user', at: '2026-09-30T08:00:00.000Z', reason: 'wrong direction' },
    }],
    ...patch,
  }
}

/** The neighbourhood around Longformer, for a search or a click on it. */
export function longformerPage(): RelationsPage {
  return relationsPage({
    match: 'found',
    neighbourhood: {
      center: 'longformer',
      nodes: [
        node('longformer', 'paper', 'Longformer', { ring: 0, core: true }), node('fixed', 'method', '固定分块', { core: true }),
        node('bigbird', 'paper', 'BigBird', { slot: 1 }), node('summary', 'task', '长文档摘要', { ring: 2, parent: 'fixed' }),
      ],
      edges: [edge('introduces', 'longformer', 'fixed'), edge('extends', 'bigbird', 'longformer'), edge('applied-to', 'fixed', 'summary')],
      omitted: { nodes: 2, edges: 3 },
    },
  })
}

/** A two-hop path from block-sparse attention to long-document summarisation. */
export function pathsPage(patch: Partial<RelationPathsPage> = {}): RelationPathsPage {
  const hop = (relation: string, kind: RelationKindId, from: string, to: string, direction: 'forward' | 'backward', status: 'active' | 'stale' = 'active') => ({
    relation, kind, from, to, direction, status, confidence: 0.8, grounds: [ground(`g-${relation}`)], parallel: [],
  })
  return {
    from: 'block', to: 'summary',
    paths: [
      {
        nodes: ['block', 'fixed', 'summary'], cost: 2, confidence: 0.67, stale: false,
        hops: [hop('is-a:fixed>block', 'is-a', 'fixed', 'block', 'backward'), hop('applied-to:fixed>summary', 'applied-to', 'fixed', 'summary', 'forward')],
      },
      {
        nodes: ['block', 'context', 'summary'], cost: 3, confidence: 0.4, stale: true,
        hops: [hop('applied-to:block>context', 'applied-to', 'block', 'context', 'forward', 'stale'), hop('applied-to:summary>context', 'applied-to', 'summary', 'context', 'backward')],
      },
    ],
    nodes: NODES.filter(item => ['block', 'fixed', 'summary', 'context'].includes(item.id)).map(({ id, kind, name, aliases, status, degree }) => ({ id, kind, name, aliases, status, degree })),
    ...patch,
  }
}

/** A cell with no counts, in the given state. */
export function cell(state: RelationGapCell['state'], patch: Partial<RelationGapCell> = {}): RelationGapCell {
  return { state, papers: 0, viaSubtypes: 0, runs: 0, files: 0, stale: 0, passages: 0, rejected: 0, relations: [], ...patch }
}

/** Methods against tasks with one cell of every state. */
export function gapsPage(patch: Partial<RelationGapPage> = {}): RelationGapPage {
  return {
    axis: 'task',
    rows: [{ id: 'dynamic', name: '动态选块', passages: 4 }, { id: 'fixed', name: '固定分块', passages: 6 }],
    columns: [{ id: 'context', name: '长上下文建模', passages: 9 }, { id: 'summary', name: '长文档摘要', passages: 3 }, { id: 'qa', name: '问答', passages: 0 }],
    cells: [
      [cell('reported', { papers: 3 }), cell('mentioned', { passages: 2 }), cell('uncovered')],
      [cell('absent', { rejected: 1 }), cell('stale', { stale: 1 }), cell('project-only', { runs: 2 })],
    ],
    basis: { literature: 12, fullText: 7, abstractOnly: 4, metadataOnly: 1, files: 3 },
    wording: {
      heading: 'relationsGapHeading',
      states: {
        'reported': 'relationsGapReported', 'project-only': 'relationsGapProjectOnly', 'stale': 'relationsGapStale', 'mentioned': 'relationsGapMentioned',
        'absent': 'relationsGapAbsent', 'uncovered': 'relationsGapUncovered',
      },
    },
    ...patch,
  }
}

/** A literature record and a project file the research holds. */
export function record(id: string, patch: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: id as EvidenceRecord['id'], title: 'Longformer: The Long-Document Transformer', kind: 'literature', path: 'literature/longformer.md',
    fullTextPath: 'literature/longformer.pdf', sha256: 'a'.repeat(64), revision: 2, importedAt: '2026-09-01T00:00:00.000Z', chunks: [],
    coverage: 'full-text', verified: true, stale: false, ...patch,
  }
}

/** What a request to `relations-*` is answered with; each handler may be replaced. */
export interface Handlers {
  graph(request: Extract<ResearchCommand, { action: 'relations-graph' }>): Promise<ResearchResponse> | ResearchResponse
  paths(request: Extract<ResearchCommand, { action: 'relations-paths' }>): Promise<ResearchResponse> | ResearchResponse
  gaps(request: Extract<ResearchCommand, { action: 'relations-gaps' }>): Promise<ResearchResponse> | ResearchResponse
  propose(request: Extract<ResearchCommand, { action: 'relations-propose' }>): Promise<ResearchResponse> | ResearchResponse
  reject(request: Extract<ResearchCommand, { action: 'relations-reject' }>): Promise<ResearchResponse> | ResearchResponse
  restore(request: Extract<ResearchCommand, { action: 'relations-restore' }>): Promise<ResearchResponse> | ResearchResponse
  merge(request: Extract<ResearchCommand, { action: 'relations-merge' }>): Promise<ResearchResponse> | ResearchResponse
  suggestions(request: Extract<ResearchCommand, { action: 'relations-suggestions' }>): Promise<ResearchResponse> | ResearchResponse
  reground(request: Extract<ResearchCommand, { action: 'relations-reground' }>): Promise<ResearchResponse> | ResearchResponse
  citations(request: Extract<ResearchCommand, { action: 'relations-citations' }>): Promise<ResearchResponse> | ResearchResponse
}

/** A decision outcome the host answers `relations-reject` and `relations-restore` with. */
export const changed = (relation: string): RelationOutcomeView => ({ status: 'changed', relation })

/** The default answers: the graph around block-sparse attention, a search that finds Longformer, and nothing to merge. */
export const defaults: Handlers = {
  graph: (request) => {
    if (request.entity === undefined) return { message: 'Graph', relations: relationsPage() }
    if (request.entity === 'longformer' || request.entity === 'Longformer') return { message: 'Graph', relations: longformerPage() }
    if (request.entity === 'attention') return { message: 'Graph', relations: relationsPage({ match: 'ambiguous', neighbourhood: undefined, candidates: relationsPage().hubs.slice(0, 2) }) }
    if (request.entity === 'block') return { message: 'Graph', relations: relationsPage({ match: 'found' }) }
    return { message: 'Graph', relations: relationsPage({ match: 'unknown', neighbourhood: undefined }) }
  },
  paths: () => ({ message: 'Paths', relationPaths: pathsPage() }),
  gaps: request => ({ message: 'Gaps', relationGaps: gapsPage({ axis: request.axis }) }),
  propose: () => ({
    message: 'Proposed',
    relationOutcomes: [{ status: 'added', relation: 'applied-to:block>context', ground: 'g1', created: [], locatorCorrected: false, warnings: [], restored: false }],
  }),
  reject: request => ({ message: 'Rejected', relationOutcomes: [changed(request.relation)] }),
  restore: request => ({ message: 'Restored', relationOutcomes: [changed(request.relation)] }),
  merge: request => ({
    message: 'Merged', relationMerge: { status: 'merged', entity: { id: request.into, kind: 'method', name: 'Mixture of experts', aliases: [] }, dropped: [] },
  }),
  suggestions: () => ({ message: 'Suggestions', relationSuggestions: [] }),
  reground: () => ({ message: 'Regrounded', relationReground: { regrounded: 1, lapsed: 0 } }),
  citations: () => ({ message: 'Citations', relationCitations: { asked: 3, works: 3, added: 2, unchanged: 1, rejected: 0, failures: [] } }),
}

/** The view's inputs and what the fake host saw. */
export interface Harness {
  props: WorkbenchProps & { project: ReturnType<typeof newProject> }
  commands: ResearchCommand[]
  openFile: ReturnType<typeof vi.fn>
}

/**
 * A research with literature and a fake host; every request is parsed against the command schema, so a view that
 * sends something the host would refuse fails the spec.
 * @param handlers - answers that replace the defaults.
 * @param options - whether the research is an example, and the records it holds.
 * @returns the props to render with, and what the host was asked.
 */
export function harness(handlers: Partial<Handlers> = {}, options: { example?: boolean; evidence?: EvidenceRecord[] } = {}): Harness {
  const project = newProject({ root: '/research/relations', title: 'Block-sparse attention', brief: '' }, 'workspace' as WorkspaceId)
  project.evidence = options.evidence ?? [record('e-lf'), record('e-notes', { title: 'notes.md', kind: 'file', path: 'notes.md', revision: 5, fullTextPath: undefined })]
  if (options.example === true) project.example = true
  const modules = { map: false, evidence: false, memory: false, relations: true }
  const snapshot: ResearchSnapshot = {
    projects: [project], modes: [], components: [], preferences: {}, knowledge: { enabled: false, modules },
  }
  const answers: Handlers = { ...defaults, ...handlers }
  const commands: ResearchCommand[] = []
  const openFile = vi.fn()
  const run = async (request: ResearchCommand): Promise<ResearchResponse> => {
    commandSchema.parse(request); commands.push(request)
    switch (request.action) {
      case 'relations-graph': return answers.graph(request)
      case 'relations-paths': return answers.paths(request)
      case 'relations-gaps': return answers.gaps(request)
      case 'relations-propose': return answers.propose(request)
      case 'relations-reject': return answers.reject(request)
      case 'relations-restore': return answers.restore(request)
      case 'relations-merge': return answers.merge(request)
      case 'relations-suggestions': return answers.suggestions(request)
      case 'relations-reground': return answers.reground(request)
      case 'relations-citations': return answers.citations(request)
      default: throw new Error(`unexpected ${request.action}`)
    }
  }
  const props = {
    t, project, run, openFile, useResearch: (select: (value: object) => unknown) => select({ snapshot, tasks: [] }),
  } as Harness['props']
  return { props, commands, openFile }
}
