/** The research record read as a graph: question, claims, the sources and runs behind them, and where each claim is used. */
import type { ClaimRecord, EvidenceRecord, ExperimentRecord, ResearchProject } from './types.ts'

/** Where a claim stands once its sources are looked at, not just the state it was recorded with. */
export type EvidenceGraphState = 'supported' | 'proposed' | 'stale' | 'contradicted' | 'missing'

/** One node of the evidence graph; `id` is stable for a record, so a client can keep its selection across reads. */
export interface EvidenceGraphNode {
  id: string
  kind: 'question' | 'claim' | 'literature' | 'file' | 'run' | 'artifact'
  label: string
  /** Claims carry their derived state; a source or run carries `stale` when its content changed after it was cited. */
  state?: EvidenceGraphState | undefined
  /** The claim's kind, a run's recorded metrics or status, a source's identifier. */
  detail?: string | undefined
  /** A claim: the files it appears in. */
  where?: string[] | undefined
  /** The record this node stands for, so a client can open it. */
  ref?: { claimId?: string; evidenceId?: string; experimentId?: string; artifactId?: string; path?: string } | undefined
}

/** One relation of the evidence graph. */
export interface EvidenceGraphEdge {
  from: string
  to: string
  kind: 'asks' | 'supports' | 'appears-in'
  /** A support whose source changed after the claim cited it. */
  stale: boolean
  /** The quotation a support rests on. */
  quote?: string | undefined
}

/** The graph with the counts a header shows. */
export interface EvidenceGraph {
  nodes: EvidenceGraphNode[]
  edges: EvidenceGraphEdge[]
  summary: Record<EvidenceGraphState | 'claims', number>
}

const LABEL_LIMIT = 160
const QUESTION_ID = 'question'

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > LABEL_LIMIT ? `${flat.slice(0, LABEL_LIMIT - 1)}…` : flat
}

/** The run a run-output source belongs to: its path is `.research/runs/<run id>/…`. */
function runOf(record: EvidenceRecord, experiments: readonly ExperimentRecord[]): ExperimentRecord | undefined {
  const id = /^\.research\/runs\/([^/]+)\//.exec(record.path)?.[1]
  return id === undefined ? undefined : experiments.find(run => run.id === id)
}

function metricsText(run: ExperimentRecord): string {
  const entries = Object.entries(run.metrics).slice(0, 4).map(([key, value]) => `${key} ${Number.isInteger(value) ? value : Number(value.toPrecision(4))}`)
  return entries.length === 0 ? run.status : entries.join(' · ')
}

/** A run whose output a claim cites; it is stale when the output's source is. */
function runNode(id: string, run: ExperimentRecord, source: EvidenceRecord): EvidenceGraphNode {
  return { id, kind: 'run', label: `${run.spec.name} · seed ${run.spec.seed}`, state: source.stale ? 'stale' : 'supported', detail: metricsText(run),
    ref: { experimentId: run.id, evidenceId: source.id } }
}

/** A literature or file source a claim cites; a citation of a record that no longer exists reads as a stale file. */
function sourceNode(id: string, evidenceId: string, source: EvidenceRecord | undefined): EvidenceGraphNode {
  return { id, kind: source?.kind === 'literature' ? 'literature' : 'file', label: source === undefined ? evidenceId : clip(source.title),
    state: source === undefined || source.stale ? 'stale' : 'supported',
    ...source?.doi ? { detail: source.doi } : source?.sourceUrl ? { detail: source.sourceUrl } : {},
    ref: { evidenceId, ...source === undefined ? {} : { path: source.path } } }
}

/**
 * Where a claim stands: the recorded state refined by what its sources say now.
 * A contradicted claim stays contradicted; a claim that is not a hypothesis and cites nothing is missing its evidence;
 * a citation of an older revision, or of a source marked stale, makes the claim stale.
 * @param claim - the recorded claim.
 * @param sources - the project's sources, by id.
 * @returns the derived state.
 */
export function claimState(claim: ClaimRecord, sources: ReadonlyMap<string, EvidenceRecord>): EvidenceGraphState {
  if (claim.state === 'contradicted') return 'contradicted'
  if (claim.evidence.length === 0) return claim.kind === 'hypothesis' ? 'proposed' : 'missing'
  const outdated = claim.evidence.some((link) => {
    const source = sources.get(link.evidenceId)
    return source === undefined || source.stale || link.revision < source.revision
  })
  if (outdated || claim.state === 'stale') return 'stale'
  return claim.state
}

/**
 * Project the research record into the evidence graph. Pure: it reads the record and nothing else.
 * @param project - the research record.
 * @returns the nodes, the edges and the counts per state.
 */
export function buildEvidenceGraph(
  project: Pick<ResearchProject, 'brief' | 'title' | 'claims' | 'evidence' | 'artifacts' | 'experiments'>,
): EvidenceGraph {
  const sources = new Map<string, EvidenceRecord>(project.evidence.map(record => [record.id, record]))
  const nodes = new Map<string, EvidenceGraphNode>()
  const edges: EvidenceGraphEdge[] = []
  const summary: EvidenceGraph['summary'] = { claims: 0, supported: 0, proposed: 0, stale: 0, contradicted: 0, missing: 0 }
  nodes.set(QUESTION_ID, { id: QUESTION_ID, kind: 'question', label: clip(project.brief === '' ? project.title : project.brief) })
  for (const claim of project.claims) {
    const state = claimState(claim, sources)
    summary.claims += 1
    summary[state] += 1
    const claimId = `claim:${claim.id}`
    const files = claim.artifactIds.flatMap((id) => {
      const artifact = project.artifacts.find(item => item.id === id)
      return artifact === undefined ? [] : [artifact]
    })
    nodes.set(claimId, { id: claimId, kind: 'claim', label: clip(claim.text), state, detail: claim.kind,
      where: files.map(file => file.path), ref: { claimId: claim.id } })
    edges.push({ from: QUESTION_ID, to: claimId, kind: 'asks', stale: false })
    for (const link of claim.evidence) {
      const source = sources.get(link.evidenceId)
      const run = source === undefined ? undefined : runOf(source, project.experiments)
      const id = run === undefined ? `evidence:${link.evidenceId}` : `run:${run.id}`
      if (!nodes.has(id)) {
        nodes.set(id, run === undefined ? sourceNode(id, link.evidenceId, source) : runNode(id, run, source as EvidenceRecord))
      }
      edges.push({ from: claimId, to: id, kind: 'supports', stale: source === undefined || source.stale || link.revision < source.revision,
        ...link.quote === '' ? {} : { quote: clip(link.quote) } })
    }
    for (const file of files) {
      const id = `artifact:${file.id}`
      if (!nodes.has(id)) {
        nodes.set(id, { id, kind: 'artifact', label: file.path, state: file.stale ? 'stale' : 'supported', ref: { artifactId: file.id, path: file.path } })
      }
      edges.push({ from: claimId, to: id, kind: 'appears-in', stale: file.stale })
    }
  }
  return { nodes: [...nodes.values()], edges, summary }
}
