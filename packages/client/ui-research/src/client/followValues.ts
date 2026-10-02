/**
 * The 对话 view's pure parts: finding the knowledge calls of the conversation's latest turn, folding what they touched
 * into one small graph, and placing it. Everything comes from the calls' own results; the research record is not
 * read. A node's ids are the ones the other views use, so a node is marked, struck through and found the same way
 * everywhere, and whether it is marked is read from the current marks, never from the trace.
 */
import type { ChatLocationNodeIndex, ChatNode, ChatNodeStore, ChatSnapshot, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  KnowledgeMarkView, KnowledgeTraceNode, KnowledgeTraceSource, RelationAuthor, RelationKindId,
} from '@deepseek-ai/dsh-research-workbench/types'
import { labelWidth } from './mapValues.ts'
import { knowledgeTraceOf } from './toolCallValues.ts'

/** The id of the idea node, which the recalls of a turn point from. */
export const IDEA = 'idea'
/** The wire name of the knowledge tool. */
const KNOWLEDGE_TOOL = 'research_knowledge'
/** Turns searched backward for knowledge calls; an older call is not the conversation's latest. */
export const SCANNED_TURNS = 12
/** Nodes the picture draws; the rest are counted. */
export const DRAWN_NODES = 14

/** The parts of the conversation's Chat target that the search for knowledge calls reads. */
export interface KnowledgeChat {
  timeline: Pick<ChatSnapshot['timeline'], 'turnOrder'>
  locations: Pick<ChatLocationNodeIndex, 'getTurn'>
  nodes: Pick<ChatNodeStore, 'get'>
}

/**
 * The settled, successful knowledge calls of one loaded turn, in the order the conversation shows them.
 * @param snapshot - the Chat target of the conversation.
 * @param turn - the turn's number.
 * @returns the calls' results.
 */
export function turnCalls(snapshot: KnowledgeChat, turn: number): ToolResultNode[] {
  const calls: ToolResultNode[] = []
  for (const key of snapshot.locations.getTurn(turn)) {
    const node = snapshot.nodes.get(key) as ChatNode | undefined
    if (node?.kind !== 'tool-call') continue
    const root = node.data.root
    if ('kind' in root && root.call?.name === KNOWLEDGE_TOOL && !root.isError) calls.push(root)
  }
  return calls
}

/**
 * The knowledge calls of one turn: the latest turn that has any, or the turn of a given call.
 * @param snapshot - the Chat target of the conversation.
 * @param callId - a call to find; when none of the latest turns holds it, the latest turn with a call answers.
 * @returns that turn's settled knowledge calls; empty when none of the latest turns holds one.
 */
export function knowledgeCallsOf(snapshot: KnowledgeChat, callId?: string): ToolResultNode[] {
  const turns = snapshot.timeline.turnOrder
  let latest: ToolResultNode[] | undefined
  for (let at = turns.length - 1; at >= Math.max(0, turns.length - SCANNED_TURNS); at--) {
    const calls = turnCalls(snapshot, turns[at] as number)
    if (calls.length === 0) continue
    if (callId === undefined || calls.some(call => call.callId === callId)) return calls
    latest ??= calls
  }
  return latest ?? []
}

/**
 * Whether two selections hold the same calls, so that a selector hook does not publish an equal list again.
 * @param left - one selection.
 * @param right - the other.
 * @returns true when each place holds the same result object.
 */
export function sameCalls(left: readonly ToolResultNode[], right: readonly ToolResultNode[]): boolean {
  return left.length === right.length && left.every((call, at) => call === right[at])
}

/** What a node of the picture is: a trace node, or the idea the turn's recalls started from. */
export interface FollowNode {
  id: string
  kind: KnowledgeTraceNode['kind'] | 'idea'
  source: KnowledgeTraceSource | 'idea'
  /** The name the call saw; the idea has none, the view names it. */
  label: string
  /** How the latest call that named it used it. */
  use: KnowledgeTraceNode['use']
  /** A built-in graph paper's index on the domain map. */
  index: number | undefined
}

