/** Project navigation and project creation. Creating a project starts nothing: the conversation does the work. */
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import { useModes, type WorkbenchProps } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import { chosenMode, standingText } from './format.ts'
import { ModeSelect } from './ModeSelect.tsx'
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

/** A folder can be typed in a browser or picked by the desktop host. */
export function ResearchProjectEntry(props: WorkbenchProps & { composerDraft?: string }): ReactNode {
  const { t } = props
  const modes = useModes(props)
  const [open, setOpen] = useState(false)
  const [root, setRoot] = useState('')
  const creating = useAction()
  const picking = useAction()
  const trigger = useRef<HTMLButtonElement>(null)
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (creating.pending) return
    const form = new FormData(event.currentTarget)
    // Every name read here is a field this form always renders.
    const text = (name: string): string => (form.get(name) as string).trim()
    const request = {
      title: text('title'), root: root.trim(), brief: text('brief'),
      ...chosenMode(form),
      autonomy: text('autonomy') === 'automatic' ? 'automatic' as const : 'checkpoints' as const,
    }
    creating.start(async () => {
      const project = await props.create(request)
      if (project.sessionId) await props.openConversation(project.sessionId, project.workspaceId)
      else props.expand(project.id, 'workflow')
      close()
    })
  }
  return <>
    <button ref={trigger} className={props.composerDraft === undefined ? styles.entry : styles.composerEntry} type="button"
      disabled={creating.pending} aria-label={t('newProjectDirectory')} title={t('newProjectHint')}
      onClick={() => { creating.clear(); picking.clear(); setOpen(true) }}>
      {props.composerDraft === undefined ? t('newProjectDirectory') : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 6.5h5.2l1.6 2H20v9a.5.5 0 0 1-.5.5h-15a.5.5 0 0 1-.5-.5v-11Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>}
    </button>
    <Modal open={open} onClose={close} title={t('newProject')} closeLabel={t('close')} className={styles.dialog ?? ''}>
      <form className={styles.form} onSubmit={submit}>
        <label>{t('title')}<input name="title" required autoFocus /></label>
        <label>{t('directory')}<input name="root" required value={root} onChange={(e) => { setRoot(e.target.value) }} placeholder={t('projectRootHint')} /></label>
        <button type="button" className={styles.entry} disabled={picking.pending} onClick={() => {
          picking.start(async () => { const path = await props.pickDirectory(); if (path) setRoot(path) })
        }}>{t('pickDirectory')}</button>
        <ActionError t={t} error={picking.error} />
        <label>{t('mode')}<ModeSelect modes={modes} t={t} name="mode" defaultValue="general" /></label>
        <label>{t('autonomy')}<select name="autonomy" defaultValue="checkpoints">
          <option value="checkpoints">{t('autonomyCheckpoints')}</option>
          <option value="automatic">{t('autonomyAutomatic')}</option>
        </select></label>
        <label>{t('brief')}<textarea name="brief" rows={3} defaultValue={props.composerDraft ?? ''} /></label>
        <ActionError t={t} error={creating.error} />
        <div className={styles.actions}><button className={styles.primary} disabled={creating.pending}>{t(creating.pending ? 'newProjectBusy' : 'create')}</button><button type="button" className={styles.entry} onClick={close}>{t('cancel')}</button></div>
      </form>
    </Modal>
  </>
}
