/**
 * 领域地图 (Domain map): every paper of the built-in graph placed so that similar papers sit together, with the
 * research's idea, its imported literature, the agent's recent recalls and the person's marks over it, and a panel
 * beside or below that says where the idea lands, how crowded it is there and which work is closest. The person's
 * 相关 / 不相关 marks go to the host, and recall follows them.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  KnowledgeMarkView, MapOverlayPage, MapPaperView, MapPlacementView, MapSearchView, MapViewPage, ResearchCommand, ResearchProject,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkbenchProps } from './contract.ts'
import { ActionError } from './Action.tsx'
import { MapStage, type StageMarker, type StageProps } from './MapStage.tsx'
import { MarksCard } from './MarksCard.tsx'
import {
  buildPointIndex, clampCamera, clipped, colourGroups, crowdingOf, decodeMap, regionColours, safeLink, wholeMap,
  type BuiltMap, type Crowding, type MapCamera,
} from './mapValues.ts'
import styles from './KnowledgeMap.module.css'

/** The map view's inputs: the research face, the research, and what the view's owner offers beside the map. */
export type MapViewProps = WorkbenchProps & {
  project: ResearchProject
  /** Add a sentence to the conversation's draft; absent where no composer is beside the map. */
  ask?: ((sentence: string) => void) | undefined
  /** Open the catalog view searching for these words; absent where the catalog is off. */
  openCatalog?: ((query: string) => void) | undefined
}

type BuiltOverlay = Extract<MapOverlayPage, { built: true }>
type Layer = 'idea' | 'library' | 'recall' | 'gaps'
type Verdict = KnowledgeMarkView['verdict']

const LAYERS: readonly { layer: Layer; key: 'kmLayerIdea' | 'kmLayerLibrary' | 'kmLayerRecall' | 'kmLayerGaps' }[] = [
  { layer: 'idea', key: 'kmLayerIdea' }, { layer: 'library', key: 'kmLayerLibrary' },
  { layer: 'recall', key: 'kmLayerRecall' }, { layer: 'gaps', key: 'kmLayerGaps' },
]
/** Sparse areas are a fact about this drawing of the corpus, not evidence of a research gap, so they start hidden. */
const INITIAL_LAYERS: Record<Layer, boolean> = { idea: true, library: true, recall: true, gaps: false }
const CROWDING: Record<Crowding, { key: 'kmCrowdingSparse' | 'kmCrowdingModerate' | 'kmCrowdingCrowded'; tone: TagTone }> = {
  sparse: { key: 'kmCrowdingSparse', tone: 'success' }, moderate: { key: 'kmCrowdingModerate', tone: 'warning' }, crowded: { key: 'kmCrowdingCrowded', tone: 'danger' },
}
/** An alternative placement drawn as a dashed ring once it holds this share of the evidence. */
const ALTERNATIVE_SHARE = 0.15
/** Recalled papers named on the map; the others are drawn unnamed. */
const RECALL_LABELS = 6
const LIBRARY_LABELS = 10
const FOCUS_ZOOM = 4
const IDEA_ZOOM = 3
const HOVER_DELAY_MS = 120

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** The person's mark on a built-in paper, if any. */
function markOf(marks: readonly KnowledgeMarkView[], paperId: string): KnowledgeMarkView | undefined {
  return marks.find(mark => mark.target.graph === 'ai' && mark.target.kind === 'paper' && mark.target.id === paperId)
}

/**
 * The view of one research's domain map. It reads the map once and the research's overlay whenever the record
 * changes or the person asks to read it again.
 * @param props - the research face and the research whose map to show; the owner keys it by research.
 * @returns the map with its panel, the line that the map is not built, a failure, or a loading line.
 */
