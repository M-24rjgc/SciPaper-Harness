// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within, type BoundFunctions, type queries } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type {
  KnowledgeMarkView, MapOverlayPage, MapPaperView, MapSearchView, MapViewPage, ResearchCommand, ResearchResponse, ResearchSnapshot,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { MapView, type MapViewProps } from '../src/client/KnowledgeMap.tsx'
import { decodeMap, fitScale, transformOf, wholeMap, type BuiltMap } from '../src/client/mapValues.ts'
import { zh } from '../src/client/locales.ts'
import { translate } from './fixtures/translate.tsx'

afterEach(cleanup)
beforeEach(() => {
  Element.prototype.setPointerCapture = () => {}
})
const t = translate(zh)
const project = newProject({ root: '/research/map', title: 'Map study', brief: '' }, 'workspace' as WorkspaceId)

/** Twelve papers: six in region 0 near (0.3, 0.3), four in region 1 near (0.7, 0.7), two in no region. */
const POINTS: readonly (readonly [number, number])[] = [
  [0.3, 0.3], [0.32, 0.3], [0.3, 0.33], [0.28, 0.28], [0.33, 0.27], [0.31, 0.35],
  [0.7, 0.7], [0.72, 0.68], [0.69, 0.73], [0.74, 0.71], [0.2, 0.8], [0.8, 0.2],
]
function mapPage(): BuiltMap {
  const bytes = Buffer.alloc(POINTS.length * 4)
  POINTS.forEach(([x, y], at) => {
    bytes.writeUInt16LE(Math.round(x * 65535), at * 4)
    bytes.writeUInt16LE(Math.round(y * 65535), at * 4 + 2)
  })
  return {
    built: true, graph: { name: 'ai', papers: 29240, patterns: 318 }, points: bytes.toString('base64'),
    regionOf: Buffer.from([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 255, 255]).toString('base64'),
    regions: [
      { index: 0, label: 'attention / sparse', keywords: ['attention', 'sparse'], papers: 6, domain: 'ML', x: 0.3, y: 0.3 },
      { index: 1, label: 'graph / gnn', keywords: ['graph', 'gnn'], papers: 4, domain: 'ML', x: 0.7, y: 0.7 },
    ],
    gaps: [{ index: 0, x: 0.5, y: 0.5, area: 0.01, borders: ['attention / sparse', 'graph / gnn', 'third'], recurs: 3, runs: 5, description: 'Sparse' }],
  }
}
const paper = (index: number, extra: Partial<MapPaperView> = {}): MapPaperView => ({
  index, id: `p${index}`, title: `Paper ${index}`, idea: `Idea ${index}`, story: '', score: null, ...extra,
})
const DETAILS: Record<number, MapPaperView> = {
  0: paper(0, { region: 'attention / sparse', pattern: 'Sparse attention', url: 'https://openreview.net/forum?id=p0' }),
  1: paper(1, { region: 'graph / gnn' }),
  2: paper(2, { idea: '' }),
  6: paper(6, { region: 'graph / gnn', url: 'javascript:alert(1)' }),
}
function overlay(patch: Partial<Extract<MapOverlayPage, { built: true }>> = {}): MapOverlayPage {
  return {
    built: true, honour: true,
    idea: {
      text: 'block sparse attention for long context', source: 'recall',
      placement: {
        x: 0.31, y: 0.31, confidence: 0.6, region: 'attention / sparse', crowding: 0.82,
        alternatives: [{ x: 0.7, y: 0.7, share: 0.3 }, { x: 0.2, y: 0.8, share: 0.05 }],
        nearest: [
          { index: 0, title: 'Paper 0', weight: 1 }, { index: 1, title: 'Paper 1', weight: 0.5 }, { index: 2, title: 'Paper 2', weight: 0.25 },
          { index: 3, title: 'Paper 3', weight: 0.1 },
        ],
      },
    },
    library: [
      { evidenceId: 'e0', title: 'Imported exact paper', placement: { x: 0.3, y: 0.3, confidence: 1, alternatives: [], nearest: [], crowding: 0.5, exact: true } },
      { evidenceId: 'e1', title: 'Imported placed paper', placement: { x: 0.72, y: 0.7, confidence: 0.4, alternatives: [], nearest: [], crowding: 0.2 } },
      { evidenceId: 'e2', title: 'Unplaced reference' },
      ...Array.from({ length: 10 }, (_, at) => ({
        evidenceId: `x${at}`, title: `Extra ${at}`, placement: { x: 0.2, y: 0.8, confidence: 1, alternatives: [], nearest: [], crowding: 0.1 },
      })),
    ],
    recalled: [0, 1, 2, 3, 4, 5, 6, 999].map(index => ({ index, title: `Paper ${index}`, query: 'block sparse attention' })),
    marks: [
      { id: 'ai:paper:p1', target: { kind: 'paper', graph: 'ai', id: 'p1' }, verdict: 'pin', by: 'user', at: '2026-10-01T00:00:00.000Z', title: 'Paper 1', index: 1, note: 'my baseline' },
      { id: 'ai:paper:p9', target: { kind: 'paper', graph: 'ai', id: 'p9' }, verdict: 'irrelevant', by: 'user', at: '2026-10-01T00:00:00.000Z', title: 'Paper 9', index: 9 },
      { id: 'ai:paper:p11', target: { kind: 'paper', graph: 'ai', id: 'p11' }, verdict: 'irrelevant', by: 'agent', at: '2026-10-01T00:00:00.000Z', index: 11 },
      { id: 'ai:pattern:x', target: { kind: 'pattern', graph: 'ai', id: 'x' }, verdict: 'pin', by: 'user', at: '2026-10-01T00:00:00.000Z' },
    ],
    ...patch,
  }
}
const SEARCH: MapSearchView = {
  query: 'graph neural networks', basis: 'lexical',
  placement: { x: 0.7, y: 0.7, confidence: 0.9, region: 'graph / gnn', alternatives: [], nearest: [], crowding: 0.4 },
  papers: [{ index: 6, title: 'Paper 6' }, { index: 999, title: 'Gone' }], patterns: [{ index: 1, name: 'Message passing', x: 0.7, y: 0.7 }],
}

