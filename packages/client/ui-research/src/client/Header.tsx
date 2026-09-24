/**
 * Where the research stands, in the conversation's own header. The session
 * header is hidden while a session is still blank, so this never competes with
 * the entry screen; it appears once there is work to report on.
 */
import type { ReactNode } from 'react'
import { useModes, useSessionProject, type SessionSeatProps, type WorkbenchProps } from './contract.ts'
import { standingText } from './format.ts'
import styles from './Header.module.css'

/** Mode and the phase the last check left open; opening it shows the full record beside the conversation. */
export function ResearchStatusChip(props: WorkbenchProps & SessionSeatProps): ReactNode {
  const { t } = props
  const project = useSessionProject(props)
  const modes = useModes(props)
  if (!project) return null
  return <button type="button" className={styles.chip} onClick={() => props.showProgress?.()} title={t('railGuideTitle')}>
    <span className={styles.stage}>{standingText(project, modes, t)}</span>
    {project.autonomy === 'automatic' && <>
      <span className={styles.separator}>·</span>
      <span className={styles.position}>{t('autonomyShortAutomatic')}</span>
    </>}
  </button>
}

/** The project's files and the figure gallery, reachable from the conversation header. */
export function ResearchProjectActions(props: WorkbenchProps & SessionSeatProps): ReactNode {
  const { t } = props
  const project = useSessionProject(props)
  if (!project) return null
  return <span className={styles.actions}>
    <button type="button" className={styles.action} onClick={() => { props.expand(project.id, 'artifacts') }}>{t('projectFolder')}</button>
    <button type="button" className={styles.action} onClick={() => { props.expand(project.id, 'gallery') }}>{t('gallery')}</button>
  </span>
}
