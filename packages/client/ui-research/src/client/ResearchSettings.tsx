/**
 * Everything configurable about research, in the one place configuration
 * belongs. The workbench surfaces carry no settings at all; when a change is
 * needed mid-research the conversation sends the person here and back.
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import { Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentStatus, ResearchPreferences, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { ResearchKey } from './locales.ts'
import type { WorkbenchProps } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import { EnvironmentForm } from './EnvironmentForm.tsx'
import styles from './ResearchSettings.module.css'

/** Field names of one model role, in the order the row lays them out. */
interface RoleFields {
  provider: ResearchKey
  model: ResearchKey
}

/** The image endpoint a fresh configuration starts from (OpenAI, gpt-image-2); the person only adds the key. */
const IMAGE_START = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2', size: '1536x1024', quality: 'high', apiStyle: 'images' } as const
const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const
/** The embedding endpoint a key alone enables: OpenAI's small embedding model. */
const EMBEDDING_START = { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small' } as const
const IMAGE_STYLES = ['images', 'chat'] as const

function text(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/** A choice among fixed values, each named by its own dictionary entry. */
function Choice<V extends string>(props: {
  label: string
  name: string
  value: V
  options: readonly V[]
  optionKey: (value: V) => ResearchKey
  t: WorkbenchProps['t']
}): ReactNode {
  return <label className={styles.field}>
    <span className={styles.fieldLabel}>{props.label}</span>
    <select className={styles.input} name={props.name} defaultValue={props.value}>
      {props.options.map(option => <option key={option} value={option}>{props.t(props.optionKey(option))}</option>)}
    </select>
  </label>
}

function Field(props: { label: string; name: string; defaultValue?: string; type?: string }): ReactNode {
  return <label className={styles.field}>
    <span className={styles.fieldLabel}>{props.label}</span>
    <input className={styles.input} name={props.name} type={props.type ?? 'text'} defaultValue={props.defaultValue} />
  </label>
}

/**
 * One model role: what it is for, what it is bound to now, and the two ids
 * that bind it. The standing value reads as a sentence so an unbound role
 * still says what happens without it.
 */
function Role(props: {
  title: string
  body: string
  standing: string
  note: string
  fields: RoleFields
  values: Partial<Record<ResearchKey, string | undefined>>
  t: WorkbenchProps['t']
}): ReactNode {
  const { t } = props
  const provider = props.values[props.fields.provider]
  const model = props.values[props.fields.model]
  return <details className={styles.role}>
    <summary className={styles.roleHead}>
      <span className={styles.roleTitle}>{props.title}</span>
      <span className={styles.roleBody}>{props.body}</span>
      <span className={styles.roleStanding}>{props.standing}</span>
      <span className={styles.roleNote}>{props.note}</span>
    </summary>
    <div className={styles.roleFields}>
      <Field
        label={t(props.fields.provider)}
        name={props.fields.provider}
        {...(provider === undefined ? {} : { defaultValue: provider })}
      />
      <Field
        label={t(props.fields.model)}
        name={props.fields.model}
        {...(model === undefined ? {} : { defaultValue: model })}
      />
    </div>
  </details>
}

const TEX_ENGINE_NAMES = { pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX' } as const

/** One detected component; LaTeX's longer tool information opens below the component grid. */
function Component(props: WorkbenchProps & { component: ComponentStatus; detailsOpen: boolean; toggleDetails: () => void }): ReactNode {
  const { component, t } = props
  const installing = useAction()
  const latex = component.id === 'latex'
  const version = latex && !component.installed ? '' : component.version
  const hasDetails = latex && Boolean(component.source || component.engines?.length || component.path || component.problem)
  return <div className={styles.componentCell}>
    <div className={styles.component}>
      <span className={component.installed ? styles.componentOn : styles.componentOff} aria-hidden="true"></span>
      <div className={styles.componentInfo}>
        <div className={styles.componentSummary}>
          <span className={styles.componentName}>{latex ? t('componentLatex') : component.id}</span>
          {version && <span className={styles.componentVersion}>{version}</span>}
        </div>
      </div>
      {component.installed
        ? <Tag tone="success">{t('installed')}</Tag>
        : <button
          type="button"
          className={styles.install}
          disabled={installing.pending}
          onClick={() => { installing.start(() => props.install(component.id)) }}
        >{t(installing.pending ? 'installing' : 'notInstalled')}</button>}
      {hasDetails && <button
        type="button"
        className={props.detailsOpen ? `${styles.componentDisclosure} ${styles.componentDisclosureOpen}` : styles.componentDisclosure}
        aria-label={t(props.detailsOpen ? 'componentDetailsHide' : 'componentDetailsShow')}
        aria-controls="research-latex-component-details"
        aria-expanded={props.detailsOpen}
        title={t(props.detailsOpen ? 'componentDetailsHide' : 'componentDetailsShow')}
        onClick={props.toggleDetails}
      />}
    </div>
    <ActionError t={t} error={installing.error} />
  </div>
}

/** The detected TeX source and commands, shown at full width on request. */
function LatexDetails(props: { component: ComponentStatus; t: WorkbenchProps['t'] }): ReactNode {
  const { component, t } = props
  const engines = component.engines?.map(engine => TEX_ENGINE_NAMES[engine]).join(' / ')
  return <div id="research-latex-component-details" className={styles.componentDetails} role="region" aria-label={t('latexDetails')}>
    {component.source !== undefined && <div className={styles.componentDetail}>
      {t('componentSource', { source: t(`componentSource_${component.source}`) })}
    </div>}
    {component.installed && engines && <div className={styles.componentDetail}>
      {t('latexEngines', { engines })}
    </div>}
    {component.path && <div className={styles.componentDetail}>
      <span>{t('componentPath')}</span>
      <code className={styles.componentPath} title={component.path}>{component.path}</code>
    </div>}
    {!component.installed && component.problem !== undefined && <div className={styles.componentDetail}>
      {t(`latexProblem_${component.problem}`)}
    </div>}
  </div>
}

/** A settings save that stores no provider key. */
const NO_KEYS = { image: '', embedding: '' } as const

/** The preferences with the research home set to a folder, or taken out so the default applies. */
function withResearchHome(preferences: ResearchPreferences, researchHome: string | undefined): ResearchPreferences {
  const next = { ...preferences }
  delete next.researchHome
  return researchHome === undefined ? next : { ...next, researchHome }
}

/**
 * 研究存放位置 (Where new researches are kept): the folder in effect, another
 * one through the host's chooser (a typed path where the host has none), and
 * the way back to the default. Existing researches stay where they are.
 */
function ResearchHome(props: WorkbenchProps & { preferences: ResearchPreferences; home: string | undefined }): ReactNode {
  const { t, preferences } = props
  const saving = useAction()
  const [typing, setTyping] = useState(false)
  const save = (researchHome: string | undefined): void => {
    setTyping(false)
    saving.start(() => props.configure(withResearchHome(preferences, researchHome), NO_KEYS))
  }
  const choose = (): void => {
    saving.start(async () => {
      const picked = await props.pickDirectory()
      if (picked.kind === 'picked') await props.configure(withResearchHome(preferences, picked.path), NO_KEYS)
      else if (picked.kind === 'unavailable') setTyping(true)
    })
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    save(text(new FormData(event.currentTarget), 'researchHome'))
  }
  return <section className={styles.group}>
    <h3 className={styles.groupTitle}>{t('researchHomeTitle')}</h3>
    <p className={styles.groupHint}>{t('researchHomeHint')}</p>
    <div className={styles.home}>
      <span className={styles.homePath}>{props.home}</span>
      {preferences.researchHome === undefined && <Tag tone="neutral">{t('researchHomeDefault')}</Tag>}
    </div>
    <div className={styles.homeActions}>
      <button type="button" className={styles.install} disabled={saving.pending} onClick={choose}>{t('researchHomeChange')}</button>
      {preferences.researchHome !== undefined && <button type="button" className={styles.install} disabled={saving.pending}
        onClick={() => { save(undefined) }}>{t('researchHomeReset')}</button>}
    </div>
    {typing && <form className={styles.homeForm} onSubmit={submit}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('folderTypeLabel')}</span>
        <input className={styles.input} name="researchHome" required autoFocus spellCheck={false} defaultValue={props.home} />
      </label>
      <p className={styles.groupHint}>{t('folderTypeHint')}</p>
      <div className={styles.homeActions}>
        <button type="submit" className={styles.save}>{t('save')}</button>
        <button type="button" className={styles.install} onClick={() => { setTyping(false) }}>{t('cancel')}</button>
      </div>
    </form>}
    <ActionError t={t} error={saving.error} />
  </section>
}

/**
 * 显示示例研究 (Show example researches): whether the sidebar lists the
 * examples, saved at once with every other preference kept.
 */
function ShowExamples(props: WorkbenchProps & { preferences: ResearchPreferences; available: boolean | undefined }): ReactNode {
  const { t, preferences } = props
  const saving = useAction()
  const shown = preferences.showExamples !== false
  return <section className={styles.group}>
    <div className={styles.switchRow}>
      <div className={styles.switchText}>
        <h3 className={styles.groupTitle}>{t('showExamplesTitle')}</h3>
        <p className={styles.groupHint}>{t('showExamplesHint')}</p>
      </div>
      <Switch
        checked={shown}
        label={t('showExamplesTitle')}
        disabled={saving.pending}
        onChange={(next) => { saving.start(() => props.configure({ ...preferences, showExamples: next }, NO_KEYS)) }}
      />
    </div>
    {shown && props.available === false && <p className={styles.groupHint}>{t('showExamplesEmpty')}</p>}
    <ActionError t={t} error={saving.error} />
  </section>
}

/** One research removed from the list, with the way back. */
function RemovedResearch(props: WorkbenchProps & { project: ResearchProject }): ReactNode {
  const { t, project } = props
  const restoring = useAction()
  return <div className={styles.componentCell}>
    <div className={styles.removed}>
      <span className={styles.removedText}>
        <span className={styles.environmentName}>{project.untitled === true ? t('treeUntitled') : project.title}</span>
        <span className={styles.environmentDetail}>{project.root}</span>
      </span>
      <button
        type="button"
        className={styles.install}
        disabled={restoring.pending}
        onClick={() => { restoring.start(() => props.run({ action: 'unarchive-project', projectId: project.id })) }}
      >{t(restoring.pending ? 'removedRestoring' : 'removedRestore')}</button>
    </div>
    <ActionError t={t} error={restoring.error} />
  </div>
}

/** 已移出的研究 (Removed researches): each one the person took out of the sidebar, to restore. */
function RemovedResearches(props: WorkbenchProps & { projects: readonly ResearchProject[] }): ReactNode {
  const { t } = props
  const removed = props.projects.filter(project => project.archived === true)
  return <section className={styles.group}>
    <h3 className={styles.groupTitle}>{t('removedTitle')}</h3>
    <p className={styles.groupHint}>{t('removedHint')}</p>
    {removed.length === 0
      ? <p className={styles.groupHint}>{t('removedNone')}</p>
      : <div className={styles.environments}>
        {removed.map(project => <RemovedResearch key={project.id} {...props} project={project} />)}
      </div>}
  </section>
}

/** The research section of the settings panel; nothing here lives on the main surface. */
export function ResearchSettingsSection(props: WorkbenchProps): ReactNode {
  const { t } = props
  const view = props.useResearch(s => s)
  const saving = useAction()
  const [showLatexDetails, setShowLatexDetails] = useState(false)
  const preferences = view.snapshot?.preferences ?? {}
  const latex = view.snapshot?.components.find(component => component.id === 'latex')
  const environments = (view.snapshot?.projects ?? []).flatMap(project =>
    project.environments.map(environment => ({ project: project.title, environment })))
  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const endpoint = text(form, 'imageEndpoint') || (text(form, 'imageKey') ? IMAGE_START.baseUrl : '')
    const embeddingEndpoint = text(form, 'embeddingEndpoint') || (text(form, 'embeddingKey') ? EMBEDDING_START.baseUrl : '')
    // The conversation's model is chosen in the composer, so no main-model binding is written; one stored earlier is dropped here.
    const next: ResearchPreferences = {
      ...(text(form, 'visionModel') ? { vision: { provider: text(form, 'visionProvider'), model: text(form, 'visionModel') } } : {}),
      // A key alone is enough: the endpoint then defaults to OpenAI's. An untouched form enables nothing.
      ...(endpoint
        ? {
          image: {
            baseUrl: endpoint, model: text(form, 'imageModel') || IMAGE_START.model, size: text(form, 'imageSize') || IMAGE_START.size,
            quality: IMAGE_QUALITIES.find(item => item === text(form, 'imageQuality')) ?? IMAGE_START.quality,
            apiStyle: IMAGE_STYLES.find(item => item === text(form, 'imageApiStyle')) ?? IMAGE_START.apiStyle,
          },
        }
        : {}),
      ...(embeddingEndpoint ? { embedding: { baseUrl: embeddingEndpoint, model: text(form, 'embeddingModel') || EMBEDDING_START.model } } : {}),
      ...(text(form, 'pythonPath') ? { python: text(form, 'pythonPath') } : {}),
      ...(text(form, 'uvPath') ? { uv: text(form, 'uvPath') } : {}),
      ...(text(form, 'texPath') ? { texBin: text(form, 'texPath') } : {}),
      // The research home and the examples switch have their own groups; this form keeps them as they are.
      ...(preferences.researchHome === undefined ? {} : { researchHome: preferences.researchHome }),
      ...(preferences.showExamples === undefined ? {} : { showExamples: preferences.showExamples }),
    }
    const keys = { image: text(form, 'imageKey'), embedding: text(form, 'embeddingKey') }
    saving.start(() => props.configure(next, keys))
  }
  const values: Partial<Record<ResearchKey, string | undefined>> = {
    visionProvider: preferences.vision?.provider,
    visionModel: preferences.vision?.model,
    imageEndpoint: preferences.image?.baseUrl,
    imageModel: preferences.image?.model ?? IMAGE_START.model,
    imageSize: preferences.image?.size ?? IMAGE_START.size,
    embeddingEndpoint: preferences.embedding?.baseUrl,
    embeddingModel: preferences.embedding?.model ?? EMBEDDING_START.model,
    pythonPath: preferences.python,
    uvPath: preferences.uv,
    texPath: preferences.texBin,
  }
  return <div className={styles.root}>
    <p className={styles.subtitle}>{t('settingsSubtitle')}</p>

    <ResearchHome {...props} preferences={preferences} home={view.snapshot?.researchHome} />
    <ShowExamples {...props} preferences={preferences}
      available={view.snapshot?.projects.some(project => project.example === true && project.archived !== true)} />
    <RemovedResearches {...props} projects={view.snapshot?.projects ?? []} />

    <form key={JSON.stringify(preferences)} className={styles.group} onSubmit={save}>
      <h3 className={styles.groupTitle}>{t('modelRoles')}</h3>
      <p className={styles.groupHint}>{t('modelHelp')}</p>
      <Role
        t={t}
        title={t('roleVision')}
        body={t('roleVisionBody')}
        standing={preferences.vision === undefined ? t('roleVisionFollow') : `${preferences.vision.provider} · ${preferences.vision.model}`}
        note={t('roleVisionNote')}
        fields={{ provider: 'visionProvider', model: 'visionModel' }}
        values={values}
      />
      <Role
        t={t}
        title={t('roleImage')}
        body={t('roleImageBody')}
        standing={preferences.image === undefined ? t('roleImageOff') : preferences.image.model}
        note={t('roleImageNote')}
        fields={{ provider: 'imageEndpoint', model: 'imageModel' }}
        values={values}
      />
      <Role
        t={t}
        title={t('roleEmbedding')}
        body={t('roleEmbeddingBody')}
        standing={preferences.embedding === undefined ? t('roleEmbeddingOff') : preferences.embedding.model}
        note={t('roleEmbeddingNote')}
        fields={{ provider: 'embeddingEndpoint', model: 'embeddingModel' }}
        values={values}
      />
      <details><summary className={styles.groupHint}>{t('advancedSettings')}</summary>
        <div className={styles.roleFields}>
          <Field label={t('imageSize')} name="imageSize" defaultValue={preferences.image?.size ?? IMAGE_START.size} />
          <Choice
            t={t} label={t('imageQuality')} name="imageQuality" value={preferences.image?.quality ?? IMAGE_START.quality}
            options={IMAGE_QUALITIES} optionKey={quality => `imageQuality_${quality}`}
          />
          <Choice
            t={t} label={t('imageApiStyle')} name="imageApiStyle" value={preferences.image?.apiStyle ?? IMAGE_START.apiStyle}
            options={IMAGE_STYLES} optionKey={style => `imageApiStyle_${style}`}
          />
          <Field label={t('imageKey')} name="imageKey" type="password" />
          <Field label={t('embeddingKey')} name="embeddingKey" type="password" />
        </div>
        <div className={styles.roleFields}>
          <Field label={t('pythonPath')} name="pythonPath" {...(values.pythonPath ? { defaultValue: values.pythonPath } : {})} />
          <Field label={t('uvPath')} name="uvPath" {...(values.uvPath ? { defaultValue: values.uvPath } : {})} />
          <Field label={t('texPath')} name="texPath" {...(values.texPath ? { defaultValue: values.texPath } : {})} />
        </div>
      </details>
      <button type="submit" className={styles.save} disabled={saving.pending}>{t(saving.pending ? 'saving' : 'save')}</button>
      {saving.done && <p className={styles.groupHint} role="status">{t('settingsSaved')}</p>}
      <ActionError t={t} error={saving.error} />
    </form>

    <section className={styles.group}>
      <h3 className={styles.groupTitle}>{t('localComponents')}</h3>
      <p className={styles.groupHint}>{t('localComponentsNote')}</p>
      <div className={styles.components}>
        {view.snapshot?.components.map(component =>
          <Component key={component.id} {...props} component={component}
            detailsOpen={component.id === 'latex' && showLatexDetails}
            toggleDetails={() => { setShowLatexDetails(open => !open) }} />)}
      </div>
      {showLatexDetails && latex && <LatexDetails component={latex} t={t} />}
    </section>

    <section className={styles.group}>
      <div className={styles.sectionHead}><h3 className={styles.groupTitle}>{t('experimentEnvironments')}</h3><EnvironmentForm {...props} /></div>
      <p className={styles.groupHint}>{t('experimentEnvironmentsNote')}</p>
      {environments.length === 0
        ? <p className={styles.groupHint}>{t('noEnvironments')}</p>
        : <div className={styles.environments}>
          {environments.map(entry => <div key={entry.environment.id} className={styles.environment}>
            <span className={styles.environmentName}>{entry.environment.name}</span>
            <span className={styles.environmentDetail}>
              {entry.project} · {t(entry.environment.target)} · {entry.environment.python}
            </span>
            {entry.environment.isDefault && <Tag tone="info">{t('environmentDefault')}</Tag>}
            {/* `ready` is only what creation found, never probed since, so it earns no tag; an unusual state still does. */}
            {entry.environment.status !== 'ready' && <Tag tone="warning">{t(entry.environment.status)}</Tag>}
          </div>)}
        </div>}
    </section>

    <p className={styles.footer}>{t('settingsFooter')}</p>
  </div>
}
