/**
 * The pure parts of a `kg:` link in an assistant reply: which ids a destination can name, and how an id is found in the
 * traces of the conversation's own knowledge calls. The destination is untrusted model text, looked up and never followed.
 */
import { describe, expect, it } from 'vitest'
import { KNOWLEDGE_SCHEME, knowledgeTargetOf, linkIds, sameTarget } from '../src/client/linkValues.ts'
import { AROUND, chatOf, knowledgeCall, MARKS_READ, PATHS, RECALL } from './fixtures/trace.client.ts'

describe('the ids a link destination can name', () => {
  it('claims the kg scheme', () => {
    expect(KNOWLEDGE_SCHEME).toBe('kg')
  })

  it('reads the text after the scheme as one id, whatever characters it holds', () => {
    expect(linkIds('kg:ai:paper:moba')).toEqual(['ai:paper:moba'])
    expect(linkIds('KG:compares-with:method:fixed>method:flex')).toEqual(['compares-with:method:fixed>method:flex'])
    expect(linkIds('kg:method:固定分块')).toEqual(['method:固定分块'])
  })

  it('offers the decoded text too when the destination carries well-formed percent escapes', () => {
    expect(linkIds('kg:project:paper:a%20b')).toEqual(['project:paper:a%20b', 'project:paper:a b'])
    expect(linkIds('kg:project:paper:100%25')).toEqual(['project:paper:100%25', 'project:paper:100%'])
  })

  it('keeps a malformed escape as the literal text and names nothing for an empty id', () => {
    expect(linkIds('kg:project:paper:100%')).toEqual(['project:paper:100%'])
    expect(linkIds('kg:project:paper:%E0%A4%A')).toEqual(['project:paper:%E0%A4%A'])
    expect(linkIds('kg:')).toEqual([])
  })
})

describe('finding what a link names in the conversation', () => {
  it('finds a node a call touched, with the call and the trace node', () => {
    const recall = knowledgeCall({ action: 'recall' }, RECALL)
    const target = knowledgeTargetOf(chatOf([{ turn: 1, calls: [recall] }]), ['ai:paper:moba'])
    expect(target).toEqual({ kind: 'node', id: 'ai:paper:moba', call: recall.callId, node: RECALL.nodes[0] })
  })

  it('finds a relation with the names of its ends, and reads an end the call did not name by its id', () => {
    const paths = knowledgeCall({ action: 'relations-paths' }, PATHS)
    const chat = chatOf([{ turn: 1, calls: [paths] }])
    expect(knowledgeTargetOf(chat, ['compares-with:method:fixed>method:flex'])).toEqual({
      kind: 'relation', id: 'compares-with:method:fixed>method:flex', call: paths.callId, edge: PATHS.edges[0],
      names: { from: 'Fixed blocks', to: 'FlexPrefill' },
    })
    const lone = knowledgeCall({}, { v: 1, action: 'relations-paths', nodes: [], edges: [{ id: 'extends:a>b', kind: 'extends', from: 'a', to: 'b' }] })
    expect(knowledgeTargetOf(chatOf([{ turn: 1, calls: [lone] }]), ['extends:a>b'])).toMatchObject({ names: { from: 'a', to: 'b' } })
  })

  it('answers with the latest call that touched the id, searching the newest turn and the newest call first', () => {
    const early = knowledgeCall({ action: 'recall' }, RECALL)
    const first = knowledgeCall({ action: 'relations-neighbourhood' }, AROUND)
    const second = knowledgeCall({ action: 'relations-paths' }, PATHS)
    const chat = chatOf([{ turn: 1, calls: [early] }, { turn: 2, calls: [first, second] }])
    expect(knowledgeTargetOf(chat, ['method:flex'])).toMatchObject({ call: second.callId })
    expect(knowledgeTargetOf(chat, ['ai:paper:flex'])).toMatchObject({ call: early.callId })
  })

  it('tries each candidate id in order', () => {
    const recall = knowledgeCall({ action: 'recall' }, RECALL)
    const chat = chatOf([{ turn: 1, calls: [recall] }])
    expect(knowledgeTargetOf(chat, ['ai:paper:moba%20', 'ai:paper:moba'])).toMatchObject({ id: 'ai:paper:moba' })
  })

  it('names nothing for an id no call touched, a malformed trace, a failed call, or no id at all', () => {
    const recall = knowledgeCall({ action: 'recall' }, RECALL)
    const failed = knowledgeCall({ action: 'recall' }, RECALL, { isError: true })
    const plain = knowledgeCall({ action: 'graph-status' }, null)
    const malformed = knowledgeCall({ action: 'recall' }, { v: 2, nodes: RECALL.nodes })
    const chat = chatOf([{ turn: 1, calls: [plain, malformed, failed] }])
    expect(knowledgeTargetOf(chat, ['ai:paper:moba'])).toBeUndefined()
    expect(knowledgeTargetOf(chatOf([{ turn: 1, calls: [recall] }]), ['ai:paper:invented'])).toBeUndefined()
    expect(knowledgeTargetOf(chatOf([{ turn: 1, calls: [recall] }]), [])).toBeUndefined()
    expect(knowledgeTargetOf(chatOf([]), ['ai:paper:moba'])).toBeUndefined()
    expect(knowledgeTargetOf(chatOf([{ turn: 1, calls: [knowledgeCall({ action: 'marks' }, MARKS_READ)] }]), ['ai:paper:moba'])).toBeUndefined()
  })

  it('does not take an id from another conversation: only the chat it is given is searched', () => {
    const other = chatOf([{ turn: 1, calls: [knowledgeCall({ action: 'recall' }, RECALL)] }])
    const mine = chatOf([{ turn: 1, calls: [] }])
    expect(knowledgeTargetOf(other, ['ai:paper:moba'])).toBeDefined()
    expect(knowledgeTargetOf(mine, ['ai:paper:moba'])).toBeUndefined()
  })

  it('treats two lookups as one when they name the same thing through the same call', () => {
    const recall = knowledgeCall({ action: 'recall' }, RECALL)
    const chat = chatOf([{ turn: 1, calls: [recall] }])
    const a = knowledgeTargetOf(chat, ['ai:paper:moba'])
    expect(sameTarget(a, knowledgeTargetOf(chat, ['ai:paper:moba']))).toBe(true)
    expect(sameTarget(a, a)).toBe(true)
    expect(sameTarget(undefined, undefined)).toBe(true)
    expect(sameTarget(a, undefined)).toBe(false)
    expect(sameTarget(undefined, a)).toBe(false)
    expect(sameTarget(a, knowledgeTargetOf(chat, ['ai:paper:flex']))).toBe(false)
  })
})
