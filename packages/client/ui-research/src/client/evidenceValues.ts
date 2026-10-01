/**
 * What the My research (我的研究) view derives from the evidence graph before it draws: where every node sits, and the
 * sentences of the detail panel. The host sends facts about the record (statuses, citations, counts); every sentence is
 * picked from the dictionary here, so nothing the person reads is generated outside the interface language.
 *
 * @module @deepseek-ai/dsh-client-ui-research/evidenceValues
 */
import type {
  EvidenceClaimStatus, EvidenceGraphClaim, EvidenceGraphLink, EvidenceGraphPage, EvidenceGraphSource,
} from '@deepseek-ai/dsh-research-workbench/types'
import { counted, locatorText, type Translate } from './format.ts'
import type { ResearchKey } from './locales.ts'

/** Height of a claim card, in pixels; its text is clamped to fit. */
export const CLAIM_HEIGHT = 108
/** Height of an evidence card, in pixels. */
export const SOURCE_HEIGHT = 88
/** Space between two cards of one column. */
export const NODE_GAP = 12
/** Half the tallest the question card grows; the question is centred on its claims and never closer to the top than this. */
export const QUESTION_HALF = 98

/** A card's place in its column. */
export interface PlacedNode {
  id: string
  top: number
  center: number
}

/** A claim card and its place. */
export interface PlacedClaim extends PlacedNode {
  claim: EvidenceGraphClaim
}

/** An evidence card and its place. */
export interface PlacedSource extends PlacedNode {
  source: EvidenceGraphSource
}

/** A line from the question to a claim, as heights in the gutter between their columns. */
export interface QuestionEdge {
  claimId: string
  from: number
  to: number
}

/** A line from a claim to a source, as heights in the gutter between their columns. */
export interface SourceEdge {
  claimId: string
  sourceId: string
  from: number
  to: number
  /** The line leads to a placeholder, not to something the claim cites. */
  expected: boolean
  /** The claim cites a revision of the source that is no longer the source's. */
  outdated: boolean
  /** The claim's status, which colours the line while the claim is selected. */
  status: EvidenceClaimStatus
}

/** Where the cards and lines of the node-link layout go. */
export interface EvidenceLayout {
  /** Height of the three columns. */
  height: number
  /** Height of the question card's centre. */
  question: number
  claims: PlacedClaim[]
  sources: PlacedSource[]
  questionEdges: QuestionEdge[]
  sourceEdges: SourceEdge[]
}

function placed(id: string, top: number, height: number): PlacedNode {
  return { id, top, center: top + height / 2 }
}

/**
 * Place the question, the claims and the evidence in three columns. Evidence cards stack in the order a claim first
 * cites them; each claim sits level with the middle of its own evidence and is pushed down only as far as the claim
 * above it requires. Every height is a pixel count the columns reproduce exactly, so the lines between them are
 * computed rather than measured.
 * @param page - the evidence graph.
 * @returns the heights of every card and line; all zero for a graph without claims.
 */
