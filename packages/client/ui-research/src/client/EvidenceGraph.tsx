/**
 * 我的研究 (My research): the research question, the conclusions the record holds, and the runs and literature behind
 * each, in three columns joined by lines. Selecting a conclusion lights its lines and opens, beside or below the graph,
 * where it is written, what supports it, what would invalidate it and what to do next. The host sends facts about the
 * record; the layout and every sentence are derived here (`evidenceValues.ts`).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EvidenceClaimStatus, EvidenceGraphClaim, EvidenceGraphPage, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkbenchProps } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import {
  CLAIM_HEIGHT, SOURCE_HEIGHT, cardWhere, citationMeta, countChips, evidenceLayout, expectedRuns, invalidationLines, nextStepKey,
  sourceIndex, sourceKindText, sourceLabel, sourceMeta, statusText, supportOf, whereText, type EvidenceLayout,
} from './evidenceValues.ts'
import styles from './EvidenceGraph.module.css'

/** How a claim status reads as a badge, and which tag tone the count chip of a status takes. */
const STATUS_TONE: Record<EvidenceClaimStatus, TagTone> = {
  supported: 'success', stale: 'warning', missing: 'danger', proposed: 'info', contradicted: 'danger',
}

/** A component-local length handed to the stylesheet; the stylesheet turns it into a position or a size. */
function lengths(values: Record<`--eg-${string}`, number>): CSSProperties {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, `${value}px`]))
}

/** One line of a gutter, from a height on its left edge to a height on its right. */
interface GutterEdge {
  key: string
  kind: string
  status?: string
  active: boolean
  from: number
  to: number
}

/** One gutter between two columns: the lines of the layout as curves. */
function Gutter(props: { height: number; edges: readonly GutterEdge[] }): ReactNode {
  // Lit lines are drawn last so they cross over the dim ones.
  const ordered = [...props.edges].sort((a, b) => Number(a.active) - Number(b.active))
  return <svg className={styles.gutter} viewBox={`0 0 100 ${props.height}`} preserveAspectRatio="none" aria-hidden="true">
    {ordered.map(edge => <path
      key={edge.key} className={styles.edge} data-kind={edge.kind} data-status={edge.status} data-active={edge.active}
      d={`M0,${edge.from} C50,${edge.from} 50,${edge.to} 100,${edge.to}`} />)}
  </svg>
}

/** The graph itself: the question, the claims as buttons, the evidence as cards, and the lines between them. */
function Graph(props: WorkbenchProps & {
  page: EvidenceGraphPage
  layout: EvidenceLayout
  claim: EvidenceGraphClaim
  choose: (id: string) => void
}): ReactNode {
  const { page, layout, claim, t } = props
  const lit = new Set([...claim.links.map(link => link.sourceId), ...claim.expected])
  return <div className={styles.columns} style={lengths({ '--eg-height': layout.height, '--eg-claim-height': CLAIM_HEIGHT, '--eg-source-height': SOURCE_HEIGHT })}>
    <div className={styles.column} data-heading={t('egQuestion')}>
      <p className={styles.question} style={lengths({ '--eg-top': layout.question })} title={page.question}>
        <span className={styles.questionKicker}>{t('egQuestion')}</span>
        <span className={styles.questionText}>{page.question}</span>
      </p>
    </div>
    <Gutter height={layout.height} edges={layout.questionEdges.map(edge => ({ key: edge.claimId, kind: 'ask', active: edge.claimId === claim.id, from: edge.from, to: edge.to }))} />
    <ol className={styles.column} data-heading={t('egColumnClaims')} aria-label={t('egColumnClaims')}>
      {layout.claims.map(({ claim: item, top }) => <li key={item.id} className={styles.node} style={lengths({ '--eg-top': top })}>
        <button type="button" className={styles.claim} data-status={item.status} aria-pressed={item.id === claim.id} title={item.text}
          onClick={() => { props.choose(item.id) }}>
          <span className={styles.kicker}>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.status}>{statusText(item.status, t)}</span>
            {cardWhere(item) !== '' && <span className={styles.where}>· {cardWhere(item)}</span>}
          </span>
          <span className={styles.claimText}>{item.text}</span>
        </button>
      </li>)}
    </ol>
    <Gutter height={layout.height} edges={layout.sourceEdges.map(edge => ({
      key: `${edge.claimId}:${edge.sourceId}`, kind: edge.expected ? 'expected' : edge.outdated ? 'outdated' : 'support', status: edge.status,
      active: edge.claimId === claim.id, from: edge.from, to: edge.to,
    }))} />
    <ul className={styles.column} data-heading={t('egColumnEvidence')} aria-label={t('egColumnEvidence')}>
      {layout.sources.map(({ source, top }) => <li key={source.id} className={styles.node} style={lengths({ '--eg-top': top })}>
        <div className={styles.source} data-kind={source.kind} data-changed={source.changed} data-linked={lit.has(source.id)}>
          <span className={styles.sourceKind}>{sourceKindText(source, t)}</span>
          <span className={styles.sourceLabel}>{sourceLabel(source, t)}</span>
          <span className={styles.sourceMeta}>{sourceMeta(source, t)}</span>
        </div>
      </li>)}
    </ul>
  </div>
}

