/**
 * 对话 (Conversation): a small graph of what the agent touched in the conversation's latest turn, drawn from the results
 * of its knowledge calls and kept beside the conversation. The idea, the items a recall returned, pinned or left out
 * by the person's marks, the relations it read and the paths it walked are drawn; a switch lights the path it took.
 * Under the picture are the person's marks, with the switch that tells the agent to follow them and a way to take each
 * one off: the same commands the Domain map uses. An example research can be looked at, never marked.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { KnowledgeMarkView, ResearchProject, ResearchSnapshot } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkbenchProps } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import { counted } from './format.ts'
import { FollowGraph, chipText } from './FollowGraph.tsx'
import { chipWidth, edgeState, followLayout, turnTrace, verdictOf, type FollowNode } from './followValues.ts'
import { MarksCard, type MarksCardRelation } from './MarksCard.tsx'
import { entityName, relationSentence } from './relationsValues.ts'
import styles from './Follow.module.css'

/** The view's inputs: the research face, the research, and the turn on show. */
export type FollowViewProps = WorkbenchProps & {
  project: ResearchProject
  /** The knowledge calls of the turn to draw: the latest turn that has any, or the turn of the call the person came from. */
  calls: readonly ToolResultNode[]
  /** The call the person came from; the nodes it touched are ringed. */
  call?: string | undefined
  /** The node to bring into focus. */
  node?: string | undefined
  /** Follow the latest turn again; given only while the view shows a chosen call's turn. */
  release?: (() => void) | undefined
  /** Which knowledge plugins are on: the marks need the graph engine, the added relations the relation graph. */
  knowledge: NonNullable<ResearchSnapshot['knowledge']>
}

/** How the line a node is drawn on reads in the focus strip. */
const USE_KEYS = {
  pinned: 'kfUsePinned', recalled: 'kfUseRecalled', skipped: 'kfUseSkipped', centre: 'kfUseCentre', end: 'kfUseEnd',
} as const

/** The verdict a call already acted on, by how it used a node; a mark that says the same is not repeated in the focus strip. */
const USED_AS = { pinned: 'pin', skipped: 'irrelevant', recalled: undefined, centre: undefined, end: undefined } as const

/** The kinds of line the legend explains, in the order it lists them. */
const LEGEND = [
  { state: 'walked', key: 'kfLegendWalked' }, { state: 'plain', key: 'kfLegendRead' },
  { state: 'yours', key: 'kfLegendYours' }, { state: 'skipped', key: 'kfLegendSkipped' },
] as const

/** What a node is called in the focus strip: the idea, a pattern, a paper, or the relation graph's kind of entity. */
function kindText(node: FollowNode, t: WorkbenchProps['t']): string {
  if (node.kind === 'idea') return t('kfIdea')
  if (node.kind === 'pattern') return t('kgPattern')
  return node.source === 'relations' ? entityName(node.kind, t) : t('kgPaper')
}

/**
 * The view of the conversation's latest knowledge calls.
 * @param props - the research face, the research and the calls to draw.
 * @returns the picture with its marks, or the line that the agent has not used the graph yet.
 */