interface Harness {
  props: MapViewProps
  commands: ResearchCommand[]
  marks: KnowledgeMarkView[]
}
function harness(options: {
  view?: MapViewPage
  overlay?: () => Promise<ResearchResponse>
  search?: () => Promise<ResearchResponse>
  mark?: () => Promise<ResearchResponse>
  honour?: () => Promise<ResearchResponse>
  example?: boolean
  embedding?: boolean
  ask?: boolean
  catalog?: boolean
} = {}): Harness {
  const commands: ResearchCommand[] = []
  const marks: KnowledgeMarkView[] = []
  const snapshot: ResearchSnapshot = {
    projects: [project], modes: [], components: [],
    knowledge: { enabled: true, modules: { map: true, evidence: false, memory: false, relations: false } },
    preferences: options.embedding === true ? { embedding: { baseUrl: 'https://embed.example/v1', model: 'm' } } : {},
  }
  const run = async (request: ResearchCommand): Promise<ResearchResponse> => {
    commandSchema.parse(request); commands.push(request)
    switch (request.action) {
      case 'map-view': return { message: 'Map', mapView: options.view ?? mapPage() }
      case 'map-overlay': return options.overlay === undefined ? { message: 'Overlay', mapOverlay: overlay() } : options.overlay()
      case 'map-papers': return { message: 'Papers', mapPapers: request.indices.flatMap(index => DETAILS[index] ?? []) }
      case 'map-search': return options.search === undefined ? { message: 'Search', mapSearch: SEARCH } : options.search()
      case 'mark': {
        if (options.mark !== undefined) return options.mark()
        const id = `ai:paper:${request.target.id}`
        marks.splice(0, marks.length, ...marks.filter(item => item.id !== id),
          { id, target: request.target, verdict: request.verdict, by: 'user', at: '2026-10-01T00:00:00.000Z' })
        return { message: 'Marked', marks: [...marks] }
      }
      case 'honour-marks': {
        if (options.honour !== undefined) return options.honour()
        return { message: 'Honour', honour: request.honour }
      }
      case 'unmark': {
        marks.splice(0, marks.length, ...marks.filter(item => item.id !== request.id))
        return { message: 'Removed', marks: [...marks] }
      }
      default: throw new Error(`unexpected ${request.action}`)
    }
  }
  const props: MapViewProps = {
    t, project: { ...project, example: options.example === true }, run,
    useResearch: (select: (value: object) => unknown) => select({ snapshot, tasks: [] }),
    ...options.ask === true ? { ask: vi.fn() } : {},
    ...options.catalog === true ? { openCatalog: vi.fn() } : {},
  } as never
  return { props, commands, marks }
}
async function settle(): Promise<void> { await act(async () => { for (let at = 0; at < 4; at++) await Promise.resolve() }) }
async function wait(ms: number): Promise<void> { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }

/** Where the stage draws a world point before it is moved, at the default viewport. */
function screenOf(x: number, y: number): { clientX: number; clientY: number } {
  const map = decodeMap(mapPage())
  const viewport = { width: 640, height: 520 }
  const transform = transformOf(wholeMap(map.bounds), viewport, fitScale(map.bounds, viewport))
  return { clientX: x * transform.scale + transform.offsetX, clientY: y * transform.scale + transform.offsetY }
}
const stageOf = (view: ReturnType<typeof render>): HTMLElement => view.container.querySelector('[data-map-stage]') as HTMLElement
const markerX = (view: ReturnType<typeof render>, kind: string): string =>
  (view.container.querySelector(`[data-kind="${kind}"]`) as HTMLElement).style.getPropertyValue('--km-x')

it('asks the map plugin and says that the map is not built, without reading an overlay', async () => {
  const h = harness({ view: { built: false } })
  const view = render(<MapView {...h.props} />)
  expect(view.getByRole('status').textContent).toBe(zh.kgLoading)
  await settle()
  expect(h.commands).toEqual([{ action: 'map-view', projectId: project.id }])
  expect(view.getByRole('heading', { name: zh.kmNotBuiltTitle })).toBeTruthy()
  expect(view.getByText(zh.kmNotBuiltBody)).toBeTruthy()
})

