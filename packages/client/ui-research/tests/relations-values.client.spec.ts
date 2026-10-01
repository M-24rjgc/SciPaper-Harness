import { expect, it } from 'vitest'
import type { RelationNeighbourhoodView, RelationOutcomeView } from '@deepseek-ai/dsh-research-workbench/types'
import { zh } from '../src/client/locales.ts'
import {
  GAP_STATES, NODE_HEIGHT, NODE_WIDTH, authorName, coverageText, endRef, entityName, gapCounts, gapSentence, gapShort, gapTakeaway,
  groundMeta, hasSources, hopSentence, knownNodes, nameIndex, openPath, outcomeNotes, pathLine, pathRelations, percent, quotable,
  relationName, relationSentence, relationsLayout, sourceCounts, sourceName, statesIn,
} from '../src/client/relationsValues.ts'
import { EDGES, NODES, cell, edge, gapsPage, ground, node, pathsPage, record, relationsPage, t } from './fixtures/relations.ts'

const hood = (): RelationNeighbourhoodView => ({ center: 'block', nodes: NODES, edges: EDGES, omitted: { nodes: 0, edges: 0 } })
const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y)

it('draws the same picture for the same graph, whatever order the host lists it in', () => {
  const first = relationsLayout(hood())
  expect(relationsLayout(hood())).toEqual(first)
  const shuffled = relationsLayout({ ...hood(), nodes: [...NODES].reverse(), edges: [...EDGES].reverse() })
  const at = (layout: typeof first): Record<string, string> => Object.fromEntries(layout.nodes.map(item => [item.node.id, `${item.x},${item.y}`]))
  expect(at(shuffled)).toEqual(at(first))
  expect(first.width).toBeGreaterThan(NODE_WIDTH)
  expect(first.height).toBeGreaterThan(NODE_HEIGHT)
  for (const item of first.nodes) {
    expect(item.x - NODE_WIDTH / 2).toBeGreaterThanOrEqual(0)
    expect(item.x + NODE_WIDTH / 2).toBeLessThanOrEqual(first.width)
    expect(item.y - NODE_HEIGHT / 2).toBeGreaterThanOrEqual(0)
    expect(item.y + NODE_HEIGHT / 2).toBeLessThanOrEqual(first.height)
  }
})

it('breaks a tie between nodes of one slot by id, so the host\'s listing order never moves them', () => {
  const same = [node('b', 'task', 'B'), node('a', 'task', 'A'), node('c', 'task', 'C')]
  const forward = relationsLayout({ center: 'block', nodes: [NODES[0] as typeof NODES[number], ...same], edges: [], omitted: { nodes: 0, edges: 0 } })
  const backward = relationsLayout({ center: 'block', nodes: [NODES[0] as typeof NODES[number], ...[...same].reverse()], edges: [], omitted: { nodes: 0, edges: 0 } })
  const spot = (layout: typeof forward, id: string): string => {
    const item = layout.nodes.find(placed => placed.node.id === id) as (typeof forward.nodes)[number]
    return `${item.x},${item.y}`
  }
  for (const id of ['a', 'b', 'c']) expect(spot(backward, id)).toBe(spot(forward, id))
  expect(spot(forward, 'a')).not.toBe(spot(forward, 'b'))
})