/** A line of the picture. */
export interface FollowEdge {
  id: string
  /** `idea` for a recall's line from the idea; else the relation's kind. */
  kind: RelationKindId | 'idea'
  from: string
  to: string
  /** Who first recorded a relation; unknown for a hop of a path. */
  by: RelationAuthor | undefined
  /** The agent walked it: a pinned item of a recall, or a hop of a path it found. */
  walked: boolean
  /** A mark left the node it points at out of the recall. */
  skipped: boolean
}

/** A relation of the relation graph, as a line of the picture. */
export interface FollowRelation extends FollowEdge {
  kind: RelationKindId
}

/**
 * How a line reads, before the view's switches: left out by a mark, a relation the person recorded, one the agent
 * walked, or one it merely read.
 * @param edge - the line.
 * @returns the state.
 */
export function edgeState(edge: FollowEdge): 'skipped' | 'yours' | 'walked' | 'plain' {
  if (edge.skipped) return 'skipped'
  if (edge.by === 'user') return 'yours'
  return edge.walked ? 'walked' : 'plain'
}

/** What the knowledge calls of one turn touched, folded into one picture. */
export interface TurnTrace {
  /** The nodes the picture draws, in the order the calls named them. */
  nodes: FollowNode[]
  /** The lines between drawn nodes. */
  edges: FollowEdge[]
  /** The relations the person recorded that the calls read or walked, drawn or not. */
  added: FollowRelation[]
  /** The name of every node the calls named, drawn or not. */
  names: ReadonlyMap<string, string>
  /** The nodes on a walked line, and the pinned ones. */
  walked: ReadonlySet<string>
  /** The nodes each call touched, by call id. */
  touched: ReadonlyMap<string, ReadonlySet<string>>
  /** The latest recall's query: the idea. */
  query: string | undefined
  /** The knowledge calls of the turn. */
  calls: number
  /** Nodes named but not drawn. */
  hidden: number
}

type Use = NonNullable<KnowledgeTraceNode['use']>

/** How much a node deserves one of the drawn places. */
function weight(node: FollowNode, walked: ReadonlySet<string>): number {
  if (node.id === IDEA) return 6
  if (node.use === 'pinned' || walked.has(node.id)) return 5
  if (node.use === 'skipped') return 4
  return node.use === 'centre' || node.use === 'end' ? 3 : 1
}

/**
 * Fold the traces of one turn's knowledge calls into a picture: the idea when a recall happened, the nodes in the order the
 * calls named them, a relation once with its author, and a line from the idea to each item a recall returned or skipped.
 * @param calls - the turn's settled knowledge calls.
 * @returns the picture; undefined when no call kept a trace.
 */
