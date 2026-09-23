/** Research workspace presentation. All operations arrive through the plugin face. */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ArtifactRecord, EnvironmentId, EvidenceId, ArtifactId, ResearchProject, ResearchCommand, CheckReport } from '@deepseek-ai/dsh-research-workbench/types'
import { useModes, type WorkbenchProps } from './contract.ts'
import { ResearchSettingsSection } from './ResearchSettings.tsx'
import { ProjectStatus } from './Rail.tsx'
import { ModeSelect } from './ModeSelect.tsx'
import { chosenMode, researchFileUrl } from './format.ts'
import styles from './Workbench.module.css'

type PanelProps = WorkbenchProps & { project: ResearchProject }
const kinds = ['manuscript', 'diagram', 'figure', 'code', 'bibliography', 'supplement', 'image'] as const
/** Quiet period after the last draw.io autosave before the file is written. */
const AUTOSAVE_DELAY_MS = 1500
const lines = (value: string): string[] => value.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
/** A text field of a form this file renders; every name passed here is a field the form always carries. */
const field = (form: FormData, name: string): string => (form.get(name) as string).trim()
const attempt = (promise: Promise<unknown>): void => { void promise.catch(() => {}) }

/** Compact mark used by both native navigation and the research header. */
export function ResearchMark(): ReactNode {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 3h8M10 3v7L4.6 19a1.3 1.3 0 0 0 1.1 2h12.6a1.3 1.3 0 0 0 1.1-2L14 10V3M8 15h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><circle cx="12" cy="17.5" r="1" fill="currentColor"/></svg>
}
/** Independent product name in the native sidebar. */
export function ResearchBrand(props: PropsLocale<'research'>): ReactNode { return <span>{props.t('name')}</span> }

/**
 * A project file shown in place. PDFs render in the browser's own viewer, which
 * cannot run inside a sandboxed frame; everything else is framed with no
 * script permission at all.
 */
function Preview(props: PanelProps & { path: string; onClose: () => void }): ReactNode {
  const pdf = props.path.toLowerCase().endsWith('.pdf')
  return <div className={styles.card}>
    <div className={styles.toolbar}><code>{props.path}</code><button onClick={props.onClose}>{props.t('close')}</button></div>
    <iframe className={styles.preview} title={props.t('preview')} src={researchFileUrl(props.project.id, props.path)} {...(pdf ? {} : { sandbox: '' })} />
  </div>
}

/** The last check, as a list of what is still open. */
function CheckSummary(props: WorkbenchProps & { check: CheckReport }): ReactNode {
  const { check, t } = props
  const errors = check.findings.filter(finding => finding.severity === 'error').length
  return <>
    <strong>{check.clean ? t('checkClean') : t('findings')} · {t('checkErrors', { n: errors })} · {t('checkWarnings', { n: check.findings.length - errors })}</strong>
    {check.findings.map((finding, index) => <p key={index}>{finding.message}{finding.file === undefined ? '' : ` — ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}`}</p>)}
  </>
}