it('puts the centre in the middle, the core group nearest it, and a second-ring node next to its parent', () => {
  const layout = relationsLayout(hood())
  const place = (id: string): { x: number; y: number } => layout.nodes.find(item => item.node.id === id) as { x: number; y: number }
  expect(place('block')).toMatchObject(layout.centre)
  const centre = place('block')
  // The first ring is walked from the top, clockwise, in slot order.
  expect(place('dynamic').y).toBeLessThan(centre.y)
  expect(Math.abs(place('dynamic').x - centre.x)).toBeLessThan(5)
  // Every core node lies nearer than every other first-ring node.
  const core = ['dynamic', 'fixed', 'context'].map(id => distance(place(id), centre))
  const rest = ['full', 'ruler', 'accuracy', 'longformer', 'bigbird', 'moba'].map(id => distance(place(id), centre))
  expect(Math.max(...core)).toBeLessThan(Math.min(...rest) + 80)
  expect(Math.max(...core)).toBeLessThan(Math.max(...rest))
  // The second ring lies beyond the first, and beside its own parent.
  expect(distance(place('summary'), centre)).toBeGreaterThan(Math.max(...rest))
  const others = NODES.filter(item => item.ring === 1 && item.id !== 'longformer').map(item => distance(place('summary'), place(item.id)))
  expect(distance(place('summary'), place('longformer'))).toBeLessThan(Math.min(...others))
})

it('spreads the children of one parent along an arc and keeps neighbours apart', () => {
  const children = ['a', 'b', 'c', 'd'].map((id, slot) => node(id, 'task', id.toUpperCase(), { ring: 2, parent: 'longformer', slot }))
  const layout = relationsLayout({ center: 'block', nodes: [...NODES.filter(item => item.ring < 2), ...children], edges: [], omitted: { nodes: 0, edges: 0 } })
  const spots = children.map(child => layout.nodes.find(item => item.node.id === child.id) as { x: number; y: number })
  expect(new Set(spots.map(spot => `${spot.x},${spot.y}`)).size).toBe(4)
  // Every other child is pushed outward.
  const centre = layout.centre
  expect(distance(spots[1] as { x: number; y: number }, centre)).toBeGreaterThan(distance(spots[0] as { x: number; y: number }, centre) - 1)
})

it('never stacks two nodes, however many hang from one parent', () => {
  const ring = Array.from({ length: 9 }, (_, slot) => node(`n${slot}`, 'method', `Method ${slot}`, { slot, core: slot < 4 }))
  const crowd = ring.flatMap(parent => Array.from({ length: 5 }, (_, slot) => node(`${parent.id}-${slot}`, 'task', `Task ${parent.id} ${slot}`, { ring: 2, parent: parent.id, slot })))
  const layout = relationsLayout({ center: 'block', nodes: [NODES[0] as typeof NODES[number], ...ring, ...crowd], edges: [], omitted: { nodes: 0, edges: 0 } })
  expect(layout.nodes).toHaveLength(1 + ring.length + crowd.length)
  for (const [at, a] of layout.nodes.entries()) {
    for (const b of layout.nodes.slice(at + 1)) {
      expect(Math.abs(a.x - b.x) >= NODE_WIDTH || Math.abs(a.y - b.y) >= NODE_HEIGHT, `${a.node.id} and ${b.node.id}`).toBe(true)
    }
  }
})

it('places a second-ring node whose parent is missing around the outer ring instead of dropping it', () => {
  const lost = [node('x', 'task', 'X', { ring: 2, slot: 0 }), node('y', 'task', 'Y', { ring: 2, parent: 'absent', slot: 1 })]
  const layout = relationsLayout({ center: 'block', nodes: [...NODES.filter(item => item.ring < 2), ...lost], edges: [], omitted: { nodes: 0, edges: 0 } })
  expect(layout.nodes.map(item => item.node.id)).toContain('x')
  const [x, y] = ['x', 'y'].map(id => layout.nodes.find(item => item.node.id === id) as { x: number; y: number })
  expect(distance(x as { x: number; y: number }, y as { x: number; y: number })).toBeGreaterThan(NODE_WIDTH)
})

