/**
 * Everything configurable about research, in the one place configuration
 * belongs. The workbench surfaces carry no settings at all; when a change is
 * needed mid-research the conversation sends the person here and back.
 */
import { type FormEvent, type ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentStatus, ResearchPreferences } from '@deepseek-ai/dsh-research-workbench/types'
import type { ResearchKey } from './locales.ts'
import type { WorkbenchProps } from './contract.ts'
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
      {props.note !== '' && <span className={styles.roleNote}>{props.note}</span>}
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

/** One managed component, with the action only an absent one offers. */
function Component(props: WorkbenchProps & { component: ComponentStatus; busy: boolean }): ReactNode {
  const { component, t } = props
  return <div className={styles.component}>
    <span className={component.installed ? styles.componentOn : styles.componentOff}></span>
    <span className={styles.componentName}>{component.id}</span>
    <span className={styles.componentVersion}>{component.version}</span>
    {component.installed
      ? <Tag tone="success">{t('installed')}</Tag>
      : <button
        type="button"
        className={styles.install}
        disabled={props.busy}
        onClick={() => { void props.install(component.id).catch(() => {}) }}
      >{t('notInstalled')}</button>}
  </div>
}

/** The research section of the settings panel; nothing here lives on the main surface. */
export function ResearchSettingsSection(props: WorkbenchProps): ReactNode {
  const { t } = props
  const view = props.useResearch(s => s)
  const preferences = view.snapshot?.preferences ?? {}
  const environments = (view.snapshot?.projects ?? []).flatMap(project =>
    project.environments.map(environment => ({ project: project.title, environment })))
  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const endpoint = text(form, 'imageEndpoint') || (text(form, 'imageKey') ? IMAGE_START.baseUrl : '')
    const embeddingEndpoint = text(form, 'embeddingEndpoint') || (text(form, 'embeddingKey') ? EMBEDDING_START.baseUrl : '')
    const next: ResearchPreferences = {
      ...(text(form, 'mainModel') ? { main: { provider: text(form, 'mainProvider'), model: text(form, 'mainModel') } } : {}),
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
    }
    void props.configure(next, { image: text(form, 'imageKey'), embedding: text(form, 'embeddingKey') }).catch(() => {})
  }
  const values: Partial<Record<ResearchKey, string | undefined>> = {
    mainProvider: preferences.main?.provider,
    mainModel: preferences.main?.model,
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
    {view.error && <p className={styles.error} role="alert">{view.error}</p>}

    <form key={JSON.stringify(preferences)} className={styles.group} onSubmit={save}>
      <h3 className={styles.groupTitle}>{t('modelRoles')}</h3>
      <p className={styles.groupHint}>{t('modelHelp')}</p>
      <Role
        t={t}
        title={t('roleMain')}
        body={t('roleMainBody')}
        standing={preferences.main === undefined ? t('roleUnset') : `${preferences.main.provider} · ${preferences.main.model}`}
        note=""
        fields={{ provider: 'mainProvider', model: 'mainModel' }}
        values={values}
      />
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
      <button type="submit" className={styles.save} disabled={view.busy}>{t('save')}</button>
    </form>

    <section className={styles.group}>
      <h3 className={styles.groupTitle}>{t('localComponents')}</h3>
      <p className={styles.groupHint}>{t('localComponentsNote')}</p>
      <div className={styles.components}>
        {view.snapshot?.components.map(component =>
          <Component key={component.id} {...props} component={component} busy={view.busy} />)}
      </div>
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
            <Tag tone={entry.environment.status === 'ready' ? 'success' : 'warning'}>{t(entry.environment.status)}</Tag>
          </div>)}
        </div>}
    </section>

    <p className={styles.footer}>{t('settingsFooter')}</p>
  </div>
}
