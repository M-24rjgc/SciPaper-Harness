/**
 * The 对话 view's picture: the nodes a turn's knowledge calls touched as chips, joined by the lines between them. A
 * chip is a button, so the picture is reachable by keyboard and read by name; the lines are decoration. The agent's
 * walked lines are drawn thick while the highlight is on, and a chip reads pinned or struck through from the marks as
 * they stand now.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { KnowledgeMarkView } from '@deepseek-ai/dsh-research-workbench/types'
import type { Translate } from './format.ts'
import { clipped } from './mapValues.ts'
import { edgeState, FOLLOW_HEIGHT, FOLLOW_WIDTH, IDEA, verdictOf, type FollowEdge, type FollowNode, type PlacedFollowNode } from './followValues.ts'
import styles from './Follow.module.css'

/** What the picture draws and what it reports. */
export interface FollowGraphProps {
  t: Translate
  nodes: readonly PlacedFollowNode[]
  edges: readonly FollowEdge[]
  /** The marks as they stand now. */
  marks: readonly KnowledgeMarkView[]
  /** Whether the agent follows the marks: a mark that is paused changes how a chip looks no more. */
  honour: boolean
  /** Draw the lines the agent walked thick. */
  highlight: boolean
  /** The relations rejected since the call read them. */
  rejected: ReadonlySet<string>
  /** The node in focus. */
  selected: string | undefined
  /** The nodes of the call the person came from. */
  touched: ReadonlySet<string> | undefined
  /** The nodes on a walked line. */
  walked: ReadonlySet<string>
  select: (node: FollowNode) => void
}

/** The characters a chip shows of a name. */
const CHIP_CHARS = 22

/**
 * The text on a chip.
 * @param node - the node.
 * @param t - bound dictionary lookup.
 * @returns the idea's name, or the node's name cut to fit.
 */
export function chipText(node: FollowNode, t: Translate): string {
  return node.id === IDEA ? t('kfIdea') : clipped(node.label, CHIP_CHARS)
}

/** Component-local positions handed to the stylesheet, in per cent of the picture. */
function place(x: number, y: number): CSSProperties {
  return Object.fromEntries([['--fg-x', `${(x / FOLLOW_WIDTH * 100).toFixed(2)}%`], ['--fg-y', `${(y / FOLLOW_HEIGHT * 100).toFixed(2)}%`]])
}

/** The state a line is drawn in. */
function lineState(edge: FollowEdge, props: Pick<FollowGraphProps, 'highlight' | 'rejected'>): string {
  const state = edgeState(edge)
  if (props.rejected.has(edge.id)) return 'rejected'
  return state === 'walked' && !props.highlight ? 'plain' : state
}

/**
 * How a chip looks: the idea, a pinned or not relevant mark while the agent follows marks, a node on a walked line
 * while the highlight is on, else plain.
 */
function look(node: FollowNode, props: FollowGraphProps): string {
  if (node.id === IDEA) return 'idea'
  const verdict = props.honour ? verdictOf(props.marks, node.id) : undefined
  if (verdict === 'pin') return 'pinned'
  if (verdict === 'irrelevant') return 'struck'
  return props.highlight && props.walked.has(node.id) ? 'walked' : 'plain'
}

/**
 * The picture of one turn's knowledge calls.
 * @param props - the placed nodes and lines, the marks, and the switches.
 * @returns the picture.
 */
export function FollowGraph(props: FollowGraphProps): ReactNode {
  const { t } = props
  const at = new Map(props.nodes.map(placed => [placed.node.id, placed] as const))
  return <div className={styles.scroller}>
    <div className={styles.canvas} role="group" aria-label={t('kfGraph')} data-follow-graph data-highlight={props.highlight}>
      <svg className={styles.lines} viewBox={`0 0 ${FOLLOW_WIDTH} ${FOLLOW_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
        {props.edges.map((edge) => {
          const from = at.get(edge.from) as PlacedFollowNode, to = at.get(edge.to) as PlacedFollowNode
          return <line key={edge.id} className={styles.line} data-state={lineState(edge, props)} data-kind={edge.kind}
            x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
        })}
      </svg>
      {props.nodes.map(({ node, x, y }) => {
        const verdict = props.honour ? verdictOf(props.marks, node.id) : undefined
        const text = chipText(node, t)
        return <button key={node.id} type="button" className={styles.node} data-node={node.id} data-kind={node.kind} data-look={look(node, props)}
          data-touched={props.touched?.has(node.id) === true} aria-pressed={props.selected === node.id}
          aria-label={verdict === 'pin' ? t('kfChipPinned', { name: text }) : verdict === 'irrelevant' ? t('kfChipIrrelevant', { name: text }) : text}
          title={node.label === '' ? text : node.label} style={place(x, y)} onClick={() => { props.select(node) }}>
          {text}
        </button>
      })}
    </div>
  </div>
}
