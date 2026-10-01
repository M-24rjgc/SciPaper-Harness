/**
 * The relation graph's drawing: the centre entity with its halo, its neighbours and theirs, every relation a line
 * with a button at its midpoint that names it. Nodes and relation names are buttons, so the picture is reachable by
 * keyboard and read by name; the lines are decoration. The picture has a fixed pixel size and scrolls in its panel.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import type { RelationEdgeView, RelationNodeView } from '@deepseek-ai/dsh-research-workbench/types'
import type { Translate } from './format.ts'
import { NODE_HEIGHT, NODE_WIDTH, entityName, relationName, type RelationsLayout } from './relationsValues.ts'
import styles from './RelationsView.module.css'

/** What the graph draws and what it reports. */
export interface RelationsGraphProps {
  t: Translate
  layout: RelationsLayout
  /** The relation whose source the side panel shows. */
  selected: string | undefined
  /** Relations on the path being shown; they are drawn thick. */
  pathEdges: ReadonlySet<string>
  /** Nodes on the path being shown. */
  pathNodes: ReadonlySet<string>
  /** Centre the graph on a node. */
  focus: (node: RelationNodeView) => void
  /** Show a relation's source. */
  select: (edge: RelationEdgeView) => void
}

/** Component-local lengths handed to the stylesheet. */
function lengths(values: Record<`--rg-${string}`, number>): CSSProperties {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, `${value}px`]))
}

/** The state a relation's line is drawn in. */
function lineState(edge: RelationEdgeView, onPath: boolean): 'path' | 'stale' | 'plain' {
  return onPath ? 'path' : edge.status === 'stale' ? 'stale' : 'plain'
}

/**
 * The graph of one neighbourhood.
 * @param props - the layout, the selection and the path to light.
 * @returns the scrolling picture.
 */
export function RelationsGraph(props: RelationsGraphProps): ReactNode {
  const { t, layout } = props
  const scroller = useRef<HTMLDivElement>(null)
  // The centre is brought into view whenever the picture changes; a panel narrower than the picture scrolls to it.
  useEffect(() => {
    const element = scroller.current as HTMLDivElement
    element.scrollLeft = Math.max(0, layout.centre.x - element.clientWidth / 2)
    element.scrollTop = Math.max(0, layout.centre.y - element.clientHeight / 2)
  }, [layout])
  const names = new Map(layout.nodes.map(({ node }) => [node.id, node.name] as const))
  return <div ref={scroller} className={styles.scroller} data-relations-scroller>
    <div className={styles.canvas} role="group" aria-label={t('relationsGraph')} data-relations-graph
      style={lengths({ '--rg-width': layout.width, '--rg-height': layout.height, '--rg-node-width': NODE_WIDTH, '--rg-node-height': NODE_HEIGHT })}>
      <svg className={styles.lines} width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
        {layout.edges.map(({ edge, from, to, arrow }) => {
          const state = lineState(edge, props.pathEdges.has(edge.id))
          return <g key={edge.id} className={styles.stroke} data-state={state} data-selected={edge.id === props.selected}>
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
            <polygon points="0,0 -9,-4.5 -9,4.5" transform={`translate(${arrow.x} ${arrow.y}) rotate(${arrow.deg})`} />
          </g>
        })}
      </svg>
      {layout.edges.map(({ edge, label }) => {
        const state = lineState(edge, props.pathEdges.has(edge.id))
        const kind = relationName(edge.kind, t)
        const from = names.get(edge.from) as string, to = names.get(edge.to) as string
        return <button key={edge.id} type="button" className={styles.edgeLabel} data-state={state}
          aria-pressed={edge.id === props.selected}
          aria-label={`${t('relationsEdgeLabel', { from, kind, to })}${edge.status === 'stale' ? `, ${t('relationsOutdated')}` : ''}`}
          style={lengths({ '--rg-x': label.x, '--rg-y': label.y })} onClick={() => { props.select(edge) }}>
          {edge.status === 'stale' ? `${kind} · ${t('relationsStaleShort')}` : kind}
        </button>
      })}
      {layout.nodes.map(({ node, x, y }) => <button key={node.id} type="button" className={styles.node} data-kind={node.kind}
        data-ring={node.ring} data-core={node.core} data-status={node.status} data-on-path={props.pathNodes.has(node.id)}
        aria-current={node.ring === 0 ? 'true' : undefined} aria-label={t('relationsNodeLabel', { name: node.name, kind: entityName(node.kind, t) })}
        title={node.status === 'orphaned' ? `${node.name} · ${t('relationsOrphaned')}` : node.name}
        style={lengths({ '--rg-x': x, '--rg-y': y })} onClick={() => { props.focus(node) }}>
        <span className={styles.nodeKind}>{entityName(node.kind, t)}</span>
        <span className={styles.nodeName}>{node.name}</span>
      </button>)}
    </div>
  </div>
}