/** The project's own files: sources, manuscript, figures, runs. */
export function Workbench(props: WorkbenchProps): ReactNode {
  const view = props.useResearch(s => s)
  const modes = useModes(props)
  const { t } = props
  const focus = props.useFocus(s => s)
  const [selected, setSelected] = useState(focus.projectId ?? '')
  const [tab, setTab] = useState<'workflow' | 'sources' | 'claims' | 'artifacts' | 'experiments' | 'settings'>(focus.panel ?? 'workflow')
  useEffect(() => { setSelected(focus.projectId ?? ''); setTab(focus.panel ?? 'workflow') }, [focus.projectId, focus.panel])
  const [creating, setCreating] = useState(false)
  const project = view.snapshot?.projects.find(p => p.id === selected) ?? view.snapshot?.projects[0]
  const session = project?.sessionId
  const create = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault(); const f = new FormData(event.currentTarget)
    attempt(props.create({
      title: field(f, 'title'), root: field(f, 'root'), brief: field(f, 'brief'),
      ...chosenMode(f),
      autonomy: field(f, 'autonomy') === 'automatic' ? 'automatic' : 'checkpoints',
    }).then(() => { setCreating(false) }))
  }
  return <main className={styles.root} aria-label={t('name')}>
    <header className={styles.header}><div className={styles.heading}><ResearchMark /><div><h1>{t('name')}</h1><p>{t('subtitle')}</p></div></div><button onClick={() => { setCreating(true) }}>{t('newProject')}</button></header>
    <div className={styles.projectBar}>
      <select aria-label={t('projects')} value={project?.id ?? ''} onChange={(e) => { setSelected(e.target.value) }}>
        {!project && <option value="">{t('projects')}</option>}
        {view.snapshot?.projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
      </select>
      <button onClick={() => { attempt(props.refresh()) }} disabled={view.busy}>{t('refresh')}</button>
      {session && <button onClick={() => { attempt(props.openConversation(session)) }}>{t('openConversation')}</button>}
    </div>
    {creating && <form className={styles.card} onSubmit={create}>
      <Field label={t('title')} name="title" required />
      <Field label={t('directory')} name="root" required placeholder={t('projectRootHint')} />
      <label>{t('mode')}<ModeSelect modes={modes} t={t} name="mode" defaultValue="general" /></label>
      <label>{t('autonomy')}<select name="autonomy" defaultValue="checkpoints"><option value="checkpoints">{t('autonomyCheckpoints')}</option><option value="automatic">{t('autonomyAutomatic')}</option></select></label>
      <label>{t('brief')}<textarea name="brief" rows={3} /></label>
      <div className={styles.toolbar}><button type="submit" disabled={view.busy}>{t('create')}</button><button type="button" onClick={() => { setCreating(false) }}>{t('cancel')}</button></div>
    </form>}
    <nav className={styles.tabs}>{(['workflow', 'sources', 'claims', 'artifacts', 'experiments'] as const).map(item => <button key={item} aria-current={tab === item ? 'page' : undefined} onClick={() => { setTab(item) }}>{t(item)}</button>)}</nav>
    {view.error && <div className={styles.error} role="alert">{view.error}</div>}
    <div className={styles.body}>{project
      ? <div key={project.id}>
        {tab === 'workflow' && <Overview {...props} project={project} />}
        {tab === 'settings' && <ResearchSettingsSection {...props} />}
        {tab === 'claims' && <div>{project.claims.map(claim => <button className={styles.claimRow} key={claim.id} onClick={() => { props.focusClaim(claim.id) }}><span>{claim.text}</span><span className={styles.badge}>{t(claim.state)}</span></button>)}</div>}
        {tab === 'sources' && <Sources {...props} project={project} />}
        {tab === 'artifacts' && <Artifacts {...props} project={project} />}
        {tab === 'experiments' && <Experiments {...props} project={project} />}
      </div>
      : <div className={styles.empty}><ResearchMark /><h2>{t('noProjects')}</h2><button onClick={() => { setCreating(true) }}>{t('newProject')}</button></div>}</div>
    {view.response && <details className={styles.response}>
      <summary>{view.response.message}</summary>
      {view.response.path && <code>{view.response.path}</code>}
      {view.response.content && <pre>{view.response.content}</pre>}
      {view.response.check && <CheckSummary {...props} check={view.response.check} />}
    </details>}
    <footer className={styles.footer}><details><summary>{t('tasks')} · {view.tasks.filter(j => j.status === 'running').length} {t('running')}</summary>{view.tasks.slice(-12).reverse().map(job => <div key={job.id} className={styles.task}><span>{t(job.status)}</span><span>{job.message}</span></div>)}</details></footer>
  </main>
}