export function turnTrace(calls: readonly ToolResultNode[]): TurnTrace | undefined {
  const traced = calls.flatMap((call) => {
    const trace = knowledgeTraceOf(call)
    return trace === undefined ? [] : [{ id: call.callId, trace }]
  })
  if (traced.length === 0) return undefined
  const named = new Map<string, FollowNode>()
  const relations = new Map<string, FollowRelation>()
  const recalled = new Map<string, Use>()
  const touched = new Map<string, ReadonlySet<string>>()
  let query: string | undefined
  let omitted = 0
  for (const { id, trace } of traced) {
    omitted += trace.omitted ?? 0
    if (trace.action === 'recall') query = trace.query ?? query
    touched.set(id, new Set(trace.nodes.map(node => node.id)))
    for (const node of trace.nodes) {
      const before = named.get(node.id)
      named.set(node.id, { ...node, use: node.use ?? before?.use, index: node.index ?? before?.index })
      if (trace.action === 'recall' && node.use !== undefined) recalled.set(node.id, node.use)
    }
    for (const edge of trace.edges) {
      const before = relations.get(edge.id)
      const walked = edge.walked === true || before?.walked === true
      relations.set(edge.id, { ...edge, by: edge.by ?? before?.by, walked, skipped: false })
    }
  }
  const lines: FollowEdge[] = [...relations.values()]
  if (query !== undefined) {
    named.set(IDEA, { id: IDEA, kind: 'idea', source: 'idea', label: '', use: undefined, index: undefined })
    for (const [id, use] of recalled) {
      lines.push({ id: `${IDEA}>${id}`, kind: 'idea', from: IDEA, to: id, by: undefined, walked: use === 'pinned', skipped: use === 'skipped' })
    }
  }
  const walked = new Set(lines.filter(line => line.walked).flatMap(line => [line.from, line.to]))
  const everyone = [...named.values()]
  const ranked = everyone.map((node, at) => ({ node, at })).sort((a, b) => weight(b.node, walked) - weight(a.node, walked) || a.at - b.at)
  const drawn = new Set(ranked.slice(0, DRAWN_NODES).map(({ node }) => node.id))
  return {
    nodes: everyone.filter(node => drawn.has(node.id)),
    edges: lines.filter(line => drawn.has(line.from) && drawn.has(line.to)),
    added: [...relations.values()].filter(relation => relation.by === 'user'),
    names: new Map(everyone.map(node => [node.id, node.label])),
    walked, touched, query, calls: calls.length, hidden: everyone.length - drawn.size + omitted,
  }
}

/** The logical width the picture is placed in; the view scales it to the panel. */
export const FOLLOW_WIDTH = 480
/** The logical height of the picture. */
export const FOLLOW_HEIGHT = 340
const CHIP_HEIGHT = 28
const EDGE_GAP = 6
/** The inner and outer ring, as shares of the picture's width and height. */
const RING = [{ x: 0.3, y: 0.3 }, { x: 0.41, y: 0.41 }] as const
/** A chip that would cover another turns this many degrees along its ring at a time, up to MAX_TURNS times. */
const TURN = 8
const MAX_TURNS = 23
/** The angles and ring scales a chip tries in turn, nearest its wanted place first. */
const TRIES = Array.from({ length: MAX_TURNS }, (_, step) => step).flatMap(step =>
  [1, 1.18, 0.82].flatMap(scale => (step === 0 ? [0] : [step * TURN, -step * TURN]).map(turn => ({ turn, scale }))))

/** A node with its place in the picture, its centre in logical pixels. */
export interface PlacedFollowNode {
  node: FollowNode
  x: number
  y: number
  width: number
}

/**
 * The width a node's chip takes.
 * @param text - the text on the chip.
 * @returns the width in logical pixels, bounded so that one name never takes the row.
 */
export function chipWidth(text: string): number {
  return Math.min(160, Math.max(48, labelWidth(text, 12, 26)))
}

/**
 * Place the nodes of a picture: the idea, or the most connected node, in the middle; its neighbours on an inner
 * ellipse; theirs, and any node no line reaches, on an outer one, each near its parent; then chips that would cover
 * each other move outward, and every chip is kept inside the picture. The same graph is placed the same way every time.
 * @param nodes - the drawn nodes.
 * @param edges - the lines between them.
 * @param widthOf - the width of each node's chip.
 * @returns the nodes with their places.
 */