export function MapView(props: MapViewProps): ReactNode {
  const { project, t } = props
  const [page, setPage] = useState<MapViewPage | null>(null)
  const [overlay, setOverlay] = useState<BuiltOverlay | undefined>()
  const [error, setError] = useState('')
  const [overlayError, setOverlayError] = useState('')
  const [reading, setReading] = useState(0)
  const latest = useRef(0)
  const latestOverlay = useRef(0)
  useEffect(() => {
    const ticket = ++latest.current
    props.run({ action: 'map-view', projectId: project.id }).then((result) => {
      if (ticket !== latest.current) return
      if (!result.mapView) throw new Error(t('kgNoResponse'))
      setPage(result.mapView)
      setError('')
    }).catch((reason: unknown) => {
      if (ticket === latest.current) setError(errorText(reason))
    })
    return () => { latest.current++ }
  }, [project.id])
  // The overlay is read only over a map that is built.
  const built = page?.built === true
  useEffect(() => {
    if (!built) return
    const ticket = ++latestOverlay.current
    props.run({ action: 'map-overlay', projectId: project.id }).then((result) => {
      if (ticket !== latestOverlay.current) return
      if (result.mapOverlay?.built !== true) throw new Error(t('kgNoResponse'))
      setOverlay(result.mapOverlay)
      setOverlayError('')
    }).catch((reason: unknown) => {
      if (ticket === latestOverlay.current) setOverlayError(errorText(reason))
    })
    return () => { latestOverlay.current++ }
  }, [project.id, project.revision, reading, built])
  return <section className={styles.view} data-map-view aria-busy={page === null && error === ''}>
    <ActionError t={t} error={error} />
    {page === null && error === '' && <p role="status" className={styles.note}>{t('kgLoading')}</p>}
    {page !== null && !page.built && <div className={styles.notBuilt}>
      <h3 className={styles.title}>{t('kmNotBuiltTitle')}</h3>
      <p className={styles.notBuiltBody}>{t('kmNotBuiltBody')}</p>
    </div>}
    {page?.built === true && <Explorer {...props} page={page} overlay={overlay} overlayError={overlayError}
      reread={() => { setReading(value => value + 1) }} />}
  </section>
}

