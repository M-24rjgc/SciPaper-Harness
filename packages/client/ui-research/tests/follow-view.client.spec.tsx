// @vitest-environment jsdom

/**
 * The 对话 view beside a conversation: the nodes the agent touched in its latest turn drawn from the results of its
 * knowledge calls, the switch that lights the path it took, and the person's marks under the picture with the switch
 * that tells the agent to follow them. A node reads pinned or struck through from the marks as they stand now.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, type RenderResult } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { KnowledgeMarkView, KnowledgeModules, KnowledgeTrace, ResearchCommand, ResearchResponse, RelationsPage } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { FollowView, type FollowViewProps } from '../src/client/FollowView.tsx'
import type { KnowledgeMarksState } from '../src/client/contract.ts'
import { en, zh } from '../src/client/locales.ts'
import { translate } from './fixtures/translate.tsx'
import { AROUND, knowledgeCall, markOn, MARKS_READ, PATHS, RECALL } from './fixtures/trace.client.ts'

afterEach(cleanup)

const everything: KnowledgeModules = { map: true, evidence: true, memory: true, relations: true }
const settle = async (): Promise<void> => { await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }) }
const rejectedPage = (ids: string[]): RelationsPage => ({
  problems: [], counts: { entities: 3, relations: 2, stale: 0, rejected: ids.length, citationLists: 0 }, match: 'none', hubs: [], candidates: [],
  rejected: ids.map(id => ({ id, kind: 'compares-with' as const, from: 'method:fixed', to: 'method:flex', fromName: 'Fixed blocks', toName: 'FlexPrefill' })),
})

interface Seat {
  marks?: readonly KnowledgeMarkView[]
  honour?: boolean
  /** The marks have not been read yet. */
  unread?: boolean
  example?: boolean
  enabled?: boolean
  modules?: KnowledgeModules
  rejected?: string[]
  language?: Record<string, string>
}

function harness(seat: Seat = {}) {
  const project = newProject({ root: '/research/follow', title: 'Follow study', brief: '' }, 'workspace' as WorkspaceId)
  project.example = seat.example === true
  const state: KnowledgeMarksState = seat.unread === true ? {} : { [project.id]: { marks: seat.marks ?? [], honour: seat.honour ?? true } }
  const commands: ResearchCommand[] = []
  const run = vi.fn(async (request: ResearchCommand): Promise<ResearchResponse> => {
    commands.push(request)
    if (request.action === 'relations-graph') return { message: 'Graph', relations: rejectedPage(seat.rejected ?? []) }
    return { message: 'ok' }
  })
  const readMarks = vi.fn()
  const release = vi.fn()
  const props = {
    t: translate(seat.language ?? zh), project, run, readMarks,
    useMarks: (select: (value: KnowledgeMarksState) => unknown) => select(state),
    calls: [], knowledge: { enabled: seat.enabled ?? true, modules: seat.modules ?? everything },
  } as FollowViewProps
  return { props, project, commands, run, readMarks, release }
}

function show(h: ReturnType<typeof harness>, over: Partial<FollowViewProps> = {}): RenderResult {
  return render(<FollowView {...h.props} {...over} />)
}

const lineStates = (view: RenderResult): string[] => [...view.container.querySelectorAll('line')].map(line => line.getAttribute('data-state') ?? '')
const chip = (view: RenderResult, id: string): HTMLElement => view.container.querySelector(`[data-node="${id}"]`) as HTMLElement