export function followLayout(
  nodes: readonly FollowNode[], edges: readonly FollowEdge[], widthOf: (node: FollowNode) => number,
): PlacedFollowNode[] {
  if (nodes.length === 0) return []
  const near = new Map<string, string[]>(nodes.map(node => [node.id, []]))
  for (const edge of edges) { near.get(edge.from)?.push(edge.to); near.get(edge.to)?.push(edge.from) }
  const degree = (node: FollowNode): number => (near.get(node.id) as string[]).length
  // The first of the most connected nodes when the idea is not drawn; the list is not empty here, so reduce has a start.
  const middle = nodes.find(node => node.id === IDEA) ?? nodes.reduce((best, node) => degree(node) > degree(best) ? node : best)
  const level = new Map<string, number>([[middle.id, 0]])
  const parent = new Map<string, string>()
  const queue = [middle.id]
  for (const id of queue) {
    for (const next of near.get(id) as string[]) {
      // A line to a node that is not drawn leads nowhere.
      if (level.has(next) || !near.has(next)) continue
      level.set(next, (level.get(id) as number) + 1)
      parent.set(next, id)
      queue.push(next)
    }
  }
  const angle = new Map<string, number>()
  const inner = nodes.filter(node => level.get(node.id) === 1)
  inner.forEach((node, at) => { angle.set(node.id, -90 + 360 * (at + 0.5) / inner.length) })
  const outer = nodes.filter(node => !angle.has(node.id) && node.id !== middle.id)
  const children = new Map<string, FollowNode[]>()
  const loose: FollowNode[] = []
  for (const node of outer) {
    const owner = parent.get(node.id)
    if (owner !== undefined && angle.has(owner)) children.set(owner, [...children.get(owner) ?? [], node])
    else loose.push(node)
  }
  for (const [owner, group] of children) {
    const step = Math.min(34, 110 / group.length)
    group.forEach((node, at) => { angle.set(node.id, (angle.get(owner) as number) + (at - (group.length - 1) / 2) * step) })
  }
  loose.forEach((node, at) => { angle.set(node.id, -90 + 360 * (at + 0.25) / loose.length) })
  const centre = { x: FOLLOW_WIDTH / 2, y: FOLLOW_HEIGHT / 2 }
  const placed: PlacedFollowNode[] = []
  // The middle node goes first. Each other node takes the first place along its ring, then on rings a little off it,
  // where it covers no chip yet; when there is none, its own place.
  for (const node of [middle, ...nodes.filter(item => item !== middle)]) {
    const width = widthOf(node)
    const ring = level.get(node.id) === 1 ? RING[0] : RING[1]
    const bounded = (x: number, y: number): Spot => ({
      x: Math.min(FOLLOW_WIDTH - width / 2 - EDGE_GAP, Math.max(width / 2 + EDGE_GAP, x)),
      y: Math.min(FOLLOW_HEIGHT - CHIP_HEIGHT / 2 - EDGE_GAP, Math.max(CHIP_HEIGHT / 2 + EDGE_GAP, y)),
    })
    const wanted: Spot[] = node === middle ? [centre] : TRIES.map(({ turn, scale }) => {
      const radians = (((angle.get(node.id) as number) + turn) * Math.PI) / 180
      const reach = { x: ring.x * FOLLOW_WIDTH * scale, y: ring.y * FOLLOW_HEIGHT * scale }
      return bounded(centre.x + Math.cos(radians) * reach.x, centre.y + Math.sin(radians) * reach.y)
    })
    const free = wanted.find(spot => !placed.some(other => touching(other, spot.x, spot.y, width)))
    placed.push({ node, width, ...free ?? wanted[0] as Spot })
  }
  return nodes.map(node => placed.find(item => item.node === node) as PlacedFollowNode)
}

/** A place in the picture. */
interface Spot { x: number; y: number }

/** Whether a chip centred at (x, y) would cover or touch a placed one. */
function touching(other: PlacedFollowNode, x: number, y: number, width: number): boolean {
  return Math.abs(other.x - x) < (other.width + width) / 2 + EDGE_GAP && Math.abs(other.y - y) < CHIP_HEIGHT + EDGE_GAP
}

/**
 * The verdict of the person's mark on a node, read from the marks as they stand now.
 * @param marks - the research's marks.
 * @param id - a node id.
 * @returns `pin`, `irrelevant`, or undefined when the node is unmarked (or is no pattern or paper of a graph).
 */
export function verdictOf(marks: readonly KnowledgeMarkView[], id: string): KnowledgeMarkView['verdict'] | undefined {
  return marks.find(mark => mark.id === id)?.verdict
}