it('shows why the map could not be read: a plugin that went off, an empty answer, or a refusal that is not an error', async () => {
  const off = render(<MapView {...{ ...harness().props, run: async () => { throw new Error('Domain map plugin is disabled.') } }} />)
  await settle()
  expect(off.getByRole('alert').textContent).toContain('Domain map plugin is disabled.')
  off.unmount()
  const empty = render(<MapView {...{ ...harness().props, run: async () => ({ message: 'Map' }) }} />)
  await settle()
  expect(empty.getByRole('alert').textContent).toContain(zh.kgNoResponse)
  empty.unmount()
  const plain = render(<MapView {...{ ...harness().props, run: async () => { throw 'plain refusal' } }} />)
  await settle()
  expect(plain.getByRole('alert').textContent).toContain('plain refusal')
})

it('drops the answers of reads that another research has overtaken', async () => {
  const slow = Promise.withResolvers<ResearchResponse>()
  const failing = Promise.withResolvers<ResearchResponse>()
  const h = harness()
  const view = render(<MapView {...{ ...h.props, run: () => slow.promise }} />)
  const other = { ...project, id: 'other' as typeof project.id }
  view.rerender(<MapView {...h.props} project={other} />)
  await settle()
  expect(view.container.querySelector('[data-map-stage]')).toBeTruthy()
  const second = render(<MapView {...{ ...h.props, run: () => failing.promise }} />)
  second.rerender(<MapView {...h.props} project={other} />)
  await settle()
  failing.reject(new Error('Overtaken failure'))
  slow.resolve({ message: 'late' })
  await settle()
  expect(within(second.container).queryByText('Overtaken failure')).toBeNull()
  expect(within(view.container).queryByText(zh.kgNoResponse)).toBeNull()
  // An overlay read overtaken by another research is dropped too.
  const overlays: ReturnType<typeof Promise.withResolvers<ResearchResponse>>[] = []
  const queued = harness({
    overlay: () => {
      const next = Promise.withResolvers<ResearchResponse>()
      overlays.push(next)
      return next.promise
    },
  })
  const third = render(<MapView {...queued.props} />)
  await settle()
  third.rerender(<MapView {...queued.props} project={other} />)
  await settle()
  overlays[0]!.resolve({ message: 'Overlay', mapOverlay: overlay({ idea: { text: 'a stale idea', source: 'brief' } }) })
  overlays[1]!.resolve({ message: 'Overlay', mapOverlay: overlay() })
  await settle()
  expect(within(third.container).queryByText('a stale idea')).toBeNull()
  expect(within(third.container).getByText('block sparse attention for long context')).toBeTruthy()
  // An overlay read that fails after another research overtook it is dropped as well.
  overlays.length = 0
  const fourth = render(<MapView {...queued.props} />)
  await settle()
  fourth.rerender(<MapView {...queued.props} project={{ ...other, id: 'third' as typeof project.id }} />)
  await settle()
  overlays[0]!.reject(new Error('Overtaken overlay'))
  overlays[1]!.resolve({ message: 'Overlay', mapOverlay: overlay() })
  await settle()
  expect(within(fourth.container).queryByText('Overtaken overlay')).toBeNull()})

it('draws the map with the idea, the library, the recall and the marks, and the panel beside it', async () => {
  const fills: string[] = []
  const context = { setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(() => { fills.push('rect') }), fillStyle: '', globalAlpha: 1 }
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as never)
  const h = harness()
  const view = render(<MapView {...h.props} />)
  await settle()
  expect(h.commands.slice(0, 2)).toEqual([{ action: 'map-view', projectId: project.id }, { action: 'map-overlay', projectId: project.id }])
  expect(fills.length % 12).toBe(0)
  expect(fills.length).toBeGreaterThan(0)
  expect(context.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0)
  getContext.mockRestore()
  expect(view.getByText(/29,240/)).toBeTruthy()
  expect(view.container.querySelector('[data-kind="idea"]')?.getAttribute('title')).toBe('block sparse attention for long context')
  expect(view.container.querySelectorAll('[data-kind="alternative"]')).toHaveLength(1)
  const library = [...view.container.querySelectorAll('span[data-kind="library"]')].filter(node => node.getAttribute('title') !== null)
  expect(library).toHaveLength(12)
  expect(library[0]?.getAttribute('data-variant')).toBe('exact')
  expect(library[1]?.getAttribute('title')).toBe(`Imported placed paper · ${zh.kmLibraryPlaced}`)
  const recalls = [...view.container.querySelectorAll('span[data-kind="recall"][title]')]
  // Seven recalled papers the map holds and two marked ones that were not recalled; the paper outside the map is left out.
  expect(recalls).toHaveLength(9)
  expect(recalls.find(node => node.getAttribute('title')?.startsWith('Paper 1 '))?.getAttribute('data-variant')).toBe('pin')
  expect(recalls.at(-2)?.getAttribute('title')).toBe('Paper 9')
  expect(recalls.at(-1)?.getAttribute('title')).toBe('')
  expect(recalls[0]?.getAttribute('title')).toBe(`Paper 0 · ${t('kmRecalledFor', { query: 'block sparse attention' })}`)
  const legend = [zh.kmLegendPaper, zh.kmLegendRecall, zh.kmLegendLibrary]
  for (const line of legend) expect(view.getByText(line)).toBeTruthy()
  expect(view.queryByText(zh.kmLegendGaps)).toBeNull()

  const panel = within(view.container.querySelector('[data-map-panel]') as HTMLElement)
  expect(panel.getByText(zh.kmIdeaFromRecall)).toBeTruthy()
  expect(panel.getByText(t('kmLands', { region: 'attention / sparse' }))).toBeTruthy()
  expect(panel.getByText(t('kmIdeaSplit', { n: 1 }))).toBeTruthy()
  expect(panel.getByText(zh.kmCrowdingCrowded)).toBeTruthy()
  expect(panel.getByText(t('kmCrowdingBody', { share: 82 }))).toBeTruthy()
  // Without a composer beside the map, nothing offers to draft a question.
  expect(panel.queryByRole('button', { name: zh.kmAskNovelty })).toBeNull()
  expect(panel.queryByRole('button', { name: zh.kmAskRegion })).toBeNull()
  expect(h.commands).toContainEqual({ action: 'map-papers', projectId: project.id, indices: [0, 1, 2, 3] })
  expect(panel.getByText(`${zh.kmSameRegion} · Sparse attention`)).toBeTruthy()
  expect(panel.getByText('graph / gnn')).toBeTruthy()
  const rows = panel.getAllByRole('listitem')
  expect(rows[1]?.getAttribute('data-verdict')).toBe('pin')
  expect(within(rows[1]!).getByRole('button', { name: zh.kmPin }).getAttribute('aria-pressed')).toBe('true')
  expect((rows[0]!.querySelector('[class*="barFill"]') as HTMLElement).style.width).toBe('100%')
})

