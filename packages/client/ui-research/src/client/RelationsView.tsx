/**
 * 关系 (Relations): the entities of the research (methods, tasks, datasets, metrics and papers) and the relations
 * between them, each resting on the source's own words. The graph shows one entity's neighbourhood within two hops;
 * choosing another entity centres it there. Cards beside it show how two things connect, what the selected relation
 * rests on, the person's way to add or reject a relation, the entities that may be one, and the blanks in the
 * research's own literature. The host sends the facts and layout hints; the picture and every sentence are derived
 * here (`relationsValues.ts`). Nothing is drawn that a record does not hold.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type {
  RelationEdgeView, RelationEntityKind, RelationNeighbourhoodView, RelationNodeSummary, RelationPathView, RelationsPage, ResearchProject,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkbenchProps } from './contract.ts'
import { ActionError } from './Action.tsx'
import { RelationsGraph } from './RelationsGraph.tsx'
import { CitationsCard, ProposeCard, SuggestionsCard, type ProposeSeed } from './RelationsEdit.tsx'
import { GapCard } from './RelationsGaps.tsx'
import { failure, PathCard, RejectedCard, RelationCard, type PanelProps } from './RelationsPanels.tsx'
import {
  ENTITY_KINDS, entityName, hasSources, knownNodes, nameIndex, pathRelations, relationsLayout, type EndInput,
} from './relationsValues.ts'
import styles from './RelationsView.module.css'

/** A starting point for the add form, numbered so that choosing the same relation twice resets the form twice. */
interface Seed { key: number; value: ProposeSeed }

/** The problems the stored file has, each naming what it keeps from being honored. */
function Problems(props: { t: WorkbenchProps['t']; problems: readonly string[] }): ReactNode {
  return props.problems.length === 0 ? null : <div className={styles.problems} role="alert" data-relations-problems>
    <p>{props.t('relationsProblemsHead')}</p>
    <ul>{props.problems.map(problem => <li key={problem}>{problem}</li>)}</ul>
  </div>
}

/**
 * The view of one research's relation graph. It asks the host again whenever the research record changes or the
 * person changes a relation.
 * @param props - the research face and the research whose relations to show; the owner keys it by research.
 * @returns the graph with its cards, the explanation that there are no relations yet, a failure, or a loading line.
 */