describe('before the agent has used the graph', () => {
  it('says so, offers no picture or switch, and still lists the marks the person made', () => {
    const h = harness({ marks: [markOn('moba', 'pin', 'MoBA')] })
    const view = show(h)
    expect(view.getByText(zh.kfEmptyTitle)).toBeTruthy()
    expect(view.getByText(zh.kfEmptyBody)).toBeTruthy()
    expect(view.queryByRole('button', { name: zh.kfHighlight })).toBeNull()
    expect(view.container.querySelector('[data-follow-graph]')).toBeNull()
    expect(view.getByText('MoBA')).toBeTruthy()
    expect(view.getByRole('switch', { name: zh.kmHonour }).getAttribute('aria-checked')).toBe('true')
    expect(h.readMarks).toHaveBeenCalledWith(h.project.id)
  })

  it('shows no marks card while no mark is read, and withdraws it with the graph engine', () => {
    expect(show(harness({ unread: true })).container.querySelector('[data-map-marks]')).toBeNull()
    cleanup()
    const off = harness({ enabled: false, marks: [markOn('moba', 'pin', 'MoBA')] })
    const view = show(off)
    expect(view.container.querySelector('[data-map-marks]')).toBeNull()
    expect(off.readMarks).not.toHaveBeenCalled()
  })
})