export function evidenceLayout(page: EvidenceGraphPage): EvidenceLayout {
  const sources = page.sources.map((source, index): PlacedSource => ({
    ...placed(source.id, index * (SOURCE_HEIGHT + NODE_GAP), SOURCE_HEIGHT), source,
  }))
  const sourceAt = new Map(sources.map(node => [node.id, node]))
  let floor = 0
  const placedClaims = page.claims.map((claim) => {
    const targets = [...new Set([...claim.links.map(link => link.sourceId), ...claim.expected])]
    const centers = targets.flatMap(id => sourceAt.get(id)?.center ?? [])
    const wanted = centers.length === 0 ? floor + CLAIM_HEIGHT / 2 : centers.reduce((sum, center) => sum + center, 0) / centers.length
    const node: PlacedClaim = { ...placed(claim.id, Math.max(wanted - CLAIM_HEIGHT / 2, floor), CLAIM_HEIGHT), claim }
    floor = node.top + CLAIM_HEIGHT + NODE_GAP
    return { node, targets }
  })
  const claims = placedClaims.map(({ node }) => node)
  const first = claims[0]?.center ?? 0
  const last = claims.at(-1)?.center ?? 0
  const question = claims.length === 0 ? 0 : Math.max((first + last) / 2, QUESTION_HALF)
  const bottoms = [
    ...claims.map(node => node.top + CLAIM_HEIGHT), ...sources.map(node => node.top + SOURCE_HEIGHT),
    claims.length === 0 ? 0 : question + QUESTION_HALF,
  ]
  return {
    height: Math.max(0, ...bottoms),
    question,
    claims,
    sources,
    questionEdges: claims.map(node => ({ claimId: node.id, from: question, to: node.center })),
    sourceEdges: placedClaims.flatMap(({ node, targets }) => targets.flatMap((sourceId): SourceEdge[] => {
      const target = sourceAt.get(sourceId)
      if (target === undefined) return []
      return [{
        claimId: node.id, sourceId, from: node.center, to: target.center, expected: node.claim.expected.includes(sourceId),
        outdated: node.claim.links.some(link => link.sourceId === sourceId && link.outdated), status: node.claim.status,
      }]
    })),
  }
}

/**
 * Index the graph's source nodes.
 * @param page - the evidence graph.
 * @returns the source nodes by id.
 */
export function sourceIndex(page: Pick<EvidenceGraphPage, 'sources'>): ReadonlyMap<string, EvidenceGraphSource> {
  return new Map(page.sources.map(source => [source.id, source]))
}

const STATUS_KEYS: Record<EvidenceClaimStatus, ResearchKey> = {
  supported: 'egStatusSupported', stale: 'egStatusStale', missing: 'egStatusMissing', proposed: 'egStatusProposed', contradicted: 'egStatusContradicted',
}
const COUNT_KEYS: Record<EvidenceClaimStatus, ResearchKey> = {
  supported: 'egCountSupported', stale: 'egCountStale', missing: 'egCountMissing', proposed: 'egCountProposed', contradicted: 'egCountContradicted',
}
/** Statuses the count strip always shows, even at zero; the others appear only when a claim has them. */
const ALWAYS_COUNTED: readonly EvidenceClaimStatus[] = ['supported', 'stale', 'missing']
const STATUS_ORDER: readonly EvidenceClaimStatus[] = ['supported', 'stale', 'missing', 'proposed', 'contradicted']
const KIND_KEYS: Record<EvidenceGraphSource['kind'], ResearchKey> = {
  run: 'egKindRun', literature: 'egKindLiterature', file: 'egKindFile', 'expected-run': 'egKindExpected', none: 'egKindNone',
}
const COVERAGE_KEYS: Partial<Record<NonNullable<EvidenceGraphSource['coverage']>, ResearchKey>> = {
  'full-text': 'fullText', abstract: 'abstract', metadata: 'metadata',
}

/**
 * A claim status as the person reads it.
 * @param status - the claim's status.
 * @param t - bound dictionary lookup.
 * @returns the localized name.
 */
export function statusText(status: EvidenceClaimStatus, t: Translate): string {
  return t(STATUS_KEYS[status])
}

/** One chip of the count strip. */
export interface CountChip {
  /** `total` for the number of conclusions, else the status counted. */
  kind: 'total' | EvidenceClaimStatus
  text: string
}

/**
 * The chips above the graph: the number of conclusions, then how many stand at each status. Supported, stale and
 * missing always appear; proposed and contradicted appear when a claim has them.
 * @param summary - the page's counts.
 * @param t - bound dictionary lookup.
 * @returns the chips in reading order.
 */
export function countChips(summary: EvidenceGraphPage['summary'], t: Translate): CountChip[] {
  const shown = STATUS_ORDER.filter(status => ALWAYS_COUNTED.includes(status) || summary[status] > 0)
  return [
    { kind: 'total', text: counted(summary.claims, 'egClaimsOne', 'egClaimsMany', t) },
    ...shown.map((status): CountChip => ({ kind: status, text: t(COUNT_KEYS[status], { n: summary[status] }) })),
  ]
}

