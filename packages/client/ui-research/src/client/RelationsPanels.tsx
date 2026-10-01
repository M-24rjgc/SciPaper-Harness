/**
 * The cards beside the relation graph that read it: how two things connect, what the selected relation rests on, and
 * the relations the person rejected. Each card keeps its own pending state and failure line, and none of them writes
 * to an example research.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  EvidenceRecord, RelationEdgeView, RelationGroundView, RelationNodeSummary, RelationPathsPage, RelationPathView, RelationRegroundView,
  RelationRejectedView, ResearchCommand, ResearchProject,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkbenchProps } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import { counted, dateText, type Translate } from './format.ts'
import {
  authorName, entityName, groundMeta, hopSentence, nameIndex, openPath, pathLine, percent, relationSentence, sourceCounts,
} from './relationsValues.ts'
import styles from './RelationsView.module.css'

/** What every card of the view is given. */
export interface PanelProps {
  t: Translate
  run: WorkbenchProps['run']
  project: ResearchProject
  /** An example research can be looked at, not changed. */
  readOnly: boolean
  /** Counts the view's rereads; a card that reads on its own asks again when it changes. */
  tick: number
  /** Ask every card to read again. */
  reread: () => void
}

/** The failure text of a thrown value. */
export function failure(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** Why the host refused a change, in its own words. */
export function Refused(props: { t: Translate; message: string }): ReactNode {
  return props.message === '' ? null : <p className={styles.refusal} role="alert">{props.t('relationsRefused', { message: props.message })}</p>
}

/** The attributes of a button that writes: disabled in an example, with the reason as its title. */
export function writes(props: Pick<PanelProps, 't' | 'readOnly'>, busy: boolean): { disabled: boolean; title: string | undefined } {
  return { disabled: props.readOnly || busy, title: props.readOnly ? props.t('relationsExampleReadOnly') : undefined }
}

/** One end of a path being asked for: the typed name, and the id when it was picked from the suggestions. */
interface End { text: string; id?: string | undefined }

const NONE_KEYS = {
  'unknown-node': 'relationsPathUnknown', 'ambiguous-node': 'relationsPathAmbiguous', 'same-node': 'relationsPathSame', 'no-path': 'relationsPathNone',
} as const

/** The cards' lists of choices when two ends are ambiguous. */
function Candidates(props: { t: Translate; side: 'from' | 'to'; nodes: readonly RelationNodeSummary[]; pick: (node: RelationNodeSummary) => void }): ReactNode {
  const { t } = props
  return props.nodes.length < 2 ? null : <ul className={styles.choices}>
    {props.nodes.map(node => <li key={node.id}>
      <button type="button" className={styles.choice} data-side={props.side} onClick={() => { props.pick(node) }}>
        {t('relationsNodeLabel', { name: node.name, kind: entityName(node.kind, t) })}
      </button>
    </li>)}
  </ul>
}

/** One path as a chain: each hop's sentence with its best ground. */
function Chain(props: { t: Translate; path: RelationPathView; names: ReadonlyMap<string, string> }): ReactNode {
  const { t, path } = props
  return <ol className={styles.chain}>
    {path.hops.map(hop => <li key={hop.relation} className={styles.hop} data-status={hop.status}>
      <p className={styles.hopSentence}>
        <span>{hopSentence(hop, props.names, t)}</span>
        {hop.status === 'stale' && <Tag tone="warning">{t('relationsStaleShort')}</Tag>}
      </p>
      {hop.grounds.slice(0, 1).map(ground => <div key={ground.id} className={styles.ground}>
        {ground.quote !== undefined && <blockquote className={styles.quote}>{ground.quote}</blockquote>}
        <span className={styles.meta}>{groundMeta(ground, t)}</span>
      </div>)}
    </li>)}
  </ol>
}

/**
 * 两件事之间怎么连起来: two entities, the best path between them as a readable chain with the words that ground each hop,
 * the other paths folded away, and the reasons there is none in plain words. The chosen path is lit in the graph.
 * @param props - the cards' shared props, the centre, the nodes to suggest, and the graph's path seat.
 * @returns the card.
 */
export function PathCard(props: PanelProps & {
  centre: RelationNodeSummary | undefined
  pool: readonly RelationNodeSummary[]
  /** Light a path in the graph; called with undefined when there is none. */
  show: (path: RelationPathView | undefined) => void
}): ReactNode {
  const { t, project } = props
  const [fromEnd, setFromEnd] = useState<End | undefined>()
  const [toEnd, setToEnd] = useState<End>({ text: '' })
  const [result, setResult] = useState<RelationPathsPage | undefined>()
  const [index, setIndex] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const asked = useRef<{ from: End; to: End } | undefined>(undefined)
  const latest = useRef(0)
  const toInput = useRef<HTMLInputElement>(null)
  const list = useId()
  // Until the person types a start, it is the entity the graph is centred on.
  const from: End = fromEnd ?? { text: props.centre?.name ?? '', id: props.centre?.id }
  const ask = (start: End, end: End): void => {
    asked.current = { from: start, to: end }
    const ticket = ++latest.current
    setPending(true); setError('')
    props.run({ action: 'relations-paths', projectId: project.id, from: start.id ?? start.text, to: end.id ?? end.text, k: 3 }).then((response) => {
      if (ticket !== latest.current) return
      if (!response.relationPaths) throw new Error(t('kgNoResponse'))
      setResult(response.relationPaths); setIndex(0)
      props.show(response.relationPaths.paths[0])
    }).catch((reason: unknown) => {
      if (ticket === latest.current) setError(failure(reason))
    }).finally(() => { if (ticket === latest.current) setPending(false) })
  }
  // A changed record can change the paths, so the question asked last is asked again.
  useEffect(() => {
    if (asked.current !== undefined) ask(asked.current.from, asked.current.to)
    return () => { latest.current++ }
  }, [project.id, project.revision, props.tick])
  const pick = (side: 'from' | 'to', node: RelationNodeSummary): void => {
    const end = { text: node.name, id: node.id }
    if (side === 'from') { setFromEnd(end); ask(end, toEnd) } else { setToEnd(end); ask(from, end) }
  }
  const another = (): void => {
    const input = toInput.current as HTMLInputElement
    latest.current++
    asked.current = undefined
    setFromEnd(undefined); setToEnd({ text: '' }); setResult(undefined); setError(''); setPending(false)
    props.show(undefined)
    input.focus()
  }
  const choose = (at: number): void => {
    setIndex(at)
    props.show((result as RelationPathsPage).paths[at])
  }
  const names = nameIndex(result?.nodes ?? [])
  const path = result?.paths[index]
  return <section className={styles.card} data-relations-paths aria-busy={pending}>
    <h4 className={styles.cardTitle}>{t('relationsPathTitle')}</h4>
    <form className={styles.pair} onSubmit={(event) => { event.preventDefault(); ask(from, toEnd) }}>
      <label className={styles.field}><span>{t('relationsFrom')}</span>
        <input list={list} value={from.text} onChange={(event) => { setFromEnd({ text: event.target.value }) }} />
      </label>
      <label className={styles.field}><span>{t('relationsTo')}</span>
        <input ref={toInput} list={list} value={toEnd.text} onChange={(event) => { setToEnd({ text: event.target.value }) }} />
      </label>
      <datalist id={list}>{props.pool.map(node => <option key={node.id} value={node.name} label={entityName(node.kind, t)} />)}</datalist>
      <div className={styles.row}>
        <button type="submit" className={styles.primary} disabled={pending || from.text.trim() === '' || toEnd.text.trim() === ''}>
          {t(pending ? 'relationsPathFinding' : 'relationsPathFind')}
        </button>
        <button type="button" className={styles.secondary} onClick={another}>{t('relationsPathAnother')}</button>
      </div>
    </form>
    <ActionError t={t} error={error} />
    {result?.none !== undefined && <p className={styles.line}>{t(NONE_KEYS[result.none])}</p>}
    {result?.candidates !== undefined && <>
      <Candidates t={t} side="from" nodes={result.candidates.from} pick={(node) => { pick('from', node) }} />
      <Candidates t={t} side="to" nodes={result.candidates.to} pick={(node) => { pick('to', node) }} />
    </>}
    {result !== undefined && path !== undefined && <>
      <p className={styles.line}>
        {counted(result.paths.length, 'relationsPathFoundOne', 'relationsPathFoundMany', t)}{' '}
        {t(index === 0 ? 'relationsPathBest' : 'relationsPathChosen', {
          hops: counted(path.hops.length, 'relationsHopsOne', 'relationsHopsMany', t), confidence: percent(path.confidence),
        })}
      </p>
      {path.stale && <p className={styles.warn}>{t('relationsPathStale')}</p>}
      <Chain t={t} path={path} names={names} />
      {result.paths.length > 1 && <details className={styles.more}>
        <summary>{t('relationsPathOthers', { n: result.paths.length - 1 })}</summary>
        <ul className={styles.others}>
          {result.paths.map((other, at) => at === index ? null : <li key={other.nodes.join('>')} className={styles.other}>
            <span>{pathLine(other, names, t)}</span>
            <button type="button" className={styles.link} onClick={() => { choose(at) }}>{t('relationsPathShow')}</button>
          </li>)}
        </ul>
      </details>}
    </>}
  </section>
}

/** The reason field and its two buttons, shown where the person is rejecting something. */
function RejectForm(props: {
  t: Translate
  reason: string
  busy: boolean
  setReason: (reason: string) => void
  confirm: () => void
  cancel: () => void
}): ReactNode {
  const { t } = props
  return <form className={styles.reject} onSubmit={(event) => { event.preventDefault(); props.confirm() }}>
    <input aria-label={t('relationsRejectWhy')} placeholder={t('relationsRejectWhy')} value={props.reason} maxLength={280}
      onChange={(event) => { props.setReason(event.target.value) }} />
    <button type="submit" className={styles.danger} disabled={props.busy}>{t('relationsRejectConfirm')}</button>
    <button type="button" className={styles.secondary} onClick={props.cancel}>{t('cancel')}</button>
  </form>
}

/** One ground of the selected relation, with the source's own words. */
function GroundItem(props: PanelProps & {
  ground: RelationGroundView
  record: EvidenceRecord | undefined
  busy: boolean
  open: (record: EvidenceRecord) => void
  reject: () => void
  restore: () => void
}): ReactNode {
  const { t, ground, record } = props
  const lock = writes(props, props.busy)
  return <li className={styles.groundItem} data-status={ground.status}>
    <span className={styles.meta}>{groundMeta(ground, t)}</span>
    {ground.setting !== undefined && <span className={styles.meta}>{t('relationsSetting', { setting: ground.setting })}</span>}
    {ground.quote !== undefined && <blockquote className={styles.quote}>{ground.quote}</blockquote>}
    {ground.by !== undefined && <span className={styles.meta}>{t('relationsRecordedBy', { who: authorName(ground.by, t) })}</span>}
    {ground.status === 'outdated' && <p className={styles.warn}>{t('relationsOutdated')}</p>}
    {ground.rejection !== undefined && <p className={styles.warn}>
      {t('relationsRejectedBy', { who: authorName(ground.rejection.by, t), date: dateText(ground.rejection.at, t) })}
      {ground.rejection.reason !== undefined && ` · ${t('relationsRejectedWhy', { reason: ground.rejection.reason })}`}
    </p>}
    <div className={styles.row}>
      {ground.evidenceId !== undefined && <button type="button" className={styles.secondary} disabled={record === undefined}
        title={record === undefined ? t('relationsOpenGone') : undefined} onClick={() => { props.open(record as EvidenceRecord) }}>{t('relationsOpen')}</button>}
      {ground.status === 'rejected'
        ? <button type="button" className={styles.secondary} {...lock} onClick={props.restore}>{t('relationsRestoreGround')}</button>
        : <button type="button" className={styles.danger} {...lock} onClick={props.reject}>{t('relationsRejectGround')}</button>}
    </div>
  </li>
}

/**
 * 选中的关系: who it joins, who recorded it, and every ground with the source's own words, where in the source they
 * sit and whether the source has changed since. The person can open the source, reject the relation or one ground,
 * check outdated grounds against the sources again, or add another relation.
 * @param props - the cards' shared props and the selected relation.
 * @returns the card; the owner keys it by relation.
 */
export function RelationCard(props: PanelProps & {
  edge: RelationEdgeView | undefined
  names: ReadonlyMap<string, string>
  openFile: WorkbenchProps['openFile']
  add: (edge: RelationEdgeView) => void
}): ReactNode {
  const { t, project, edge } = props
  const [rejecting, setRejecting] = useState<string | undefined>()
  const [reason, setReason] = useState('')
  const [refusal, setRefusal] = useState('')
  const [checked, setChecked] = useState<RelationRegroundView | undefined>()
  const deciding = useAction()
  const regrounding = useAction()
  const opening = useAction()
  if (edge === undefined) {
    return <section className={styles.card} data-relations-selected>
      <h4 className={styles.cardTitle}>{t('relationsSelectedTitle')}</h4>
      <p className={styles.line}>{t('relationsSelectedNone')}</p>
    </section>
  }
  const decide = (command: Extract<ResearchCommand, { action: 'relations-reject' | 'relations-restore' }>): void => {
    deciding.start(async () => {
      setRefusal('')
      const response = await props.run(command)
      const outcome = response.relationOutcomes?.[0]
      if (outcome === undefined) throw new Error(t('kgNoResponse'))
      if (outcome.status === 'refused') { setRefusal(outcome.message); return }
      setRejecting(undefined); setReason('')
      props.reread()
    })
  }
  const check = (): void => {
    regrounding.start(async () => {
      const response = await props.run({ action: 'relations-reground', projectId: project.id })
      if (!response.relationReground) throw new Error(t('kgNoResponse'))
      setChecked(response.relationReground)
      props.reread()
    })
  }
  const stale = edge.status === 'stale' || edge.grounds.some(ground => ground.status === 'outdated')
  const counts = sourceCounts(edge.sources, t)
  const lock = writes(props, deciding.pending)
  const from = props.names.get(edge.from) as string, to = props.names.get(edge.to) as string
  const ask = (target: string): void => { setRejecting(target); setReason(''); setRefusal('') }
  return <section className={styles.card} data-relations-selected>
    <p className={styles.kicker}>{t('relationsSelectedTitle')}</p>
    <h4 className={styles.relation}>{relationSentence(from, edge.kind, to, t)}</h4>
    <p className={styles.meta}>
      {t('relationsRecordedBy', { who: authorName(edge.by, t) })} · {t('relationsConfidence', { n: percent(edge.confidence) })}
      {counts !== '' && ` · ${counts}`}
    </p>
    {stale && <p className={styles.warn}>{t('relationsOutdated')}</p>}
    <h5 className={styles.subTitle}>{t('relationsGroundsHead', { n: edge.grounds.length })}</h5>
    <ul className={styles.grounds}>
      {edge.grounds.map(ground => <GroundItem key={ground.id} {...props} ground={ground} busy={deciding.pending}
        record={project.evidence.find(item => item.id === ground.evidenceId)}
        open={(record) => { opening.start(() => { props.openFile(project.root, openPath(record)) }) }}
        reject={() => { ask(ground.id) }}
        restore={() => { decide({ action: 'relations-restore', projectId: project.id, relation: edge.id, ground: ground.id }) }} />)}
    </ul>
    {rejecting !== undefined && <RejectForm t={t} reason={reason} busy={deciding.pending} setReason={setReason}
      confirm={() => {
        // An empty target is the relation itself; anything else is one of its grounds.
        decide({
          action: 'relations-reject', projectId: project.id, relation: edge.id,
          ...rejecting === '' ? {} : { ground: rejecting }, ...reason.trim() === '' ? {} : { reason: reason.trim() },
        })
      }} cancel={() => { setRejecting(undefined) }} />}
    <ActionError t={t} error={opening.error} />
    <ActionError t={t} error={deciding.error} />
    <Refused t={t} message={refusal} />
    {checked !== undefined && <p className={styles.line} role="status">{t('relationsRegrounded', { ...checked })}</p>}
    <ActionError t={t} error={regrounding.error} />
    <div className={styles.row}>
      <button type="button" className={styles.danger} {...lock} onClick={() => { ask('') }}>{t('relationsRejectRelation')}</button>
      <button type="button" className={styles.secondary} onClick={() => { props.add(edge) }}>{t('relationsAddOne')}</button>
      {stale && <button type="button" className={styles.secondary} {...writes(props, regrounding.pending)} onClick={check}>
        {t(regrounding.pending ? 'relationsRegrounding' : 'relationsReground')}
      </button>}
    </div>
  </section>
}

/**
 * 已驳回的关系: the relations the person or the assistant rejected, each with who rejected it and why, and a button that
 * brings it back. The host refuses to restore what the person rejected when the assistant asks; the person always may.
 * @param props - the cards' shared props and the rejected relations.
 * @returns the card, or nothing while none is rejected.
 */
export function RejectedCard(props: PanelProps & { items: readonly RelationRejectedView[] }): ReactNode {
  const { t, project } = props
  const [refusal, setRefusal] = useState('')
  const restoring = useAction()
  if (props.items.length === 0) return null
  const lock = writes(props, restoring.pending)
  const restore = (item: RelationRejectedView): void => {
    restoring.start(async () => {
      setRefusal('')
      const response = await props.run({ action: 'relations-restore', projectId: project.id, relation: item.id })
      const outcome = response.relationOutcomes?.[0]
      if (outcome === undefined) throw new Error(t('kgNoResponse'))
      if (outcome.status === 'refused') { setRefusal(outcome.message); return }
      props.reread()
    })
  }
  return <details className={styles.card} data-relations-rejected>
    <summary className={styles.cardTitle}>{t('relationsRejectedHead', { n: props.items.length })}</summary>
    <ul className={styles.grounds}>
      {props.items.map(item => <li key={item.id} className={styles.groundItem}>
        <span>{relationSentence(item.fromName, item.kind, item.toName, t)}</span>
        {item.rejection !== undefined && <span className={styles.meta}>
          {t('relationsRejectedBy', { who: authorName(item.rejection.by, t), date: dateText(item.rejection.at, t) })}
          {item.rejection.reason !== undefined && ` · ${t('relationsRejectedWhy', { reason: item.rejection.reason })}`}
        </span>}
        <div className={styles.row}>
          <button type="button" className={styles.secondary} {...lock} onClick={() => { restore(item) }}>{t('relationsRestore')}</button>
        </div>
      </li>)}
    </ul>
    <ActionError t={t} error={restoring.error} />
    <Refused t={t} message={refusal} />
  </details>
}