describe('the picture of a recall', () => {
  const recall = knowledgeCall({ action: 'recall', query: 'block sparse attention' }, RECALL)

  it('draws the idea and what the recall returned or left out, under the title of the view', () => {
    const view = show(harness(), { calls: [recall] })
    expect(view.getByRole('heading', { name: zh.kfTitle })).toBeTruthy()
    expect(view.getByRole('group', { name: zh.kfGraph })).toBeTruthy()
    for (const name of [zh.kfIdea, 'MoBA', 'MInference', /^Adaptive sparse/, 'FlexPrefill']) expect(view.getByRole('button', { name })).toBeTruthy()
    expect(lineStates(view)).toEqual(['walked', 'skipped', 'plain', 'plain'])
    expect(view.getByText(zh.kfCallsOne)).toBeTruthy()
    expect([...view.container.querySelectorAll('li')].map(item => item.textContent).slice(0, 3)).toEqual([zh.kfLegendWalked, zh.kfLegendRead, zh.kfLegendSkipped])
  })

  it('reads a pinned node as pinned and a node marked not relevant as struck through, from the marks as they stand now', () => {
    const marks = [markOn('moba', 'pin', 'MoBA'), markOn('minf', 'irrelevant', 'MInference')]
    const view = show(harness({ marks }), { calls: [recall] })
    expect(chip(view, 'ai:paper:moba').getAttribute('data-look')).toBe('pinned')
    expect(chip(view, 'ai:paper:moba').textContent).toBe('MoBA')
    expect(chip(view, 'ai:paper:moba').getAttribute('aria-label')).toBe(zh.kfChipPinned.replace('{name}', 'MoBA'))
    expect(chip(view, 'ai:paper:minf').getAttribute('data-look')).toBe('struck')
    expect(chip(view, 'ai:paper:minf').getAttribute('aria-label')).toBe(zh.kfChipIrrelevant.replace('{name}', 'MInference'))
    expect(chip(view, 'ai:paper:flex').getAttribute('data-look')).toBe('plain')
    expect(chip(view, 'ai:paper:flex').getAttribute('aria-label')).toBe('FlexPrefill')
    expect(chip(view, 'idea').getAttribute('data-look')).toBe('idea')
  })

  it('shows the same nodes plain while the person has paused the marks, and again as the marks change', () => {
    const marks = [markOn('minf', 'irrelevant', 'MInference')]
    const paused = show(harness({ marks, honour: false }), { calls: [recall] })
    expect(chip(paused, 'ai:paper:minf').getAttribute('data-look')).toBe('plain')
    expect(paused.getByText(zh.kfHonourOff)).toBeTruthy()
    expect(paused.getByRole('switch', { name: zh.kmHonour }).getAttribute('aria-checked')).toBe('false')
    cleanup()
    const none = show(harness({ marks: [] }), { calls: [recall] })
    expect(chip(none, 'ai:paper:minf').getAttribute('data-look')).toBe('plain')
  })

  it('lights the path the agent took while the switch is on, and draws every line alike while it is off', () => {
    const view = show(harness(), { calls: [recall] })
    const toggle = view.getByRole('button', { name: zh.kfHighlight })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(chip(view, 'ai:paper:moba').getAttribute('data-look')).toBe('walked')
    expect(view.container.querySelector('[data-follow-graph]')?.getAttribute('data-highlight')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(lineStates(view)).toEqual(['plain', 'skipped', 'plain', 'plain'])
    expect(chip(view, 'ai:paper:moba').getAttribute('data-look')).toBe('plain')
  })

  it('brings a node into focus on a click, says how the agent used it and what the mark says now, and lets it go on a second click', () => {
    const view = show(harness({ marks: [markOn('moba', 'pin', 'MoBA')] }), { calls: [recall] })
    fireEvent.click(chip(view, 'ai:paper:moba'))
    const focus = view.container.querySelector('[data-follow-focus]') as HTMLElement
    expect(focus.textContent).toContain(zh.kgPaper)
    expect(focus.textContent).toContain('MoBA')
    expect(focus.textContent).toContain(zh.kfUsePinned)
    expect(focus.textContent).not.toContain(zh.kfNodePinned)
    expect(chip(view, 'ai:paper:moba').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chip(view, 'ai:paper:flex'))
    expect((view.container.querySelector('[data-follow-focus]') as HTMLElement).textContent).toContain(zh.kfUseRecalled)
    expect((view.container.querySelector('[data-follow-focus]') as HTMLElement).textContent).not.toContain(zh.kfNodePinned)
    fireEvent.click(chip(view, 'ai:paper:flex'))
    expect(view.container.querySelector('[data-follow-focus]')).toBeNull()
    fireEvent.click(chip(view, 'idea'))
    expect((view.container.querySelector('[data-follow-focus]') as HTMLElement).textContent).toContain('block sparse attention long context')
    fireEvent.click(chip(view, 'ai:pattern:adaptive'))
    expect((view.container.querySelector('[data-follow-focus]') as HTMLElement).textContent).toContain(zh.kgPattern)
    fireEvent.click(chip(view, 'ai:paper:minf'))
    expect((view.container.querySelector('[data-follow-focus]') as HTMLElement).textContent).toContain(zh.kfUseSkipped)
  })

  it('opens with a node in focus when a chip of a tool card asked for it, and rings the nodes of the call it came from', () => {
    const view = show(harness(), { calls: [recall], node: 'ai:paper:flex', call: recall.callId })
    expect(chip(view, 'ai:paper:flex').getAttribute('aria-pressed')).toBe('true')
    expect(chip(view, 'ai:paper:moba').getAttribute('data-touched')).toBe('true')
    expect(chip(view, 'idea').getAttribute('data-touched')).toBe('false')
    cleanup()
    const other = show(harness(), { calls: [recall], call: 'kg-elsewhere' })
    expect(chip(other, 'ai:paper:moba').getAttribute('data-touched')).toBe('false')
  })

  it('offers the latest turn again while it shows the turn of a chosen call', () => {
    const h = harness()
    const view = show(h, { calls: [recall], release: h.release })
    expect(view.getByText(zh.kfEarlier)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: zh.kfLatest }))
    expect(h.release).toHaveBeenCalledTimes(1)
    cleanup()
    expect(show(h, { calls: [recall] }).queryByText(zh.kfEarlier)).toBeNull()
  })

  it('counts the calls of the turn and the nodes it could not draw, in either language', () => {
    const many = Array.from({ length: 20 }, (_, at) => ({ id: `method:m${at}`, source: 'relations' as const, kind: 'method' as const, label: `M${at}` }))
    const crowd = knowledgeCall({ action: 'relations-neighbourhood' }, { v: 1, action: 'relations-neighbourhood', edges: [], nodes: many })
    const view = show(harness({ language: en }), { calls: [recall, crowd, knowledgeCall({ action: 'marks' }, MARKS_READ)] })
    expect(view.getByText(/This turn: 3 graph calls · \d+ more not drawn/)).toBeTruthy()
    expect(view.getByRole('heading', { name: en.kfTitle })).toBeTruthy()
    expect(view.getByRole('button', { name: en.kfIdea })).toBeTruthy()
  })
})