function Field(props: {
  label: string
  name: string
  defaultValue?: string | number
  placeholder?: string
  required?: boolean
  type?: string
}): ReactNode {
  return <label>{props.label}<input name={props.name} type={props.type ?? 'text'} defaultValue={props.defaultValue} placeholder={props.placeholder} required={props.required} /></label>
}

/** Where the project stands, how it is run, and the package it exports. */
function Overview(props: PanelProps): ReactNode {
  const { project, t } = props
  return <>
    <section className={styles.card}>
      <h2>{project.title}</h2>
      <p>{project.brief}</p>
      <code className={styles.muted}>{project.root}</code>
      <ProjectStatus {...props} commandSession={project.sessionId} />
    </section>
    <div className={styles.toolbar}><button onClick={() => { attempt(props.run({ action: 'export', projectId: project.id })) }}>{t('exportPaper')}</button></div>
  </>
}

function Sources(props: PanelProps): ReactNode {
  const { project, t } = props
  const view = props.useResearch(s => s)
  const [preview, setPreview] = useState('')
  return <>
    <form className={styles.card} onSubmit={(e) => { e.preventDefault(); attempt(props.run({ action: 'import', projectId: project.id, paths: field(new FormData(e.currentTarget), 'paths').split('\n').map(s => s.trim()).filter(Boolean) })) }}>
      <label>{t('sourcePaths')}<textarea name="paths" required rows={3} /></label>
      <button disabled={view.busy}>{t('importSources')}</button>
    </form>
    <form className={styles.card} onSubmit={(e) => {
      e.preventDefault(); const f = new FormData(e.currentTarget), provider = field(f, 'provider')
      attempt(props.run(provider === 'local'
        ? { action: 'search-evidence', projectId: project.id, query: field(f, 'query') }
        : { action: 'literature-search', projectId: project.id, provider: provider as 'crossref' | 'openalex' | 'arxiv', query: field(f, 'query') }))
    }}>
      <Field label={t('query')} name="query" required />
      <div className={styles.toolbar}><select name="provider" aria-label={t('source')}><option value="local">{t('searchLocal')}</option>{(['crossref', 'openalex', 'arxiv'] as const).map(p => <option key={p}>{p}</option>)}</select><button>{t('search')}</button></div>
    </form>
    {view.response?.literature?.map(item => <article className={styles.card} key={item.id}>
      <h3>{item.title}</h3><p>{item.authors.join(', ')} · {item.year}</p><p>{item.abstract}</p>
      <code className={styles.muted}>{item.doi ?? item.url}</code>
      <button onClick={() => { attempt(props.run({ action: 'literature-import', projectId: project.id, item })) }}>{t('importReference')}</button>
    </article>)}
    {preview !== '' && <Preview {...props} path={preview} onClose={() => { setPreview('') }} />}
    {!project.evidence.length && <p className={styles.empty}>{t('emptySources')}</p>}
    {project.evidence.map(source => <article className={styles.card} key={source.id}>
      <div className={styles.toolbar}><h3>{source.title}</h3><span className={styles.badge}>{source.coverage}</span><span>{t('revision')} {source.revision}</span></div>
      <button onClick={() => { setPreview(source.path) }}>{t('claimOpenSource')}</button>
      {source.fullTextPath !== undefined && <button onClick={setPreview.bind(null, source.fullTextPath)}>{t('fullText')}</button>}
      <p className={styles.muted}>{source.path}</p>
      {source.stale && <p className={styles.error}>{t('stale')}</p>}
      {source.originalPath && <button onClick={() => { attempt(props.run({ action: 'refresh-evidence', projectId: project.id, evidenceId: source.id })) }}>{t('refreshSource')}</button>}
    </article>)}
  </>
}