it('switches the layers, showing the sparse areas only on request and hiding the rest', async () => {
  const view = render(<MapView {...harness().props} />)
  await settle()
  const toggle = (name: string): HTMLElement => view.getByRole('button', { name })
  expect(toggle(zh.kmLayerGaps).getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(toggle(zh.kmLayerGaps))
  expect(view.container.querySelector('[class*="gap"]')).toBeTruthy()
  expect(view.getByText(zh.kmGapShort, { selector: 'span' })).toBeTruthy()
  const gapTitle = `${t('kmGapLabel', { regions: 'attention / sparse · graph / gnn' })} · ${t('kmGapRecurs', { recurs: 3, others: 4 })}`
  expect(view.container.querySelector('[class*="gap"][title]')?.getAttribute('title')).toBe(gapTitle)
  expect(view.getByText(zh.kmLegendGaps)).toBeTruthy()
  for (const name of [zh.kmLayerIdea, zh.kmLayerLibrary, zh.kmLayerRecall]) fireEvent.click(toggle(name))
  expect(view.container.querySelector('[data-kind="idea"]')).toBeNull()
  expect(view.container.querySelector('[data-kind="library"]')).toBeNull()
  expect(view.container.querySelector('[data-kind="recall"]')).toBeNull()
  expect(view.queryByText(zh.kmLegendRecall)).toBeNull()
  // With the marks gone, every region has room for its name.
  expect([...view.container.querySelectorAll('[data-map-stage] [data-tone]')].map(node => node.textContent)).toEqual(['attention / sparse', 'graph / gnn'])
})

it('searches the map, flies to the landing, lists what matched and opens a matching paper', async () => {
  const h = harness({ ask: true, catalog: true })
  const view = render(<MapView {...h.props} />)
  await settle()
  const box = view.getByRole('searchbox', { name: zh.kmSearch })
  expect(box.getAttribute('placeholder')).toBe(zh.kmSearchLexical)
  fireEvent.submit(view.getByRole('search'))
  expect(h.commands.some(command => command.action === 'map-search')).toBe(false)
  expect(view.container.querySelector('[data-kind="search-place"]')).toBeNull()
  fireEvent.change(box, { target: { value: ' graph neural networks ' } })
  fireEvent.submit(view.getByRole('search'))
  expect(view.getByRole('button', { name: zh.kmSearching })).toBeTruthy()
  await settle()
  expect(h.commands).toContainEqual({ action: 'map-search', projectId: project.id, query: 'graph neural networks' })
  // The map flies to where the search lands.
  expect(markerX(view, 'search-place')).toBe('320px')
  const card = within(view.container.querySelector('[data-map-search]') as HTMLElement)
  expect(card.getByText(zh.kmSearchLexicalNote)).toBeTruthy()
  expect(card.getByText(t('kmLands', { region: 'graph / gnn' }))).toBeTruthy()
  expect(view.container.querySelectorAll('span[data-kind="search"][title]')).toHaveLength(1)
  expect(view.getByText(zh.kmLegendSearch)).toBeTruthy()
  // The panel's questions follow the search's region now.
  fireEvent.click(view.getByRole('button', { name: zh.kmAskRegion }))
  expect(h.props.ask).toHaveBeenCalledWith(t('kmAskRegionDraft', { region: 'graph / gnn' }))
  fireEvent.click(view.getByRole('button', { name: zh.kmInCatalog }))
  expect(h.props.openCatalog).toHaveBeenCalledWith('graph gnn')
  fireEvent.click(card.getByRole('button', { name: 'Message passing' }))
  fireEvent.click(card.getByRole('button', { name: 'Paper 6' }))
  await settle()
  const selected = within(view.container.querySelector('[data-map-selected]') as HTMLElement)
  expect(selected.getByText('Paper 6')).toBeTruthy()
  expect(selected.queryByRole('link')).toBeNull()
  fireEvent.click(card.getByRole('button', { name: zh.kmSearchClear }))
  expect(view.container.querySelector('[data-map-search]')).toBeNull()
  expect((box as HTMLInputElement).value).toBe('')
})

it('says when a search matched nothing, failed or came back empty, and offers meaning-based search with an embedding model', async () => {
  const nothing = harness({ embedding: true, search: async () => ({ message: 'Search', mapSearch: { query: 'zzz', basis: 'semantic+lexical', papers: [], patterns: [] } }) })
  const view = render(<MapView {...nothing.props} />)
  await settle()
  const box = view.getByRole('searchbox')
  expect(box.getAttribute('placeholder')).toBe(zh.kmSearchSemantic)
  fireEvent.change(box, { target: { value: 'zzz' } })
  fireEvent.submit(view.getByRole('search')); await settle()
  expect(view.getByText(zh.kmSearchNothing)).toBeTruthy()
  expect(view.getByText(zh.kmSearchSemanticNote)).toBeTruthy()
  view.unmount()
  const between = harness({ search: async () => ({ message: 'Search', mapSearch: { ...SEARCH, placement: { ...SEARCH.placement!, region: undefined } } }) })
  const third = render(<MapView {...between.props} />)
  await settle()
  fireEvent.change(third.getByRole('searchbox'), { target: { value: 'x' } })
  fireEvent.submit(third.getByRole('search')); await settle()
  expect(within(third.container.querySelector('[data-map-search]') as HTMLElement).getByText(zh.kmLandsBetween)).toBeTruthy()
  third.unmount()
  const failed = harness({ search: async () => { throw new Error('Search refused') } })
  const second = render(<MapView {...failed.props} />)
  await settle()
  fireEvent.change(second.getByRole('searchbox'), { target: { value: 'x' } })
  fireEvent.submit(second.getByRole('search')); await settle()
  expect(second.getByRole('alert').textContent).toContain('Search refused')
  failed.props.run = async () => ({ message: 'nothing' })
  second.rerender(<MapView {...failed.props} />)
  fireEvent.submit(second.getByRole('search')); await settle()
  expect(second.getByRole('alert').textContent).toContain(zh.kgNoResponse)
})

it('marks the closest work relevant or not, takes a mark off when pressed again, and reports a refused mark', async () => {
  const h = harness()
  const view = render(<MapView {...h.props} />)
  await settle()
  const panel = view.container.querySelector('[data-map-panel]') as HTMLElement
  const row = (at: number): BoundFunctions<typeof queries> => within(within(panel).getAllByRole('listitem')[at]!)
  fireEvent.click(row(0).getByRole('button', { name: zh.kmIrrelevant })); await settle()
  expect(h.commands).toContainEqual({ action: 'mark', projectId: project.id, target: { kind: 'paper', graph: 'ai', id: 'p0' }, verdict: 'irrelevant' })
  expect(row(0).getByRole('button', { name: zh.kmIrrelevant }).getAttribute('aria-pressed')).toBe('true')
  // The host's answer replaces the marks, so the pin read from the overlay is gone.
  expect(row(1).getByRole('button', { name: zh.kmPin }).getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(row(0).getByRole('button', { name: zh.kmIrrelevant })); await settle()
  expect(h.commands).toContainEqual({ action: 'unmark', projectId: project.id, id: 'ai:paper:p0' })
  expect(row(0).getByRole('button', { name: zh.kmIrrelevant }).getAttribute('aria-pressed')).toBe('false')
  h.props.run = async () => ({ message: 'no marks in the answer' })
  view.rerender(<MapView {...h.props} />)
  fireEvent.click(row(2).getByRole('button', { name: zh.kmPin })); await settle()
  expect(row(2).getByRole('button', { name: zh.kmPin }).getAttribute('aria-pressed')).toBe('false')
  h.props.run = async () => { throw new Error('Mark refused') }
  view.rerender(<MapView {...h.props} />)
  fireEvent.click(row(2).getByRole('button', { name: zh.kmPin })); await settle()
  expect(view.getByText(/Mark refused/)).toBeTruthy()
})

it('lets an example be looked at but not marked', async () => {
  const view = render(<MapView {...harness({ example: true }).props} />)
  await settle()
  const pin = within(view.container.querySelector('[data-map-panel]') as HTMLElement).getAllByRole('button', { name: zh.kmPin })[0]!
  expect(pin.hasAttribute('disabled')).toBe(true)
  expect(pin.getAttribute('title')).toBe(zh.kmExampleReadOnly)
})

it('describes the paper under the pointer, opens it on a click, and moves the map with drags, the wheel, keys and buttons', async () => {
  const h = harness()
  const view = render(<MapView {...h.props} />)
  await settle()
  const stage = stageOf(view)
  const at = screenOf(0.3, 0.3)
  fireEvent.pointerMove(stage, { ...at, pointerId: 1 })
  await wait(160)
  expect(view.getByRole('tooltip').textContent).toContain('Paper 0')
  expect(view.getByRole('tooltip').textContent).toContain(t('kmPattern', { pattern: 'Sparse attention' }))
  fireEvent.pointerMove(stage, { clientX: 5, clientY: 5, pointerId: 1 })
  expect(view.queryByRole('tooltip')).toBeNull()
  fireEvent.pointerMove(stage, { ...screenOf(0.7, 0.7), pointerId: 1 })
  await wait(160)
  expect(view.getByRole('tooltip').textContent).not.toContain(zh.kmPattern.slice(0, 4))
  fireEvent.pointerLeave(stage)
  expect(view.queryByRole('tooltip')).toBeNull()

  // A press with another button does nothing; a click without movement selects the paper under it.
  fireEvent.pointerDown(stage, { ...at, button: 2, pointerId: 1 })
  fireEvent.pointerUp(stage, { ...at, button: 2, pointerId: 1 })
  expect(view.container.querySelector('[data-map-selected]')).toBeNull()
  fireEvent.pointerDown(stage, { ...at, button: 0, pointerId: 1 })
  fireEvent.pointerMove(stage, { clientX: at.clientX + 1, clientY: at.clientY, pointerId: 1 })
  fireEvent.pointerUp(stage, { ...at, button: 0, pointerId: 1 })
  await settle()
  const selected = within(view.container.querySelector('[data-map-selected]') as HTMLElement)
  expect(selected.getByRole('link', { name: zh.kmOpenPaper }).getAttribute('href')).toBe('https://openreview.net/forum?id=p0')
  expect(selected.getByText('Idea 0')).toBeTruthy()
  expect(view.container.querySelector('[data-kind="selected"]')?.getAttribute('title')).toBe('Paper 0')
  fireEvent.click(selected.getByRole('button', { name: zh.kmClose }))
  expect(view.container.querySelector('[data-map-selected]')).toBeNull()
  // A click on empty ground selects nothing.
  fireEvent.pointerDown(stage, { clientX: 5, clientY: 5, button: 0, pointerId: 1 })
  fireEvent.pointerUp(stage, { clientX: 5, clientY: 5, button: 0, pointerId: 1 })
  expect(view.container.querySelector('[data-map-selected]')).toBeNull()

  const start = markerX(view, 'idea')
  fireEvent.pointerDown(stage, { clientX: 300, clientY: 300, button: 0, pointerId: 1 })
  fireEvent.pointerMove(stage, { clientX: 340, clientY: 300, pointerId: 1 })
  fireEvent.pointerUp(stage, { clientX: 340, clientY: 300, button: 0, pointerId: 1 })
  expect(markerX(view, 'idea')).not.toBe(start)
  expect(view.container.querySelector('[data-map-selected]')).toBeNull()
  fireEvent.pointerUp(stage, { clientX: 340, clientY: 300, button: 0, pointerId: 1 })
  view.unmount()

  // Every move redraws the points from a new place; a key the map does not use redraws nothing.
  const firsts: string[] = []
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    setTransform: () => {}, clearRect: () => { firsts.push('') }, fillStyle: '', globalAlpha: 1,
    fillRect: (x: number, y: number) => { if (firsts.at(-1) === '') firsts[firsts.length - 1] = `${Math.round(x)},${Math.round(y)}` },
  }) as never)
  const moved = render(<MapView {...harness().props} />)
  await settle()
  const target = stageOf(moved)
  const draws = (): number => firsts.length
  const actions: (() => void)[] = [
    () => { fireEvent.wheel(target, { deltaY: -200, clientX: 200, clientY: 200 }) },
    ...['+', '=', '-', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map(key => () => { fireEvent.keyDown(target, { key }) }),
    () => { fireEvent.click(moved.getByRole('button', { name: zh.kmZoomIn })) },
    () => { fireEvent.click(moved.getByRole('button', { name: zh.kmZoomOut })) },
  ]
  for (const action of actions) {
    const before = draws()
    const from = firsts.at(-1)
    action()
    expect(draws()).toBe(before + 1)
    expect(firsts.at(-1)).not.toBe(from)
  }
  const before = draws()
  fireEvent.keyDown(target, { key: 'x' })
  expect(draws()).toBe(before)
  fireEvent.click(moved.getByRole('button', { name: zh.kmRecenter }))
  expect(markerX(moved, 'idea')).toBe('320px')
  getContext.mockRestore()
})