/** Where a run executes: the computer the interface runs on, or the SSH host's own alias. */
function hostText(host: string | undefined, t: Translate): string {
  if (host === undefined) return ''
  return host === 'local' ? t('local') : host
}

/** A run's status in words; nothing for a node that carries none. */
function statusOfRun(source: EvidenceGraphSource, t: Translate): string {
  return source.status === undefined ? '' : t(source.status)
}

/** The first metrics a run recorded, exactly as the run's metrics file reported them. */
function metricsText(metrics: EvidenceGraphSource['metrics']): string {
  return Object.entries(metrics ?? {}).slice(0, 2).map(([name, value]) => `${name} ${value}`).join(' · ')
}

/**
 * The small line above a card's name: what kind of thing it is, and that it changed after a claim cited it.
 * @param source - the evidence node.
 * @param t - bound dictionary lookup.
 * @returns for example `Literature · source changed`.
 */
export function sourceKindText(source: EvidenceGraphSource, t: Translate): string {
  const kind = t(KIND_KEYS[source.kind])
  return source.changed ? `${kind} · ${t('egChanged')}` : kind
}

/**
 * The name of an evidence node: a run with its seed, a source by its title.
 * @param source - the evidence node.
 * @param t - bound dictionary lookup.
 * @returns the name; a sentence for the marker where nothing is cited.
 */
export function sourceLabel(source: EvidenceGraphSource, t: Translate): string {
  if (source.kind === 'none') return t('egNoneLabel')
  return source.seed === undefined ? source.label : `${source.label} · ${t('runSeed')} ${source.seed}`
}

/**
 * The small line under a card's name: a run's numbers and where it ran, a source's verification and coverage.
 * @param source - the evidence node.
 * @param t - bound dictionary lookup.
 * @returns the facts joined by a middle dot; empty when the node has none.
 */
export function sourceMeta(source: EvidenceGraphSource, t: Translate): string {
  const parts: string[] = []
  if (source.kind === 'none') parts.push(t('egNoneMeta'))
  else if (source.kind === 'run') parts.push(metricsText(source.metrics) || statusOfRun(source, t), hostText(source.host, t))
  else if (source.kind === 'expected-run') parts.push(statusOfRun(source, t), hostText(source.host, t))
  else {
    if (source.kind === 'literature') parts.push(source.verified === true ? t('verified') : t('egUnverified'))
    const coverage = source.coverage === undefined ? undefined : COVERAGE_KEYS[source.coverage]
    if (coverage !== undefined) parts.push(t(coverage))
  }
  return parts.filter(part => part !== '').join(' · ')
}

/**
 * Where a claim is written, for its card: the first file that carries it.
 * @param claim - the claim.
 * @returns the file's path; empty when no file carries the claim.
 */
export function cardWhere(claim: Pick<EvidenceGraphClaim, 'files'>): string {
  return claim.files[0]?.path ?? ''
}

/**
 * Where a claim is written, for the detail panel.
 * @param claim - the claim.
 * @param t - bound dictionary lookup.
 * @returns the first file with a count of the others, or that no file carries it yet.
 */
export function whereText(claim: Pick<EvidenceGraphClaim, 'files'>, t: Translate): string {
  const [first, ...others] = claim.files
  if (first === undefined) return t('egWhereNone')
  return others.length === 0 ? first.path : t('egWhereMore', { path: first.path, n: others.length })
}

/** One source a claim cites, with every citation of it. */
export interface SupportItem {
  source: EvidenceGraphSource
  links: EvidenceGraphLink[]
}

/**
 * The sources a claim cites, in the order it first cites them, each with all its citations.
 * @param claim - the claim.
 * @param sources - the graph's source nodes by id.
 * @returns the cited sources.
 */