it('draws only the relations between nodes it placed, spreads parallel ones along the line and ends arrows at the border', () => {
  const layout = relationsLayout({
    ...hood(), edges: [...EDGES, edge('extends', 'ghost', 'block'), edge('compares-with', 'block', 'fixed'), edge('improves-on', 'fixed', 'block')],
  })
  expect(layout.edges.map(item => item.edge.from)).not.toContain('ghost')
  const pair = layout.edges.filter(item => [item.edge.from, item.edge.to].sort().join() === 'bigbird,longformer')
  expect(pair).toHaveLength(2)
  expect(pair[0]?.label).not.toEqual(pair[1]?.label)
  const triple = layout.edges.filter(item => [item.edge.from, item.edge.to].sort().join() === 'block,fixed')
  expect(new Set(triple.map(item => `${item.label.x},${item.label.y}`)).size).toBe(3)
  for (const placed of layout.edges) {
    // The arrowhead tip lies between the nodes' borders: nearer the target than the source, and outside the target's box.
    const across = Math.abs(placed.arrow.x - placed.to.x), down = Math.abs(placed.arrow.y - placed.to.y)
    const outside = across > NODE_WIDTH / 2 - 1 || down > NODE_HEIGHT / 2 - 1
    expect(outside).toBe(true)
    expect(distance(placed.arrow, placed.to)).toBeLessThan(distance(placed.arrow, placed.from))
  }
  const horizontal = relationsLayout({
    center: 'a', nodes: [node('a', 'method', 'A', { ring: 0 }), node('b', 'method', 'B', { slot: 0 })], edges: [edge('is-a', 'a', 'b')], omitted: { nodes: 0, edges: 0 },
  })
  const only = horizontal.edges[0] as (typeof horizontal.edges)[number]
  expect(Number.isFinite(only.arrow.deg)).toBe(true)
  expect(distance(only.arrow, only.to)).toBeGreaterThan(Math.min(NODE_WIDTH, NODE_HEIGHT) / 2)
})

it('survives a relation joining a node to itself, a neighbourhood without its centre, and a neighbourhood without nodes', () => {
  const loop = relationsLayout({
    center: 'a', nodes: [node('a', 'method', 'A', { ring: 0 })], edges: [edge('is-a', 'a', 'a')], omitted: { nodes: 0, edges: 0 },
  })
  expect(loop.edges).toHaveLength(1)
  expect(Number.isFinite(loop.edges[0]?.arrow.x)).toBe(true)
  const headless = relationsLayout({ center: 'gone', nodes: [node('b', 'task', 'B', { slot: 0 })], edges: [], omitted: { nodes: 0, edges: 0 } })
  expect(headless.centre.x).toBeGreaterThan(0)
  expect(headless.centre.y).toBeGreaterThan(0)
  const empty = relationsLayout({ center: 'gone', nodes: [], edges: [], omitted: { nodes: 0, edges: 0 } })
  expect(empty).toMatchObject({ nodes: [], edges: [] })
  expect(Number.isFinite(empty.width)).toBe(true)
})

it('names the relations on a path and reads each in the reader\'s language', () => {
  const paths = pathsPage()
  expect([...pathRelations(paths.paths[0])]).toEqual(['is-a:fixed>block', 'applied-to:fixed>summary'])
  expect([...pathRelations(undefined)]).toEqual([])
  expect(relationName('evaluated-on', t)).toBe(zh.relationsRelEvaluatedOn)
  expect(entityName('dataset', t)).toBe(zh.relationsKindDataset)
  expect(sourceName('citation', t)).toBe(zh.relationsSourceCitation)
  expect(authorName('user', t)).toBe('你')
  expect(authorName('agent', t)).toBe('助手')
  expect(relationSentence('A', 'applied-to', 'B', t)).toBe('A —用于→ B')
  const names = nameIndex(paths.nodes)
  const [back, forward] = (paths.paths[0] as (typeof paths.paths)[number]).hops as [(typeof paths.paths)[number]['hops'][number], (typeof paths.paths)[number]['hops'][number]]
  expect(hopSentence(back, names, t)).toBe('块稀疏注意力 ←属于— 固定分块')
  expect(hopSentence(forward, names, t)).toBe('固定分块 —用于→ 长文档摘要')
  expect(hopSentence({ ...forward, to: 'unlisted' }, names, t)).toBe('固定分块 —用于→ unlisted')
  expect(pathLine(paths.paths[0] as (typeof paths.paths)[number], names, t)).toBe('块稀疏注意力 ←属于— 固定分块 —用于→ 长文档摘要')
  expect(pathLine(paths.paths[1] as (typeof paths.paths)[number], new Map(), t)).toBe('block —用于→ context ←用于— summary')
  expect(percent(0.666)).toBe(67)
})

