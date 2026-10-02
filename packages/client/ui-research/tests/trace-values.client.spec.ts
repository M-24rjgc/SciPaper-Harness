/**
 * What the client reads of a knowledge call's trace: the host persists it as the result's presentation metadata, the
 * session log hands it back unchecked, and anything that does not read the way the host writes it is left out.
 */
import { describe, expect, it } from 'vitest'
import type { KnowledgeTrace } from '@deepseek-ai/dsh-research-workbench/types'
import { readTrace, recalledCounts } from '../src/client/traceValues.ts'
import { AROUND, MARKS_READ, PATHS, RECALL } from './fixtures/trace.client.ts'

describe('reading a trace from the result metadata', () => {
  it('reads every trace the host writes back as it was written', () => {
    for (const trace of [RECALL, PATHS, AROUND, MARKS_READ]) expect(readTrace(JSON.parse(JSON.stringify(trace)))).toEqual(trace)
    const bounded: KnowledgeTrace = { v: 1, action: 'mark', nodes: [], edges: [], marks: { count: 1 }, omitted: 4 }
    expect(readTrace(bounded)).toEqual(bounded)
  })

  it('reads a call that touched nothing to draw, and anything that is no version 1 trace, as absent', () => {
    expect(readTrace(null)).toBeUndefined()
    expect(readTrace(undefined)).toBeUndefined()
    expect(readTrace('trace')).toBeUndefined()
    expect(readTrace([RECALL])).toBeUndefined()
    expect(readTrace({ ...RECALL, v: 2 })).toBeUndefined()
    expect(readTrace({ ...RECALL, action: 'recall-everything' })).toBeUndefined()
    expect(readTrace({ ...RECALL, action: 7 })).toBeUndefined()
  })

  it('leaves out a node or relation that is malformed and keeps the rest', () => {
    const trace = readTrace({
      v: 1, action: 'relations-neighbourhood',
      nodes: [
        { id: 'method:a', source: 'relations', kind: 'method', label: 'A', use: 'centre', index: -1 },
        { id: '', source: 'relations', kind: 'method', label: 'no id' },
        { id: 'method:b', source: 'elsewhere', kind: 'method', label: 'B' },
        { id: 'method:c', source: 'relations', kind: 'spaceship', label: 'C' },
        { id: 'method:d', source: 'relations', kind: 'method', label: 4 },
        { id: 'method:e', source: 'relations', kind: 'task', label: 'E', use: 'invented', index: 2.5 },
        'not a node',
      ],
      edges: [
        { id: 'r1', kind: 'extends', from: 'method:a', to: 'method:e', by: 'user', walked: true },
        { id: 'r2', kind: 'invented', from: 'method:a', to: 'method:e' },
        { id: 'r3', kind: 'extends', from: 'method:a' },
        { id: 'r4', kind: 'extends', from: 'method:a', to: 'method:e', by: 'robot', walked: false },
        null,
      ],
    })
    expect(trace?.nodes).toEqual([
      { id: 'method:a', source: 'relations', kind: 'method', label: 'A', use: 'centre' },
      { id: 'method:e', source: 'relations', kind: 'task', label: 'E' },
    ])
    expect(trace?.edges).toEqual([
      { id: 'r1', kind: 'extends', from: 'method:a', to: 'method:e', by: 'user', walked: true },
      { id: 'r4', kind: 'extends', from: 'method:a', to: 'method:e' },
    ])
  })

  it('keeps only well-formed counts, and treats a missing list as empty', () => {
    expect(readTrace({ v: 1, action: 'marks', marks: { count: 2, honour: 'yes' }, paths: -1, omitted: 1.5, query: 4 })).toEqual({ v: 1, action: 'marks', nodes: [], edges: [], marks: { count: 2 } })
    expect(readTrace({ v: 1, action: 'marks', marks: { count: '2' } })).toEqual({ v: 1, action: 'marks', nodes: [], edges: [] })
    expect(readTrace({ v: 1, action: 'marks', marks: 3 })).toEqual({ v: 1, action: 'marks', nodes: [], edges: [] })
    expect(readTrace({ v: 1, action: 'relations-paths', paths: 0, nodes: 'none', edges: {} })).toEqual({ v: 1, action: 'relations-paths', nodes: [], edges: [], paths: 0 })
  })
})

describe('what a recall brought back', () => {
  it('counts the patterns and papers it returned, pinned or not, and not what a mark took out', () => {
    expect(recalledCounts(RECALL)).toEqual({ patterns: 1, papers: 2 })
    expect(recalledCounts(MARKS_READ)).toEqual({ patterns: 0, papers: 0 })
  })
})
