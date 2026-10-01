/** Knowledge graph exploration and configuration over the shared research service. */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  KnowledgeGraphNode, KnowledgeGraphPage, KnowledgeGraphQuery, ProjectId, ResearchPreferences, ResearchProject, ResearchSnapshot,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { WorkbenchProps } from './contract.ts'
import { sessionProject, useSessionProject } from './contract.ts'
import type { ResearchTabProps } from './Tabs.tsx'
import { ActionError, useAction } from './Action.tsx'
import { EvidenceView } from './EvidenceGraph.tsx'
import { MemoryView } from './MemoryView.tsx'
import { RelationsView } from './RelationsView.tsx'
import { MapView } from './KnowledgeMap.tsx'
import { safeLink } from './mapValues.ts'
import { appendedDraft } from './format.ts'
import type { ResearchKey } from './locales.ts'
import styles from './Knowledge.module.css'
import shell from './KnowledgeViews.module.css'

type GraphProps = WorkbenchProps & { project: ResearchProject; initial?: KnowledgeGraphQuery | undefined }

/** The views of the Knowledge tab; each one belongs to a plugin of the knowledge bundle. */
export type KnowledgeViewId = 'map' | 'relations' | 'evidence' | 'memory' | 'catalog'

/** The tab names of the views. */
const VIEW_LABELS: Record<KnowledgeViewId, ResearchKey> = {
  map: 'kgViewMap', relations: 'kgViewRelations', evidence: 'kgViewEvidence', memory: 'kgViewMemory', catalog: 'kgViewCatalog',
}

/** At least one view, in the order the segmented control lists them. */
export type KnowledgeViewList = readonly [KnowledgeViewId, ...KnowledgeViewId[]]

/**
 * The views the knowledge plugins of this profile offer, in the order the control lists them: a plugin that is off
 * contributes none. The catalog belongs to the graph engine, the map to the domain map, the evidence view to the evidence graph,
 * the memory view to the research memory, the relations view to the relation graph.
 * @param knowledge - what the snapshot says about the knowledge plugins.
 * @returns the views to offer, or undefined when no knowledge plugin is on.
 */
export function knowledgeViews(knowledge: ResearchSnapshot['knowledge']): KnowledgeViewList | undefined {
  const [first, ...rest] = knowledge === undefined ? [] : [
    ...knowledge.modules.map ? ['map' as const] : [],
    ...knowledge.modules.relations ? ['relations' as const] : [],
    ...knowledge.modules.evidence ? ['evidence' as const] : [],
    ...knowledge.modules.memory ? ['memory' as const] : [],
    ...knowledge.enabled ? ['catalog' as const] : [],
  ]
  return first === undefined ? undefined : [first, ...rest]
}

/** Three semantic columns keep every displayed relation inspectable without an unstable force simulation. */
export function graphPositions(nodes: readonly KnowledgeGraphNode[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  const kinds = ['domain', 'pattern', 'paper'] as const
  const height = Math.max(380, ...kinds.map(kind => nodes.filter(node => node.kind === kind).length * 44 + 36))
  for (const [column, kind] of kinds.entries()) {
    const group = nodes.filter(node => node.kind === kind)
    group.forEach((node, row) => positions.set(node.id, {
      x: 84 + column * 285, y: 32 + (row + 0.5) * (height - 64) / Math.max(group.length, 1),
    }))
  }
  return positions
}

function GraphCanvas(props: {
  page: KnowledgeGraphPage
  selected: string | undefined
  choose: (node: KnowledgeGraphNode) => void
  t: WorkbenchProps['t']
}): ReactNode {
  const positions = graphPositions(props.page.nodes)
  const height = Math.max(380, ...[...positions.values()].map(position => position.y + 36))
  return <div className={styles.canvas}>
    <svg viewBox={`0 0 830 ${height}`} role="group" aria-label={props.t('kgGraph')}>
      {props.page.edges.map((edge) => {
        const from = positions.get(edge.from), to = positions.get(edge.to)
        return from && to ? <path key={`${edge.kind}:${edge.from}:${edge.to}`} className={styles.edge}
          data-relation={edge.kind} d={`M${from.x},${from.y} C${(from.x + to.x) / 2},${from.y} ${(from.x + to.x) / 2},${to.y} ${to.x},${to.y}`} /> : null
      })}
      {props.page.nodes.map((node) => {
        const point = positions.get(node.id)
        if (!point) return null
        const label = node.label.length > 29 ? `${node.label.slice(0, 28)}…` : node.label
        return <g key={node.id} className={`${styles.node} ${styles[node.kind]}`} transform={`translate(${point.x},${point.y})`}
          role="button" tabIndex={0} aria-label={node.label} aria-pressed={props.selected === node.id}
          onClick={() => { props.choose(node) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.choose(node) } }}>
          <title>{node.label}</title><circle r={node.kind === 'pattern' ? 9 : 6} />
          <rect x={13} y={-15} width={155} height={30} rx={5} />
          <text x={20} y={4}>{label}</text>
        </g>
      })}
    </svg>
  </div>
}