export function FollowView(props: FollowViewProps): ReactNode {
  const { project, t, knowledge } = props
  const trace = useMemo(() => turnTrace(props.calls), [props.calls])
  const [highlight, setHighlight] = useState(true)
  const [selected, setSelected] = useState(props.node)
  const [rejected, setRejected] = useState<ReadonlySet<string>>(() => new Set())
  const read = props.useMarks(state => state[project.id])
  const marks = read?.marks ?? []
  const honour = read?.honour ?? true
  const change = useAction()
  const readOnly = project.example === true
  const added = trace?.added ?? []

  // The marks are read again whenever the record changes or another turn's calls come.
  useEffect(() => { if (knowledge.enabled) props.readMarks(project.id) }, [project.id, project.revision, props.calls])
  // Which of the relations the person recorded still stand: the relation graph lists the ones rejected since.
  useEffect(() => {
    if (!knowledge.modules.relations || added.length === 0) return
    let current = true
    props.run({ action: 'relations-graph', projectId: project.id, hops: 1, maxNodes: 1 }).then((result) => {
      if (current) setRejected(new Set(result.relations?.rejected.map(item => item.id)))
    }).catch((_error: unknown) => {
      // The relation graph could not be read, so every relation the person recorded stays listed.
    })
    return () => { current = false }
  }, [project.id, project.revision, knowledge.modules.relations, added.length])

  const placed = useMemo(
    () => trace === undefined ? [] : followLayout(trace.nodes, trace.edges, node => chipWidth(chipText(node, t))),
    [trace, t],
  )
  const focus = trace?.nodes.find(node => node.id === selected)
  const legend = LEGEND.filter(item => trace?.edges.some(edge => edgeState(edge) === item.state))
  // A relation whose end the calls did not name is read by that end's id.
  const nameOf = (id: string): string => trace?.names.get(id) ?? id
  const standing: MarksCardRelation[] = added.filter(edge => !rejected.has(edge.id)).map(edge => ({
    id: edge.id, sentence: relationSentence(nameOf(edge.from), edge.kind, nameOf(edge.to), t),
  }))

  const undo = (mark: KnowledgeMarkView): void => { change.start(() => props.run({ action: 'unmark', projectId: project.id, id: mark.id })) }
  const follow = (next: boolean): void => { change.start(() => props.run({ action: 'honour-marks', projectId: project.id, honour: next })) }
  const undoRelation = (relation: MarksCardRelation): void => {
    change.start(async () => {
      await props.run({ action: 'relations-reject', projectId: project.id, relation: relation.id })
      setRejected(previous => new Set([...previous, relation.id]))
    })
  }

  return <section className={styles.view} data-follow-view>
    <div className={styles.head}>
      <h3 className={styles.title}>{t('kfTitle')}</h3>
      {trace !== undefined && <button type="button" className={styles.toggle} aria-pressed={highlight} onClick={() => { setHighlight(value => !value) }}>{t('kfHighlight')}</button>}
    </div>
    {trace === undefined && <div className={styles.empty} data-follow-empty>
      <h4 className={styles.emptyTitle}>{t('kfEmptyTitle')}</h4>
      <p className={styles.emptyBody}>{t('kfEmptyBody')}</p>
    </div>}
    {trace !== undefined && <>
      <FollowGraph t={t} nodes={placed} edges={trace.edges} marks={marks} honour={honour} highlight={highlight} rejected={rejected}
        selected={selected} touched={props.call === undefined ? undefined : trace.touched.get(props.call)} walked={trace.walked}
        select={(node) => { setSelected(node.id === selected ? undefined : node.id) }} />
      <ul className={styles.legend}>
        {legend.map(item => <li key={item.state} className={styles.legendItem}>
          <span className={styles.swatch} data-state={item.state} aria-hidden="true" />{t(item.key)}
        </li>)}
      </ul>
      <p className={styles.caption}>
        {counted(trace.calls, 'kfCallsOne', 'kfCalls', t)}{trace.hidden > 0 && ` · ${t('kfHidden', { n: trace.hidden })}`}
      </p>
      {props.release !== undefined && <p className={styles.earlier}>
        {t('kfEarlier')}<button type="button" className={styles.link} onClick={props.release}>{t('kfLatest')}</button>
      </p>}
      {focus !== undefined && <Focus t={t} node={focus} query={trace.query} verdict={honour ? verdictOf(marks, focus.id) : undefined} />}
    </>}
    {knowledge.enabled && <>
      <MarksCard t={t} marks={marks} honour={honour} pending={change.pending} readOnly={readOnly} undo={undo} setHonour={follow}
        relations={standing} undoRelation={knowledge.modules.relations ? undoRelation : undefined}
        notes={{ on: t('kfHonourOn'), off: t('kfHonourOff') }} />
      <ActionError t={t} error={change.error} />
    </>}
  </section>
}

/** The node in focus: what it is, how the agent used it, and what the person's mark says now. */
function Focus(props: { t: WorkbenchProps['t']; node: FollowNode; query: string | undefined; verdict: KnowledgeMarkView['verdict'] | undefined }): ReactNode {
  const { t, node } = props
  return <div className={styles.focus} data-follow-focus>
    <div className={styles.focusHead}>
      <span className={styles.focusKind}>{kindText(node, t)}</span><strong className={styles.focusName}>{node.kind === 'idea' ? props.query : node.label}</strong>
    </div>
    {node.kind !== 'idea' && <p className={styles.focusLine}>{t(node.use === undefined ? 'kfUseRead' : USE_KEYS[node.use])}</p>}
    {props.verdict !== undefined && props.verdict !== USED_AS[node.use ?? 'recalled'] &&
      <p className={styles.focusLine}>{t(props.verdict === 'pin' ? 'kfNodePinned' : 'kfNodeIrrelevant')}</p>}
  </div>
}