export function RelationsView(props: WorkbenchProps & { project: ResearchProject }): ReactNode {
  const { project, t } = props
  const [page, setPage] = useState<RelationsPage | null>(null)
  const [shown, setShown] = useState<RelationNeighbourhoodView | undefined>()
  const [entity, setEntity] = useState<string | undefined>()
  const [typed, setTyped] = useState('')
  const [asked, setAsked] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [edgeId, setEdgeId] = useState<string | undefined>()
  const [path, setPath] = useState<RelationPathView | undefined>()
  const [seed, setSeed] = useState<Seed | undefined>()
  const latest = useRef(0)
  const current = useRef<RelationNeighbourhoodView | undefined>(undefined)
  current.current = shown

  const load = (ask: string | undefined, typedText = ''): void => {
    const ticket = ++latest.current
    setBusy(true)
    props.run({ action: 'relations-graph', projectId: project.id, hops: 2, ...ask === undefined ? {} : { entity: ask } }).then((result) => {
      if (ticket !== latest.current) return
      const next = result.relations
      if (!next) throw new Error(t('kgNoResponse'))
      setPage(next); setAsked(typedText); setError('')
      if (next.neighbourhood !== undefined) {
        setShown(next.neighbourhood)
        // The graph keeps the entity asked for; when none was, it follows the most connected one.
        setEntity(next.match === 'found' ? next.neighbourhood.center : undefined)
      }
    }).catch((reason: unknown) => {
      if (ticket === latest.current) setError(failure(reason))
    }).finally(() => { if (ticket === latest.current) setBusy(false) })
  }
  useEffect(() => {
    load(entity)
    return () => { latest.current++ }
  }, [project.id, project.revision, tick])

  const reread = (): void => { setTick(value => value + 1) }
  const focus = (id: string): void => { load(id) }
  const search = (event: FormEvent): void => {
    event.preventDefault()
    const text = typed.trim()
    if (text !== '') load(text, text)
  }
  // A path whose nodes are not all in the picture brings its start to the centre, where two hops reach the most of it.
  const showPath = (next: RelationPathView | undefined): void => {
    setPath(next)
    const nodes = new Set(current.current?.nodes.map(node => node.id))
    if (next !== undefined && !next.nodes.every(id => nodes.has(id))) load(next.nodes[0])
  }

  const layout = useMemo(() => shown === undefined ? undefined : relationsLayout(shown), [shown])
  const readOnly = project.example === true
  const shared: PanelProps = { t, run: props.run, project, readOnly, tick, reread }
  const pool: RelationNodeSummary[] = page === null ? [] : knownNodes(shown?.nodes ?? [], page.hubs, page.candidates)
  const names = nameIndex(shown?.nodes ?? [])
  const kinds = new Map((shown?.nodes ?? []).map(node => [node.id, node.kind] as const))
  const centre = shown?.nodes.find(node => node.id === shown.center)
  const edge = shown?.edges.find(item => item.id === edgeId)
  const add = (from: RelationEdgeView): void => {
    // A relation is drawn only between nodes of the picture, so both ends have a name and a kind.
    const end = (id: string): EndInput => ({ text: names.get(id) as string, kind: kinds.get(id) as RelationEntityKind })
    setSeed(previous => ({ key: (previous?.key ?? 0) + 1, value: { kind: from.kind, from: end(from.from), to: end(from.to) } }))
  }
  const literature = project.evidence.some(record => record.kind === 'literature')

  return <section className={styles.view} data-relations-view aria-busy={busy || (page === null && error === '')}>
    <ActionError t={t} error={error} />
    {page === null && error === '' && <p role="status" className={styles.note}>{t('kgLoading')}</p>}
    {page !== null && <Problems t={t} problems={page.problems} />}
    {page !== null && shown === undefined && <div className={styles.empty} data-relations-empty>
      <h3 className={styles.emptyTitle}>{t('relationsEmptyTitle')}</h3>
      <p className={styles.emptyBody}>{t('relationsEmptyBody')}</p>
      {!hasSources(project.evidence) && <p className={styles.warn}>{t('relationsEmptyNoSources')}</p>}
      {literature && <CitationsCard {...shared} />}
      {hasSources(project.evidence) && <ProposeCard {...shared} key={seed?.key ?? 0} known={pool} seed={seed?.value} startOpen />}
      <RejectedCard {...shared} items={page.rejected} />
    </div>}
    {page !== null && shown !== undefined && layout !== undefined && <>
      <div className={styles.toolbar}>
        <p className={styles.centred}>{t('relationsCentredOn', { name: centre?.name ?? shown.center })}</p>
        <form className={styles.search} role="search" onSubmit={search}>
          <input type="search" aria-label={t('relationsSearch')} placeholder={t('relationsSearchPlaceholder')} value={typed}
            onChange={(event) => { setTyped(event.target.value) }} />
          <button type="submit" disabled={busy || typed.trim() === ''}>{t('relationsSearchButton')}</button>
        </form>
        <ul className={styles.legend}>
          {ENTITY_KINDS.map(kind => <li key={kind} className={styles.legendItem}>
            <span className={styles.swatch} data-kind={kind} aria-hidden="true" />{entityName(kind, t)}
          </li>)}
        </ul>
      </div>
      {page.match === 'unknown' && <p className={styles.notice} role="status">{t('relationsUnknown', { text: asked })}</p>}
      {page.match === 'ambiguous' && <div className={styles.notice} role="status">
        <p>{t('relationsAmbiguous', { text: asked })}</p>
        <ul className={styles.choices}>{page.candidates.map(node => <li key={node.id}>
          <button type="button" className={styles.choice} onClick={() => { focus(node.id) }}>
            {t('relationsNodeLabel', { name: node.name, kind: entityName(node.kind, t) })}
          </button>
        </li>)}</ul>
      </div>}
      {page.hubs.length > 0 && <div className={styles.hubs}>
        <span className={styles.hubsHead}>{t('relationsHubsHead')}</span>
        <ul>{page.hubs.map(hub => <li key={hub.id}>
          <button type="button" className={styles.hub} data-kind={hub.kind} aria-pressed={hub.id === shown.center} onClick={() => { focus(hub.id) }}>{hub.name}</button>
        </li>)}</ul>
      </div>}
      <p className={styles.counts}>{t('relationsCounts', page.counts)}</p>
      <div className={styles.body} data-relations-body>
        <div className={styles.stage}>
          <RelationsGraph t={t} layout={layout} selected={edge?.id} pathEdges={pathRelations(path)} pathNodes={new Set(path?.nodes)}
            focus={(node) => { if (node.id !== shown.center) focus(node.id) }} select={(item) => { setEdgeId(item.id) }} />
          <div className={styles.key}>
            <span className={styles.keyItem}><span className={styles.keyLine} data-state="path" aria-hidden="true" />{t('relationsLegendPath')}</span>
            <span className={styles.keyItem}><span className={styles.keyLine} data-state="plain" aria-hidden="true" />{t('relationsLegendOther')}</span>
          </div>
          {shown.omitted.nodes + shown.omitted.edges > 0 && <p className={styles.meta}>{t('relationsOmitted', shown.omitted)}</p>}
        </div>
        <aside className={styles.aside} aria-label={t('kgViewRelations')} data-relations-aside>
          <PathCard {...shared} centre={centre} pool={pool} show={showPath} />
          <RelationCard {...shared} key={edge?.id ?? ''} edge={edge} names={names} openFile={props.openFile} add={add} />
          <ProposeCard {...shared} key={seed?.key ?? 0} known={pool} seed={seed?.value} startOpen={seed !== undefined} />
          <RejectedCard {...shared} items={page.rejected} />
          <SuggestionsCard {...shared} />
          <GapCard {...shared} />
          {literature && <CitationsCard {...shared} />}
        </aside>
      </div>
    </>}
  </section>
}
