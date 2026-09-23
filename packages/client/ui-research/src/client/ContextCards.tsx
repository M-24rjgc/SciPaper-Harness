/** Claims and editable outputs alongside the conversation that produced them. */
import type { ReactNode } from 'react'
import type { ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkbenchProps } from './contract.ts'
import { researchFileUrl } from './format.ts'
import styles from './ContextCards.module.css'

/** The newest claim and visual output stay linked to their full project records. */
export function ContextCards(props: WorkbenchProps & { project: ResearchProject }): ReactNode {
  const { project, t } = props
  const claim = project.claims.at(-1)
  const artifact = [...project.artifacts].reverse().find(a => a.kind === 'diagram' || a.kind === 'figure' || a.kind === 'image')
  if (!claim && !artifact) return null
  return <div className={styles.root}>
    {claim && <article className={styles.claim}>
      <div className={styles.meta}>{t('claim')}<span className={styles.tag}>{t(claim.state)}</span></div>
      <button className={styles.claimTitle} onClick={() =>{  props.focusClaim(claim.id) }}>{claim.text}</button>
      <div className={styles.links}>
        {claim.evidence.map((link, index) => {
          const source = project.evidence.find(e => e.id === link.evidenceId)
          return source && <button key={index} className={styles.source} onClick={() =>{  props.focusClaim(claim.id) }}>{source.title}{link.locator.page ? ` · ${t('locatorPage', { n: link.locator.page })}` : ''}</button>
        })}
        {claim.evidence.length === 0 && <span className={styles.missing}>{t('claimNoSources')}</span>}
      </div>
    </article>}
    {artifact && <article className={styles.artifact}>
      {/\.(svg|png|jpe?g|webp)$/i.test(artifact.path)
        ? <img className={styles.preview} alt={artifact.path} src={researchFileUrl(project.id, artifact.path)} />
        : <div className={styles.filePreview}><svg viewBox="0 0 48 48" width="48" height="48" fill="none" aria-hidden="true"><rect x="5" y="17" width="11" height="14" rx="3"/><rect x="32" y="17" width="11" height="14" rx="3"/><path d="M16 24h16m-5-4 5 4-5 4"/></svg><span>{t(artifact.kind)}</span></div>}
      <div className={styles.artifactFoot}><strong>{artifact.path}</strong><span>{t('revisionN', { n: artifact.revision })}</span><button className={styles.source} onClick={() =>{  props.expand(project.id, 'artifacts', artifact.id) }}>{t('openEditor')}</button></div>
    </article>}
  </div>
}
