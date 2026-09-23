/** Project navigation and project creation. Creating a project starts nothing: the conversation does the work. */
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchMode } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkbenchProps } from './contract.ts'
import { standingText } from './format.ts'
import styles from './ProjectEntry.module.css'

const MODES: readonly ResearchMode[] = ['paper-first', 'from-results', 'free']

/** Project cards name where each project stands and open its own conversation. */
export function ResearchProjects(props: WorkbenchProps & { wide: boolean }): ReactNode {
  const { t } = props
  // Most recently worked on first, the same project the blank session offers to resume.
  const projects = [...props.useResearch(s => s).snapshot?.projects ?? []].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  if (!props.wide) return null
  return <nav className={styles.projects} aria-label={t('projects')}>
    <div className={styles.label}>{t('projects')}</div>
    {projects.length === 0 && <p className={styles.empty}>{t('heroNoHistory')}</p>}
    {projects.map(project => <button type="button" className={styles.project} key={project.id} onClick={() => {
      if (project.sessionId) void props.openConversation(project.sessionId).catch(() => {})
      else void props.create({ root: project.root, title: project.title, brief: project.brief })
        .then((bound) => {
          if (bound.sessionId) return props.openConversation(bound.sessionId)
          props.expand(bound.id)
          return undefined
        }).catch(() => {})
    }}>
      <strong>{project.title}</strong>
      <span className={styles.empty}>{standingText(project, t)}</span>
    </button>)}
  </nav>
}

/** A folder can be typed in a browser or picked by the desktop host. */
export function ResearchProjectEntry(props: WorkbenchProps & { composerDraft?: string }): ReactNode {
  const { t } = props
  const view = props.useResearch(s => s)
  const [open, setOpen] = useState(false)
  const [root, setRoot] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (submitting) return
    const form = new FormData(event.currentTarget)
    // Every name read here is a field this form always renders.
    const text = (name: string): string => (form.get(name) as string).trim()
    const mode = MODES.find(item => item === text('mode'))
    setError('')
    setSubmitting(true)
    void props.create({
      title: text('title'), root: root.trim(), brief: text('brief'),
      ...(mode === undefined ? {} : { mode }),
      autonomy: text('autonomy') === 'automatic' ? 'automatic' : 'checkpoints',
    })
      .then(async (project) => {
        if (project.sessionId) await props.openConversation(project.sessionId)
        else props.expand(project.id, 'workflow')
        close()
      })
      .catch((problem: unknown) => { setError(String(problem)) })
      .finally(() => { setSubmitting(false) })
  }
  return <>
    <button ref={trigger} className={props.composerDraft === undefined ? styles.entry : styles.composerEntry} type="button"
      disabled={view.busy || submitting} aria-label={t('newProjectDirectory')} title={t('newProjectHint')}
      onClick={() => { setError(''); setOpen(true) }}>
      {props.composerDraft === undefined ? t('newProjectDirectory') : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 6.5h5.2l1.6 2H20v9a.5.5 0 0 1-.5.5h-15a.5.5 0 0 1-.5-.5v-11Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>}
    </button>
    <Modal open={open} onClose={close} title={t('newProject')} closeLabel={t('close')} className={styles.dialog ?? ''}>
      <form className={styles.form} onSubmit={submit}>
        <label>{t('title')}<input name="title" required autoFocus /></label>
        <label>{t('directory')}<input name="root" required value={root} onChange={(e) => { setRoot(e.target.value) }} placeholder={t('projectRootHint')} /></label>
        <button type="button" className={styles.entry} disabled={view.busy} onClick={() => {
          void props.pickDirectory().then((path) => { if (path) setRoot(path) }).catch((problem: unknown) => { setError(String(problem)) })
        }}>{t('pickDirectory')}</button>
        <label>{t('mode')}<select name="mode" defaultValue="">
          <option value="">{t('modeAuto')}</option>
          <option value="paper-first">{t('modePaperFirst')}</option>
          <option value="from-results">{t('modeFromResults')}</option>
          <option value="free">{t('modeFree')}</option>
        </select></label>
        <label>{t('autonomy')}<select name="autonomy" defaultValue="checkpoints">
          <option value="checkpoints">{t('autonomyCheckpoints')}</option>
          <option value="automatic">{t('autonomyAutomatic')}</option>
        </select></label>
        <label>{t('brief')}<textarea name="brief" rows={3} defaultValue={props.composerDraft ?? ''} /></label>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}><button className={styles.primary} disabled={view.busy || submitting}>{t(submitting ? 'newProjectBusy' : 'create')}</button><button type="button" className={styles.entry} onClick={close}>{t('cancel')}</button></div>
      </form>
    </Modal>
  </>
}
