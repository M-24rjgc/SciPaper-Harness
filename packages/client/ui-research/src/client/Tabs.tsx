/**
 * The research's secondary tools as right-sidebar tabs beside the conversation:
 * the experiment board and the figure gallery. Each tab shows the research of
 * the conversation it sits beside, and an example research reads as view only.
 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { useSessionProject, type WorkbenchProps } from './contract.ts'
import { Board } from './Board.tsx'
import { Gallery } from './Gallery.tsx'
import type { Translate } from './format.ts'
import styles from './Tabs.module.css'

/** Composed props of a research tab body: the tab seat's runtime share and the research face. */
export type ResearchTabProps = PropsRuntime<'sidebar.right.pane.tab'> & WorkbenchProps

/** What a tab says beside a conversation that is in no research. */
export function NoResearch(props: { t: Translate }): ReactNode {
  return <div className={styles.root}><p className={styles.empty}>{props.t('railNoProject')}</p></div>
}

/** The line an example research's tabs open with. */
export function ExampleBanner(props: { t: Translate }): ReactNode {
  return <p className={styles.exampleBanner}>{props.t('exampleBanner')}</p>
}

/** 实验看板 (Experiment board): the live board of the conversation's research; an example's runs cannot be stopped. */
export function ResearchBoardTab(props: ResearchTabProps): ReactNode {
  const project = useSessionProject(props)
  if (!project) return <NoResearch t={props.t} />
  return <div className={styles.root}>
    {project.example === true && <ExampleBanner t={props.t} />}
    <Board key={project.id} {...props} project={project} />
  </div>
}

/** 配图灵感 (Figure gallery): the published figures to study; an example saves no reference. */
export function ResearchGalleryTab(props: ResearchTabProps): ReactNode {
  const project = useSessionProject(props)
  if (!project) return <NoResearch t={props.t} />
  return <div className={styles.root}>
    {project.example === true && <ExampleBanner t={props.t} />}
    <Gallery key={project.id} {...props} project={project} />
  </div>
}

/** The board tab's chip title, in the interface language as it is now. */
export function ResearchBoardTitle(props: { t: Translate }): ReactNode {
  return <span className={styles.title}>{props.t('boardTitle')}</span>
}

/** The Sources tab's chip title. */
export function ResearchSourcesTitle(props: { t: Translate }): ReactNode {
  return <span className={styles.title}>{props.t('sourcesTab')}</span>
}

/** The gallery tab's chip title. */
export function ResearchGalleryTitle(props: { t: Translate }): ReactNode {
  return <span className={styles.title}>{props.t('gallery')}</span>
}
