/**
 * The cards beside the relation graph that change it: the person's own relation with a quotation of a source, the
 * entities that may be one, and the citation lists. Nothing here writes to an example research, and a refusal shows
 * the host's own message, which says where the quotation departs from the source.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type {
  EvidenceRecord, RelationCitationsView, RelationKindId, RelationMergeSuggestionView, RelationNodeSummary,
} from '@deepseek-ai/dsh-research-workbench/types'
import { ActionError, useAction } from './Action.tsx'
import { failure, Refused, writes, type PanelProps } from './RelationsPanels.tsx'
import {
  ENTITY_KINDS, PROPOSABLE, endRef, entityName, outcomeNotes, quotable, relationName, type EndInput,
} from './relationsValues.ts'
import styles from './RelationsView.module.css'

/** The relation and ends a form starts from. */
export interface ProposeSeed { kind: RelationKindId; from: EndInput; to: EndInput }

/** One end of a proposal: a name that may already be in the graph, and the kind it is created as when it is not. */
function EndFields(props: Pick<PanelProps, 't'> & {
  legend: string
  value: EndInput
  list: string
  disabled: boolean
  change: (value: EndInput) => void
}): ReactNode {
  const { t, value } = props
  return <fieldset className={styles.end} disabled={props.disabled}>
    <legend>{props.legend}</legend>
    <input aria-label={`${props.legend} · ${t('relationsFormName')}`} list={props.list} value={value.text}
      onChange={(event) => { props.change({ ...value, text: event.target.value }) }} />
    <select aria-label={`${props.legend} · ${t('relationsFormType')}`} value={value.kind}
      onChange={(event) => { props.change({ ...value, kind: event.target.value as EndInput['kind'] }) }}>
      {ENTITY_KINDS.map(kind => <option key={kind} value={kind}>{entityName(kind, t)}</option>)}
    </select>
  </fieldset>
}

/**
 * 补一条关系: the person's relation, grounded in a quotation of one of the research's own sources at its current
 * revision. Ends named by typing are created by the proposal itself.
 * @param props - the cards' shared props, the nodes the view has seen, the form's starting point and whether it starts open.
 * @returns the card; the owner keys it so that a new starting point resets the form.
 */
