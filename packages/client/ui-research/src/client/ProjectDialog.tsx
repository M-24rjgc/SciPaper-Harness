/** Explicit project creation and conversation assignment; opening either dialog creates nothing. */
import { useId, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProjectId, ResearchProject, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import type { ResearchTreeInjected } from './contract.ts'
import type { Translate } from './format.ts'
import { ActionError, useAction } from './Action.tsx'
import styles from './ResearchTree.module.css'

type Operations = Pick<ResearchTreeInjected, 'run' | 'chooseFolder' | 'openResult'>

/** A cross-platform default child folder; the Host validates the resulting absolute path. */
function suggestedRoot(home: string, name: string): string {
  const folder = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '')
  return `${home.replace(/[\\/]+$/, '')}/${folder}`
}

/** Create or reopen a project only after confirmation, retaining the form on failure. */
export function ProjectDialog(props: Operations & {
  t: Translate
  home: string
  sourceSessionId?: string | undefined
  onClose(): void
}): ReactNode {
  const { t } = props
  const formId = useId()
  const saving = useAction()
  const [name, setName] = useState('')
  const [chosenRoot, setChosenRoot] = useState<string | undefined>()
  const [confirmation, setConfirmation] = useState<ResearchResponse | undefined>()
  const [pickerUnavailable, setPickerUnavailable] = useState(false)
  const root = chosenRoot ?? suggestedRoot(props.home, name)
  const close = (): void => { if (!saving.pending) props.onClose() }
  const submit = (): void => {
    saving.start(async () => {
      const result = await props.run({ action: 'create-project', title: name.trim(), root: root.trim(),
        ...(confirmation === undefined ? {} : { confirmNonEmpty: true }),
        ...(props.sourceSessionId === undefined ? {} : { sessionId: props.sourceSessionId }),
      })
      if (result.sessionId === undefined) { setConfirmation(result); return }
      await props.openResult(result)
      props.onClose()
    })
  }
  const label = saving.pending ? t('projectCreating') : confirmation?.outcome === 'existing' ? t('projectOpen')
    : confirmation?.outcome === 'needs-confirm' ? t('projectUseFolder') : t('projectCreate')
  return <Modal open onClose={close} title={t('projectNew')} closeLabel={t('close')} footer={<>
    <Button variant="outline" disabled={saving.pending} onClick={close}>{t('cancel')}</Button>
    <Button variant="primary" type="submit" form={formId} disabled={saving.pending || name.trim() === '' || root.trim() === ''}>{label}</Button>
  </>}>
    <form id={formId} className={styles.form} onSubmit={(event) => { event.preventDefault(); submit() }}>
      <label className={styles.field}><span>{t('projectName')}</span>
        <input className={styles.input} value={name} autoFocus required disabled={saving.pending}
          onChange={(event) => { setName(event.target.value); setConfirmation(undefined); saving.clear() }} />
      </label>
      <label className={styles.field}><span>{t('projectLocation')}</span>
        <input className={styles.input} value={root} required disabled={saving.pending} spellCheck={false}
          onChange={(event) => { setChosenRoot(event.target.value); setConfirmation(undefined); saving.clear() }} />
      </label>
      <Button variant="outline" disabled={saving.pending} onClick={() => { saving.start(async () => {
        const picked = await props.chooseFolder()
        setPickerUnavailable(picked.kind === 'unavailable')
        if (picked.kind === 'picked') { setChosenRoot(picked.path); setConfirmation(undefined) }
      }) }}>{t('projectPick')}</Button>
      <p className={styles.hint}>{t('projectLocationHint')}</p>
      {pickerUnavailable && <p className={styles.hint} role="status">{t('projectTypeLocation')}</p>}
      {props.sourceSessionId !== undefined && <p className={styles.hint}>{t('projectJoinHint')}</p>}
      {confirmation !== undefined && <p className={styles.hint} role="status">{confirmation.outcome === 'existing'
        ? t('projectExisting', { title: confirmation.project?.title ?? '' }) : t('projectNonEmpty')}</p>}
      <ActionError t={t} error={saving.error} />
    </form>
  </Modal>
}

/** Choose the destination for a completed ordinary conversation; the Host rejects active work. */
export function JoinProjectDialog(props: Pick<Operations, 'run' | 'openResult'> & { t: Translate; projects: readonly ResearchProject[]; sessionId: string; onClose(): void }): ReactNode {
  const { t } = props
  const saving = useAction()
  const [selected, setSelected] = useState<ProjectId | undefined>()
  const close = (): void => { if (!saving.pending) props.onClose() }
  return <Modal open onClose={close} title={t('projectJoinTitle')} closeLabel={t('close')} footer={<>
    <Button variant="outline" disabled={saving.pending} onClick={close}>{t('cancel')}</Button>
    <Button variant="primary" disabled={saving.pending || selected === undefined} onClick={() => {
      if (selected === undefined) return
      saving.start(async () => {
        await props.openResult(await props.run({ action: 'join-project', projectId: selected, sessionId: props.sessionId }))
        props.onClose()
      })
    }}>{t('projectJoin')}</Button>
  </>}>
    <div className={styles.form}>
      <p className={styles.hint}>{t('projectJoinHint')}</p>
      <div className={styles.projectChoices}>
        {props.projects.filter(project => project.example !== true && project.archived !== true).map(project =>
          <label key={project.id} className={styles.projectChoice}>
            <input type="radio" name="project" checked={selected === project.id} disabled={saving.pending} onChange={() => { setSelected(project.id) }} />
            <span>{project.title}</span>
          </label>)}
      </div>
      <ActionError t={t} error={saving.error} />
    </div>
  </Modal>
}