export function supportOf(claim: Pick<EvidenceGraphClaim, 'links'>, sources: ReadonlyMap<string, EvidenceGraphSource>): SupportItem[] {
  const items = new Map<string, SupportItem>()
  for (const link of claim.links) {
    const source = sources.get(link.sourceId)
    if (source === undefined) continue
    const item = items.get(source.id)
    if (item === undefined) items.set(source.id, { source, links: [link] })
    else item.links.push(link)
  }
  return [...items.values()]
}

/**
 * The runs a claim without evidence is waiting for.
 * @param claim - the claim.
 * @param sources - the graph's source nodes by id.
 * @returns the runs in progress or not yet collected that the page shows for it.
 */
export function expectedRuns(claim: Pick<EvidenceGraphClaim, 'expected'>, sources: ReadonlyMap<string, EvidenceGraphSource>): EvidenceGraphSource[] {
  return claim.expected.flatMap((id) => {
    const source = sources.get(id)
    return source?.kind === 'expected-run' ? [source] : []
  })
}

/** How many of the cited sources are of each kind. */
function kindCounts(items: readonly SupportItem[]): { runs: number; literature: number; files: number } {
  return {
    runs: items.filter(item => item.source.kind === 'run').length,
    literature: items.filter(item => item.source.kind === 'literature').length,
    files: items.filter(item => item.source.kind === 'file').length,
  }
}

/**
 * What would make a claim go stale, said from its structure: the sources it rests on, the files that would be marked
 * with it, and any source that already changed.
 * @param claim - the claim.
 * @param sources - the graph's source nodes by id.
 * @param t - bound dictionary lookup.
 * @returns one or more sentences, each a paragraph.
 */
export function invalidationLines(claim: EvidenceGraphClaim, sources: ReadonlyMap<string, EvidenceGraphSource>, t: Translate): string[] {
  if (claim.status === 'contradicted') return [t('egInvalidateContradicted')]
  const items = supportOf(claim, sources)
  if (items.length === 0) return [t('egInvalidateNone')]
  const { runs, literature, files } = kindCounts(items)
  const phrases = [
    ...runs === 0 ? [] : [counted(runs, 'egRunsOne', 'egRunsMany', t)],
    ...literature === 0 ? [] : [counted(literature, 'egLiteratureOne', 'egLiteratureMany', t)],
    ...files === 0 ? [] : [counted(files, 'egFilesOne', 'egFilesMany', t)],
  ]
  const changed = items.filter(item => item.links.some(link => link.outdated)).map(item => sourceLabel(item.source, t))
  return [
    t('egInvalidateRests', { sources: phrases.join(t('egJoin')) }),
    ...claim.files.length === 0 ? [] : [t('egInvalidateFiles', { paths: claim.files.map(file => file.path).join(t('egJoin')) })],
    ...changed.length === 0 ? [] : [t('egInvalidateStale', { names: changed.join(t('egJoin')) })],
  ]
}

/**
 * The step to suggest for a claim, chosen from its status and what it cites or waits for.
 * @param claim - the claim.
 * @param sources - the graph's source nodes by id.
 * @returns the dictionary key of the suggestion.
 */
export function nextStepKey(claim: EvidenceGraphClaim, sources: ReadonlyMap<string, EvidenceGraphSource>): ResearchKey {
  const waiting = expectedRuns(claim, sources).length > 0
  switch (claim.status) {
    case 'contradicted': return 'egNextRevise'
    case 'stale': return 'egNextStale'
    case 'missing': return waiting ? 'egNextWait' : 'egNextMissing'
    case 'proposed':
      if (claim.links.length > 0) return 'egNextJudge'
      return waiting ? 'egNextWait' : 'egNextTest'
    case 'supported': return supportOf(claim, sources).length === 1 ? 'egNextSingle' : 'egNextOk'
  }
}

/**
 * Where a citation points inside its source, with the revision cited.
 * @param link - the citation.
 * @param t - bound dictionary lookup.
 * @returns for example `page 3 · rev. 1`.
 */
export function citationMeta(link: EvidenceGraphLink, t: Translate): string {
  return [locatorText(link.locator, t), t('revisionN', { n: link.revision })].filter(part => part !== '').join(' · ')
}
