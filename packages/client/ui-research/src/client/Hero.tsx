/** Blank-session entry: the research mark, the promise, and the three ways to open. */
import { useEffect, type ReactNode } from 'react'
import type { ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import { useSessionProject, type SessionSeatProps, type WorkbenchProps } from './contract.ts'
import { ContextCards } from './ContextCards.tsx'
import { standingText } from './format.ts'
import styles from './Hero.module.css'

/** Owner share of the blank-session dock seat. */
export interface HeroDockProps {
  session: { blank: boolean }
}

/** The flask mark standing where the generic brand mark would be. */
export function ResearchHeroMark(props: { size?: number | undefined; className?: string | undefined }): ReactNode {
  const size = props.size ?? 34
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={props.className} aria-hidden="true">
    <path d="M8 3h8M10 3v7L4.6 19a1.3 1.3 0 0 0 1.1 2h12.6a1.3 1.3 0 0 0 1.1-2L14 10V3M8 15h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <circle cx="12" cy="17.5" r="1" fill="currentColor"/>
  </svg>
}

function MaterialsIcon(): ReactNode {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 4.5h9l5 5V19a.5.5 0 0 1-.5.5h-13A.5.5 0 0 1 5 19V4.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    <path d="M13.5 4.5V10h5.2M8.5 13h7M8.5 16h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
}

function IdeaIcon(): ReactNode {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.5"/>
    <path d="M12 8.6v3.6M12 15.2v.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
}

function ResumeIcon(): ReactNode {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4.8 12a7.2 7.2 0 1 1 2.3 5.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M4.5 17.2V12h5.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
}

/**
 * The three standing promises, drawn under the composer on the entry screen
 * only: they describe how the product works, not what this session is doing.
 */
export function ResearchPromise(props: WorkbenchProps & { variant?: 'hero' | 'composer' }): ReactNode {
  const { t } = props
  if (props.variant === 'composer') return null
  return <div className={styles.promise}>
    <span className={styles.promiseItem}><span className={styles.dotClay}></span>{t('heroPromiseDecide')}</span>
    <span className={styles.promiseItem}><span className={styles.dotTeal}></span>{t('heroPromiseTrace')}</span>
    <span className={styles.promiseItem}><span className={styles.dotGrey}></span>{t('heroPromiseRuns')}</span>
  </div>
}

/**
 * Beside an ongoing research conversation: the rail opens once, and the newest
 * claim and figure stay linked above the composer until runs take their place.
 * Decisions are asked in the conversation itself, never by a card here.
 */
export function ResearchDock(props: WorkbenchProps & HeroDockProps & SessionSeatProps): ReactNode {
  const project = useSessionProject(props)
  useEffect(() => {
    if (!project || !props.showProgress) return
    const frame = requestAnimationFrame(() => props.showProgress?.())
    return () => { cancelAnimationFrame(frame) }
  }, [project?.id])
  if (!props.session.blank && project && project.experiments.length === 0) return <ContextCards {...props} project={project} />
  return null
}

/** The resume card's contents, drawn the same whether or not there is a session to walk back into. */
function ResumeContent(props: WorkbenchProps & { resume: ResearchProject }): ReactNode {
  const { t, resume } = props
  return <>
    <span className={styles.icon}><ResumeIcon /></span>
    <span className={styles.cardTitle}>{t('heroCardResume')}</span>
    <span className={styles.cardBody}>{t('heroCardResumeBody')}</span>
    <span className={styles.resumeBox}>
      <span className={styles.resumeTitle}>{resume.title}</span>
      <span className={styles.resumeStage}>{standingText(resume, t)}</span>
    </span>
  </>
}

export function ResearchStarters(props: WorkbenchProps): ReactNode {
  const { t } = props
  const view = props.useResearch(s => s)
  const projects = view.snapshot?.projects ?? []
  const resume = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const resumeSession = resume?.sessionId
  return <div className={styles.dock}>
    <p className={styles.intro}>{t('heroIntro')}</p>
    <div className={styles.cards}>
      <article className={styles.card}>
        <span className={styles.icon}><MaterialsIcon /></span>
        <span className={styles.cardTitle}>{t('heroCardMaterials')}</span>
        <span className={styles.cardBody}>{t('heroCardMaterialsBody')}</span>
        <span className={styles.example}>{t('heroOpeningMaterials')}</span>
      </article>
      <article className={styles.card}>
        <span className={styles.icon}><IdeaIcon /></span>
        <span className={styles.cardTitle}>{t('heroCardIdea')}</span>
        <span className={styles.cardBody}>{t('heroCardIdeaBody')}</span>
        <span className={styles.example}>{t('heroOpeningIdea')}</span>
      </article>
      {!resume && <article className={styles.card}>
        <span className={styles.icon}><ResumeIcon /></span>
        <span className={styles.cardTitle}>{t('heroCardResume')}</span>
        <span className={styles.cardBody}>{t('heroCardResumeBody')}</span>
        <span className={styles.resumeBox}>{t('heroNoHistory')}</span>
      </article>}
      {resume && (resumeSession === undefined
        ? <article className={styles.card}><ResumeContent {...props} resume={resume} /></article>
        : <button
          type="button"
          className={styles.cardButton}
          onClick={() => { void props.openConversation(resumeSession).catch(() => {}) }}
        ><ResumeContent {...props} resume={resume} /></button>)}
    </div>
  </div>
}
