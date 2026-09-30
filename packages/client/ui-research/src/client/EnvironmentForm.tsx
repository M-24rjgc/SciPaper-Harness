/** Project environment creation uses the same inspected/managed backend operation as the agent. */
import { useState, type FormEvent, type ReactNode } from 'react'
import type { EnvironmentRecord } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkbenchProps } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import styles from './ResearchSettings.module.css'

/**
 * Environment settings remain project scoped, including SSH and dependency
 * locking. Preparing an environment is a host job; the form waits for it, keeps
 * what was typed when it fails, and closes once it succeeded.
 */
export function EnvironmentForm(props: WorkbenchProps): ReactNode {
  const { t } = props
  const view = props.useResearch(s => s)
  const projects = view.snapshot?.projects ?? []
  const [kind, setKind] = useState<EnvironmentRecord['kind']>('uv')
  const [target, setTarget] = useState<EnvironmentRecord['target']>('local')
  const [open, setOpen] = useState(false)
  const preparing = useAction()
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    // Every name read through value() is a field this form always renders.
    const value = (name: string): string => (data.get(name) as string).trim()
    // A project select left with no options is absent from the form data, which matches no project.
    const project = projects.find(p => p.id === data.get('project'))
    if (!project) return
    const environment = {
      name: value('name'), kind, target, python: value('python'),
      requirements: kind === 'uv' ? value('requirements').split('\n').map(v => v.trim()).filter(Boolean) : [],
      isDefault: data.get('default') === 'on',
      ...(target === 'ssh' ? { sshHost: value('sshHost'), remoteRoot: value('remoteRoot') } : {}),
    }
    preparing.start(async () => {
      await props.run({ action: 'environment', projectId: project.id, environment })
      setOpen(false)
    })
  }
  return <div>
    <button className={styles.install} type="button" disabled={projects.length === 0} aria-expanded={open} onClick={() =>{  setOpen(!open) }}>{t('newEnvironment')}</button>
    {open && <form className={styles.environmentForm} onSubmit={submit}>
      <div className={styles.roleFields}>
        <label className={styles.field}>{t('projects')}<select className={styles.input} name="project" required>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
        <label className={styles.field}>{t('environmentName')}<input className={styles.input} name="name" required /></label>
        <label className={styles.field}>{t('environmentKind')}<select className={styles.input} value={kind} onChange={(e) =>{  setKind(e.target.value as EnvironmentRecord['kind']) }}>{(['uv', 'existing', 'conda'] as const).map(k => <option key={k} value={k}>{t(k === 'uv' ? 'managed' : k)}</option>)}</select></label>
        <label className={styles.field}>{t('target')}<select className={styles.input} value={target} onChange={(e) =>{  setTarget(e.target.value as EnvironmentRecord['target']) }}><option value="local">{t('local')}</option><option value="ssh">{t('ssh')}</option></select></label>
      </div>
      <label className={styles.field}>{t('python')}<input className={styles.input} key={kind} name="python" defaultValue={kind === 'uv' ? '3.12' : ''} required /></label>
      {target === 'ssh' && <div className={styles.roleFields}><label className={styles.field}>{t('sshHost')}<input name="sshHost" className={styles.input} required /></label><label className={styles.field}>{t('remoteRoot')}<input name="remoteRoot" className={styles.input} required /></label></div>}
      {kind === 'uv' && <label className={styles.field}>{t('requirements')}<textarea name="requirements" className={styles.input} rows={3} /></label>}
      <label className={styles.check}><input type="checkbox" name="default" defaultChecked />{t('defaultEnvironment')}</label>
      <p className={styles.groupHint}>{t('environmentHelp')}</p>
      <ActionError t={t} error={preparing.error} />
      {preparing.pending && <p className={styles.groupHint} role="status">{t('running')}</p>}
      <button disabled={preparing.pending} className={styles.save}>{t('addEnvironment')}</button>
    </form>}
  </div>
}