it('opens the details of the closest work, drafts questions for the agent, and reads the overlay again', async () => {
  const h = harness({ ask: true })
  const view = render(<MapView {...h.props} />)
  await settle()
  // A paper whose details the host has not sent says so, and cannot be marked.
  const rows = within(view.container.querySelector('[data-map-panel]') as HTMLElement).getAllByRole('listitem')
  expect(within(rows[3]!).getByRole('button', { name: zh.kmPin }).hasAttribute('disabled')).toBe(true)
  expect(rows[3]!.querySelector('[class*="rowWhere"]')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Paper 3' })); await settle()
  expect(within(view.container.querySelector('[data-map-selected]') as HTMLElement).getByRole('status').textContent).toBe(zh.kgLoading)
  fireEvent.click(view.getByRole('button', { name: 'Paper 2' })); await settle()
  const selected = within(view.container.querySelector('[data-map-selected]') as HTMLElement)
  expect(selected.getByText('Paper 2', { selector: 'p' })).toBeTruthy()
  expect(selected.queryByText('Idea 2')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: zh.kmAskNovelty }))
  expect(h.props.ask).toHaveBeenCalledWith(zh.kmAskNoveltyDraft)
  // Without the catalog, only the question to the agent is offered.
  expect(view.queryByRole('button', { name: zh.kmInCatalog })).toBeNull()
  const reads = h.commands.filter(command => command.action === 'map-overlay').length
  fireEvent.click(view.getByRole('button', { name: zh.kmRefresh })); await settle()
  expect(h.commands.filter(command => command.action === 'map-overlay')).toHaveLength(reads + 1)
})

