/**
 * The vector math behind the knowledge graphs, all deterministic: tokens,
 * BM25 ranking, term-weight vectors, cosine similarity, reciprocal-rank
 * fusion, and the two clusterings spark-to-paper's graph builder uses —
 * average-linkage agglomerative clustering under a cosine distance threshold
 * for embeddings, and k-means for term-weight vectors, where cosine
 * distances run too high for one threshold to mean anything.
 */

/** Function words too common to tell two research texts apart. */
const STOP = new Set((
  'the a an of for to in on and or with from by is are be was were this that these those we our its their it as at into over '
  + 'under than such can which while using based via approach method model framework toward towards novel new paper study show'
).split(' '))

/**
 * The search tokens of a text: lowercase words of three or more letters or
 * digits without function words, and overlapping pairs of CJK characters.
 * @param text - any text.
 * @returns the tokens in order.
 */
export function tokens(text: string): string[] {
  const out: string[] = []
  for (const word of text.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]+/g) ?? []) {
    if (/^[\u3400-\u9fff]/.test(word)) {
      if (word.length === 1) out.push(word)
      for (let index = 0; index + 1 < word.length; index++) out.push(word.slice(index, index + 2))
    } else if (word.length > 2 && !STOP.has(word)) out.push(word)
  }
  return out
}

/** Okapi BM25 over a fixed set of documents. */
export class Bm25 {
  private readonly postings = new Map<string, number[]>()
  private readonly lengths: number[]
  private readonly average: number

  /** @param documents - each document's tokens. */
  constructor(documents: readonly (readonly string[])[]) {
    this.lengths = documents.map(document => document.length)
    this.average = this.lengths.reduce((sum, length) => sum + length, 0) / Math.max(documents.length, 1) || 1
    documents.forEach((document, index) => {
      const counts = new Map<string, number>()
      for (const token of document) counts.set(token, (counts.get(token) ?? 0) + 1)
      for (const [token, count] of counts) {
        const list = this.postings.get(token) ?? []
        list.push(index, count)
        this.postings.set(token, list)
      }
    })
  }

  /**
   * The documents that share a token with the query, best first.
   * @param query - the query's tokens.
   * @param limit - how many to return.
   * @returns document indexes with their scores.
   */
  rank(query: readonly string[], limit: number): { index: number; score: number }[] {
    const scores = new Map<number, number>()
    const total = this.lengths.length
    for (const token of new Set(query)) {
      const list = this.postings.get(token)
      if (!list) continue
      const idf = Math.log(1 + (total - list.length / 2 + 0.5) / (list.length / 2 + 0.5))
      for (let at = 0; at < list.length; at += 2) {
        const index = list[at] as number, count = list[at + 1] as number
        const norm = count + 1.2 * (0.25 + 0.75 * (this.lengths[index] as number) / this.average)
        scores.set(index, (scores.get(index) ?? 0) + idf * count * 2.2 / norm)
      }
    }
    return [...scores].map(([index, score]) => ({ index, score })).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit)
  }
}

/** A sparse vector: term index to weight, unit length. */
export type SparseVector = Map<number, number>
/** An embedding or a sparse term vector. */
export type Vector = Float32Array | SparseVector

/**
 * Unit-length TF-IDF vectors for a set of texts.
 * @param texts - each text's tokens.
 * @returns one vector per text; a text without tokens gets an empty vector.
 */
export function termVectors(texts: readonly (readonly string[])[]): SparseVector[] {
  const vocabulary = new Map<string, number>()
  const frequency: number[] = []
  const counted = texts.map((text) => {
    const counts = new Map<number, number>()
    for (const token of text) {
      let id = vocabulary.get(token)
      if (id === undefined) { id = vocabulary.size; vocabulary.set(token, id); frequency.push(0) }
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    for (const id of counts.keys()) frequency[id] = (frequency[id] as number) + 1
    return counts
  })
  return counted.map((counts) => {
    const vector: SparseVector = new Map()
    const idf = (id: number): number => Math.log((1 + texts.length) / (1 + (frequency[id] as number)) + 1)
    for (const [id, count] of counts) vector.set(id, (1 + Math.log(count)) * idf(id))
    return unit(vector)
  })
}

function unit(vector: SparseVector): SparseVector {
  const norm = Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0))
  if (norm > 0) for (const [id, value] of vector) vector.set(id, value / norm)
  return vector
}

/**
 * Cosine similarity of two vectors, dense or sparse (sparse ones are unit length already).
 * @param a - one vector.
 * @param b - the other, of the same kind.
 * @returns the similarity, 0 when either is empty.
 */
export function cosine(a: Vector, b: Vector): number {
  if (a instanceof Map && b instanceof Map) {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a]
    let sum = 0
    for (const [id, value] of small) sum += value * (large.get(id) ?? 0)
    return sum
  }
  const x = a as Float32Array, y = b as Float32Array
  let dot = 0, nx = 0, ny = 0
  for (let index = 0; index < x.length; index++) {
    dot += (x[index] as number) * (y[index] as number)
    nx += (x[index] as number) ** 2
    ny += (y[index] as number) ** 2
  }
  return nx > 0 && ny > 0 ? dot / Math.sqrt(nx * ny) : 0
}