export function ProposeCard(props: PanelProps & {
  known: readonly RelationNodeSummary[]
  seed: ProposeSeed | undefined
  startOpen: boolean
}): ReactNode {
  const { t, project, seed } = props
  const records = quotable(project.evidence)
  const [open, setOpen] = useState(props.startOpen)
  const [kind, setKind] = useState<RelationKindId>(seed !== undefined && PROPOSABLE.includes(seed.kind) ? seed.kind : 'applied-to')
  const [from, setFrom] = useState<EndInput>(seed?.from ?? { text: '', kind: 'method' })
  const [to, setTo] = useState<EndInput>(seed?.to ?? { text: '', kind: 'task' })
  const [evidenceId, setEvidenceId] = useState('')
  const [quote, setQuote] = useState('')
  const [notes, setNotes] = useState<string[]>([])
  const [refusal, setRefusal] = useState('')
  const [problem, setProblem] = useState('')
  const action = useAction()
  const list = useId()
  const lock = writes(props, action.pending)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const record = records.find(item => item.id === evidenceId) as EvidenceRecord
    const start = endRef(from, props.known, project.evidence), end = endRef(to, props.known, project.evidence)
    setNotes([]); setRefusal(''); setProblem('')
    if ('missing' in start) { setProblem(t('relationsPaperUnknown', { name: start.missing })); return }
    if ('missing' in end) { setProblem(t('relationsPaperUnknown', { name: end.missing })); return }
    action.start(async () => {
      const response = await props.run({
        action: 'relations-propose', projectId: project.id,
        proposals: [{ kind, from: start, to: end, ground: { type: 'quote', evidenceId: record.id, revision: record.revision, quote: quote.trim() } }],
      })
      const outcome = response.relationOutcomes?.[0]
      if (outcome === undefined) throw new Error(t('kgNoResponse'))
      if (outcome.status === 'refused') { setRefusal(outcome.message); return }
      setNotes(outcomeNotes(outcome, t))
      setQuote('')
      props.reread()
    })
  }
  const ready = !lock.disabled && evidenceId !== '' && quote.trim() !== '' && from.text.trim() !== '' && to.text.trim() !== ''
  return <details className={styles.card} open={open} data-relations-propose onToggle={(event) => { setOpen(event.currentTarget.open) }}>
    <summary className={styles.cardTitle}>{t('relationsAddOne')}</summary>
    <p className={styles.line}>{t('relationsProposeHint')}</p>
    {records.length === 0 ? <p className={styles.warn}>{t('relationsFormNoSource')}</p> : <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}><span>{t('relationsFormKind')}</span>
        <select value={kind} disabled={props.readOnly} onChange={(event) => { setKind(event.target.value as RelationKindId) }}>
          {PROPOSABLE.map(item => <option key={item} value={item}>{relationName(item, t)}</option>)}
        </select>
      </label>
      <datalist id={list}>{props.known.map(node => <option key={node.id} value={node.name} label={entityName(node.kind, t)} />)}</datalist>
      <EndFields t={t} legend={t('relationsFrom')} value={from} list={list} disabled={props.readOnly} change={setFrom} />
      <EndFields t={t} legend={t('relationsTo')} value={to} list={list} disabled={props.readOnly} change={setTo} />
      <label className={styles.field}><span>{t('relationsFormSource')}</span>
        <select value={evidenceId} disabled={props.readOnly} onChange={(event) => { setEvidenceId(event.target.value) }}>
          <option value="">{t('relationsFormSourceNone')}</option>
          {records.map(record => <option key={record.id} value={record.id}>
            {record.title} · {t(record.kind === 'literature' ? 'egKindLiterature' : 'egKindFile')} · {t('revisionN', { n: record.revision })}
          </option>)}
        </select>
      </label>
      <label className={styles.field}><span>{t('relationsFormQuote')}</span>
        <textarea rows={3} value={quote} placeholder={t('relationsFormQuoteHint')} disabled={props.readOnly}
          onChange={(event) => { setQuote(event.target.value) }} />
      </label>
      <div className={styles.row}>
        <button type="submit" className={styles.primary} disabled={!ready} title={lock.title}>
          {t(action.pending ? 'relationsFormSubmitting' : 'relationsFormSubmit')}
        </button>
      </div>
    </form>}
    {problem !== '' && <p className={styles.refusal} role="alert">{problem}</p>}
    <ActionError t={t} error={action.error} />
    <Refused t={t} message={refusal} />
    {notes.length > 0 && <ul className={styles.notes} role="status">{notes.map(note => <li key={note}>{note}</li>)}</ul>}
  </details>
}

/**
 * 这些可能是同一个东西: pairs of entities whose names look alike, each with a merge that asks which name stays and says
 * that a merge cannot be undone. Nothing is shown while the host suggests nothing.
 * @param props - the cards' shared props.
 * @returns the card, or nothing.
 */