function Artifacts(props: PanelProps): ReactNode {
  const { project, t } = props
  const [selected, setSelected] = useState('')
  const [draft, setDraft] = useState('')
  const [path, setPath] = useState('paper/main.tex')
  const [kind, setKind] = useState<ArtifactRecord['kind']>('manuscript')
  const [revision, setRevision] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [preview, setPreview] = useState('')
  const [diagram, setDiagram] = useState(false)
  const artifact = project.artifacts.find(a => a.id === selected)
  const requested = props.useFocus(s => s).artifactId
  const show = (record: ArtifactRecord, content: string): void => {
    setSelected(record.id); setPath(record.path); setKind(record.kind); setRevision(record.revision); setDraft(content); setDirty(false); setPreview(''); setDiagram(record.kind === 'diagram')
  }
  useEffect(() => {
    const record = project.artifacts.find(item => item.id === requested)
    if (!record) return
    let active = true
    attempt(props.run({ action: 'read-artifact', projectId: project.id, artifactId: record.id }).then((response) => { if (active) show(record, response.content ?? '') }))
    return () => { active = false }
  }, [project.id, requested])
  const open = async (record: ArtifactRecord): Promise<void> => {
    const response = await props.run({ action: 'read-artifact', projectId: project.id, artifactId: record.id })
    show(record, response.content ?? '')
  }
  const save = async (content: string): Promise<void> => {
    const response = await props.run({ action: 'save-artifact', projectId: project.id, path, kind, content, expectedRevision: revision, evidence: artifact?.evidence ?? [], claimIds: artifact?.claimIds ?? [], inputArtifacts: artifact?.inputArtifacts ?? [] })
    const next = response.project?.artifacts.find(a => a.path === path)
    if (next) { setSelected(next.id); setRevision(next.revision) }
    setDraft(content); setDirty(false)
  }
  /** Take in an edit made outside this editor as a new revision, then show it. */
  const adopt = async (record: ArtifactRecord): Promise<void> => {
    await props.run({ action: 'register-artifact', projectId: project.id, path: record.path, kind: record.kind, evidence: record.evidence, claimIds: record.claimIds, inputArtifacts: record.inputArtifacts })
    await open(record)
  }
  return <>
    <div className={styles.toolbar}>
      <select aria-label={t('chooseFile')} value={selected} onChange={(e) => { const a = project.artifacts.find(v => v.id === e.target.value); if (a) attempt(open(a)) }} disabled={dirty}>
        <option value="">{t('chooseFile')}</option>
        {project.artifacts.map(a => <option key={a.id} value={a.id}>{a.stale ? '↻ ' : ''}{a.path}</option>)}
      </select>
      <button disabled={dirty} onClick={() => { setSelected(''); setDraft(''); setRevision(0); setPath('paper/main.tex'); setKind('manuscript'); setPreview(''); setDiagram(false) }}>{t('newArtifact')}</button>
      {dirty && <span className={styles.badge}>{t('unsaved')}</span>}
    </div>
    <div className={styles.grid}>
      <label>{t('path')}<input value={path} onChange={(e) => { setPath(e.target.value) }} disabled={!!artifact} /></label>
      <label>{t('artifactKind')}<select value={kind} onChange={(e) => { setKind(e.target.value as ArtifactRecord['kind']) }} disabled={!!artifact}>{kinds.map(k => <option key={k} value={k}>{t(k)}</option>)}</select></label>
    </div>
    {artifact && <p className={styles.muted}>{artifact.path} · {t('revision')} {revision} · {t(artifact.stale ? 'stale' : 'current')}</p>}
    <div className={styles.toolbar}>
      <button onClick={() => { attempt(save(draft)) }}>{t('save')}</button>
      {artifact && <>
        <button onClick={() => { attempt(adopt(artifact)) }}>{t('registerChanges')}</button>
        <button onClick={() => { const compiled = [...project.compilations].reverse().find(c => c.artifactId === artifact.id && c.status === 'completed'); setPreview(compiled?.pdfPath ?? artifact.path) }}>{t('preview')}</button>
        <button onClick={() => { attempt(props.run({ action: 'visual-review', projectId: project.id, artifactId: artifact.id })) }}>{t('visualReview')}</button>
      </>}
      {kind === 'diagram' && <button onClick={() => { setDiagram(!diagram) }}>{t(diagram ? 'editSource' : 'diagram')}</button>}
      {artifact?.kind === 'manuscript' && <form className={styles.toolbar} onSubmit={(e) => { e.preventDefault(); attempt(props.run({ action: 'compile', projectId: project.id, artifactId: artifact.id, engine: field(new FormData(e.currentTarget), 'engine') as 'xelatex' })) }}>
        <select name="engine" aria-label={t('compile')}>{['xelatex', 'pdflatex', 'lualatex'].map(engine => <option key={engine}>{engine}</option>)}</select>
        <button disabled={dirty}>{t('compile')}</button>
      </form>}
    </div>
    {diagram ? <Diagram {...props} xml={draft} onSave={save} /> : <textarea className={styles.editor} aria-label={t('content')} spellCheck={false} value={draft} onChange={(e) => { setDraft(e.target.value); setDirty(true) }} />}
    {preview && <Preview {...props} path={preview} onClose={() => { setPreview('') }} />}
    {project.compilations.filter(c => c.artifactId === selected).slice(-1).map(c => <pre key={c.createdAt}>{c.diagnostics.join('\n')}</pre>)}
    {project.visualReviews.filter(r => r.artifactId === selected).slice(-1).map((r) => { const reviewer = r.sessionId; return <div className={styles.card} key={r.createdAt}><p>{r.findings}</p>{reviewer && <button onClick={() => { attempt(props.openConversation(reviewer)) }}>{t('openConversation')}</button>}</div> })}
    <details className={styles.card}><summary>{t('illustration')}</summary><p>{t('illustrationHelp')}</p><form onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); attempt(props.run({ action: 'generate-image', projectId: project.id, prompt: field(f, 'prompt'), path: field(f, 'path') })) }}><Field label={t('imagePrompt')} name="prompt" required /><Field label={t('imagePath')} name="path" defaultValue="figures/illustration.png" required /><button>{t('generate')}</button></form></details>
  </>
}

