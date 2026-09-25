/**
 * 资料 (Sources): what the research stands on and what it claims, beside the
 * conversation. Each source names its authors, year, DOI and what the research
 * holds of it, and opens in the right sidebar's own viewers; each claim opens
 * its sources over the whole frame. Nothing here imports, searches or verifies
 * anything: the assistant does those.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EvidenceRecord, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { SidebarRightNavigationParams } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { useSessionProject, type SourceReference } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import { CLAIM_TONE } from './ClaimSheet.tsx'
import type { Translate } from './format.ts'
import type { ResearchKey } from './locales.ts'
import { ExampleBanner, NoResearch, type ResearchTabProps } from './Tabs.tsx'
import tabs from './Tabs.module.css'
import styles from './Sources.module.css'

/** Authors named before the rest become 等 (et al.). */
const SHOWN_AUTHORS = 3

/** What the research holds of a source, in words: 全文, 仅摘要, 仅元数据 or 数据. */
function coverageKey(coverage: EvidenceRecord['coverage']): ResearchKey {
  return coverage === 'full-text' ? 'fullText' : coverage
}

/** Whether the tab was opened to show its claims. */
function toClaims(params: SidebarRightNavigationParams): boolean {
  return typeof params === 'object' && 'section' in params && params.section === 'claims'
}

/** The byline of a literature source: `A, B, C 等 · 2023`. */
function byline(reference: SourceReference | undefined, t: Translate): string {
  if (reference === undefined) return ''
  const named = reference.authors.slice(0, SHOWN_AUTHORS).join(', ')
  const authors = reference.authors.length > SHOWN_AUTHORS ? t('authorsMore', { names: named, n: reference.authors.length - SHOWN_AUTHORS }) : named
  return [authors, reference.year === undefined ? '' : String(reference.year)].filter(Boolean).join(' · ')
}

/** The references of a project's literature sources, read once each; the rest have none. */
function useReferences(props: ResearchTabProps, project: ResearchProject): Readonly<Record<string, SourceReference>> {
  const [references, setReferences] = useState<Readonly<Record<string, SourceReference>>>({})
  const literature = project.evidence.filter(source => source.kind === 'literature')
  const wanted = literature.map(source => `${source.id}@${source.revision}`).join(' ')
  useEffect(() => {
    let active = true
    for (const source of literature) {
      void props.reference(project.id, source).then((reference) => {
        if (active && reference !== undefined) setReferences(previous => ({ ...previous, [source.id]: reference }))
      })
    }
    return () => { active = false }
  }, [project.id, wanted])
  return references
}

/** One source and its reference record when it has one, and how the tab opens a file. */
interface SourceProps {
  t: Translate
  source: EvidenceRecord
  reference: SourceReference | undefined
  open: (path: string) => void
}

/** One source: what it is, what the research holds of it, and the viewers that open it. */
function Source(props: SourceProps): ReactNode {
  const { source, t } = props
  const fullText = source.fullTextPath
  const meta = [byline(props.reference, t), source.doi === undefined ? '' : t('claimDoi', { doi: source.doi })].filter(Boolean).join(' · ')
  return <li className={styles.source}>
    <div className={styles.head}>
      <span className={styles.name}>{source.title}</span>
      <Tag tone="neutral">{t(coverageKey(source.coverage))}</Tag>
      {source.stale && <Tag tone="warning">{t('stale')}</Tag>}
    </div>
    {meta !== '' && <p className={styles.meta}>{meta}</p>}
    <div className={styles.actions}>
      <button type="button" onClick={() => { props.open(source.path) }}>{t('claimOpenSource')}</button>
      {fullText !== undefined && <button type="button" onClick={() => { props.open(fullText) }}>{t('fullText')}</button>}
    </div>
  </li>
}

/** The tab body: the research's sources, then its claims; each open scrolls to the top, or to the claims when it asks for them. */
export function ResearchSourcesTab(props: ResearchTabProps): ReactNode {
  const project = useSessionProject(props)
  if (!project) return <NoResearch t={props.t} />
  return <SourcesBody key={project.id} {...props} project={project} />
}

function SourcesBody(props: ResearchTabProps & { project: ResearchProject }): ReactNode {
  const { project, t } = props
  const { navigation } = props.useTabInfo().tab
  const top = useRef<HTMLDivElement>(null)
  const claims = useRef<HTMLElement>(null)
  const opening = useAction()
  const references = useReferences(props, project)
  const wanted: RefObject<HTMLElement> = toClaims(navigation.params) ? claims : top
  // Each open scrolls to the section it asked for, even when the tab was already open: the pane's scroll
  // position is the one the tab before it left.
  useEffect(() => { wanted.current?.scrollIntoView({ block: 'start' }) }, [wanted, navigation.revision])
  const open = (path: string): void => { opening.start(() => { props.openFile(project.root, path) }) }
  return <div ref={top} className={tabs.root}>
    {project.example === true && <ExampleBanner t={t} />}
    <section className={styles.section}>
      <h3 className={styles.heading}>{t('sourcesTab')}<span className={styles.count}>{project.evidence.length}</span></h3>
      <ActionError t={t} error={opening.error} />
      {project.evidence.length === 0
        ? <p className={tabs.empty}>{t('sourcesEmpty')}</p>
        : <ul className={styles.list}>{project.evidence.map(source =>
          <Source key={source.id} t={t} source={source} reference={references[source.id]} open={open} />)}</ul>}
    </section>
    <section ref={claims} className={styles.section}>
      <h3 className={styles.heading}>{t('claims')}<span className={styles.count}>{project.claims.length}</span></h3>
      {project.claims.length === 0
        ? <p className={tabs.empty}>{t('noClaims')}</p>
        : <ul className={styles.list}>{project.claims.map(claim => <li key={claim.id}>
          <button type="button" className={styles.claim} onClick={() => { props.focusClaim({ projectId: project.id, claimId: claim.id }) }}>
            <span className={styles.claimText}>{claim.text}</span>
            <Tag tone={CLAIM_TONE[claim.state]}>{t(claim.state)}</Tag>
          </button>
        </li>)}</ul>}
    </section>
  </div>
}