/** The map, its toolbar and its panel. */
function Explorer(props: MapViewProps & {
  page: BuiltMap
  overlay: BuiltOverlay | undefined
  overlayError: string
  reread: () => void
}): ReactNode {
  const { project, page, overlay, t } = props
  const map = useMemo(() => decodeMap(page), [page])
  const colours = useMemo(() => regionColours(page.regions), [page])
  const groups = useMemo(() => colourGroups(map, colours), [map, colours])
  const index = useMemo(() => buildPointIndex(map), [map])
  const [layers, setLayers] = useState(INITIAL_LAYERS)
  const [camera, setCamera] = useState<MapCamera>(() => wholeMap(map.bounds))
  const [details, setDetails] = useState<ReadonlyMap<number, MapPaperView>>(() => new Map())
  const asked = useRef(new Set<number>())
  const [hovered, setHovered] = useState<number | undefined>()
  const [selected, setSelected] = useState<number | undefined>()
  const [marks, setMarks] = useState<readonly KnowledgeMarkView[]>([])
  const [honour, setHonour] = useState(true)
  const [marking, setMarking] = useState<string | undefined>()
  const [markError, setMarkError] = useState('')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<MapSearchView | undefined>()
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const snapshot = props.useResearch(view => view.snapshot)
  const semantic = snapshot?.preferences.embedding !== undefined

  const move = useCallback((update: (current: MapCamera) => MapCamera) => {
    setCamera(current => clampCamera(update(current), map.bounds))
  }, [map])
  const fly = (x: number, y: number, zoom: number): void => { move(() => ({ cx: x, cy: y, zoom })) }
  const want = useCallback((indices: readonly number[]) => {
    const missing = indices.filter(at => !asked.current.has(at))
    if (missing.length === 0) return
    for (const at of missing) asked.current.add(at)
    props.run({ action: 'map-papers', projectId: project.id, indices: missing }).then((result) => {
      setDetails(previous => new Map([...previous, ...(result.mapPapers ?? []).map(paper => [paper.index, paper] as const)]))
    }).catch(() => { for (const at of missing) asked.current.delete(at) })
  }, [project.id])

  const idea = overlay?.idea
  const placement = idea?.placement
  useEffect(() => {
    setMarks(overlay?.marks ?? [])
    setHonour(overlay?.honour ?? true)
  }, [overlay])
  useEffect(() => { want(placement?.nearest.map(paper => paper.index) ?? []) }, [placement, want])
  useEffect(() => { if (selected !== undefined) want([selected]) }, [selected, want])
  useEffect(() => {
    if (hovered === undefined) return
    const timer = setTimeout(() => { want([hovered]) }, HOVER_DELAY_MS)
    return () => { clearTimeout(timer) }
  }, [hovered, want])

  const runSearch = (event: FormEvent): void => {
    event.preventDefault()
    const text = query.trim()
    if (text === '') return
    setSearching(true); setSearchError('')
    props.run({ action: 'map-search', projectId: project.id, query: text }).then((result) => {
      if (!result.mapSearch) throw new Error(t('kgNoResponse'))
      setSearch(result.mapSearch)
      const landing = result.mapSearch.placement
      if (landing !== undefined) fly(landing.x, landing.y, FOCUS_ZOOM)
    }).catch((reason: unknown) => { setSearchError(errorText(reason)) }).finally(() => { setSearching(false) })
  }
  const clearSearch = (): void => { setSearch(undefined); setQuery(''); setSearchError('') }

  const mark = (paper: MapPaperView, verdict: Verdict): void => {
    const current = markOf(marks, paper.id)
    const request: ResearchCommand = current?.verdict === verdict
      ? { action: 'unmark', projectId: project.id, id: current.id }
      : { action: 'mark', projectId: project.id, target: { kind: 'paper', graph: 'ai', id: paper.id }, verdict }
    setMarking(paper.id); setMarkError('')
    props.run(request).then((result) => { if (result.marks) setMarks(result.marks) })
      .catch((reason: unknown) => { setMarkError(errorText(reason)) }).finally(() => { setMarking(undefined) })
  }
  const undo = (item: KnowledgeMarkView): void => {
    setMarking(item.id); setMarkError('')
    props.run({ action: 'unmark', projectId: project.id, id: item.id }).then((result) => { if (result.marks) setMarks(result.marks) })
      .catch((reason: unknown) => { setMarkError(errorText(reason)) }).finally(() => { setMarking(undefined) })
  }
  const follow = (next: boolean): void => {
    setMarking('honour'); setMarkError('')
    props.run({ action: 'honour-marks', projectId: project.id, honour: next }).then((result) => { setHonour(result.honour ?? next) })
      .catch((reason: unknown) => { setMarkError(errorText(reason)) }).finally(() => { setMarking(undefined) })
  }
  const pickPaper = (at: number): void => {
    setSelected(at)
    fly(map.x[at] as number, map.y[at] as number, Math.max(camera.zoom, FOCUS_ZOOM))
  }

  const markers = useMemo((): StageMarker[] => {
    const list: StageMarker[] = []
    const onMap = (at: number): boolean => at < map.count
    if (layers.idea && idea !== undefined && placement !== undefined) {
      list.push({ key: 'idea', kind: 'idea', x: placement.x, y: placement.y, label: t('kmIdeaTag'), title: idea.text, priority: 4 })
      placement.alternatives.filter(other => other.share >= ALTERNATIVE_SHARE).forEach((other, at) => {
        list.push({ key: `alternative${at}`, kind: 'alternative', x: other.x, y: other.y, title: idea.text, priority: 0 })
      })
    }
    if (layers.library && overlay !== undefined) {
      overlay.library.forEach((item, at) => {
        if (item.placement === undefined) return
        const exact = item.placement.exact === true
        list.push({
          key: `library:${item.evidenceId}`, kind: 'library', x: item.placement.x, y: item.placement.y, variant: exact ? 'exact' : 'placed', priority: 3,
          title: `${item.title} · ${t(exact ? 'kmLibraryExact' : 'kmLibraryPlaced')}`, ...at < LIBRARY_LABELS ? { label: clipped(item.title, 26) } : {},
        })
      })
    }
    if (layers.recall && overlay !== undefined) {
      const recalled = new Map(overlay.recalled.map(paper => [paper.index, paper] as const))
      const marked = marks.flatMap(item => item.index !== undefined && !recalled.has(item.index) ? [item.index] : [])
      const papers = [...recalled.keys(), ...marked]
      papers.filter(onMap).forEach((at, rank) => {
        const paper = recalled.get(at)
        const verdict = marks.find(item => item.index === at)?.verdict
        const title = paper === undefined ? marks.find(item => item.index === at)?.title ?? '' : `${paper.title} · ${t('kmRecalledFor', { query: paper.query })}`
        list.push({
          key: `paper:${at}`, kind: 'recall', x: map.x[at] as number, y: map.y[at] as number, variant: verdict ?? 'none', title, priority: 2,
          ...paper !== undefined && rank < RECALL_LABELS ? { label: clipped(paper.title, 26) } : {},
        })
      })
    }
    if (search !== undefined) {
      if (search.placement !== undefined) {
        list.push({ key: 'search', kind: 'search-place', x: search.placement.x, y: search.placement.y, label: clipped(search.query, 26), title: search.query, priority: 5 })
      }
      search.papers.filter(paper => onMap(paper.index)).forEach((paper) => {
        list.push({ key: `search:${paper.index}`, kind: 'search', x: map.x[paper.index] as number, y: map.y[paper.index] as number, title: paper.title, priority: 1 })
      })
    }
    if (selected !== undefined) {
      list.push({ key: 'selected', kind: 'selected', x: map.x[selected] as number, y: map.y[selected] as number, title: details.get(selected)?.title ?? '', priority: 6 })
    }
    return list
  }, [layers, overlay, idea, placement, marks, search, selected, details, map, t])

  const legend: StageProps['legend'] = [
    'paper', ...layers.recall ? ['recall' as const] : [], ...layers.library ? ['library' as const] : [],
    ...layers.gaps ? ['gaps' as const] : [], ...search !== undefined ? ['search' as const] : [],
  ]
  const focusRegion = search?.placement?.region ?? placement?.region
  const keywords = page.regions.find(region => region.label === focusRegion)?.keywords.join(' ')
  const readOnly = project.example === true
  const { ask, openCatalog } = props
  const catalogue = openCatalog === undefined || keywords === undefined ? undefined : () => { openCatalog(keywords) }
  const paperOf = (at: number): MapPaperView | undefined => details.get(at)

  return <div className={styles.explorer}>
    <div className={styles.toolbar}>
      <form className={styles.search} role="search" onSubmit={runSearch}>
        <input type="search" aria-label={t('kmSearch')} placeholder={t(semantic ? 'kmSearchSemantic' : 'kmSearchLexical')} value={query}
          onChange={(event) => { setQuery(event.target.value) }} />
        <button type="submit" disabled={searching || query.trim() === ''}>{t(searching ? 'kmSearching' : 'kmSearchButton')}</button>
      </form>
      <div className={styles.layers} role="group" aria-label={t('kmLayers')}>
        <span className={styles.layersLabel}>{t('kmLayers')}</span>
        {LAYERS.map(({ layer, key }) => <button key={layer} type="button" className={styles.toggle} data-layer={layer} aria-pressed={layers[layer]}
          onClick={() => { setLayers(value => ({ ...value, [layer]: !value[layer] })) }}>
          <span className={styles.toggleSwatch} data-layer={layer} aria-hidden="true" />{t(key)}
        </button>)}
      </div>
    </div>
    <ActionError t={t} error={searchError} />
    <div className={styles.body}>
      <MapStage t={t} map={map} groups={groups} index={index} regions={page.regions} colours={colours}
        gaps={layers.gaps ? page.gaps : undefined} markers={markers} camera={camera} move={move}
        hover={setHovered} hovered={hovered === undefined ? undefined : paperOf(hovered)}
        select={(at) => { setSelected(at) }} hasIdea={placement !== undefined}
        recenter={() => { if (placement === undefined) setCamera(wholeMap(map.bounds)); else fly(placement.x, placement.y, IDEA_ZOOM) }}
        caption={t('kmCaption', { papers: page.graph.papers.toLocaleString(), patterns: page.graph.patterns.toLocaleString() })} legend={legend} />
      <aside className={styles.panel} aria-label={t('kmIdeaTag')} data-map-panel>
        {search !== undefined && <SearchCard t={t} search={search} clear={clearSearch} flyTo={fly} pick={pickPaper} />}
        {selected !== undefined && <PaperCard t={t} paper={paperOf(selected)} verdict={markVerdict(marks, paperOf(selected))}
          pending={marking !== undefined} readOnly={readOnly} mark={mark} close={() => { setSelected(undefined) }} />}
        <IdeaCard t={t} idea={idea} error={props.overlayError} reread={props.reread} />
        {placement !== undefined && <CrowdingCard t={t} placement={placement} ask={props.ask} />}
        {placement !== undefined && <section className={styles.card}>
          <div className={styles.cardHead}>
            <h4 className={styles.cardTitle}>{t('kmNearestTitle')}</h4>
            <span className={styles.cardHint}>{t('kmNearestHint')}</span>
          </div>
          {placement.nearest.length === 0 && <p className={styles.line}>{t('kmNearestNone')}</p>}
          <ul className={styles.nearest}>
            {placement.nearest.map(item => <NearestRow key={item.index} t={t} title={item.title} weight={item.weight}
              paper={paperOf(item.index)} region={placement.region} verdict={markVerdict(marks, paperOf(item.index))}
              pending={marking !== undefined} readOnly={readOnly} mark={mark} open={() => { pickPaper(item.index) }} />)}
          </ul>
          <ActionError t={t} error={markError} />
        </section>}
        <MarksCard t={t} marks={marks} honour={honour} pending={marking !== undefined} readOnly={readOnly} undo={undo} setHonour={follow} />
        {focusRegion !== undefined && (ask !== undefined || catalogue !== undefined) && <div className={styles.actions}>
          {ask !== undefined && <button type="button" className={styles.primary}
            onClick={() => { ask(t('kmAskRegionDraft', { region: focusRegion })) }}>{t('kmAskRegion')}</button>}
          {catalogue !== undefined && <button type="button" className={styles.secondary} onClick={catalogue}>{t('kmInCatalog')}</button>}
        </div>}
      </aside>
    </div>
  </div>
}