it('describes a ground by its kind, title and place, and points at the file that opens its source', () => {
  expect(groundMeta(ground('g'), t)).toBe('全文 · Longformer: The Long-Document Transformer · 第 3 页')
  expect(groundMeta(ground('g', { locator: undefined, source: 'run', title: 'run 1' }), t)).toBe('运行 · run 1')
  expect(openPath(record('e'))).toBe('literature/longformer.pdf')
  expect(openPath(record('e', { fullTextPath: undefined }))).toBe('literature/longformer.md')
  expect(sourceCounts({ 'full-text': 2, 'abstract': 0, 'file': 0, 'run': 1, 'citation': 0 }, t)).toBe('全文 2 · 运行 1')
  expect(sourceCounts({ 'full-text': 0, 'abstract': 0, 'file': 0, 'run': 0, 'citation': 0 }, t)).toBe('')
})

it('offers literature and files to quote, never an experiment', () => {
  const records = [record('lit'), record('file', { kind: 'file' }), record('run', { kind: 'experiment' })]
  expect(quotable(records).map(item => item.id)).toEqual(['lit', 'file'])
  expect(hasSources(records)).toBe(true)
  expect(hasSources([record('run', { kind: 'experiment' })])).toBe(false)
  expect(hasSources([])).toBe(false)
})

it('resolves the ends of a typed proposal to a node, a literature record or a new entity', () => {
  const known = relationsPage().hubs.concat([
    { id: 'lf', kind: 'paper', name: 'Longformer', aliases: ['LF'], status: 'active', degree: 2 },
    { id: 'context', kind: 'task', name: '长上下文建模', aliases: ['long-context modelling'], status: 'active', degree: 1 },
  ])
  const evidence = [record('e-lf'), record('e-notes', { kind: 'file', title: 'notes.md' })]
  expect(endRef({ text: ' 动态选块 ', kind: 'task' }, known, evidence)).toEqual({ id: 'dynamic' })
  expect(endRef({ text: 'long-context modelling', kind: 'method' }, known, evidence)).toEqual({ id: 'context' })
  expect(endRef({ text: 'lf', kind: 'paper' }, known, evidence)).toEqual({ id: 'lf' })
  expect(endRef({ text: 'fixed', kind: 'method' }, known, evidence)).toEqual({ id: 'fixed' })
  expect(endRef({ text: 'Sliding window', kind: 'method' }, known, evidence)).toEqual({ kind: 'method', name: 'Sliding window' })
  expect(endRef({ text: 'longformer: the long-document transformer', kind: 'paper' }, known, evidence)).toEqual({ kind: 'paper', evidenceId: 'e-lf' })
  expect(endRef({ text: 'e-lf', kind: 'paper' }, known, evidence)).toEqual({ kind: 'paper', evidenceId: 'e-lf' })
  expect(endRef({ text: 'notes.md', kind: 'paper' }, known, evidence)).toEqual({ missing: 'notes.md' })
  const twins = [
    { id: 'a-task', kind: 'task' as const, name: 'Summarisation', aliases: [], status: 'active' as const, degree: 1 },
    { id: 'a-metric', kind: 'metric' as const, name: 'Summarisation', aliases: [], status: 'active' as const, degree: 1 },
  ]
  expect(endRef({ text: 'summarisation', kind: 'metric' }, twins, evidence)).toEqual({ id: 'a-metric' })
  expect(endRef({ text: 'summarisation', kind: 'dataset' }, twins, evidence)).toEqual({ id: 'a-task' })
})

