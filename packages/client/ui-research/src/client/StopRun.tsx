/** Stopping a run, from its card above the composer or from the experiment board. */
import { useState, type ReactNode } from 'react'
import type { ExperimentRecord, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkbenchProps } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import styles from './StopRun.module.css'

/** The run to stop, and how the surrounding surface draws its buttons. */
export interface StopRunProps {
  project: ResearchProject
  record: ExperimentRecord
  /** Class of the stop buttons (the first press and the confirmation). */
  stopClassName?: string | undefined
  /** Class of the button that keeps the run going. */
  keepClassName?: string | undefined
}

/**
 * Stop, behind one confirmation, because a stopped run cannot be resumed.
 * While the host cancels the run the control says so; a refusal shows under
 * the button, which stays available.
 */
export function StopRun(props: WorkbenchProps & StopRunProps): ReactNode {
  const { project, record, t } = props
  const [asking, setAsking] = useState(false)
  const stopping = useAction()
  if (stopping.pending) return <span className={styles.status} role="status">{t('runStopping')}</span>
  if (!asking) {
    return <>
      <button type="button" className={props.stopClassName} onClick={() => { setAsking(true) }}>{t('runStop')}</button>
      <ActionError t={t} error={stopping.error} />
    </>
  }
  return <span className={styles.confirm} role="group" aria-label={t('confirmStop')}>
    <span className={styles.question}>{t('confirmStop')}</span>
    <button type="button" className={props.stopClassName} onClick={() => {
      setAsking(false)
      stopping.start(() => props.run({ action: 'experiment-cancel', projectId: project.id, runId: record.id }))
    }}>{t('runStop')}</button>
    <button type="button" className={props.keepClassName} onClick={() => { setAsking(false) }}>{t('runKeep')}</button>
  </span>
}