/** The panel for the selected conclusion. */
function Detail(props: WorkbenchProps & { project: ResearchProject; page: EvidenceGraphPage; claim: EvidenceGraphClaim }): ReactNode {
  const { project, page, claim, t } = props
  const opening = useAction()
  const sources = sourceIndex(page)
  const support = supportOf(claim, sources)
  const waiting = expectedRuns(claim, sources)
  const file = claim.files[0]
  return <aside className={styles.detail} aria-label={t('egGraph')} data-evidence-detail>
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <Tag tone={STATUS_TONE[claim.status]}>{statusText(claim.status, t)}</Tag>
        <span className={styles.whereLine}>{whereText(claim, t)}</span>
      </div>
      <p className={styles.claimFull}>{claim.text}</p>
    </section>
    <section className={styles.card}>
      <h4 className={styles.cardTitle}>{t('egSupportHead')}</h4>
      {support.length === 0 && waiting.length === 0 && <p className={styles.line}>{t('egSupportNone')}</p>}
      {support.map(({ source, links }) => <div key={source.id} className={styles.support}>
        <span className={styles.supportName}>
          <span className={styles.supportKind}>{sourceKindText(source, t)}</span> {sourceLabel(source, t)}
        </span>
        {sourceMeta(source, t) !== '' && <span className={styles.supportMeta}>{sourceMeta(source, t)}</span>}
        {links.map((link, index) => <div key={index} className={styles.citation}>
          {link.quote !== undefined && <blockquote className={styles.quote}>{link.quote}</blockquote>}
          <span className={styles.supportMeta}>{citationMeta(link, t)}{link.outdated && ` · ${t('egOutdated')}`}</span>
        </div>)}
      </div>)}
      {waiting.map(source => <p key={source.id} className={styles.line}>{t('egSupportExpected', { name: sourceLabel(source, t) })}</p>)}
      {claim.expectedMore > 0 && <p className={styles.line}>{t('egExpectedMore', { n: claim.expectedMore })}</p>}
    </section>
    <section className={styles.card}>
      <h4 className={styles.cardTitle}>{t('egInvalidateHead')}</h4>
      {invalidationLines(claim, sources, t).map(line => <p key={line} className={styles.line}>{line}</p>)}
    </section>
    <section className={styles.card}>
      <h4 className={styles.cardTitle}>{t('egNextHead')}</h4>
      <p className={styles.line}>{t(nextStepKey(claim, sources))}</p>
    </section>
    <ActionError t={t} error={opening.error} />
    <div className={styles.actions}>
      {file !== undefined && <button type="button" className={styles.primary} onClick={() => { opening.start(() => { props.openFile(project.root, file.path) }) }}>{t('egOpenFile')}</button>}
      <button type="button" className={styles.secondary} onClick={() => { props.focusClaim({ projectId: project.id, claimId: claim.id }) }}>{t('egAllSources')}</button>
    </div>
  </aside>
}

/**
 * The view of one research's evidence graph. It asks the host again whenever the research record changes.
 * @param props - the research face and the research whose graph to show; the owner keys it by research.
 * @returns the graph with its count strip and detail panel, or a line saying why there is none.
 */
export function EvidenceView(props: WorkbenchProps & { project: ResearchProject }): ReactNode {
  const { project, t } = props
  const [page, setPage] = useState<EvidenceGraphPage | null>(null)
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState<string | undefined>()
  const latest = useRef(0)
  useEffect(() => {
    const ticket = ++latest.current
    props.run({ action: 'evidence-graph', projectId: project.id }).then((result) => {
      if (ticket !== latest.current) return
      if (!result.evidenceGraph) throw new Error(t('kgNoResponse'))
      setPage(result.evidenceGraph)
      setError('')
    }).catch((reason: unknown) => {
      if (ticket === latest.current) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { latest.current++ }
  }, [project.id, project.revision])
  const claim = page === null ? undefined : page.claims.find(item => item.id === chosen) ?? page.claims[0]
  return <section className={styles.view} data-evidence-view aria-busy={page === null && error === ''}>
    <ActionError t={t} error={error} />
    {page === null && error === '' && <p role="status" className={styles.note}>{t('kgLoading')}</p>}
    {page !== null && claim === undefined && <p className={styles.note}>{t('egEmpty')}</p>}
    {page !== null && claim !== undefined && <>
      <div className={styles.strip}>
        {countChips(page.summary, t).map(chip => <Tag key={chip.kind} tone={chip.kind === 'total' ? 'neutral' : STATUS_TONE[chip.kind]}>{chip.text}</Tag>)}
        <span className={styles.caption}>{t('egCaption')}</span>
      </div>
      <div className={styles.body}>
        <div className={styles.graph} role="group" aria-label={t('egGraph')}>
          <Graph {...props} page={page} layout={evidenceLayout(page)} claim={claim} choose={setChosen} />
        </div>
        <Detail key={claim.id} {...props} project={project} page={page} claim={claim} />
      </div>
    </>}
  </section>
}