/** The verdict of the person's mark on a paper whose details are read. */
function markVerdict(marks: readonly KnowledgeMarkView[], paper: MapPaperView | undefined): Verdict | undefined {
  return paper === undefined ? undefined : markOf(marks, paper.id)?.verdict
}

/** One paper the person can mark, and how. */
interface MarkProps {
  t: WorkbenchProps['t']
  /** Undefined while its details are read; the buttons wait for its id. */
  paper: MapPaperView | undefined
  verdict: Verdict | undefined
  pending: boolean
  readOnly: boolean
  mark: (paper: MapPaperView, verdict: Verdict) => void
}

/** 相关 and 不相关 for one paper; pressing the verdict it already has takes the mark off. */
function MarkButtons(props: MarkProps): ReactNode {
  const { t, paper } = props
  // Until the paper's details arrive there is no id to mark.
  const mark = paper === undefined || props.pending || props.readOnly ? undefined : (verdict: Verdict) => { props.mark(paper, verdict) }
  const chip = (verdict: Verdict, key: 'kmPin' | 'kmIrrelevant', hint: 'kmPinHint' | 'kmIrrelevantHint'): ReactNode =>
    <button type="button" className={styles.chip} data-verdict={verdict} aria-pressed={props.verdict === verdict} disabled={mark === undefined}
      title={t(props.readOnly ? 'kmExampleReadOnly' : hint)} onClick={mark === undefined ? undefined : () => { mark(verdict) }}>{t(key)}</button>
  return <span className={styles.chips}>{chip('pin', 'kmPin', 'kmPinHint')}{chip('irrelevant', 'kmIrrelevant', 'kmIrrelevantHint')}</span>
}

