/**
 * The Relations view's pure parts: the picture of a neighbourhood computed from the host's layout hints, and every
 * sentence the view derives from a relation, a path, a gap cell or a typed proposal. The picture needs no force
 * simulation and no measuring, so the same graph is drawn the same way every time.
 */
import type {
  EvidenceRecord, RelationEdgeView, RelationEndRef, RelationEntityKind, RelationGapCell, RelationGapPage, RelationGapState,
  RelationGroundSource, RelationGroundView, RelationHopView, RelationKindId, RelationNeighbourhoodView, RelationNodeSummary,
  RelationNodeView, RelationOutcomeView, RelationPathView,
} from '@deepseek-ai/dsh-research-workbench/types'
import { locatorText, type Translate } from './format.ts'
import type { ResearchKey } from './locales.ts'

/** The box every node is drawn in; edges end at its border. */
export const NODE_WIDTH = 132
export const NODE_HEIGHT = 44
/** Rings are ellipses, flatter than wide, because the panel is wider than tall. */
const ASPECT = 0.78
/** Room kept around the outermost nodes. */
const PAD_X = 28
const PAD_Y = 30
/** The first ring's smallest radius and the arc length each of its nodes needs. */
const RING_MIN = 210
const RING_SPACING = 140
/** Core nodes sit inside the first ring's radius, the others outside it. */
const CORE_FACTOR = 0.82
const OUTER_FACTOR = 1.1
/** How far the second ring lies beyond the first, and how far every other child is pushed out to keep neighbours apart. */
const RING_GAP = 170
const STAGGER = 48
/** The angle between two children of one parent stays within these bounds, in degrees. */
const MIN_STEP = 9
const MAX_STEP = 26
/** Parallel relations between one pair of nodes put their labels this share of the line apart. */
const LABEL_STEP = 0.18
/** Gap between an edge's arrowhead and the border of the node it points at. */
const ARROW_GAP = 3

/** A position in the picture, in pixels from its top-left corner. */
export interface Point { x: number; y: number }

/** A node with its place. */
export interface PlacedNode extends Point { node: RelationNodeView }

/** A relation with the ends of its line, the place of its label button and its arrowhead. */
export interface PlacedEdge {
  edge: RelationEdgeView
  from: Point
  to: Point
  label: Point
  /** The tip of the arrowhead at the `to` node's border, and the line's direction in degrees. */
  arrow: Point & { deg: number }
}

/** The picture of one neighbourhood. */
export interface RelationsLayout {
  width: number
  height: number
  nodes: PlacedNode[]
  edges: PlacedEdge[]
  /** Where the centre node sits, so a scrolling panel can bring it into view. */
  centre: Point
}

/** Where the label of a relation that meets the centre sits, as a share of the line measured from the centre. */
const LABEL_FROM_CENTRE = 0.6
/** The space kept between two node boxes, and how far a node that would cover another moves outward at a time (at most this many times). */
const CLEARANCE = 10
const PUSH = 24
const MAX_PUSHES = 40

/** Whether boxes centred on two points would touch. */
function touch(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < NODE_WIDTH + CLEARANCE && Math.abs(a.y - b.y) < NODE_HEIGHT + CLEARANCE
}

/** The wanted place, or the nearest place straight out from the origin where no earlier node's box is touched. */
function clear(wanted: Point, taken: readonly Point[]): Point {
  const length = Math.hypot(wanted.x, wanted.y)
  let spot = wanted
  for (let pushes = 0; length > 0 && pushes < MAX_PUSHES && taken.some(other => touch(spot, other)); pushes++) {
    spot = { x: spot.x + wanted.x / length * PUSH, y: spot.y + wanted.y / length * PUSH }
  }
  return spot
}

/** A point on an ellipse of the given radius at an angle measured clockwise from the right, in degrees. */
function onRing(angle: number, radius: number): Point {
  const radians = angle * Math.PI / 180
  return { x: Math.cos(radians) * radius, y: Math.sin(radians) * radius * ASPECT }
}

/** Nodes in the order the host's slots give, ties broken by id. */
function bySlot(a: RelationNodeView, b: RelationNodeView): number {
  return a.slot - b.slot || Number(a.id > b.id) - Number(a.id < b.id)
}

/**
 * Place a neighbourhood: the centre in the middle, the first ring around it in slot order with the `core` nodes nearer
 * than the rest, and each second-ring node on an arc beyond its parent in slot order.
 * @param view - the neighbourhood the host sent.
 * @returns the pixel size of the picture and the place of every node, line and label.
 */