/** One diagram's pending writes: at most one in flight, the latest waiting, and the debounce timer. */
interface SaveQueue { inFlight: boolean; queued?: string | undefined; timer?: ReturnType<typeof setTimeout> | undefined }

/**
 * The offline draw.io editor. An explicit save writes at once; autosaves are
 * debounced and written one at a time, the latest one winning, so a burst of
 * edits never races itself into revision conflicts.
 */
function Diagram(props: PanelProps & { xml: string; onSave: (xml: string) => Promise<void> }): ReactNode {
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const saving = useRef<SaveQueue>({ inFlight: false })
  const onSave = useRef(props.onSave)
  onSave.current = props.onSave
  const flush = (xml: string): void => {
    const state = saving.current
    if (state.inFlight) { state.queued = xml; return }
    state.inFlight = true
    void onSave.current(xml).catch(() => {}).finally(() => {
      state.inFlight = false
      const next = state.queued
      state.queued = undefined
      if (next !== undefined) flush(next)
    })
  }
  useEffect(() => {
    const listener = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) return
      let message: unknown
      try { message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data } catch { return }
      if (!message || typeof message !== 'object' || !('event' in message)) return
      if (message.event === 'init') { frame.current.contentWindow?.postMessage(JSON.stringify({ action: 'load', xml: props.xml || '<mxfile><diagram name="Architecture"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>', autosave: 1 }), '*'); setReady(true) }
      if (!('xml' in message) || typeof message.xml !== 'string') return
      const xml = message.xml
      const state = saving.current
      clearTimeout(state.timer)
      if (message.event === 'save') flush(xml)
      else if (message.event === 'autosave') state.timer = setTimeout(() => { flush(xml) }, AUTOSAVE_DELAY_MS)
    }
    window.addEventListener('message', listener)
    return () => { window.removeEventListener('message', listener); clearTimeout(saving.current.timer) }
  }, [props.xml])
  return <div><p>{props.t('diagramHelp')}</p>{!ready && <button onClick={() => { attempt(props.install('drawio')) }}>{props.t('install')}</button>}<iframe ref={frame} className={styles.diagram} title={props.t('diagram')} src="/api/research/drawio/index.html?embed=1&proto=json&offline=1&local=1&noSaveBtn=0&saveAndExit=0&noExitBtn=1&libraries=1" sandbox="allow-scripts allow-same-origin allow-downloads" /></div>
}

