/**
 * One claim and the sources standing under it. The rail opens this over the
 * whole frame; nothing here is editable, because a claim is only ever changed
 * by the work that produced it.
 */
import type { ReactNode } from 'react'
import { Modal, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ClaimRecord, EvidenceLink, EvidenceRecord, ResearchProject,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { ClaimFocus, WorkbenchProps } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import { digestText, locatorText, momentText } from './format.ts'
import { MetricsGrid } from './MetricsGrid.tsx'
import styles from './ClaimSheet.module.css'

/** How a claim's own state reads as a badge, here and in the Sources tab's claims. */
export const CLAIM_TONE: Record<ClaimRecord['state'], TagTone> = {
  supported: 'success',
  proposed: 'warning',
  contradicted: 'danger',
  stale: 'warning',
}

/** Where a claim is written down, from both directions of a link the backend never reconciles. */
function appearances(project: ResearchProject, claim: ClaimRecord): ResearchProject['artifacts'] {
  const ids = new Set<string>(claim.artifactIds)
  for (const artifact of project.artifacts) if (artifact.claimIds.includes(claim.id)) ids.add(artifact.id)
  return project.artifacts.filter(artifact => ids.has(artifact.id))
}

/** The run an experiment source came out of, matched the way the backend matches it. */
function runOf(project: ResearchProject, source: EvidenceRecord): ResearchProject['experiments'][number] | undefined {
  return project.experiments.find(run => source.path.includes(`/runs/${run.id}/`))
}

/** How the sheet opens a file: the sheet's own action, so a refusal shows inside the sheet. */
type OpenFile = (path: string) => void

/** One source card: what it says, where exactly it says it, and how to go read it. */
function Source(props: WorkbenchProps & { project: ResearchProject; link: EvidenceLink; open: OpenFile }): ReactNode {
  const { project, link, t } = props
  const source = project.evidence.find(item => item.id === link.evidenceId)
  if (!source) return null
  const run = source.kind === 'experiment' ? runOf(project, source) : undefined
  const current = !source.stale && source.revision === link.revision
  const where = locatorText(link.locator, t)
  const meta = [
    source.doi === undefined ? '' : t('claimDoi', { doi: source.doi }),
    where,
    run === undefined ? '' : `${t('runSeed')} ${run.spec.seed}`,
    run?.finishedAt === undefined ? '' : momentText(run.finishedAt, t),
    t('revisionN', { n: link.revision }),
  ].filter(Boolean).join(' · ')
  return <article className={styles.source}>
    <div className={styles.sourceThumbnail} aria-hidden="true">{run ? <><i /><i /><i /><i /></> : <><span /><span /><span /><b /><span /></>}</div>
    <div className={styles.sourceContent}>
      <div className={styles.sourceHead}>
        <span className={styles.sourceTitle}>{source.title}</span>
        {source.kind === 'experiment'
          ? <Tag tone="info">{t('claimProjectData')}</Tag>
          : current && source.verified && <Tag tone="success">{t('verified')}</Tag>}
        {!current && <Tag tone="warning">{t('stale')}</Tag>}
      </div>
      <p className={styles.sourceMeta}>{meta}</p>
      {link.quote !== '' && <blockquote className={styles.quote}>{link.quote}</blockquote>}
      {run && <MetricsGrid metrics={run.metrics} className={styles.metrics} />}
      <div className={styles.sourceFoot}>
        <button
          type="button"
          className={styles.open}
          onClick={() => { props.open(source.path) }}
        >{t(run ? 'claimOpenRun' : 'claimOpenSource')}</button>
        {run
          ? <span className={styles.digest}>{t('claimSnapshot', { n: run.spec.codeArtifactIds.length + run.spec.dataEvidenceIds.length })}</span>
          : current && <span className={styles.digest}>{t('claimDigest', { digest: digestText(source.sha256) })}</span>}
      </div>
    </div>
  </article>
}

/** The counts under "where the support comes from". */
function Mix(props: WorkbenchProps & { project: ResearchProject; claim: ClaimRecord }): ReactNode {
  const { project, claim, t } = props
  const kinds = claim.evidence.map(link => project.evidence.find(item => item.id === link.evidenceId)?.kind)
  const data = kinds.filter(kind => kind === 'experiment').length
  const literature = kinds.filter(kind => kind === 'literature').length
  if (data === 0 && literature === 0) return null
  return <div className={styles.mix}>
    <span className={styles.mixHead}>{t('claimSourceMix')}</span>
    {data > 0 && <span className={styles.mixItem}><span className={styles.mixDot}></span>{t('claimMixExperiment', { n: data })}</span>}
    {literature > 0 && <span className={styles.mixItem}><span className={styles.mixDot}></span>{t('claimMixLiterature', { n: literature })}</span>}
  </div>
}

/** The claim, its consequences, and every source behind it. */
function Sheet(props: WorkbenchProps & { project: ResearchProject; claim: ClaimRecord }): ReactNode {
  const { project, claim, t } = props
  const opening = useAction()
  const open: OpenFile = (path) => { opening.start(() => { props.openFile(project.root, path) }) }
  const written = appearances(project, claim)
  return <div className={styles.sheet}>
    <header className={styles.head}>
      <span className={styles.kicker}>{t('claim')}</span>
      <Tag tone={CLAIM_TONE[claim.state]}>{t(claim.state)}</Tag>
      <button type="button" className={styles.close} title={t('close')} onClick={() => { props.focusClaim(null) }}>×</button>
    </header>
    <ActionError t={t} error={opening.error} />
    <div className={styles.columns}>
      <div className={styles.left}>
        <p className={styles.claimText}>{claim.text}</p>
        {written.length > 0 && <div className={styles.group}>
          <span className={styles.groupHead}>{t('claimAppearsIn')}</span>
          {written.map(artifact => <button key={artifact.id} type="button" className={styles.appearance} onClick={() => { open(artifact.path) }}>
            {artifact.path} · {t('revisionN', { n: artifact.revision })}
          </button>)}
        </div>}
        <div className={styles.group}>
          <span className={styles.groupHead}>{t('claimIfSourceChanges')}</span>
          <p className={styles.groupBody}>{t('claimStaleExplain')}</p>
        </div>
        <Mix {...props} project={project} claim={claim} />
      </div>
      <div className={styles.right}>
        <span className={styles.groupHead}>{t('claimSupporting')}</span>
        {claim.evidence.length === 0
          ? <p className={styles.groupBody}>{t('claimNoSources')}</p>
          : claim.evidence.map((link, index) => <Source key={`${link.evidenceId}-${index}`} {...props} project={project} link={link} open={open} />)}
        <p className={styles.footer}>{t('claimFooter')}</p>
      </div>
    </div>
  </div>
}

/** The focused claim, looked up in its own project only: claim ids are unique within a project, not across projects. */
function focusedClaim(
  projects: readonly ResearchProject[] | undefined,
  focus: ClaimFocus | null,
): { project: ResearchProject; claim: ClaimRecord } | undefined {
  if (focus === null) return undefined
  const project = projects?.find(item => item.id === focus.projectId)
  const claim = project?.claims.find(item => item.id === focus.claimId)
  return project && claim ? { project, claim } : undefined
}

/** Frame-wide seat: it draws only while the rail has put a claim in focus. */
export function ResearchClaimSheet(props: WorkbenchProps): ReactNode {
  const { t } = props
  const focus = props.useFocus(s => s)
  const view = props.useResearch(s => s)
  const found = focusedClaim(view.snapshot?.projects, focus.claim)
  return <Modal
    open={found !== undefined}
    onClose={() => { props.focusClaim(null) }}
    title={t('claim')}
    headless
    className={styles.dialog ?? ''}
  >
    {found && <Sheet key={`${found.project.id}/${found.claim.id}`} {...props} project={found.project} claim={found.claim} />}
  </Modal>
}
