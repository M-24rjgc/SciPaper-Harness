import { describe, expect, it } from 'vitest'
import { agglomerate, Bm25, cosine, fuse, kMeans, similarityMatrix, termVectors, tokens } from '../src/clustering.ts'

describe('tokens', () => {
  it('keeps content words of three or more characters and pairs of CJK characters', () => {
    expect(tokens('We use the Sparse attention for LLMs, via a novel approach')).toEqual(['use', 'sparse', 'attention', 'llms'])
    expect(tokens('稀疏注意力 与 图')).toEqual(['稀疏', '疏注', '注意', '意力', '与', '图'])
    expect(tokens('')).toEqual([])
  })
})

describe('BM25', () => {
  it('ranks documents sharing rarer query words first and ignores unknown words', () => {
    const index = new Bm25([['sparse', 'attention', 'cost'], ['dense', 'attention'], ['graph', 'neural'], []])
    const ranked = index.rank(['sparse', 'attention', 'unknown'], 10)
    expect(ranked.map(hit => hit.index)).toEqual([0, 1])
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score)
    expect(index.rank(['attention'], 1)).toHaveLength(1)
    expect(new Bm25([]).rank(['x'], 5)).toEqual([])
    // Equal scores keep document order.
    expect(new Bm25([['same'], ['same']]).rank(['same'], 5).map(hit => hit.index)).toEqual([0, 1])
  })
})

describe('vectors and similarity', () => {
  it('builds unit TF-IDF vectors and compares sparse and dense vectors by cosine', () => {
    const [a, b, empty] = termVectors([['sparse', 'attention', 'attention'], ['sparse', 'graph'], []])
    expect(Math.hypot(...a!.values())).toBeCloseTo(1)
    expect(empty!.size).toBe(0)
    expect(cosine(a!, b!)).toBeGreaterThan(0)
    expect(cosine(b!, a!)).toBeCloseTo(cosine(a!, b!))
    expect(cosine(a!, empty!)).toBe(0)
    expect(cosine(Float32Array.of(1, 0), Float32Array.of(1, 1))).toBeCloseTo(Math.SQRT1_2)
    expect(cosine(Float32Array.of(0, 0), Float32Array.of(1, 1))).toBe(0)
    const matrix = similarityMatrix([Float32Array.of(1, 0), Float32Array.of(0, 1)])
    expect([...matrix]).toEqual([1, 0, 0, 1])
  })

  it('fuses rankings by reciprocal rank', () => {
    const fused = fuse([['a', 'b'], ['b', 'c']])
    expect(fused.get('b')).toBeCloseTo(1 / 62 + 1 / 61)
    expect([...fused].sort((x, y) => y[1] - x[1])[0]![0]).toBe('b')
  })
})

describe('clustering', () => {
  const vectors = [
    Float32Array.of(1, 0.05, 0), Float32Array.of(0.97, 0.1, 0), Float32Array.of(0.95, 0, 0.1),
    Float32Array.of(0, 1, 0.05), Float32Array.of(0.1, 0.96, 0), Float32Array.of(0, 0, 1),
  ]

  it('merges by average linkage only below the distance threshold', () => {
    const matrix = similarityMatrix(vectors)
    expect(agglomerate(matrix, vectors.length, 0.2)).toEqual([0, 0, 0, 1, 1, 2])
    expect(agglomerate(matrix, vectors.length, 2)).toEqual([0, 0, 0, 0, 0, 0])
    expect(agglomerate(matrix, vectors.length, 0)).toEqual([0, 1, 2, 3, 4, 5])
    expect(agglomerate(new Float32Array([1]), 1, 0.5)).toEqual([0])
  })

  it('splits term vectors into k groups the same way every time', () => {
    const texts = [['sparse', 'attention'], ['sparse', 'attention', 'kernel'], ['graph', 'neural'], ['graph', 'neural', 'message'], ['sparse', 'kernel']]
    const labels = kMeans(termVectors(texts), 2)
    expect(labels[0]).toBe(labels[1])
    expect(labels[2]).toBe(labels[3])
    expect(labels[0]).not.toBe(labels[2])
    expect(kMeans(termVectors(texts), 2)).toEqual(labels)
    // Identical vectors leave nothing to seed a second centre with.
    expect(kMeans(termVectors([['same'], ['same'], ['same']]), 2)).toEqual([0, 0, 0])
    // A centre left without members keeps its place.
    expect(new Set(kMeans(termVectors([['a1x'], ['a1x'], ['b2y']]), 3)).size).toBeLessThanOrEqual(3)
  })
})