function Experiments(props: PanelProps): ReactNode {
  const { project, t } = props
  const view = props.useResearch(s => s)
  const [requestId, setRequestId] = useState(() => randomUUID())
  return <>{project.experiments.length === 0 && <p>{t('noExperiments')}</p>}<form className={styles.card} onSubmit={(e) => {
    e.preventDefault(); const f = new FormData(e.currentTarget)
    let argv: unknown; try { argv = JSON.parse(field(f, 'argv')) } catch { e.currentTarget.reportValidity(); return }
    if (!Array.isArray(argv) || !argv.every((item): item is string => typeof item === 'string')) return
    const command: ResearchCommand = { action: 'experiment', projectId: project.id, requestId, spec: { name: field(f, 'name'), environmentId: field(f, 'environment') as EnvironmentId, argv, cwd: field(f, 'cwd'), seed: Number(f.get('seed')), maxSeconds: Number(f.get('seconds')), gpuIds: lines(field(f, 'gpus')), codeArtifactIds: f.getAll('code').map(String) as ArtifactId[], dataEvidenceIds: f.getAll('data').map(String) as EvidenceId[], metricsPath: field(f, 'metrics') } }
    attempt(props.run(command).then(() => { setRequestId(randomUUID()) }))
  }}><div className={styles.grid}><Field label={t('experimentName')} name="name" required /><label>{t('environment')}<select name="environment" required defaultValue={project.environments.find(e => e.isDefault)?.id}><option value="">{t('selectEnvironment')}</option>{project.environments.map(env => <option key={env.id} value={env.id}>{env.name} · {env.target}</option>)}</select></label></div><Field label={t('argv')} name="argv" required defaultValue={'["{python}", "code/train.py"]'} /><div className={styles.grid}><Field label={t('cwd')} name="cwd" defaultValue="." /><Field label={t('seed')} name="seed" type="number" defaultValue={42} /><Field label={t('maxSeconds')} name="seconds" type="number" defaultValue={3600} /><Field label={t('gpuIds')} name="gpus" /></div><div className={styles.grid}><label>{t('selectCodeFiles')}<select name="code" multiple size={4}>{project.artifacts.filter(a => a.kind === 'code' && !a.stale).map(a => <option key={a.id} value={a.id}>{a.path} · {t('revisionN', { n: a.revision })}</option>)}</select></label><label>{t('selectDataSources')}<select name="data" multiple size={4}>{project.evidence.filter(e => !e.stale).map(e => <option key={e.id} value={e.id}>{e.title} · {t('revisionN', { n: e.revision })}</option>)}</select></label></div><Field label={t('metricsPath')} name="metrics" defaultValue="metrics.json" required /><button disabled={view.busy}>{t('submitExperiment')}</button></form>{project.experiments.map(run => <article className={styles.card} key={run.id}><div className={styles.toolbar}><h3>{run.spec.name}</h3><span className={styles.badge}>{t(run.status)}</span></div><span>{t('seed')} {run.spec.seed}</span><p>{run.message}</p><pre>{JSON.stringify(run.metrics, null, 2)}</pre><div className={styles.toolbar}>{(['experiment-refresh', 'experiment-cancel', 'experiment-logs'] as const).map(action => <button key={action} onClick={() => { attempt(props.run({ action, projectId: project.id, runId: run.id })) }}>{t(action === 'experiment-refresh' ? 'inspect' : action === 'experiment-cancel' ? 'stop' : 'logs')}</button>)}</div></article>)}</>
}
