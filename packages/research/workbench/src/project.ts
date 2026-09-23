/** The research ledger's pure transitions: what exists, where it came from and what is out of date. */
import { randomUUID } from 'node:crypto'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {
  ArtifactId, ClaimRecord, CreateProjectRequest, EvidenceId, EvidenceLink, ExperimentRecord, ProjectId,
  ResearchProject, ResearchResponse, SourceLocator,
} from './types.ts'

/** Create the initial project record for a registered workspace. */
export function newProject(request: CreateProjectRequest, workspaceId: WorkspaceId): ResearchProject {
  const now = new Date().toISOString()
  return {
    id: randomUUID() as ProjectId, workspaceId, title: request.title.trim(), root: request.root,
    ...(request.mode === undefined ? {} : { mode: request.mode, modeSetBy: 'user' as const }),
    autonomy: request.autonomy ?? 'checkpoints',
    brief: request.brief, revision: 1, researchRevision: 1, createdAt: now, updatedAt: now,
    evidence: [], claims: [], artifacts: [], decisions: [], environments: [], experiments: [], compilations: [], visualReviews: [],
  }
}

/** Collapse whitespace runs so extracted PDF text with line breaks still matches a plain quote. */
const flatten = (text: string): string => text.replace(/\s+/g, ' ')

/** Reject references to absent, stale or differently versioned source material. */
export function validateLinks(project: ResearchProject, links: EvidenceLink[]): void {
  for (const link of links) {
    const evidence = project.evidence.find(item => item.id === link.evidenceId)
    if (!evidence || evidence.stale || evidence.revision !== link.revision) {
      throw new Error(`Evidence is missing or outdated: ${link.evidenceId}`)
    }
    const quoteMatches = (chunk: { text: string; locator: SourceLocator }): boolean => {
      const fields = chunk.locator as Record<string, unknown>
      const locationMatches = Object.entries(link.locator).every(([key, value]) => fields[key] === value)
      return locationMatches && flatten(chunk.text).includes(flatten(link.quote))
    }
    if (link.quote && !evidence.chunks.some(quoteMatches)) {
      throw new Error(`Quoted evidence does not match its source location: ${link.evidenceId}`)
    }
  }
}

/** Mark affected claims and all transitively dependent outputs as stale. */
export function invalidate(project: ResearchProject, changed: { evidenceId?: EvidenceId; artifactId?: ArtifactId }): void {
  for (const run of project.experiments) {
    const usesInput = changed.evidenceId !== undefined && run.spec.dataEvidenceIds.includes(changed.evidenceId)
      || changed.artifactId !== undefined && run.spec.codeArtifactIds.includes(changed.artifactId)
    if (usesInput) {
      for (const evidence of project.evidence) {
        if (evidence.kind === 'experiment' && evidence.path.includes(`/runs/${run.id}/`) && !evidence.stale) {
          evidence.stale = true
          invalidate(project, { evidenceId: evidence.id })
        }
      }
    }
  }
  const affected = new Set<ArtifactId>(changed.artifactId !== undefined ? [changed.artifactId] : [])
  for (const claim of project.claims) {
    if (changed.evidenceId !== undefined && claim.evidence.some(link => link.evidenceId === changed.evidenceId)) {
      claim.state = 'stale'
      for (const id of claim.artifactIds) affected.add(id)
    }
  }
  let grew = true
  while (grew) {
    grew = false
    for (const artifact of project.artifacts) {
      const depends = changed.evidenceId !== undefined && artifact.evidence.some(link => link.evidenceId === changed.evidenceId)
        || artifact.inputArtifacts.some(link => affected.has(link.id))
        || artifact.claimIds.some(id => project.claims.some(claim => claim.id === id && claim.state === 'stale'))
      if (depends && !affected.has(artifact.id)) { affected.add(artifact.id); grew = true }
    }
  }
  for (const artifact of project.artifacts) {
    if (affected.has(artifact.id) && artifact.id !== changed.artifactId) artifact.stale = true
  }
}

/**
 * Validate and replace one scholarly claim. A contradicted claim is a result
 * like any other: it is recorded, and nothing downstream is reset.
 */
export function putClaim(project: ResearchProject, claim: ClaimRecord): void {
  validateLinks(project, claim.evidence)
  if (claim.state === 'supported' && claim.kind !== 'hypothesis' && claim.evidence.length === 0) {
    throw new Error('A supported claim requires source evidence')
  }
  if (claim.state === 'supported' && claim.evidence.some(link => !link.quote.trim() || !Object.keys(link.locator).length)) {
    throw new Error('Supported claims require exact quoted content and a source location')
  }
  const verifiedDataEvidence = claim.evidence.some((link) => {
    const item = project.evidence.find(e => e.id === link.evidenceId)
    return item !== undefined && item.coverage === 'data' && item.verified
  })
  if (claim.kind === 'empirical' && claim.state === 'supported' && !verifiedDataEvidence) {
    throw new Error('An empirical claim requires verified experiment or imported data evidence')
  }
  for (const id of claim.artifactIds) {
    if (!project.artifacts.some(a => a.id === id)) throw new Error(`Unknown artifact: ${id}`)
  }
  const previous = project.claims.find(item => item.id === claim.id)
  if (previous && JSON.stringify(previous) !== JSON.stringify(claim)) {
    for (const id of previous.artifactIds) {
      const artifact = project.artifacts.find(a => a.id === id)
      if (artifact) artifact.stale = true
    }
  }
  project.claims = [...project.claims.filter(item => item.id !== claim.id), claim]
}

export interface EvidenceHit {
  evidenceId: EvidenceId
  revision: number
  title: string
  coverage: string
  locator: SourceLocator
  text: string
  score: number
}

/**
 * Rank evidence chunks for a query: the whole phrase outranks term coverage,
 * and title/path matches outrank body hits. Each hit carries a snippet around
 * its first match. The result is serialized within the byte budget.
 */
export function searchEvidence(project: ResearchProject, query: string, maxBytes: number): { message: string; content: string } {
  const phrase = query.trim().toLowerCase()
  const terms = phrase.split(/\s+/).filter(Boolean)
  const hits: EvidenceHit[] = []
  for (const source of project.evidence) {
    for (const chunk of source.chunks) {
      const text = chunk.text.toLowerCase()
      let score = terms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0)
      if (score === 0) continue
      if (terms.length > 1 && text.includes(phrase)) score += terms.length
      if (terms.some(term => source.title.toLowerCase().includes(term))) score += 1
      const first = Math.min(...terms.map((term) => { const at = text.indexOf(term); return at < 0 ? Number.MAX_SAFE_INTEGER : at }))
      const from = Math.max(0, first - 300)
      hits.push({
        evidenceId: source.id, revision: source.revision, title: source.title, coverage: source.coverage,
        locator: chunk.locator, text: chunk.text.slice(from, from + 600), score,
      })
    }
  }
  hits.sort((a, b) => b.score - a.score)
  const parts: string[] = []
  let bytes = 2 // '[]'
  for (const hit of hits.slice(0, 12)) {
    const serialized = JSON.stringify(hit)
    bytes += Buffer.byteLength(serialized) + 1
    if (bytes > maxBytes) break
    parts.push(serialized)
  }
  return { message: `${parts.length} evidence matches`, content: `[${parts.join(',')}]` }
}

/** Compact run view for tool results. */
export function runView(run: ExperimentRecord): NonNullable<ResearchResponse['runs']>[number] {
  return { id: run.id, status: run.status, message: run.message, metrics: run.metrics }
}
