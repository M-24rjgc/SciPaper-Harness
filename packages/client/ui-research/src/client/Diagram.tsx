/**
 * The draw.io editor for a `.drawio` file opened in the right sidebar, from the
 * research files or a link. The diagram is the research's artifact: it loads
 * through `read-artifact`, a file the record does not know yet is registered
 * first, and every save goes through `save-artifact` with the revision the
 * editor loaded, so a change made elsewhere since is refused rather than
 * overwritten. An example's diagram opens without saving.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { ArtifactRecord, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import { pathInProject, useSessionProject } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import { ExampleBanner, NoResearch, type ResearchTabProps } from './Tabs.tsx'
import tabs from './Tabs.module.css'
import styles from './Diagram.module.css'

/** Quiet period after the last draw.io autosave before the file is written. */
const AUTOSAVE_DELAY_MS = 1500
/** What an empty or new diagram starts from. */
const BLANK_DIAGRAM = '<mxfile><diagram name="Architecture"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'
/** The offline editor the host serves once the draw.io component is installed. */
const EDITOR_URL = '/api/research/drawio/index.html?embed=1&proto=json&offline=1&local=1&saveAndExit=0&noExitBtn=1&libraries=1'

/** Whether a path is absolute on POSIX, on a Windows drive, or as a UNC share. */
function isAbsolute(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * The file a draw.io tab shows, as an absolute path: an absolute address as
 * itself, a session address against that conversation's working directory.
 * @returns the path, or undefined when the address names no file or its conversation's folder is unknown.
 */
function fileOf(address: string, directories: Readonly<Record<string, string>>): string | undefined {
  const file = parseFileAddress(address)
  if (file === undefined) return undefined
  if (file.scope === 'absolute' || isAbsolute(file.path)) return file.path
  const cwd = directories[file.sessionId]
  return cwd === undefined ? undefined : `${cwd.replace(/[\\/]+$/, '')}/${file.path}`
}

/**
 * The name a draw.io tab's chip shows: the file's decoded name.
 * @param address - a `dsh-resource://file/…` address.
 * @returns the last path segment, or the address itself when it names no file.
 */
export function diagramTitle(address: string): string {
  const path = parseFileAddress(address)?.path
  return path === undefined ? address : path.slice(path.lastIndexOf('/') + 1)
}

/** One diagram's pending writes: at most one in flight, the latest waiting, and the debounce timer with its text. */
interface SaveQueue {
  inFlight: boolean
  queued?: string | undefined
  timer?: ReturnType<typeof setTimeout> | undefined
  pending?: string | undefined
}

/** The diagram as loaded: its text and the revision a save must still find. */
interface Loaded {
  xml: string
  artifact: ArtifactRecord
  revision: number
}

/** The tab body: the conversation's research, the file inside it, and the editor once the diagram is loaded. */
export function ResearchDiagramTab(props: ResearchTabProps): ReactNode {
  const { t } = props
  const project = useSessionProject(props)
  const directories = props.useDirectories(s => s)
  const { tab } = props.useTabInfo()
  if (!project) return <NoResearch t={t} />
  const file = fileOf(tab.contentId, directories)
  const path = file === undefined ? undefined : pathInProject(project.root, file)
  if (path === undefined) return <div className={tabs.root}><p className={tabs.empty}>{t('diagramOutside')}</p></div>
  return <DiagramFile key={`${project.id}\n${path}`} {...props} project={project} path={path} />
}

/** Load one project diagram, registering it when the record does not know it yet, then edit it. */
function DiagramFile(props: ResearchTabProps & { project: ResearchProject; path: string }): ReactNode {
  const { project, path, t } = props
  const example = project.example === true
  const known = project.artifacts.find(artifact => artifact.path === path)
  const loading = useAction()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  useEffect(() => {
    let active = true
    loading.start(async () => {
      let artifact = known
      if (artifact === undefined) {
        if (example) throw new Error(t('diagramNotRecorded'))
        const registered = await props.run({ action: 'register-artifact', projectId: project.id, path, kind: 'diagram', evidence: [], claimIds: [], inputArtifacts: [] })
        artifact = registered.project?.artifacts.find(item => item.path === path)
        if (artifact === undefined) throw new Error(t('diagramNotRecorded'))
      }
      const read = await props.run({ action: 'read-artifact', projectId: project.id, artifactId: artifact.id })
      if (active) setLoaded({ xml: read.content ?? '', artifact, revision: artifact.revision })
    })
    return () => { active = false }
  }, [])
  const save = async (xml: string): Promise<void> => {
    const current = loaded as Loaded
    const { artifact } = current
    const response = await props.run({
      action: 'save-artifact', projectId: project.id, path, kind: artifact.kind, content: xml, expectedRevision: current.revision,
      evidence: artifact.evidence, claimIds: artifact.claimIds, inputArtifacts: artifact.inputArtifacts,
    })
    const next = response.project?.artifacts.find(item => item.path === path)
    if (next) current.revision = next.revision
  }
  return <div className={tabs.root}>
    {example && <ExampleBanner t={t} />}
    <p className={styles.path}>{path}</p>
    <ActionError t={t} error={loading.error} />
    {loaded && <Editor {...props} xml={loaded.xml} {...example ? {} : { onSave: save }} />}
  </div>
}

/**
 * The offline draw.io editor. Before the component is installed it offers the
 * install, and the frame loads afresh once the install lands. An explicit save
 * writes at once; autosaves are debounced and written one at a time, the latest
 * one winning, and one still waiting when the tab closes is written then. A
 * refused write shows under the editor; the next edit tries again. Without
 * `onSave` the editor only shows the diagram.
 */
function Editor(props: ResearchTabProps & { xml: string; onSave?: ((xml: string) => Promise<void>) | undefined }): ReactNode {
  const { t } = props
  const installed = props.useResearch(s => s.snapshot?.components.find(component => component.id === 'drawio')?.installed === true)
  const frame = useRef<HTMLIFrameElement>(null)
  const [installs, setInstalls] = useState(0)
  const writing = useAction()
  const installing = useAction()
  const saving = useRef<SaveQueue>({ inFlight: false })
  const onSave = useRef(props.onSave)
  onSave.current = props.onSave
  const flush = (xml: string): void => {
    const state = saving.current
    const write = onSave.current
    if (write === undefined) return
    if (state.inFlight) { state.queued = xml; return }
    state.inFlight = true
    writing.start(() => write(xml).finally(() => {
      state.inFlight = false
      const next = state.queued
      state.queued = undefined
      if (next !== undefined) flush(next)
    }))
  }
  useEffect(() => {
    const listener = (event: MessageEvent): void => {
      const view = frame.current?.contentWindow
      if (view === null || view === undefined || event.source !== view) return
      let message: unknown
      try { message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data } catch { return }
      if (!message || typeof message !== 'object' || !('event' in message)) return
      if (message.event === 'init') view.postMessage(JSON.stringify({ action: 'load', xml: props.xml || BLANK_DIAGRAM, autosave: onSave.current === undefined ? 0 : 1 }), '*')
      if (!('xml' in message) || typeof message.xml !== 'string') return
      const xml = message.xml
      const state = saving.current
      clearTimeout(state.timer)
      state.pending = undefined
      if (message.event === 'save') flush(xml)
      else if (message.event === 'autosave') {
        state.pending = xml
        state.timer = setTimeout(() => { state.pending = undefined; flush(xml) }, AUTOSAVE_DELAY_MS)
      }
    }
    window.addEventListener('message', listener)
    return () => {
      window.removeEventListener('message', listener)
      const state = saving.current
      clearTimeout(state.timer)
      // An autosave still waiting when the tab goes is written now rather than lost.
      if (state.pending !== undefined) flush(state.pending)
      state.pending = undefined
    }
  }, [props.xml])
  const install = (): void => {
    installing.start(async () => {
      await props.install('drawio')
      setInstalls(count => count + 1)
    })
  }
  return <div className={styles.editor}>
    {!installed && <div className={styles.install}>
      <p className={tabs.empty}>{t('diagramInstallHint')}</p>
      <button type="button" disabled={installing.pending} onClick={install}>{installing.pending ? t('installing') : t('install')}</button>
    </div>}
    <ActionError t={t} error={installing.error} />
    <ActionError t={t} error={writing.error} />
    {installed && <iframe
      key={installs}
      ref={frame}
      className={styles.frame}
      title={t('diagram')}
      src={`${EDITOR_URL}&noSaveBtn=${props.onSave === undefined ? 1 : 0}`}
      sandbox="allow-scripts allow-same-origin allow-downloads"
    />}
  </div>
}