it('explains an idea that is missing, unplaced or between regions, and a failed overlay', async () => {
  const none = render(<MapView {...harness({ overlay: async () => ({ message: 'Overlay', mapOverlay: overlay({ idea: undefined, marks: [] }) }) }).props} />)
  await settle()
  expect(none.getByText(zh.kmIdeaNone)).toBeTruthy()
  expect(none.queryByText(zh.kmNearestTitle)).toBeNull()
  expect(none.getByRole('button', { name: zh.kmWholeMap })).toBeTruthy()
  fireEvent.click(none.getByRole('button', { name: zh.kmWholeMap }))
  none.unmount()
  const unplaced = render(<MapView {...harness({
    overlay: async () => ({ message: 'Overlay', mapOverlay: overlay({ idea: { text: '中文的简介', source: 'brief' } }) }),
  }).props} />)
  await settle()
  expect(unplaced.getByText(zh.kmIdeaFromBrief)).toBeTruthy()
  expect(unplaced.getByText(zh.kmIdeaUnplaced)).toBeTruthy()
  unplaced.unmount()
  const between = overlay()
  const idea = (between as Extract<MapOverlayPage, { built: true }>).idea!
  const loose = render(<MapView {...harness({ catalog: true, overlay: async () => ({
    message: 'Overlay', mapOverlay: { ...between, idea: { ...idea, placement: { ...idea.placement!, region: undefined, alternatives: [], nearest: [], crowding: 0.1 } } },
  }) }).props} />)
  await settle()
  expect(loose.getByText(zh.kmLandsBetween)).toBeTruthy()
  expect(loose.getByText(zh.kmCrowdingSparse)).toBeTruthy()
  expect(loose.getByText(zh.kmNearestNone)).toBeTruthy()
  expect(loose.queryByText(t('kmIdeaSplit', { n: 1 }))).toBeNull()
  // With no region to name, nothing is offered for the region.
  expect(loose.queryByRole('button', { name: zh.kmInCatalog })).toBeNull()
  loose.unmount()
  const moderate = render(<MapView {...harness({ catalog: true, overlay: async () => ({
    message: 'Overlay', mapOverlay: { ...between, idea: { ...idea, placement: { ...idea.placement!, region: 'unknown region', crowding: 0.5 } } },
  }) }).props} />)
  await settle()
  expect(moderate.getByText(zh.kmCrowdingModerate)).toBeTruthy()
  expect(moderate.queryByRole('button', { name: zh.kmInCatalog })).toBeNull()
  moderate.unmount()
  const failed = render(<MapView {...harness({ overlay: async () => { throw new Error('Overlay refused') } }).props} />)
  await settle()
  expect(failed.getByRole('alert').textContent).toContain('Overlay refused')
  expect(failed.getByText(zh.kmIdeaNone)).toBeTruthy()
  failed.unmount()
  const empty = render(<MapView {...harness({ overlay: async () => ({ message: 'Overlay', mapOverlay: { built: false } }) }).props} />)
  await settle()
  expect(empty.getByRole('alert').textContent).toContain(zh.kgNoResponse)
})