describe('the picture of the relation graph', () => {
  const around = knowledgeCall({ action: 'relations-neighbourhood', entity: 'Fixed blocks' }, AROUND)
  const paths = knowledgeCall({ action: 'relations-paths', from: 'Fixed blocks', to: 'Full attention' }, PATHS)

  it('draws the entities, the relation the person added dashed, and names each kind of entity in focus', () => {
    const view = show(harness(), { calls: [around, paths] })
    expect(view.queryByRole('button', { name: zh.kfIdea })).toBeNull()
    expect(lineStates(view)).toEqual(['yours', 'walked'])
    fireEvent.click(chip(view, 'method:fixed'))
    const focus = view.container.querySelector('[data-follow-focus]') as HTMLElement
    expect(focus.textContent).toContain(zh.relationsKindMethod)
    expect(focus.textContent).toContain(zh.kfUseEnd)
    cleanup()
    const read = show(harness(), { calls: [around] })
    fireEvent.click(chip(read, 'method:flex'))
    expect((read.container.querySelector('[data-follow-focus]') as HTMLElement).textContent).toContain(zh.kfUseRead)
    expect(lineStates(read)).toEqual(['yours', 'plain'])
    fireEvent.click(chip(read, 'method:fixed'))
    expect((read.container.querySelector('[data-follow-focus]') as HTMLElement).textContent).toContain(zh.kfUseCentre)
  })

  it('lists the relation the person added with the marks, and takes it back through the relation graph', async () => {
    const h = harness()
    const view = show(h, { calls: [around] }); await settle()
    expect(h.commands).toContainEqual({ action: 'relations-graph', projectId: h.project.id, hops: 1, maxNodes: 1 })
    const row = view.getByText('Fixed blocks —对比→ FlexPrefill').closest('li') as HTMLElement
    expect(row.textContent).toContain(zh.kfTagRelation)
    expect(view.getByText(zh.kmMarksTitle.replace('{n}', '1'))).toBeTruthy()
    fireEvent.click(row.querySelector('button') as HTMLElement); await settle()
    expect(h.commands.at(-1)).toEqual({ action: 'relations-reject', projectId: h.project.id, relation: 'compares-with:method:fixed>method:flex' })
    expect(view.queryByText('Fixed blocks —对比→ FlexPrefill')).toBeNull()
    expect(lineStates(view)).toEqual(['rejected', 'plain'])
  })

  it('leaves out a relation the relation graph says was rejected since', async () => {
    const h = harness({ rejected: ['compares-with:method:fixed>method:flex'] })
    const view = show(h, { calls: [around] }); await settle()
    expect(view.queryByText('Fixed blocks —对比→ FlexPrefill')).toBeNull()
    expect(lineStates(view)[0]).toBe('rejected')
  })

  it('reads a relation whose ends the calls did not name by their ids', async () => {
    const bare: KnowledgeTrace = { v: 1, action: 'relations-neighbourhood', nodes: [], edges: [{ id: 'r', kind: 'extends', from: 'method:a', to: 'method:b', by: 'user' }] }
    const view = show(harness(), { calls: [knowledgeCall({}, bare)] }); await settle()
    expect(view.getByText('method:a —扩展了→ method:b')).toBeTruthy()
  })

  it('keeps every relation listed when the relation graph cannot be read, and reads it only where the plugin is on', async () => {
    const h = harness()
    h.run.mockRejectedValueOnce(new Error('Relation graph plugin is disabled'))
    const view = show(h, { calls: [around] }); await settle()
    expect(view.getByText('Fixed blocks —对比→ FlexPrefill')).toBeTruthy()
    cleanup()
    const off = harness({ modules: { ...everything, relations: false } })
    const without = show(off, { calls: [around] }); await settle()
    expect(off.commands.filter(command => command.action === 'relations-graph')).toEqual([])
    expect(without.getByText('Fixed blocks —对比→ FlexPrefill')).toBeTruthy()
    expect(without.getByText('Fixed blocks —对比→ FlexPrefill').closest('li')?.querySelector('button')).toBeNull()
    // Without a relation the person added there is nothing to ask the relation graph.
    cleanup()
    const plain = harness()
    show(plain, { calls: [knowledgeCall({}, PATHS)] }); await settle()
    expect(plain.commands).toEqual([])
  })
})

