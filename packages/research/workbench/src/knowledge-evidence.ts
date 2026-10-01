/** The research record read as an evidence graph: the question, its conclusions, and the runs and literature behind each. */
import type {
  ClaimRecord, EvidenceClaimStatus, EvidenceGraphClaim, EvidenceGraphFile, EvidenceGraphLink, EvidenceGraphPage, EvidenceGraphSource,
  EvidenceLink, EvidenceRecord, ExperimentRecord, ResearchProject,
} from './types.ts'

/** The parts of a project record that the evidence graph reads. */
export type EvidenceGraphInput = Pick<ResearchProject, 'title' | 'brief' | 'claims' | 'evidence' | 'artifacts' | 'experiments' | 'environments'>

/** The most runs shown as expected evidence of one claim; the rest are counted. */
const MAX_EXPECTED = 3
/** Claim kinds that a run can test, and so can expect evidence from a run in progress. */
const TESTED_BY_RUNS: ReadonlySet<ClaimRecord['kind']> = new Set(['empirical', 'hypothesis'])
/** Run statuses that can still deliver evidence: a run in progress, or one finished whose results nobody collected. */
const DELIVERING: ReadonlySet<ExperimentRecord['status']> = new Set(['queued', 'running', 'unknown', 'completed'])

/**
 * Whether a citation no longer matches its source: the source is gone, is recorded stale, or has a revision other than the one cited.
 * @param link - the citation.
 * @param source - the source it cites, absent when the record no longer holds it.
 * @returns true when the claim rests on a source that changed.
 */
export function isOutdated(link: Pick<EvidenceLink, 'revision'>, source: Pick<EvidenceRecord, 'revision' | 'stale'> | undefined): boolean {
  return source === undefined || source.stale || source.revision !== link.revision
}

/**
 * Where a claim stands. A recorded contradiction stands. A claim that cites nothing is proposed when it is a hypothesis and missing its
 * evidence otherwise. A claim that cites a changed source, or is recorded stale, is stale. A claim recorded as proposed stays proposed.
 * @param claim - the recorded claim.
 * @param outdated - whether any citation of the claim no longer matches its source.
 * @returns the status.
 */
export function claimStatus(claim: Pick<ClaimRecord, 'kind' | 'state' | 'evidence'>, outdated: boolean): EvidenceClaimStatus {
  if (claim.state === 'contradicted') return 'contradicted'
  if (claim.evidence.length === 0) return claim.kind === 'hypothesis' ? 'proposed' : 'missing'
  if (outdated || claim.state === 'stale') return 'stale'
  return claim.state === 'proposed' ? 'proposed' : 'supported'
}

/** The run an experiment source was collected from, matched by its path the way the ledger matches it. */
function runOf(source: EvidenceRecord, experiments: readonly ExperimentRecord[]): ExperimentRecord | undefined {
  return source.kind === 'experiment' ? experiments.find(run => source.path.includes(`/runs/${run.id}/`)) : undefined
}

/** Where a run executes: `local`, or the alias of its SSH host; absent when its environment is no longer in the record. */
function hostOf(run: ExperimentRecord, environments: EvidenceGraphInput['environments']): string | undefined {
  const environment = environments.find(item => item.id === run.spec.environmentId)
  if (environment === undefined) return undefined
  return environment.target === 'ssh' ? environment.sshHost ?? 'ssh' : 'local'
}

/** A run as a source node, cited or expected. */
function runNode(id: string, kind: 'run' | 'expected-run', run: ExperimentRecord, host: string | undefined): EvidenceGraphSource {
  return {
    id, kind, label: run.spec.name, seed: run.spec.seed, status: run.status, metrics: run.metrics, changed: false,
    ...host === undefined ? {} : { host },
  }
}

/** The node of a cited source that is not a run, or of a source the record no longer holds. */
function sourceNode(id: string, evidenceId: string, source: EvidenceRecord | undefined): EvidenceGraphSource {
  if (source === undefined) return { id, kind: 'file', label: evidenceId, changed: true }
  return {
    id, kind: source.kind === 'literature' ? 'literature' : 'file', label: source.title, verified: source.verified, coverage: source.coverage,
    changed: false, path: source.path,
  }
}

/** The files that carry a claim, as the claim and each file record the link; the ledger never reconciles the two directions. */
function filesOf(claim: ClaimRecord, artifacts: EvidenceGraphInput['artifacts']): EvidenceGraphFile[] {
  return artifacts.filter(artifact => claim.artifactIds.includes(artifact.id) || artifact.claimIds.includes(claim.id))
    .map(({ id, path, revision, stale }) => ({ id, path, revision, stale }))
}

/**
 * Project the research record into the evidence graph. The projection is pure: it reads the record and nothing else, so every
 * status is derived from recorded fields and nothing is stored.
 * @param project - the research record.
 * @returns the question, each claim with its citations and files, the source nodes, and the claim counts per status.
 */
export function buildEvidenceGraph(project: EvidenceGraphInput): EvidenceGraphPage {
  const records = new Map<string, EvidenceRecord>(project.evidence.map(record => [record.id, record]))
  const sources = new Map<string, EvidenceGraphSource>()
  const summary: EvidenceGraphPage['summary'] = { claims: 0, supported: 0, stale: 0, missing: 0, proposed: 0, contradicted: 0 }
  const delivering = project.experiments.filter(run => !run.collected && DELIVERING.has(run.status))
  const claims = project.claims.map((claim): EvidenceGraphClaim => {
    const links = claim.evidence.map((link): EvidenceGraphLink => {
      const record = records.get(link.evidenceId)
      const run = record === undefined ? undefined : runOf(record, project.experiments)
      const outdated = isOutdated(link, record)
      const id = run === undefined ? `source:${link.evidenceId}` : `run:${run.id}`
      let node = sources.get(id)
      if (node === undefined) {
        node = run === undefined ? sourceNode(id, link.evidenceId, record) : { ...runNode(id, 'run', run, hostOf(run, project.environments)), path: record?.path }
        sources.set(id, node)
      }
      if (outdated) node.changed = true
      return { sourceId: id, revision: link.revision, outdated, locator: link.locator, ...link.quote === '' ? {} : { quote: link.quote } }
    })
    const status = claimStatus(claim, links.some(link => link.outdated))
    const expecting = links.length === 0 && TESTED_BY_RUNS.has(claim.kind) ? delivering : []
    const shown = expecting.slice(0, MAX_EXPECTED)
    const expected = shown.map((run) => {
      const id = `expected:${run.id}`
      if (!sources.has(id)) sources.set(id, runNode(id, 'expected-run', run, hostOf(run, project.environments)))
      return id
    })
    if (links.length === 0 && expected.length === 0) {
      const id = `none:${claim.id}`
      sources.set(id, { id, kind: 'none', label: '', changed: false })
      expected.push(id)
    }
    summary.claims += 1
    summary[status] += 1
    return {
      id: claim.id, text: claim.text, kind: claim.kind, status, files: filesOf(claim, project.artifacts), links, expected,
      expectedMore: expecting.length - shown.length,
    }
  })
  const brief = project.brief.trim()
  return { question: brief === '' ? project.title : brief, claims, sources: [...sources.values()], summary }
}