/** Query and inspect one project's built-in and custom graphs. */
function Explorer(props: GraphProps): ReactNode {
  const { project, t } = props
  const [query, setQuery] = useState(props.initial?.query ?? '')
  const [filters, setFilters] = useState<KnowledgeGraphQuery>({ source: 'all' })
  const [page, setPage] = useState<KnowledgeGraphPage | null>(null)
  const [selected, setSelected] = useState<KnowledgeGraphNode | undefined>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const latest = useRef(0)
  const load = (request: KnowledgeGraphQuery): void => {
    const ticket = ++latest.current
    setPending(true); setError('')
    props.run({ action: 'graph-view', projectId: project.id, ...request }).then((result) => {
      if (ticket !== latest.current) return
      if (!result.knowledgeGraph) throw new Error(t('kgNoResponse'))
      setPage(result.knowledgeGraph); setFilters(request); setSelected(undefined); setPending(false)
    }).catch((reason: unknown) => {
      if (ticket === latest.current) { setError(reason instanceof Error ? reason.message : String(reason)); setPending(false) }
    })
  }
  useEffect(() => { load({ source: 'all', ...props.initial }); return () => { latest.current++ } }, [project.id])
  const submit = (event: FormEvent): void => { event.preventDefault(); load({ ...filters, query, pattern: undefined, offset: 0 }) }
  const link = safeLink(selected?.url)
  /* v8 ignore next -- every load sets a source, so the default only types the optional field */
  const source = filters.source ?? 'all'
  const patterns = page?.nodes.filter(node => node.kind === 'pattern') ?? []
  return <section className={styles.explorer} data-knowledge-explorer aria-busy={pending}>
    <form className={styles.filters} onSubmit={submit} role="search">
      <input type="search" aria-label={t('kgSearch')} placeholder={t('kgSearch')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
      <button type="submit" disabled={pending}>{t(pending ? 'kgLoading' : 'kgSearchButton')}</button>
      <label><span>{t('kgSource')}</span><select value={source} onChange={(event) => {
        load({ source: event.target.value as 'all' | 'ai' | 'project', query })
      }}>
        <option value="all">{t('kgAll')}</option><option value="ai">{t('kgBuiltin')}</option><option value="project">{t('kgProject')}</option>
      </select></label>
      <label><span>{t('kgDomain')}</span><select value={filters.domain ?? ''} onChange={(event) => {
        load({ ...filters, domain: event.target.value || undefined, pattern: undefined, offset: 0 })
      }}><option value="">{t('kgAll')}</option>{page?.domains.map(domain => <option key={domain} value={domain}>{domain}</option>)}</select></label>
    </form>
    <ActionError t={t} error={error} />
    {page && <>
      <div className={styles.summary}>
        {page.graphs.map(graph => <span key={graph.source}>{t(graph.source === 'ai' ? 'kgBuiltin' : 'kgProject')} · {t('kgCounts', { patterns: String(graph.patterns), papers: String(graph.papers) })}</span>)}
      </div>
      {page.warnings.length > 0 && <details className={styles.warning}><summary>{t('kgSourceWarning')}</summary>{page.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>}
      {page.nodes.length === 0 ? <p className={styles.empty}>{t('kgEmpty')}</p> : <>
        <div className={styles.legend}><span>{t('kgDomain')}</span><span>{t('kgPattern')}</span><span>{t('kgPaper')}</span></div>
        <GraphCanvas page={page} selected={selected?.id} choose={setSelected} t={t} />
        <div className={styles.patterns}>{patterns.map(node => <button type="button" key={node.id}
          aria-pressed={selected?.id === node.id} onClick={() => { setSelected(node) }}>{node.label}</button>)}</div>
        {selected && <article className={styles.detail} data-knowledge-detail>
          <div className={styles.detailHead}><span>{t(selected.kind === 'pattern' ? 'kgPattern' : selected.kind === 'paper' ? 'kgPaper' : 'kgDomain')}</span>
            <span>{t(selected.source === 'ai' ? 'kgBuiltin' : 'kgProject')}</span></div>
          <h4>{selected.label}</h4><p>{selected.summary}</p>
          {selected.problem && <p><strong>{t('kgProblem')}</strong> {selected.problem}</p>}
          {selected.solution && <p><strong>{t('kgSolution')}</strong> {selected.solution}</p>}
          {link && <a href={link} target="_blank" rel="noopener noreferrer">{t('kgOriginal')}</a>}
          {selected.kind === 'pattern' && <button type="button" onClick={() => { load({ source: selected.source, pattern: selected.id }) }}>{t('kgRelated')}</button>}
          {selected.kind === 'pattern' && <ul className={styles.paperList}>{page.edges.filter(edge => edge.to === selected.id && edge.kind === 'uses-pattern').map((edge) => {
            const paper = page.nodes.find(node => node.id === edge.from)
            return paper ? <li key={paper.id}><button type="button" onClick={() => { setSelected(paper) }}>{paper.label}</button></li> : null
          })}</ul>}
        </article>}
      </>}
      <div className={styles.paging}>
        {filters.pattern && <button type="button" onClick={() => { load({ source: filters.source, query }) }}>{t('kgBack')}</button>}
        <span>{t('kgMatches', { count: String(page.total) })}</span>
        {page.offset > 0 && <button type="button" disabled={pending} onClick={() => { load({ ...filters, offset: Math.max(0, page.offset - 8) }) }}>{t('kgPrevious')}</button>}
        {page.hasMore && <button type="button" disabled={pending} onClick={() => { load({ ...filters, offset: page.offset + 8 }) }}>{t('kgNext')}</button>}
      </div>
    </>}
  </section>
}

/**
 * The views one research offers, behind a segmented control when there are several. The catalog is the explorer over
 * the graph engine; the others come from the sub-plugins that are on.
 */
function KnowledgeViews(props: GraphProps & { views: KnowledgeViewList; ask?: ((sentence: string) => void) | undefined }): ReactNode {
  const { project, views, t } = props
  const [chosen, setChosen] = useState<KnowledgeViewId | undefined>()
  // The map hands the catalog a region's keywords; the catalog then opens searching for them.
  const [catalogQuery, setCatalogQuery] = useState<string | undefined>()
  const openCatalog = views.includes('catalog') ? (query: string) => { setCatalogQuery(query); setChosen('catalog') } : undefined
  // A tool card that opens the graph with a query or a pattern means the catalog, which is the only view that searches.
  const searching = props.initial?.query !== undefined || props.initial?.pattern !== undefined
  // Otherwise the tab opens on the person's own research when the evidence graph is on, and on the first view offered if not.
  const opening = views.includes('evidence') ? 'evidence' : views[0]
  const active = [chosen, ...searching ? ['catalog' as const] : []].find(view => view !== undefined && views.includes(view)) ?? opening
  const tabbed = views.length > 1
  return <div className={shell.views} data-knowledge-views>
    {tabbed && <div className={shell.bar}>
      <SegmentedControl id="kg-views" label={t('kgViews')} value={active} onChange={setChosen}
        options={views.map(view => ({ value: view, label: t(VIEW_LABELS[view]) }))} />
    </div>}
    <div className={shell.panel} {...tabbed ? { role: 'tabpanel', id: `kg-views-${active}-panel`, 'aria-labelledby': `kg-views-${active}` } : {}}>
      {active === 'map' && <div className={shell.pad}><MapView {...props} key={project.id} project={project} ask={props.ask} openCatalog={openCatalog} /></div>}
      {active === 'relations' && <div className={shell.pad}><RelationsView {...props} key={project.id} project={project} /></div>}
      {active === 'evidence' && <div className={shell.pad}><EvidenceView {...props} key={project.id} project={project} /></div>}
      {active === 'memory' && <div className={shell.pad}><MemoryView {...props} key={project.id} project={project} /></div>}
      {active === 'catalog' && <div className={styles.tab}><Explorer {...props} key={`${project.id}:${catalogQuery ?? ''}`} project={project}
        initial={catalogQuery === undefined ? props.initial : { query: catalogQuery }} /></div>}
    </div>
  </div>
}

function formText(data: FormData, name: string): string {
  const value = data.get(name)
  /* v8 ignore next -- the forms hold only text inputs, so a value is a string */
  return typeof value === 'string' ? value.trim() : ''
}

function EmbeddingSettings(props: WorkbenchProps & { preferences: ResearchPreferences }): ReactNode {
  const action = useAction()
  const { t, preferences } = props
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const form = event.currentTarget, data = new FormData(form)
    const baseUrl = formText(data, 'baseUrl'), model = formText(data, 'model')
    const key = formText(data, 'key')
    action.start(async () => {
      if (Boolean(baseUrl) !== Boolean(model) || (key && !baseUrl)) throw new Error(t('kgEmbeddingRequired'))
      const next = { ...preferences }
      if (baseUrl && model) next.embedding = { baseUrl, model }
      else delete next.embedding
      await props.configure(next, { image: '', embedding: key })
      const input = form.elements.namedItem('key')
      /* v8 ignore next -- the form's key field is always an input */
      if (input instanceof HTMLInputElement) input.value = ''
    })
  }
  return <details className={styles.settings}>
    <summary>{t('kgSettings')}</summary><p className={styles.muted}>{t('kgEmbeddingHint')}</p>
    <form className={styles.settingsForm} onSubmit={submit}>
      <label>{t('kgEndpoint')}<input name="baseUrl" type="url" defaultValue={preferences.embedding?.baseUrl ?? ''} /></label>
      <label>{t('kgModel')}<input name="model" defaultValue={preferences.embedding?.model ?? ''} /></label>
      <label>{t('kgKey')}<input name="key" type="password" autoComplete="new-password" placeholder={t('kgKeyHint')} /></label>
      <button type="submit" disabled={action.pending}>{t(action.pending ? 'kgSaving' : 'kgSave')}</button>
    </form><ActionError t={t} error={action.error} />{action.done && <p role="status">{t('kgSaved')}</p>}
  </details>
}

function BuildGraph(props: GraphProps & { onComplete: () => void }): ReactNode {
  const { t } = props
  const action = useAction()
  const [message, setMessage] = useState('')
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    action.start(async () => {
      const response = await props.run({ action: 'build-graph', projectId: props.project.id, papers: formText(data, 'papers'), domain: formText(data, 'domain') })
      setMessage(response.message); props.onComplete()
    })
  }
  return <details className={styles.settings}><summary>{t('kgBuild')}</summary>
    <p className={styles.muted}>{t('kgBuildHint')}</p>
    <form onSubmit={submit} className={styles.settingsForm}>
      <label>{t('kgCorpus')}<input name="papers" defaultValue="papers.jsonl" required /></label>
      <label>{t('kgDomain')}<input name="domain" defaultValue="research" required /></label>
      <button type="submit" disabled={action.pending}>{t('kgCluster')}</button>
    </form>
    <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); action.start(async () => {
      const response = await props.run({ action: 'name-patterns', projectId: props.project.id, names: formText(data, 'names') })
      setMessage(response.message); props.onComplete()
    }) }} className={styles.settingsForm}>
      <label>{t('kgNames')}<input name="names" defaultValue="cluster_meta.json" required /></label>
      <button type="submit" disabled={action.pending}>{t('kgAssemble')}</button>
    </form>
    {action.pending && <p role="status">{t('kgBuilding')}</p>}<ActionError t={t} error={action.error} />
    {action.done && <p role="status">{message}</p>}
  </details>
}