it('keeps every node once and names them by id', () => {
  const lists = knownNodes(relationsPage().hubs, relationsPage().hubs.slice(0, 1))
  expect(lists.map(item => item.id)).toEqual(['block', 'dynamic', 'fixed', 'full'])
  expect(nameIndex(lists).get('dynamic')).toBe('动态选块')
})

it('words each gap state about the project\'s own literature and never about the field', () => {
  const page = gapsPage()
  const cells = page.cells.flat()
  expect(statesIn(page)).toEqual(GAP_STATES.filter(state => cells.some(item => item.state === state)))
  expect(statesIn(gapsPage({ cells: [[cell('absent')]] }))).toEqual(['absent'])
  expect(gapSentence('reported', cell('reported', { papers: 3 }), t)).toBe('本项目文献中有 3 篇报告')
  expect(gapSentence('reported', undefined, t)).toBe('本项目文献中有 N 篇报告')
  expect(gapSentence('mentioned', cell('mentioned', { passages: 2 }), t)).toBe('有 2 处同时提到，尚未核实')
  expect(gapSentence('project-only', undefined, t)).toBe('仅见于本项目的实验或笔记')
  expect(gapSentence('stale', undefined, t)).toBe('依据已更新，需重新核对')
  expect(gapSentence('absent', undefined, t)).toBe('本项目文献中没有报告')
  expect(gapSentence('uncovered', undefined, t)).toBe('本项目文献未涉及，结论前请先检索')
  expect(zh.relationsGapHeading).toBe('本项目文献中的空白')
  expect(gapShort(cell('reported', { papers: 3 }), t)).toBe('3 篇')
  expect(gapShort(cell('absent'), t)).toBe('空白')
  expect(gapCounts(cell('reported', { papers: 3, viaSubtypes: 1, runs: 2, files: 1, stale: 1, passages: 4, rejected: 1 }), t))
    .toBe('论文 3（其中经子类 1）· 实验 2 · 文件 1 · 已变化 1 · 同时提到 4 处 · 已驳回 1')
  expect(coverageText(page.basis, t)).toBe('依据：12 条文献记录（全文 7、仅摘要 4、仅元数据 1）和 3 个项目文件。')
  expect(gapTakeaway(page, t)).toBe('1 格在本项目文献中没有报告，1 格本项目文献未涉及。这只说明已导入的资料里有什么，不说明别处有没有。')
  expect(gapTakeaway(gapsPage({ cells: [[cell('reported', { papers: 1 })]] }), t)).toBe(zh.relationsGapTakeawayNone)
  for (const text of Object.entries(zh).filter(([key]) => key.startsWith('relationsGap')).map(([, value]) => value)) {
    expect(text).not.toMatch(/没有人|无人|没人/)
  }
})

it('says what recording a proposal did, and nothing for an outcome that is not a proposal\'s', () => {
  const added = { status: 'added', relation: 'r', ground: 'g', created: ['x'], locatorCorrected: true, warnings: ['The quotation is short.'], restored: true } as const
  expect(outcomeNotes(added, t)).toEqual([
    zh.relationsAdded, zh.relationsLocatorFixed, zh.relationsWasRejected, '新建的实体：1 个', 'The quotation is short.',
  ])
  expect(outcomeNotes({ ...added, status: 'unchanged', created: [], locatorCorrected: false, warnings: [], restored: false }, t)).toEqual([zh.relationsAlready])
  expect(outcomeNotes({ ...added, status: 'regrounded', created: [], locatorCorrected: false, warnings: [], restored: false }, t)).toEqual([zh.relationsMoved])
  const decision: Exclude<RelationOutcomeView, { status: 'refused' }> = { status: 'changed', relation: 'r' }
  expect(outcomeNotes(decision, t)).toEqual([])
})