describe('the person\'s marks under the picture', () => {
  const marks = [markOn('moba', 'pin', 'MoBA'), markOn('minf', 'irrelevant', 'MInference')]

  it('takes a mark off and turns the agent\'s following of the marks on or off, through the commands the map uses', async () => {
    const h = harness({ marks })
    const view = show(h, { calls: [knowledgeCall({}, RECALL)] })
    const row = [...view.container.querySelectorAll('[data-map-marks] li')].find(item => item.textContent?.includes('MInference')) as HTMLElement
    fireEvent.click(row.querySelector('button') as HTMLElement); await settle()
    expect(h.commands.at(-1)).toEqual({ action: 'unmark', projectId: h.project.id, id: 'ai:paper:minf' })
    fireEvent.click(view.getByRole('switch', { name: zh.kmHonour })); await settle()
    expect(h.commands.at(-1)).toEqual({ action: 'honour-marks', projectId: h.project.id, honour: false })
    expect(view.getByText(zh.kfHonourOn)).toBeTruthy()
  })

  it('says why a change failed, in place', async () => {
    const h = harness({ marks })
    h.run.mockRejectedValueOnce(new Error('The graph plugin is off'))
    const view = show(h, { calls: [knowledgeCall({}, RECALL)] })
    fireEvent.click(view.getByRole('switch', { name: zh.kmHonour })); await settle()
    expect(view.getByRole('alert').textContent).toContain('The graph plugin is off')
  })

  it('says what the mark on a node in focus is now, pinned or not relevant, while the agent follows the marks', () => {
    const recall = knowledgeCall({ action: 'recall' }, RECALL)
    const view = show(harness({ marks }), { calls: [recall] })
    fireEvent.click(chip(view, 'ai:paper:minf'))
    // The call already left it out for that mark, so the strip does not say it twice.
    expect((view.container.querySelector('[data-follow-focus]') as HTMLElement).textContent).not.toContain(zh.kfNodeIrrelevant)
    cleanup()
    // A mark made after the call is news.
    const later = show(harness({ marks: [markOn('flex', 'irrelevant', 'FlexPrefill')] }), { calls: [recall] })
    fireEvent.click(chip(later, 'ai:paper:flex'))
    expect((later.container.querySelector('[data-follow-focus]') as HTMLElement).textContent).toContain(zh.kfNodeIrrelevant)
    cleanup()
    const pinnedLater = show(harness({ marks: [markOn('flex', 'pin', 'FlexPrefill')] }), { calls: [recall] })
    fireEvent.click(chip(pinnedLater, 'ai:paper:flex'))
    expect((pinnedLater.container.querySelector('[data-follow-focus]') as HTMLElement).textContent).toContain(zh.kfNodePinned)
    cleanup()
    const paused = show(harness({ marks: [markOn('flex', 'irrelevant', 'FlexPrefill')], honour: false }), { calls: [recall] })
    fireEvent.click(chip(paused, 'ai:paper:flex'))
    expect((paused.container.querySelector('[data-follow-focus]') as HTMLElement).textContent).not.toContain(zh.kfNodeIrrelevant)
  })

  it('can be looked at but not changed in an example research', () => {
    const view = show(harness({ marks, example: true }), { calls: [knowledgeCall({}, RECALL)] })
    expect(view.getByRole('switch', { name: zh.kmHonour }).hasAttribute('disabled')).toBe(true)
    expect(view.getByRole('switch', { name: zh.kmHonour }).getAttribute('title')).toBe(zh.kmExampleReadOnly)
    const undos = view.container.querySelectorAll('[data-map-marks] li button')
    expect(undos).toHaveLength(2)
    for (const button of undos) expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(chip(view, 'ai:paper:moba'))
    expect(view.container.querySelector('[data-follow-focus]')).not.toBeNull()
  })
})
