/**
 * Where the research stands, in the conversation's own header. The session
 * header is hidden while a session is still blank, so this never competes with
 * the entry screen; it appears once there is work to report on. It is the one
 * door to the research record: a click opens the record, and a click while
 * the panel shows the record closes it.
 */
import { useMemo, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ModeSummary, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import { useModes, useSessionProject, type WorkbenchProps } from './contract.ts'
import { researchActivity } from './activity.ts'
import { modeName, packText, standingPhrase, standingPlace, type Translate } from './format.ts'
import styles from './Header.module.css'

/** Composed props of the chip: the header actions seat's runtime share and the research face. */
export type StatusChipProps = PropsRuntime<'conversation.session.header.actions'> & WorkbenchProps

/** Name the owning project before the shell's conversation titles and ancestor navigation. */
export function ResearchProjectContext(props: PropsRuntime<'conversation.session.header.context'> & WorkbenchProps): ReactNode {
  const project = useSessionProject(props)
  return <span className={styles.breadcrumb}>
    <span className={styles.projectName}>{project?.title ?? props.t('treeLoose')}</span>
    <span className={styles.separator}>/</span>
  </span>
}

/**
 * What the chip says: 模式待定 before the mode is chosen; the mode alone in
 * a mode without phases (通用); `{mode} · 已完成` with a verified ✓ once the
 * paper is finished; `{phase}已推迟` once nothing before a deferred phase is
 * left; else `{mode} · {phase} {done}/{total}`.
 */
function ChipText(props: { project: ResearchProject; modes: readonly ModeSummary[]; t: Translate }): ReactNode {
  const { project, modes, t } = props
  if (project.modeSetBy === undefined) return <span className={styles.stage}>{t('modeUnchosen')}</span>
  const mode = modeName(modes, project.mode, t)
  const place = standingPlace(project)
  if (place?.kind === 'finished') return <span className={styles.stage}>{mode} · {t('chipFinished')}<span className={styles.verified}> ✓</span></span>
  if (place?.kind === 'deferred') return <span className={styles.stage}>{t('standingDeferred', { phase: packText(place.phase.label, t) })}</span>
  const phrase = standingPhrase(project, t)
  return <span className={styles.stage}>{phrase === undefined ? mode : `${mode} · ${phrase}`}</span>
}

/**
 * The research chip: the example prefix, where the research stands, and a
 * dot, warn while a conversation or a goal of the research waits on the
 * person and ongoing blue while one of its conversations, goals or runs moves.
 */
export function ResearchStatusChip(props: StatusChipProps): ReactNode {
  const { t } = props
  const project = useSessionProject(props)
  const modes = useModes(props)
  const projects = props.useResearch(state => state.snapshot)?.projects
  const list = props.useSessions(state => state)
  const pending = props.useSessionStatus(state => state)
  const directories = props.useDirectories(state => state)
  const signal = useMemo(
    () => (project === undefined ? undefined : researchActivity(project, projects, list, pending, directories).signal),
    [project, projects, list, pending, directories],
  )
  if (!project) return null
  return <button type="button" className={styles.chip} onClick={() => { props.toggleProgress() }} title={t('railGuideTitle')}>
    {project.example === true && <>
      <span className={styles.example}>{t('exampleTag')}</span>
      <span className={styles.separator}>·</span>
    </>}
    <ChipText project={project} modes={modes} t={t} />
    {signal !== undefined && <>
      <span className={styles.dot} data-signal={signal} aria-hidden="true" />
      <span className={styles.hidden}>{t(signal === 'waiting' ? 'treeWaiting' : 'treeOngoing')}</span>
    </>}
  </button>
}
