/**
 * The experiment group as it stands right now, above the composer. Submitted
 * runs outlive the window, so this is a report on independent processes, not a
 * control panel: the only things it offers are the two a person actually needs
 * mid-run — read the output, or stop it.
 */
import { useState, type ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ExperimentRecord, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import { useSessionProject, type SessionSeatProps, type WorkbenchProps } from './contract.ts'
import { durationText, elapsedOf } from './format.ts'
import { MetricsGrid } from './MetricsGrid.tsx'
import styles from './RunPanel.module.css'

/** Runs still occupying a supervisor. */
const OPEN_RUN_STATUS = ['queued', 'running', 'unknown']
/** Cards drawn before the rest collapse into a count. */
const VISIBLE_RUNS = 5
const MS_PER_SECOND = 1000
const PERCENT = 100

/** The composer seat this panel drafts into, as the input dock supplies it. */
export interface RunPanelOwnerProps {
  /** Replace the composer draft; the person still decides whether to send it. */
  inputActions: { setDraft(text: string): void }
}

function statusMark(run: ExperimentRecord): string | undefined {
  if (run.status === 'running' || run.status === 'queued') return styles.markRunning
  if (run.status === 'completed') return styles.markDone
  return styles.markAttention
}

/** One run: what it is, how far it has got, and the things worth doing to it. */
function RunCard(props: WorkbenchProps & RunPanelOwnerProps & { project: ResearchProject; record: ExperimentRecord }): ReactNode {
  const { project, record, t } = props
  const [logs, setLogs] = useState('')
  const elapsed = elapsedOf(record)
  const limit = record.spec.maxSeconds * MS_PER_SECOND
  const open = OPEN_RUN_STATUS.includes(record.status)
  const unknown = record.status === 'unknown'
  const environment = project.environments.find(item => item.id === record.spec.environmentId)
  const fraction = record.progress?.fraction
  const runId = record.id
  const showLogs = (): void => {
    void props.run({ action: 'experiment-logs', projectId: project.id, runId })
      .then((response) => { setLogs(response.content ?? response.message) })
      .catch((error: unknown) => { setLogs(String(error)) })
  }
  return <article className={styles.run}>
    <div className={styles.runHead}>
      <span className={statusMark(record)}></span>
      <span className={styles.runName}>{record.spec.name} · {t('runSeed')} {record.spec.seed}</span>
      {open
        ? <Tag tone={unknown ? 'warning' : 'success'}>{t(unknown ? 'unknown' : 'runRunning')}</Tag>
        : record.collected && <Tag tone="success">{t('runCollected')}</Tag>}
      {elapsed !== undefined && !open && <span className={styles.runMeta}>{durationText(elapsed, t)}</span>}
      {environment && <span className={styles.runEnvironment} title={environment.python}>
        {environment.name} · {t(environment.target)}
      </span>}
    </div>

    {open && !unknown && <>
      <div className={styles.bar}>
        <span className={styles.barFill} style={{ width: `${Math.min(PERCENT, (fraction ?? (elapsed ?? 0) / limit) * PERCENT)}%` }}></span>
      </div>
      <div className={styles.runRow}>
        <span className={styles.runMeta}>
          {fraction === undefined ? `${t('runElapsed')} ${durationText(elapsed ?? 0, t)}` : t('boardPercent', { n: Math.round(fraction * PERCENT) })}
          {record.progress?.note !== undefined && ` · ${record.progress.note}`}
        </span>
        <span className={styles.runMeta}>{fraction === undefined ? `${t('runLimit')} ${durationText(limit, t)}` : `${t('runElapsed')} ${durationText(elapsed ?? 0, t)}`}</span>
      </div>
    </>}

    {unknown && <p className={styles.runNote}>{t('runUnknownNote')}</p>}
    <MetricsGrid metrics={Object.keys(record.metrics).length === 0 && open ? record.progress?.values ?? {} : record.metrics} />

    <div className={styles.actions}>
      <button type="button" className={styles.action} onClick={showLogs}>{t('logs')}</button>
      <button type="button" className={styles.action} onClick={() => { props.expand(project.id, 'experiments') }}>{t('boardOpen')}</button>
      {unknown && <button
        type="button"
        className={styles.action}
        onClick={() => { void props.run({ action: 'experiment-refresh', projectId: project.id, runId }).catch(() => {}) }}
      >{t('runReconnect')}</button>}
      {unknown && <button
        type="button"
        className={styles.action}
        onClick={() => { void props.run({ action: 'experiment-dismiss', projectId: project.id, runId }).catch(() => {}) }}
      >{t('dismiss')}</button>}
      {open && !unknown && <button
        type="button"
        className={styles.stop}
        onClick={() => { void props.run({ action: 'experiment-cancel', projectId: project.id, runId }).catch(() => {}) }}
      >{t('runStop')}</button>}
      {record.status === 'completed' && <button
        type="button"
        className={styles.action}
        onClick={() => { props.inputActions.setDraft(t('runPlotDraft', { name: record.spec.name, seed: record.spec.seed })) }}
      >{t('runPlot')}</button>}
    </div>

    {logs !== '' && <pre className={styles.logs}>{logs}</pre>}
  </article>
}

/**
 * The submitted group, newest first; nothing is drawn before a run exists.
 * Runs that still need a person stay open; finished ones fold into one row so
 * the conversation above the composer stays readable.
 */
export function ResearchRuns(props: WorkbenchProps & RunPanelOwnerProps & SessionSeatProps): ReactNode {
  const { t } = props
  const [expanded, setExpanded] = useState(false)
  const project = useSessionProject(props)
  if (!project || project.experiments.length === 0) return null
  const runs = [...project.experiments].reverse()
  const open = runs.filter(record => OPEN_RUN_STATUS.includes(record.status))
  const settled = runs.filter(record => !OPEN_RUN_STATUS.includes(record.status))
  const listed = expanded ? [...open, ...settled] : open
  const shown = listed.slice(0, VISIBLE_RUNS)
  return <div className={styles.root}>
    {shown.map(record => <RunCard key={record.id} {...props} project={project} record={record} />)}
    {listed.length > shown.length && <p className={styles.more}>{t('runMore', { n: listed.length - shown.length })}</p>}
    {settled.length > 0 && <button type="button" className={styles.settled} aria-expanded={expanded} onClick={() => { setExpanded(!expanded) }}>
      {expanded ? t('runsHideSettled') : t('runsShowSettled', { n: settled.length })}
    </button>}
  </div>
}