it('measures the stage and asks for a paper\'s details once, again after a failed read', async () => {
  const observers: { callback: ResizeObserverCallback; disconnected: boolean }[] = []
  vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
    readonly entry: { callback: ResizeObserverCallback; disconnected: boolean }
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, disconnected: false }; observers.push(this.entry) }
    observe(): void {
      const hidden = { contentRect: { width: 1000.4, height: 0 } } as ResizeObserverEntry
      const shown = { contentRect: { width: 1000.4, height: 600 } } as ResizeObserverEntry
      this.entry.callback([hidden, shown], this)
    }
    unobserve(): void {}
    disconnect(): void { this.entry.disconnected = true }
  })
  const h = harness()
  const view = render(<MapView {...h.props} />)
  await settle()
  expect(markerX(view, 'idea')).not.toBe(screenOf(0.31, 0.31).clientX)
  const asked = (): number => h.commands.filter(command => command.action === 'map-papers').length
  const count = asked()
  fireEvent.click(view.getByRole('button', { name: 'Paper 0' })); await settle()
  expect(asked()).toBe(count)
  view.unmount()
  expect(observers[0]?.disconnected).toBe(true)
  vi.unstubAllGlobals()
  // A failed read of details is asked for again the next time.
  const flaky = harness()
  let fail = true
  const run = flaky.props.run
  flaky.props.run = async (request) => {
    if (request.action === 'map-papers' && fail) { fail = false; throw new Error('busy') }
    return run(request)
  }
  const again = render(<MapView {...flaky.props} />)
  await settle()
  fireEvent.click(again.getByRole('button', { name: 'Paper 0' })); await settle()
  expect(flaky.commands.filter(command => command.action === 'map-papers')).toHaveLength(1)
  expect(within(again.container.querySelector('[data-map-selected]') as HTMLElement).getByText('Paper 0', { selector: 'p' })).toBeTruthy()
})


