/**
 * The 对话 view's pure parts: which knowledge calls are the conversation's latest, how the traces of one turn fold into
 * one picture, where that picture places its nodes, and how a node reads against the marks as they stand now.
 */
import { describe, expect, it } from 'vitest'
import type { KnowledgeTrace } from '@deepseek-ai/dsh-research-workbench/types'
import {
  chipWidth, DRAWN_NODES, edgeState, FOLLOW_HEIGHT, FOLLOW_WIDTH, followLayout, IDEA, knowledgeCallsOf, SCANNED_TURNS, sameCalls,
  turnTrace, verdictOf, type FollowNode,
} from '../src/client/followValues.ts'
import { AROUND, chatOf, knowledgeCall, markOn, MARKS_READ, PATHS, RECALL } from './fixtures/trace.client.ts'

describe('the knowledge calls of the latest turn', () => {
  it('finds the latest turn that has any, in the order the conversation shows them', () => {
    const early = knowledgeCall({ action: 'recall' }, RECALL)
    const marks = knowledgeCall({ action: 'marks' }, MARKS_READ)
    const paths = knowledgeCall({ action: 'relations-paths' }, PATHS)
    const chat = chatOf([{ turn: 1, calls: [early] }, { turn: 2, calls: [marks, paths] }, { turn: 3, calls: [] }])
    expect(knowledgeCallsOf(chat)).toEqual([marks, paths])
    expect(knowledgeCallsOf(chatOf([]))).toEqual([])
    expect(knowledgeCallsOf(chatOf([{ turn: 1, calls: [] }]))).toEqual([])
  })

  it('finds the turn of a given call, and falls back to the latest turn when none of the recent turns holds it', () => {
    const early = knowledgeCall({ action: 'recall' }, RECALL)
    const late = knowledgeCall({ action: 'marks' }, MARKS_READ)
    const chat = chatOf([{ turn: 1, calls: [early] }, { turn: 2, calls: [late] }])
    expect(knowledgeCallsOf(chat, early.callId)).toEqual([early])
    expect(knowledgeCallsOf(chat, late.callId)).toEqual([late])
    expect(knowledgeCallsOf(chat, 'kg-unknown')).toEqual([late])
    expect(knowledgeCallsOf(chatOf([]), early.callId)).toEqual([])
  })

  it('looks back a bounded number of turns', () => {
    const old = knowledgeCall({ action: 'recall' }, RECALL)
    const turns = [{ turn: 0, calls: [old] }, ...Array.from({ length: SCANNED_TURNS }, (_, at) => ({ turn: at + 1, calls: [] }))]
    expect(knowledgeCallsOf(chatOf(turns))).toEqual([])
    expect(knowledgeCallsOf(chatOf(turns.slice(1, SCANNED_TURNS)))).toEqual([])
    expect(knowledgeCallsOf(chatOf([{ turn: 0, calls: [old] }, ...turns.slice(1, SCANNED_TURNS)]))).toEqual([old])
  })

  it('counts only knowledge calls that settled without failing, whatever else the turn holds', () => {
    const good = knowledgeCall({ action: 'recall' }, RECALL)
    const failed = knowledgeCall({ action: 'recall' }, null, { isError: true })
    const other = knowledgeCall({ action: 'current' }, null, { call: { name: 'research_project', argsRaw: '{}' } })
    const unnamed = knowledgeCall({ action: 'recall' }, null, { call: null })
    expect(knowledgeCallsOf(chatOf([{ turn: 1, calls: [failed, other, unnamed, good] }]))).toEqual([good])
    expect(knowledgeCallsOf(chatOf([{ turn: 1, calls: [failed, other, unnamed] }]))).toEqual([])
  })

  it('treats two selections as one when they hold the same results', () => {
    const a = knowledgeCall({ action: 'recall' }, RECALL), b = knowledgeCall({ action: 'marks' }, MARKS_READ)
    expect(sameCalls([a, b], [a, b])).toBe(true)
    expect(sameCalls([a, b], [b, a])).toBe(false)
    expect(sameCalls([a], [a, b])).toBe(false)
    expect(sameCalls([], [])).toBe(true)
  })
})