/** Plugin detail view; the graph can also be inspected beside a research conversation. */
export function KnowledgePluginPage(props: WorkbenchProps & PluginConfigViewProps): ReactNode {
  return props.view === 'summary' ? props.t('kgShared') : <KnowledgePage {...props} />
}

function KnowledgePage(props: WorkbenchProps): ReactNode {
  const snapshot = props.useResearch(view => view.snapshot)
  const session = props.useCurrentSession(value => value), directories = props.useDirectories(value => value)
  const current = session === undefined ? undefined : sessionProject(snapshot?.projects, session, directories)
  const [selected, setSelected] = useState<ProjectId | undefined>()
  const [revision, setRevision] = useState(0)
  const [opened, setOpened] = useState(false)
  useEffect(() => { void props.refresh() }, [])
  if (!snapshot) return <p role="status">{props.t('kgLoading')}</p>
  const project = snapshot.projects.find(project => project.id === selected) ?? current ?? snapshot.projects[0]
  const views = knowledgeViews(snapshot.knowledge)
  // The views stand between two sections of the page rather than inside one: the page's own button and input rules
  // address every descendant of `root`, and would restyle the views' controls.
  return <div className={shell.page} data-knowledge-plugin>
    <section className={styles.root}>
      <p className={styles.muted}>{props.t('kgShared')}</p>
      <EmbeddingSettings {...props} preferences={snapshot.preferences} />
      {views === undefined ? <p className={styles.empty} role="status">{props.t('kgDisabled')}</p> : <div className={styles.toolbar}>
        <label>{props.t('kgResearch')}<select value={project?.id ?? ''} onChange={(event) => { setSelected(event.target.value as ProjectId) }}>
          {snapshot.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
        </select></label>
        <button type="button" onClick={() => { setOpened(value => !value) }} disabled={!project}>{props.t(opened ? 'kgClose' : 'kgOpen')}</button>
        {current && <button type="button" onClick={() => { props.openKnowledge() }}>{props.t('kgBesideChat')}</button>}
      </div>}
    </section>
    {views !== undefined && opened && project && <KnowledgeViews {...props} key={`${project.id}:${revision}`} project={project} views={views} />}
    {views !== undefined && project && !project.example && snapshot.knowledge?.enabled && <section className={styles.root}>
      <BuildGraph {...props} project={project} onComplete={() => { setRevision(value => value + 1); setOpened(true) }} />
    </section>}
  </div>
}

/** The current conversation's graph tab. */
export function KnowledgeTab(props: ResearchTabProps): ReactNode {
  const snapshot = props.useResearch(view => view.snapshot)
  const project = useSessionProject(props)
  const { navigation } = props.useTabInfo().tab
  const params = navigation.params
  const initial: KnowledgeGraphQuery = {
    query: typeof params === 'object' && 'query' in params && typeof params.query === 'string' ? params.query : undefined,
    pattern: typeof params === 'object' && 'pattern' in params && typeof params.pattern === 'string' ? params.pattern : undefined,
  }
  const draft = props.useInput(state => state.draft)
  const views = knowledgeViews(snapshot?.knowledge)
  if (views === undefined) return <div className={styles.tab}><p>{props.t('kgDisabled')}</p></div>
  if (project === undefined) return <div className={styles.tab}><p>{props.t('railNoProject')}</p></div>
  return <KnowledgeViews {...props} key={`${project.id}:${navigation.revision}`} project={project} initial={initial} views={views}
    ask={(sentence) => { props.inputActions.setDraft(appendedDraft(draft, sentence)) }} />
}