export function SuggestionsCard(props: PanelProps): ReactNode {
  const { t, project } = props
  const [items, setItems] = useState<readonly RelationMergeSuggestionView[]>([])
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState<string | undefined>()
  const [note, setNote] = useState('')
  const [refusal, setRefusal] = useState('')
  const merging = useAction()
  const latest = useRef(0)
  useEffect(() => {
    const ticket = ++latest.current
    props.run({ action: 'relations-suggestions', projectId: project.id }).then((response) => {
      if (ticket !== latest.current) return
      if (!response.relationSuggestions) throw new Error(t('kgNoResponse'))
      setItems(response.relationSuggestions); setError('')
    }).catch((reason: unknown) => { if (ticket === latest.current) setError(failure(reason)) })
    return () => { latest.current++ }
  }, [project.id, project.revision, props.tick])
  const merge = (suggestion: RelationMergeSuggestionView, keep: 'a' | 'b'): void => {
    merging.start(async () => {
      setRefusal(''); setNote('')
      const response = await props.run({
        action: 'relations-merge', projectId: project.id, from: keep === 'a' ? suggestion.b : suggestion.a, into: keep === 'a' ? suggestion.a : suggestion.b,
      })
      const outcome = response.relationMerge
      if (outcome === undefined) throw new Error(t('kgNoResponse'))
      if (outcome.status === 'refused') { setRefusal(outcome.message); return }
      setConfirming(undefined)
      setNote(outcome.dropped.length === 0 ? t('relationsMerged') : `${t('relationsMerged')} ${t('relationsMergedDropped', { n: outcome.dropped.length })}`)
      props.reread()
    })
  }
  if (items.length === 0 && note === '' && error === '') return null
  const lock = writes(props, merging.pending)
  return <section className={styles.card} data-relations-suggestions>
    <h4 className={styles.cardTitle}>{t('relationsSuggestHead')}</h4>
    <ul className={styles.grounds}>
      {items.map((item) => {
        const key = `${item.a}|${item.b}`
        return <li key={key} className={styles.groundItem}>
          <span>{item.names[0]} / {item.names[1]}</span>
          <span className={styles.meta}>{t(item.reason === 'acronym' ? 'relationsSuggestAcronym' : 'relationsSuggestSpelling')}</span>
          {confirming === key
            ? <div className={styles.confirm}>
              <p className={styles.warn}>{t('relationsMergeConfirm')}</p>
              <div className={styles.row}>
                <button type="button" className={styles.danger} {...lock} onClick={() => { merge(item, 'a') }}>{t('relationsMergeKeep', { name: item.names[0] })}</button>
                <button type="button" className={styles.danger} {...lock} onClick={() => { merge(item, 'b') }}>{t('relationsMergeKeep', { name: item.names[1] })}</button>
                <button type="button" className={styles.secondary} onClick={() => { setConfirming(undefined) }}>{t('cancel')}</button>
              </div>
            </div>
            : <div className={styles.row}>
              <button type="button" className={styles.secondary} {...lock} onClick={() => { setConfirming(key); setRefusal('') }}>{t('relationsMerge')}</button>
            </div>}
        </li>
      })}
    </ul>
    <ActionError t={t} error={error} />
    <ActionError t={t} error={merging.error} />
    <Refused t={t} message={refusal} />
    {note !== '' && <p className={styles.line} role="status">{note}</p>}
  </section>
}

/** What the citation lists gave, in words. */
function Citations(props: Pick<PanelProps, 't'> & { done: RelationCitationsView }): ReactNode {
  const { t, done } = props
  return <div className={styles.line} role="status">
    <p>{t('relationsCitationsDone', { asked: done.asked, works: done.works, added: done.added, unchanged: done.unchanged, rejected: done.rejected })}</p>
    {done.failures.length > 0 && <>
      <p>{t('relationsCitationsFailed', { n: done.failures.length })}</p>
      <ul className={styles.notes}>{done.failures.map(message => <li key={message}>{message}</li>)}</ul>
    </>}
  </div>
}

/**
 * 补充引用关系: asks the open citation databases for the imported papers' reference lists and records the citations
 * among them. It is a host job, so the button waits for the job and then says what it did.
 * @param props - the cards' shared props.
 * @returns the button, its progress and its result.
 */
export function CitationsCard(props: PanelProps): ReactNode {
  const { t, project } = props
  const [done, setDone] = useState<RelationCitationsView | undefined>()
  const fetching = useAction()
  const lock = writes(props, fetching.pending)
  const start = (): void => {
    fetching.start(async () => {
      const response = await props.run({ action: 'relations-citations', projectId: project.id })
      if (!response.relationCitations) throw new Error(t('kgNoResponse'))
      setDone(response.relationCitations)
      props.reread()
    })
  }
  return <div className={styles.citations} data-relations-citations>
    <button type="button" className={styles.secondary} {...lock} onClick={start}>{t('relationsCitations')}</button>
    <span className={styles.meta}>{t('relationsCitationsHint')}</span>
    {fetching.pending && <p className={styles.line} role="status">{t('relationsCitationsPending')}</p>}
    <ActionError t={t} error={fetching.error} />
    {done !== undefined && !fetching.pending && <Citations t={t} done={done} />}
  </div>
}