it('keeps the buttons off for a paper whose details the host did not send', async () => {
  const h = harness()
  const run = h.props.run
  const asked: number[][] = []
  h.props.run = async (request) => {
    if (request.action !== 'map-papers') return run(request)
    asked.push(request.indices)
    return { message: 'No papers' }
  }
  const view = render(<MapView {...h.props} />)
  await settle()
  const rows = within(view.container.querySelector('[data-map-panel]') as HTMLElement).getAllByRole('listitem')
  expect(within(rows[0]!).getByRole('button', { name: zh.kmPin }).hasAttribute('disabled')).toBe(true)
  expect(asked).toEqual([[0, 1, 2, 3]])
})

it('lists the marks, takes one off, and lets the person pause the agent\'s following of them', async () => {
  const h = harness()
  const view = render(<MapView {...h.props} />)
  await settle()
  const card = (): BoundFunctions<typeof queries> => within(view.container.querySelector('[data-map-marks]') as HTMLElement)
  expect(card().getByText(t('kmMarksTitle', { n: 4 }))).toBeTruthy()
  const rows = card().getAllByRole('listitem')
  expect(rows.map(row => row.getAttribute('data-verdict'))).toEqual(['pin', 'irrelevant', 'irrelevant', 'pin'])
  expect(within(rows[0]!).getByText(zh.kmTagPin)).toBeTruthy()
  expect(within(rows[0]!).getByText(t('kmMarkNote', { note: 'my baseline' }))).toBeTruthy()
  // A mark of the agent says so, one without a title shows its id.
  expect(within(rows[2]!).getByText(zh.kmMarkByAgent)).toBeTruthy()
  expect(within(rows[3]!).getByText('x')).toBeTruthy()
  expect(card().getByText(zh.kmHonourOn)).toBeTruthy()

  const toggle = card().getByRole('switch', { name: zh.kmHonour })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle); await settle()
  expect(h.commands).toContainEqual({ action: 'honour-marks', projectId: project.id, honour: false })
  expect(card().getByRole('switch', { name: zh.kmHonour }).getAttribute('aria-checked')).toBe('false')
  expect(card().getByText(zh.kmHonourOff)).toBeTruthy()
  fireEvent.click(card().getByRole('switch', { name: zh.kmHonour })); await settle()
  expect(card().getByRole('switch', { name: zh.kmHonour }).getAttribute('aria-checked')).toBe('true')

  fireEvent.click(within(rows[0]!).getByRole('button', { name: zh.kmUndo })); await settle()
  expect(h.commands).toContainEqual({ action: 'unmark', projectId: project.id, id: 'ai:paper:p1' })
  // The host's answer is the list now: nothing is left, so the card goes.
  expect(view.container.querySelector('[data-map-marks]')).toBeNull()
})

it('keeps the card as it was when the host refuses a change or answers without one, and locks it for an example', async () => {
  const refused = harness({ honour: async () => { throw new Error('Not allowed') } })
  const view = render(<MapView {...refused.props} />)
  await settle()
  const card = (): BoundFunctions<typeof queries> => within(view.container.querySelector('[data-map-marks]') as HTMLElement)
  fireEvent.click(card().getByRole('switch', { name: zh.kmHonour })); await settle()
  expect(view.getByText(/Not allowed/)).toBeTruthy()
  expect(card().getByRole('switch', { name: zh.kmHonour }).getAttribute('aria-checked')).toBe('true')
  const run = refused.props.run
  refused.props.run = async request => request.action === 'unmark' ? { message: 'Removed' } : run(request)
  view.rerender(<MapView {...refused.props} />)
  fireEvent.click(card().getAllByRole('button', { name: zh.kmUndo })[0]!); await settle()
  expect(card().getAllByRole('listitem')).toHaveLength(4)
  refused.props.run = async (request) => { if (request.action === 'unmark') throw new Error('Cannot undo'); return run(request) }
  view.rerender(<MapView {...refused.props} />)
  fireEvent.click(card().getAllByRole('button', { name: zh.kmUndo })[0]!); await settle()
  expect(view.getByText(/Cannot undo/)).toBeTruthy()
  view.unmount()

  const example = render(<MapView {...harness({ example: true }).props} />)
  await settle()
  const locked = within(example.container.querySelector('[data-map-marks]') as HTMLElement)
  expect(locked.getByRole('switch', { name: zh.kmHonour }).hasAttribute('disabled')).toBe(true)
  expect(locked.getByRole('switch', { name: zh.kmHonour }).getAttribute('title')).toBe(zh.kmExampleReadOnly)
  expect(locked.getAllByRole('button', { name: zh.kmUndo }).every(button => button.hasAttribute('disabled'))).toBe(true)
  example.unmount()

  // A host that does not say what it set leaves the switch where the person put it.
  const quiet = harness({ honour: async () => ({ message: 'Done' }) })
  const third = render(<MapView {...quiet.props} />)
  await settle()
  fireEvent.click(within(third.container.querySelector('[data-map-marks]') as HTMLElement).getByRole('switch', { name: zh.kmHonour })); await settle()
  expect(within(third.container.querySelector('[data-map-marks]') as HTMLElement).getByRole('switch', { name: zh.kmHonour }).getAttribute('aria-checked')).toBe('false')
})
