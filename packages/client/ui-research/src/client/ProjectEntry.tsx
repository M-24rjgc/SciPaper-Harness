/** The sidebar's project list. Opening a project starts nothing: the conversation does the work. */
import type { ReactNode } from 'react'
import type { ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import { useModes, type WorkbenchProps } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import { standingText } from './format.ts'
import styles from './ProjectEntry.module.css'

/** Project cards name where each project stands and open its own conversation. */
export function ResearchProjects(props: WorkbenchProps & { wide: boolean }): ReactNode {
  const { t } = props
  const opening = useAction()
  // The person's own researches first, then the examples; most recently worked on first within each.
  const snapshot = props.useResearch(s => s).snapshot
  const projects = [...snapshot?.projects ?? []]
    .sort((a, b) => Number(a.example === true) - Number(b.example === true) || b.updatedAt.localeCompare(a.updatedAt))
  const modes = useModes(props)
  if (!props.wide) return null
  const open = (project: ResearchProject): void => {
    const sessionId = project.sessionId
    opening.start(async () => {
      if (sessionId !== undefined) return props.openConversation(sessionId, project.workspaceId)
      const bound = await props.create({ root: project.root, title: project.title, brief: project.brief })
      if (bound.sessionId) return props.openConversation(bound.sessionId, bound.workspaceId)
      props.expand(bound.id)
      return undefined
    })
  }
  return <nav className={styles.projects} aria-label={t('projects')}>
    <div className={styles.label}>{t('projects')}</div>
    {projects.length === 0 && <p className={styles.empty}>{t('heroNoHistory')}</p>}
    {projects.map(project => <button type="button" className={styles.project} key={project.id} onClick={() => { open(project) }}>
      <span className={styles.titleRow}>
        <strong>{project.title}</strong>
        {project.example === true && <span className={styles.exampleTag}>{t('exampleTag')}</span>}
      </span>
      <span className={styles.empty}>{standingText(project, modes, t)}</span>
    </button>)}
    <ActionError t={t} error={opening.error} />
  </nav>
}