describe('one turn folded into one picture', () => {
  it('has no picture when no call kept a trace', () => {
    expect(turnTrace([])).toBeUndefined()
    expect(turnTrace([knowledgeCall({ action: 'graph-status' }, null), knowledgeCall({ action: 'recall' }, 'garbage')])).toBeUndefined()
  })

  it('draws the idea of a recall with a line to each item, the pinned one walked and the skipped one left out', () => {
    const picture = turnTrace([knowledgeCall({ action: 'recall' }, RECALL)])!
    expect(picture.query).toBe('block sparse attention long context')
    expect(picture.nodes.map(node => node.id)).toEqual(['ai:paper:moba', 'ai:paper:minf', 'ai:pattern:adaptive', 'ai:paper:flex', IDEA])
    expect(picture.nodes.at(-1)).toEqual({ id: IDEA, kind: 'idea', source: 'idea', label: '', use: undefined, index: undefined })
    expect(picture.edges.map(edge => [edge.id, edge.walked, edge.skipped])).toEqual([
      ['idea>ai:paper:moba', true, false], ['idea>ai:paper:minf', false, true], ['idea>ai:pattern:adaptive', false, false], ['idea>ai:paper:flex', false, false],
    ])
    expect(picture.walked).toEqual(new Set([IDEA, 'ai:paper:moba']))
    expect(picture.calls).toBe(1)
    expect(picture.hidden).toBe(0)
    expect(picture.added).toEqual([])
  })

  it('joins the traces of a turn: a relation once with its author, the path walked, and what each call touched', () => {
    const recall = knowledgeCall({ action: 'recall' }, RECALL)
    const around = knowledgeCall({ action: 'relations-neighbourhood' }, AROUND)
    const paths = knowledgeCall({ action: 'relations-paths' }, PATHS)
    const picture = turnTrace([recall, around, paths, knowledgeCall({ action: 'graph-status' }, null)])!
    const fixedToFlex = picture.edges.find(edge => edge.id === 'compares-with:method:fixed>method:flex')
    // The neighbourhood knew who recorded it, the path did not; the path walked it.
    expect(fixedToFlex).toMatchObject({ by: 'user', walked: true, skipped: false })
    expect(picture.edges.find(edge => edge.id === 'compares-with:method:flex>method:full')).toMatchObject({ by: 'agent', walked: true })
    expect(picture.added.map(edge => edge.id)).toEqual(['compares-with:method:fixed>method:flex'])
    expect(picture.names.get('method:flex')).toBe('FlexPrefill')
    expect(picture.names.get('ai:paper:flex')).toBe('FlexPrefill')
    expect(picture.nodes.find(node => node.id === 'method:fixed')?.use).toBe('end')
    expect(picture.touched.get(recall.callId)).toEqual(new Set(RECALL.nodes.map(node => node.id)))
    expect(picture.touched.get(paths.callId)).toEqual(new Set(PATHS.nodes.map(node => node.id)))
    expect(picture.calls).toBe(4)
    expect(picture.walked.has('method:full')).toBe(true)
  })

  it('lets a later call of the turn replace how a node was used, and keeps what an earlier one knew of it', () => {
    const first: KnowledgeTrace = { v: 1, action: 'recall', query: 'first', edges: [], nodes: [{ id: 'ai:paper:x', source: 'ai', kind: 'paper', label: 'X', use: 'recalled', index: 4 }] }
    const second: KnowledgeTrace = { v: 1, action: 'recall', query: 'second', edges: [], nodes: [{ id: 'ai:paper:x', source: 'ai', kind: 'paper', label: 'X', use: 'pinned' }] }
    const mark: KnowledgeTrace = { v: 1, action: 'mark', edges: [], nodes: [{ id: 'ai:paper:x', source: 'ai', kind: 'paper', label: 'X' }] }
    const picture = turnTrace([knowledgeCall({}, first), knowledgeCall({}, second), knowledgeCall({}, mark)])!
    expect(picture.query).toBe('second')
    expect(picture.nodes.find(node => node.id === 'ai:paper:x')).toMatchObject({ use: 'pinned', index: 4 })
    expect(picture.edges.find(edge => edge.id === 'idea>ai:paper:x')?.walked).toBe(true)
  })

  it('draws no idea without a recall, and keeps the idea of an earlier recall when a recall carries no query', () => {
    expect(turnTrace([knowledgeCall({}, PATHS)])!.nodes.some(node => node.id === IDEA)).toBe(false)
    const quiet: KnowledgeTrace = { v: 1, action: 'recall', edges: [], nodes: [] }
    const picture = turnTrace([knowledgeCall({}, RECALL), knowledgeCall({}, quiet)])!
    expect(picture.query).toBe(RECALL.query)
  })

  it('draws a bounded number of nodes, the pinned and walked first, and counts the rest with those the host left out', () => {
    const crowd: KnowledgeTrace = {
      v: 1, action: 'relations-neighbourhood', edges: [], omitted: 3,
      nodes: Array.from({ length: 20 }, (_, at) => ({ id: `method:m${at}`, source: 'relations' as const, kind: 'method' as const, label: `M${at}`, ...at === 19 ? { use: 'centre' as const } : {} })),
    }
    const picture = turnTrace([knowledgeCall({}, crowd), knowledgeCall({}, RECALL)])!
    expect(picture.nodes).toHaveLength(DRAWN_NODES)
    expect(picture.hidden).toBe(20 + 5 - DRAWN_NODES + 3)
    const drawn = picture.nodes.map(node => node.id)
    expect(drawn).toEqual(expect.arrayContaining([IDEA, 'ai:paper:moba', 'ai:paper:minf', 'method:m19']))
    expect(picture.edges.every(edge => drawn.includes(edge.from) && drawn.includes(edge.to))).toBe(true)
    expect(picture.names.get('method:m5')).toBe('M5')
  })

  it('reads how a line stands before the switches', () => {
    const line = { id: 'e', kind: 'extends' as const, from: 'a', to: 'b', by: undefined, walked: false, skipped: false }
    expect(edgeState(line)).toBe('plain')
    expect(edgeState({ ...line, walked: true })).toBe('walked')
    expect(edgeState({ ...line, by: 'user', walked: true })).toBe('yours')
    expect(edgeState({ ...line, by: 'user', skipped: true })).toBe('skipped')
    expect(edgeState({ ...line, by: 'agent' })).toBe('plain')
  })
})