export function relationsLayout(view: RelationNeighbourhoodView): RelationsLayout {
  const spots = new Map<string, Point>()
  const angles = new Map<string, number>()
  // A node whose box would cover an earlier one moves outward until it is clear, so the picture never stacks two nodes.
  const taken: Point[] = []
  const put = (id: string, wanted: Point): void => {
    const spot = clear(wanted, taken)
    taken.push(spot)
    spots.set(id, spot)
  }
  const first = view.nodes.filter(node => node.ring === 1).sort(bySlot)
  const inner = Math.max(RING_MIN, Math.round(first.length * RING_SPACING / (2 * Math.PI)))
  for (const node of view.nodes.filter(item => item.ring === 0)) put(node.id, { x: 0, y: 0 })
  first.forEach((node, at) => {
    const angle = -90 + 360 * at / first.length
    angles.set(node.id, angle)
    put(node.id, onRing(angle, Math.round(inner * (node.core ? CORE_FACTOR : OUTER_FACTOR))))
  })
  const outer = Math.round(inner * OUTER_FACTOR) + RING_GAP
  const children = new Map<string, RelationNodeView[]>()
  const orphans: RelationNodeView[] = []
  for (const node of view.nodes.filter(item => item.ring === 2).sort(bySlot)) {
    if (node.parent !== undefined && angles.has(node.parent)) children.set(node.parent, [...children.get(node.parent) ?? [], node])
    else orphans.push(node)
  }
  for (const [parent, group] of children) {
    const step = Math.min(MAX_STEP, Math.max(MIN_STEP, 360 / first.length / group.length * 0.9))
    group.forEach((node, at) => {
      put(node.id, onRing((angles.get(parent) as number) + (at - (group.length - 1) / 2) * step, outer + (at % 2) * STAGGER))
    })
  }
  orphans.forEach((node, at) => { put(node.id, onRing(-90 + 360 * (at + 0.5) / orphans.length, outer + STAGGER * 2)) })

  const raw = view.nodes.map(node => ({ node, ...spots.get(node.id) as Point }))
  const left = Math.min(0, ...raw.map(item => item.x)) - NODE_WIDTH / 2 - PAD_X
  const right = Math.max(0, ...raw.map(item => item.x)) + NODE_WIDTH / 2 + PAD_X
  const top = Math.min(0, ...raw.map(item => item.y)) - NODE_HEIGHT / 2 - PAD_Y
  const bottom = Math.max(0, ...raw.map(item => item.y)) + NODE_HEIGHT / 2 + PAD_Y
  const nodes = raw.map(item => ({ node: item.node, x: Math.round(item.x - left), y: Math.round(item.y - top) }))
  const at = new Map(nodes.map(item => [item.node.id, item] as const))

  // Relations between one pair of nodes, in either direction, spread their labels along the line.
  const pairKey = (edge: RelationEdgeView): string => edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`
  const joined = view.edges.filter(edge => at.has(edge.from) && at.has(edge.to))
  const groups = new Map<string, RelationEdgeView[]>()
  for (const edge of joined) groups.set(pairKey(edge), [...groups.get(pairKey(edge)) ?? [], edge])
  const edges = joined.map((edge): PlacedEdge => {
    const from = at.get(edge.from) as PlacedNode, to = at.get(edge.to) as PlacedNode
    const group = groups.get(pairKey(edge)) as RelationEdgeView[]
    const [near, far] = edge.from < edge.to ? [from, to] : [to, from]
    // The labels of relations that meet at the centre sit away from it, where the lines have fanned out.
    const anchor = near.node.ring === 0 ? LABEL_FROM_CENTRE : far.node.ring === 0 ? 1 - LABEL_FROM_CENTRE : 0.5
    const share = anchor + (group.indexOf(edge) - (group.length - 1) / 2) * LABEL_STEP
    const dx = to.x - from.x, dy = to.y - from.y
    const length = Math.hypot(dx, dy) || 1
    const ux = dx / length, uy = dy / length
    const reach = Math.min(NODE_WIDTH / 2 / Math.max(Math.abs(ux), 1e-6), NODE_HEIGHT / 2 / Math.max(Math.abs(uy), 1e-6)) + ARROW_GAP
    return {
      edge, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y },
      label: { x: Math.round(near.x + (far.x - near.x) * share), y: Math.round(near.y + (far.y - near.y) * share) },
      arrow: {
        x: Math.round(to.x - ux * reach), y: Math.round(to.y - uy * reach), deg: Math.round(Math.atan2(uy, ux) * 1800 / Math.PI) / 10,
      },
    }
  })
  const centre = at.get(view.center)
  return {
    width: Math.round(right - left), height: Math.round(bottom - top), nodes, edges,
    centre: { x: centre?.x ?? Math.round(-left), y: centre?.y ?? Math.round(-top) },
  }
}

/** The relations a path walks, for lighting them in the picture. */
export function pathRelations(path: RelationPathView | undefined): ReadonlySet<string> {
  return new Set(path?.hops.map(hop => hop.relation))
}

const RELATION_KEYS: Record<RelationKindId, ResearchKey> = {
  'cites': 'relationsRelCites', 'introduces': 'relationsRelIntroduces', 'is-a': 'relationsRelIsA', 'extends': 'relationsRelExtends',
  'improves-on': 'relationsRelImprovesOn', 'compares-with': 'relationsRelComparesWith', 'applied-to': 'relationsRelAppliedTo',
  'evaluated-on': 'relationsRelEvaluatedOn', 'measured-by': 'relationsRelMeasuredBy',
}
/**
 * What a recorded proposal did, in lines: whether the ground is new, and the repairs and warnings that came with it.
 * @param outcome - the host's outcome for the proposal, not a refusal.
 * @param t - bound dictionary lookup.
 * @returns the lines, the host's own warnings last and verbatim; empty for an outcome that is not a proposal's.
 */
export function outcomeNotes(outcome: Exclude<RelationOutcomeView, { status: 'refused' }>, t: Translate): string[] {
  if (!('created' in outcome)) return []
  return [
    t(outcome.status === 'added' ? 'relationsAdded' : outcome.status === 'regrounded' ? 'relationsMoved' : 'relationsAlready'),
    ...outcome.locatorCorrected ? [t('relationsLocatorFixed')] : [],
    ...outcome.restored ? [t('relationsWasRejected')] : [],
    ...outcome.created.length > 0 ? [t('relationsCreated', { n: outcome.created.length })] : [],
    ...outcome.warnings,
  ]
}

/** The relation kinds a person can propose: every one a quotation can ground. Citations come only from the citation lists. */
export const PROPOSABLE: readonly RelationKindId[] = [
  'introduces', 'is-a', 'extends', 'improves-on', 'compares-with', 'applied-to', 'evaluated-on', 'measured-by',
]
const ENTITY_KEYS: Record<RelationEntityKind, ResearchKey> = {
  method: 'relationsKindMethod', task: 'relationsKindTask', dataset: 'relationsKindDataset', metric: 'relationsKindMetric', paper: 'relationsKindPaper',
}
const SOURCE_KEYS: Record<RelationGroundSource, ResearchKey> = {
  'full-text': 'relationsSourceFullText', 'abstract': 'relationsSourceAbstract', 'file': 'relationsSourceFile', 'run': 'relationsSourceRun',
  'citation': 'relationsSourceCitation',
}
/** The kinds of node, in the order the legend and the entity pickers list them. */
export const ENTITY_KINDS: readonly RelationEntityKind[] = ['method', 'task', 'dataset', 'metric', 'paper']

/**
 * A relation kind in the reader's language, as it reads between its two ends.
 * @param kind - the relation kind.
 * @param t - bound dictionary lookup.
 * @returns the word or phrase.
 */
export function relationName(kind: RelationKindId, t: Translate): string {
  return t(RELATION_KEYS[kind])
}

/**
 * A node kind in the reader's language.
 * @param kind - the node kind.
 * @param t - bound dictionary lookup.
 * @returns 方法, 任务, 数据集, 指标 or 论文.
 */
export function entityName(kind: RelationEntityKind, t: Translate): string {
  return t(ENTITY_KEYS[kind])
}

/**
 * Where a ground comes from, in the reader's language.
 * @param source - the ground's source.
 * @param t - bound dictionary lookup.
 * @returns 全文, 摘要, 项目文件, 运行 or 引用.
 */
export function sourceName(source: RelationGroundSource, t: Translate): string {
  return t(SOURCE_KEYS[source])
}

/**
 * How many grounds a relation has from each kind of source.
 * @param sources - the counts by source, rejected grounds left out.
 * @param t - bound dictionary lookup.
 * @returns `全文 2 · 运行 1` for the sources with any ground; empty when none has.
 */
export function sourceCounts(sources: Record<RelationGroundSource, number>, t: Translate): string {
  return (Object.keys(SOURCE_KEYS) as RelationGroundSource[]).filter(source => sources[source] > 0)
    .map(source => `${sourceName(source, t)} ${sources[source]}`).join(' · ')
}

/**
 * Who recorded or decided something.
 * @param by - the author.
 * @param t - bound dictionary lookup.
 * @returns 你 or 助手.
 */
export function authorName(by: 'user' | 'agent', t: Translate): string {
  return t(by === 'user' ? 'relationsByUser' : 'relationsByAgent')
}

/**
 * A relation read from its first end to its second.
 * @param from - the first end's name.
 * @param kind - the relation kind.
 * @param to - the second end's name.
 * @param t - bound dictionary lookup.
 * @returns `A —kind→ B`.
 */
export function relationSentence(from: string, kind: RelationKindId, to: string, t: Translate): string {
  return t('relationsHopForward', { from, kind: relationName(kind, t), to })
}

/**
 * One hop in the direction the path walks it.
 * @param hop - the hop.
 * @param names - the name of a node by id; an unknown id reads as itself.
 * @param t - bound dictionary lookup.
 * @returns `A —kind→ B` for a hop walked along its relation, `A ←kind— B` for one walked against it.
 */
export function hopSentence(hop: RelationHopView, names: ReadonlyMap<string, string>, t: Translate): string {
  const name = (id: string): string => names.get(id) ?? id
  const forward = hop.direction === 'forward'
  return t(forward ? 'relationsHopForward' : 'relationsHopBackward', {
    from: name(forward ? hop.from : hop.to), kind: relationName(hop.kind, t), to: name(forward ? hop.to : hop.from),
  })
}

/**
 * A path as one line of names and kinds.
 * @param path - the path.
 * @param names - the name of a node by id.
 * @param t - bound dictionary lookup.
 * @returns the hops joined, each node named once.
 */
export function pathLine(path: RelationPathView, names: ReadonlyMap<string, string>, t: Translate): string {
  const name = (id: string): string => names.get(id) ?? id
  return path.hops.map((hop, at) => {
    const forward = hop.direction === 'forward'
    const kind = relationName(hop.kind, t)
    return `${at === 0 ? `${name(path.nodes[0] as string)} ` : ''}${forward ? `—${kind}→` : `←${kind}—`} ${name(path.nodes[at + 1] as string)}`
  }).join(' ')
}

/**
 * A chance as a percentage.
 * @param value - a number from 0 to 1.
 * @returns the rounded percentage.
 */
export function percent(value: number): number {
  return Math.round(value * 100)
}

/**
 * What a ground is and where it sits in its source.
 * @param ground - the ground.
 * @param t - bound dictionary lookup.
 * @returns its kind, its title and the place in the source, joined.
 */
export function groundMeta(ground: RelationGroundView, t: Translate): string {
  return [sourceName(ground.source, t), ground.title, ground.locator === undefined ? '' : locatorText(ground.locator, t)].filter(part => part !== '').join(' · ')
}

/**
 * The file that opens a ground's source: a literature record's full text when it has one, else its record.
 * @param record - the evidence record.
 * @returns the project-relative path.
 */
export function openPath(record: EvidenceRecord): string {
  return record.fullTextPath ?? record.path
}

/** The records a person can quote: literature and files; a run's results are not quotable. */
export function quotable(evidence: readonly EvidenceRecord[]): EvidenceRecord[] {
  return evidence.filter(record => record.kind !== 'experiment')
}

/** Whether the research holds anything to quote. */
export function hasSources(evidence: readonly EvidenceRecord[]): boolean {
  return quotable(evidence).length > 0
}

/** What a person typed for one end of a proposal. */
export interface EndInput { text: string; kind: RelationEntityKind }

/**
 * The node a proposal names for one end: a node already in the graph by id, name or alias; else a literature record by
 * title or id when the end is a paper; else a method, task, dataset or metric the proposal creates.
 * @param input - the typed name and the kind to create it as.
 * @param known - the nodes the view has seen.
 * @param evidence - the research's records.
 * @returns the reference, or the typed name of a paper that is not among the literature.
 */
export function endRef(
  input: EndInput, known: readonly RelationNodeSummary[], evidence: readonly EvidenceRecord[],
): RelationEndRef | { missing: string } {
  const text = input.text.trim()
  const key = text.toLowerCase()
  const named = (name: string): boolean => name.toLowerCase() === key
  const nodes = known.filter(node => node.id === text || named(node.name) || node.aliases.some(named))
  const node = nodes.find(item => item.kind === input.kind) ?? nodes[0]
  if (node !== undefined) return { id: node.id }
  if (input.kind !== 'paper') return { kind: input.kind, name: text }
  const record = evidence.find(item => item.kind === 'literature' && (item.id === text || item.title.toLowerCase() === key))
  return record === undefined ? { missing: text } : { kind: 'paper', evidenceId: record.id }
}

const GAP_SHORT: Record<RelationGapState, ResearchKey> = {
  'reported': 'relationsGapShortReported', 'project-only': 'relationsGapShortProjectOnly', 'stale': 'relationsGapShortStale',
  'mentioned': 'relationsGapShortMentioned', 'absent': 'relationsGapShortAbsent', 'uncovered': 'relationsGapShortUncovered',
}
const GAP_FULL: Record<RelationGapState, ResearchKey> = {
  'reported': 'relationsGapReported', 'project-only': 'relationsGapProjectOnly', 'stale': 'relationsGapStale',
  'mentioned': 'relationsGapMentioned', 'absent': 'relationsGapAbsent', 'uncovered': 'relationsGapUncovered',
}
/** The states in the order the legend lists them. */
export const GAP_STATES: readonly RelationGapState[] = ['reported', 'project-only', 'stale', 'mentioned', 'absent', 'uncovered']

/** The count a state's sentence carries: the papers that report it, or the passages that name both. */
function gapCount(state: RelationGapState, cell: RelationGapCell | undefined): string | number {
  if (cell === undefined) return 'N'
  return state === 'mentioned' ? cell.passages : cell.papers
}

/**
 * A cell's few words.
 * @param cell - the cell.
 * @param t - bound dictionary lookup.
 * @returns the count or the short name of its state.
 */
export function gapShort(cell: RelationGapCell, t: Translate): string {
  return t(GAP_SHORT[cell.state], { n: gapCount(cell.state, cell) })
}

/**
 * What a state says about the project's own literature.
 * @param state - the state.
 * @param cell - the cell whose count the sentence carries; without it the count reads N, as in the legend.
 * @param t - bound dictionary lookup.
 * @returns the sentence; none of them says that nobody has tested a pair or that the field has a gap.
 */
export function gapSentence(state: RelationGapState, cell: RelationGapCell | undefined, t: Translate): string {
  return t(GAP_FULL[state], { n: gapCount(state, cell) })
}

/**
 * The numbers behind a cell, for its tooltip.
 * @param cell - the cell.
 * @param t - bound dictionary lookup.
 * @returns every count the cell carries.
 */
export function gapCounts(cell: RelationGapCell, t: Translate): string {
  return t('relationsGapCounts', {
    papers: cell.papers, via: cell.viaSubtypes, runs: cell.runs, files: cell.files, stale: cell.stale,
    passages: cell.passages, rejected: cell.rejected,
  })
}

/**
 * What the matrix rests on.
 * @param basis - the coverage the host reports.
 * @param t - bound dictionary lookup.
 * @returns how many records had full text, only an abstract or only metadata, and how many files.
 */
export function coverageText(basis: RelationGapPage['basis'], t: Translate): string {
  return t('relationsGapBasis', basis)
}

/**
 * The one line under the matrix: how many cells the project's sources leave unreported or uncovered, never a claim about the field.
 * @param page - the matrix.
 * @param t - bound dictionary lookup.
 * @returns the line.
 */
export function gapTakeaway(page: RelationGapPage, t: Translate): string {
  const cells = page.cells.flat()
  const blank = cells.filter(cell => cell.state === 'absent').length
  const uncovered = cells.filter(cell => cell.state === 'uncovered').length
  return blank + uncovered === 0 ? t('relationsGapTakeawayNone') : t('relationsGapTakeaway', { blank, uncovered })
}

/** The states present in a matrix, in legend order. */
export function statesIn(page: RelationGapPage): RelationGapState[] {
  const present = new Set(page.cells.flat().map(cell => cell.state))
  return GAP_STATES.filter(state => present.has(state))
}

/** Every node a view has seen, once each. */
export function knownNodes(...lists: readonly (readonly RelationNodeSummary[])[]): RelationNodeSummary[] {
  return [...new Map(lists.flat().map(node => [node.id, node] as const)).values()]
}

/** The names of nodes by id. */
export function nameIndex(nodes: readonly RelationNodeSummary[]): Map<string, string> {
  return new Map(nodes.map(node => [node.id, node.name] as const))
}