/**
 * Reciprocal-rank fusion of several rankings (k = 60).
 * @param rankings - each a list of keys, best first.
 * @returns every key with its fused score.
 */
export function fuse(rankings: readonly (readonly string[])[]): Map<string, number> {
  const scores = new Map<string, number>()
  for (const ranking of rankings) ranking.forEach((key, rank) => { scores.set(key, (scores.get(key) ?? 0) + 1 / (61 + rank)) })
  return scores
}

/** Pairwise cosine similarities, row-major. */
export function similarityMatrix(vectors: readonly Vector[]): Float32Array {
  const n = vectors.length
  const matrix = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    matrix[i * n + i] = 1
    for (let j = i + 1; j < n; j++) {
      const value = cosine(vectors[i] as Vector, vectors[j] as Vector)
      matrix[i * n + j] = value
      matrix[j * n + i] = value
    }
  }
  return matrix
}

/**
 * Average-linkage agglomerative clustering on cosine distance, cut where the
 * linkage distance passes the threshold (the nearest-neighbour chain
 * algorithm: quadratic time and memory).
 * @param similarity - the pairwise similarity matrix of n items.
 * @param n - the number of items.
 * @param threshold - the largest cosine distance at which two clusters merge.
 * @returns a cluster label per item.
 */
export function agglomerate(similarity: Float32Array, n: number, threshold: number): number[] {
  const distance = new Float64Array(n * n)
  for (let index = 0; index < n * n; index++) distance[index] = 1 - (similarity[index] as number)
  const size = new Array<number>(n).fill(1)
  const active = new Set(Array.from({ length: n }, (_, index) => index))
  const merges: [number, number, number][] = []
  const chain: number[] = []
  while (active.size > 1) {
    if (chain.length === 0) chain.push(active.values().next().value as number)
    const a = chain.at(-1) as number
    const previous = chain.at(-2)
    let best = previous ?? -1, bestDistance = previous === undefined ? Infinity : distance[a * n + previous] as number
    for (const c of active) {
      if (c !== a && (distance[a * n + c] as number) < bestDistance) { best = c; bestDistance = distance[a * n + c] as number }
    }
    if (best !== previous) { chain.push(best); continue }
    chain.length -= 2
    merges.push([a, best, bestDistance])
    // Lance–Williams update for average linkage; the merged cluster keeps index a.
    for (const c of active) {
      if (c === a || c === best) continue
      const [sa, sb] = [size[a] as number, size[best] as number]
      const value = (sa * (distance[a * n + c] as number) + sb * (distance[best * n + c] as number)) / (sa + sb)
      distance[a * n + c] = value
      distance[c * n + a] = value
    }
    size[a] = (size[a] as number) + (size[best] as number)
    active.delete(best)
  }
  // Average linkage is monotone, so the merges below the threshold, in height order, are exactly the cut.
  const parent = Array.from({ length: n }, (_, index) => index)
  const find = (x: number): number => { while (parent[x] !== x) x = parent[x] = parent[parent[x] as number] as number; return x }
  for (const [a, b, height] of merges.sort((x, y) => x[2] - y[2])) if (height <= threshold) parent[find(b)] = find(a)
  return relabel(Array.from({ length: n }, (_, index) => find(index)))
}

/** Labels numbered 0, 1, 2 … in order of first appearance. */
function relabel(labels: readonly number[]): number[] {
  const seen = new Map<number, number>()
  return labels.map((label) => {
    if (!seen.has(label)) seen.set(label, seen.size)
    return seen.get(label) as number
  })
}

/**
 * Spherical k-means on unit vectors with a seeded k-means++ start, so the same
 * corpus always gives the same clusters.
 * @param vectors - unit-length sparse vectors.
 * @param k - the number of clusters.
 * @returns a cluster label per vector.
 */
export function kMeans(vectors: readonly SparseVector[], k: number): number[] {
  let seed = 0x9e3779b9
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const centres: SparseVector[] = [vectors[Math.floor(random() * vectors.length)] as SparseVector]
  while (centres.length < k) {
    const weights = vectors.map(vector => Math.max(0, 1 - Math.max(...centres.map(centre => cosine(vector, centre)))) ** 2)
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    if (total === 0) break
    let pick = random() * total, index = 0
    while (index < weights.length - 1 && pick >= (weights[index] as number)) pick -= weights[index++] as number
    centres.push(vectors[index] as SparseVector)
  }
  let labels: number[] = []
  for (let round = 0; round < 50; round++) {
    const next = vectors.map((vector) => {
      let best = 0, bestScore = -Infinity
      centres.forEach((centre, index) => {
        const score = cosine(vector, centre)
        if (score > bestScore) { best = index; bestScore = score }
      })
      return best
    })
    if (next.every((label, index) => label === labels[index])) break
    labels = next
    centres.forEach((_, index) => {
      const sum: SparseVector = new Map()
      vectors.forEach((vector, at) => {
        if (labels[at] !== index) return
        for (const [id, value] of vector) sum.set(id, (sum.get(id) ?? 0) + value)
      })
      // A centre that lost every member becomes empty and attracts nothing from then on.
      centres[index] = unit(sum)
    })
  }
  return relabel(labels)
}