/** One of the closest papers to the idea, its share of the evidence as a bar. */
function NearestRow(props: MarkProps & { title: string; weight: number; region: string | undefined; open: () => void }): ReactNode {
  const { t, paper } = props
  const where = [paper?.region === undefined ? undefined : paper.region === props.region ? t('kmSameRegion') : paper.region, paper?.pattern]
    .filter(part => part !== undefined).join(' · ')
  return <li className={styles.row} data-verdict={props.verdict}>
    <div className={styles.rowText}>
      <button type="button" className={styles.rowTitle} title={props.title} onClick={props.open}>{props.title}</button>
      {where !== '' && <span className={styles.rowWhere}>{where}</span>}
      <span className={styles.bar} aria-hidden="true"><span className={styles.barFill} style={{ width: `${Math.round(props.weight * 100)}%` }} /></span>
    </div>
    <MarkButtons t={t} paper={paper} verdict={props.verdict} pending={props.pending} readOnly={props.readOnly} mark={props.mark} />
  </li>
}

/** The paper selected on the map. */
function PaperCard(props: MarkProps & { close: () => void }): ReactNode {
  const { t, paper } = props
  const link = safeLink(paper?.url)
  return <section className={styles.card} data-map-selected>
    <div className={styles.cardHead}>
      <h4 className={styles.cardKicker}>{t('kmSelectedTitle')}</h4>
      <button type="button" className={styles.close} aria-label={t('kmClose')} title={t('kmClose')} onClick={props.close}>×</button>
    </div>
    {paper === undefined ? <p role="status" className={styles.line}>{t('kgLoading')}</p> : <>
      <p className={styles.paperTitle}>{paper.title}</p>
      {paper.pattern !== undefined && <p className={styles.meta}>{t('kmPattern', { pattern: paper.pattern })}</p>}
      {paper.region !== undefined && <p className={styles.meta}>{paper.region}</p>}
      {paper.idea !== '' && <p className={styles.line}>{clipped(paper.idea, 320)}</p>}
      <div className={styles.cardFoot}>
        {link !== undefined && <a href={link} target="_blank" rel="noopener noreferrer">{t('kmOpenPaper')}</a>}
        <MarkButtons t={t} paper={paper} verdict={props.verdict} pending={props.pending} readOnly={props.readOnly} mark={props.mark} />
      </div>
    </>}
  </section>
}