const node = (id: string, over: Partial<FollowNode> = {}): FollowNode => ({ id, kind: 'method', source: 'relations', label: id, use: undefined, index: undefined, ...over })
const line = (from: string, to: string) => ({ id: `${from}>${to}`, kind: 'extends' as const, from, to, by: undefined, walked: false, skipped: false })
const wide = (): number => 90

describe('where the nodes of the picture go', () => {
  it('places nothing for no node and the only node in the middle', () => {
    expect(followLayout([], [], wide)).toEqual([])
    expect(followLayout([node('a')], [], wide)).toEqual([{ node: node('a'), width: 90, x: FOLLOW_WIDTH / 2, y: FOLLOW_HEIGHT / 2 }])
  })

  it('puts the idea in the middle, its neighbours around it and theirs beyond, none covering another', () => {
    const idea = node(IDEA, { kind: 'idea', source: 'idea' })
    const nodes = [idea, ...['a', 'b', 'c', 'd', 'e'].map(id => node(id)), node('far1'), node('far2'), node('far3')]
    const edges = [...['a', 'b', 'c', 'd', 'e'].map(id => line(IDEA, id)), line('a', 'far1'), line('a', 'far2'), line('b', 'far3')]
    const placed = followLayout(nodes, edges, wide)
    const at = new Map(placed.map(item => [item.node.id, item]))
    expect(at.get(IDEA)).toMatchObject({ x: FOLLOW_WIDTH / 2, y: FOLLOW_HEIGHT / 2 })
    const distance = (id: string): number => Math.hypot((at.get(id)?.x ?? 0) - FOLLOW_WIDTH / 2, (at.get(id)?.y ?? 0) - FOLLOW_HEIGHT / 2)
    expect(distance('far1')).toBeGreaterThan(distance('a') * 0.9)
    for (const item of placed) {
      expect(item.x).toBeGreaterThanOrEqual(item.width / 2)
      expect(item.x).toBeLessThanOrEqual(FOLLOW_WIDTH - item.width / 2)
      expect(item.y).toBeGreaterThan(0)
      expect(item.y).toBeLessThan(FOLLOW_HEIGHT)
    }
    for (const [i, one] of placed.entries()) {
      for (const other of placed.slice(i + 1)) {
        expect(Math.abs(one.x - other.x) >= (one.width + other.width) / 2 || Math.abs(one.y - other.y) >= 28).toBe(true)
      }
    }
    expect(followLayout(nodes, edges, wide)).toEqual(placed)
  })

  it('centres the most connected node when there is no idea, and spreads nodes no line reaches around the outer ring', () => {
    const nodes = [node('lonely1'), node('hub'), node('x'), node('y'), node('lonely2')]
    const placed = followLayout(nodes, [line('hub', 'x'), line('hub', 'y')], wide)
    const at = new Map(placed.map(item => [item.node.id, item]))
    expect(at.get('hub')).toMatchObject({ x: FOLLOW_WIDTH / 2, y: FOLLOW_HEIGHT / 2 })
    expect(at.get('lonely1')).not.toEqual(at.get('lonely2'))
    expect(new Set(placed.map(item => `${item.x},${item.y}`)).size).toBe(5)
  })

  it('keeps a wide chip inside the picture and moves a chip that would cover another along its ring', () => {
    const nodes = [node('c'), node('a'), node('b')]
    const placed = followLayout(nodes, [line('c', 'a'), line('c', 'b')], () => 400)
    for (const item of placed) expect(item.x - item.width / 2).toBeGreaterThanOrEqual(0)
    expect(placed.every(item => item.x + item.width / 2 <= FOLLOW_WIDTH + 1)).toBe(true)
    expect(new Set(placed.map(item => item.y)).size).toBe(3)
  })

  it('still places every node when the picture has no room left for one', () => {
    const crowd = Array.from({ length: 14 }, (_, at) => node(`n${at}`))
    const placed = followLayout(crowd, crowd.slice(1).map(item => line('n0', item.id)), () => 400)
    expect(placed.map(item => item.node.id)).toEqual(crowd.map(item => item.id))
    expect(placed.every(item => item.y > 0 && item.y < FOLLOW_HEIGHT)).toBe(true)
  })

  it('ignores a line that leads to a node which is not drawn', () => {
    const placed = followLayout([node('a'), node('b')], [line('a', 'ghost'), line('a', 'b')], wide)
    expect(placed.map(item => item.node.id)).toEqual(['a', 'b'])
    expect(placed[0]).toMatchObject({ x: FOLLOW_WIDTH / 2, y: FOLLOW_HEIGHT / 2 })
  })

  it('sizes a chip by its text between a floor and a ceiling', () => {
    expect(chipWidth('')).toBe(48)
    expect(chipWidth('MoBA')).toBeGreaterThan(48)
    expect(chipWidth('x'.repeat(200))).toBe(160)
    expect(chipWidth('分块')).toBeGreaterThan(chipWidth('ab'))
  })
})

describe('a node against the marks as they stand now', () => {
  it('reads the verdict of the mark on it, and nothing for a node that is not marked', () => {
    const marks = [markOn('moba', 'pin', 'MoBA'), markOn('minf', 'irrelevant', 'MInference')]
    expect(verdictOf(marks, 'ai:paper:moba')).toBe('pin')
    expect(verdictOf(marks, 'ai:paper:minf')).toBe('irrelevant')
    expect(verdictOf(marks, 'ai:paper:flex')).toBeUndefined()
    expect(verdictOf(marks, 'method:fixed')).toBeUndefined()
    expect(verdictOf([], 'ai:paper:moba')).toBeUndefined()
  })
})