/** Where the research's idea lands, and why it does not when it does not. */
function IdeaCard(props: { t: WorkbenchProps['t']; idea: BuiltOverlay['idea']; error: string; reread: () => void }): ReactNode {
  const { t, idea } = props
  const placement = idea?.placement
  const others = placement?.alternatives.filter(other => other.share >= ALTERNATIVE_SHARE).length ?? 0
  return <section className={styles.card} data-map-idea>
    <div className={styles.cardHead}>
      <h4 className={styles.cardKicker}>{t('kmIdeaTag')}</h4>
      {idea !== undefined && <span className={styles.cardHint}>{t(idea.source === 'recall' ? 'kmIdeaFromRecall' : 'kmIdeaFromBrief')}</span>}
      <button type="button" className={styles.link} onClick={props.reread}>{t('kmRefresh')}</button>
    </div>
    <ActionError t={t} error={props.error} />
    {idea === undefined ? <p className={styles.line}>{t('kmIdeaNone')}</p> : <>
      <p className={styles.ideaText} title={idea.text}>{idea.text}</p>
      {placement === undefined
        ? <p className={styles.line}>{t('kmIdeaUnplaced')}</p>
        : <p className={styles.meta}>{placement.region === undefined ? t('kmLandsBetween') : t('kmLands', { region: placement.region })}</p>}
      {others > 0 && <p className={styles.line}>{t('kmIdeaSplit', { n: others })}</p>}
    </>}
  </section>
}

/** How crowded the map is around the idea, worded as a cue and never as a verdict on novelty. */
function CrowdingCard(props: { t: WorkbenchProps['t']; placement: MapPlacementView; ask: MapViewProps['ask'] }): ReactNode {
  const { t, placement, ask } = props
  const band = CROWDING[crowdingOf(placement.crowding)]
  return <section className={styles.card}>
    <div className={styles.cardHead}>
      <h4 className={styles.cardTitle}>{t('kmCrowdingTitle')}</h4>
      <Tag tone={band.tone}>{t(band.key)}</Tag>
    </div>
    <p className={styles.line}>{t('kmCrowdingBody', { share: Math.round(placement.crowding * 100) })}</p>
    {ask !== undefined && <button type="button" className={styles.secondary} onClick={() => { ask(t('kmAskNoveltyDraft')) }}>{t('kmAskNovelty')}</button>}
  </section>
}

/** A search's landing, its closest patterns and its matching papers. */
function SearchCard(props: {
  t: WorkbenchProps['t']
  search: MapSearchView
  clear: () => void
  flyTo: (x: number, y: number, zoom: number) => void
  pick: (index: number) => void
}): ReactNode {
  const { t, search } = props
  const empty = search.placement === undefined && search.papers.length === 0 && search.patterns.length === 0
  return <section className={styles.card} data-map-search>
    <div className={styles.cardHead}>
      <h4 className={styles.cardTitle}>{t('kmSearchTitle', { query: search.query })}</h4>
      <button type="button" className={styles.close} aria-label={t('kmSearchClear')} title={t('kmSearchClear')} onClick={props.clear}>×</button>
    </div>
    <p className={styles.meta}>{t(search.basis === 'lexical' ? 'kmSearchLexicalNote' : 'kmSearchSemanticNote')}</p>
    {empty && <p className={styles.line}>{t('kmSearchNothing')}</p>}
    {search.placement !== undefined && <p className={styles.meta}>
      {search.placement.region === undefined ? t('kmLandsBetween') : t('kmLands', { region: search.placement.region })}
    </p>}
    {search.patterns.length > 0 && <>
      <h5 className={styles.subTitle}>{t('kmSearchPatterns')}</h5>
      <ul className={styles.list}>{search.patterns.map(pattern => <li key={pattern.index}>
        <button type="button" className={styles.listButton} onClick={() => { props.flyTo(pattern.x, pattern.y, FOCUS_ZOOM) }}>{pattern.name}</button>
      </li>)}</ul>
    </>}
    {search.papers.length > 0 && <>
      <h5 className={styles.subTitle}>{t('kmSearchPapers')}</h5>
      <ul className={styles.list}>{search.papers.map(paper => <li key={paper.index}>
        <button type="button" className={styles.listButton} onClick={() => { props.pick(paper.index) }}>{paper.title}</button>
      </li>)}</ul>
    </>}
  </section>
}
