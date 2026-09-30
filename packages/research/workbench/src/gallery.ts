/**
 * The figure gallery every mode shares: hand-reviewed Figure 1 and teaser
 * figures of ICLR, ICML, NeurIPS, CVPR, ACL and AAAI papers (Top-Conf Figure
 * Gallery), to study before drawing a method or overview figure. The package
 * ships only the index (runtime/figure-gallery, built by
 * scripts/build_figure_gallery.py). A figure is fetched from the gallery when
 * someone picks it and cached in the product home; each one keeps its paper's
 * copyright. Search ranks titles, authors, venues and patterns with BM25; with
 * an embedding endpoint it also ranks titles by embedding and fuses the two,
 * once the titles' vectors are cached (the first search computes them in the
 * background and is keyword-ranked).
 */
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import { Bm25, cosine, fuse, tokens } from './clustering.ts'
import { atomicWrite, errorText } from './files.ts'
import type { Embedder } from './knowledge.ts'
import { GALLERY_ID, type galleryTiers } from './schema.ts'
import type { GalleryFigure, GalleryPage, GallerySource } from './types.ts'

/** The figures the index names: a path inside the gallery's `images/` folder. */
const IMAGE_PATH = /^images\/[a-z]+\/[A-Za-z0-9_./-]+\.(?:jpg|jpeg|png|webp)$/
const DOWNLOAD_TIMEOUT_MS = 60_000
/** Figures a search returns when it names no limit. */
const DEFAULT_LIMIT = 12
/** Semantic hits fused with the keyword hits; the rest of the gallery is too far to help. */
const SEMANTIC_DEPTH = 200

const figureSchema = z.object({
  id: z.string().regex(GALLERY_ID), venue: z.string().min(1), year: z.number().int(), title: z.string().min(1),
  authors: z.array(z.string()), pattern: z.string().min(1), paper: z.string().min(1), pdf: z.string().optional(),
  image: z.string().regex(IMAGE_PATH), width: z.number().int(), height: z.number().int(),
  tier: z.enum(['oral', 'spotlight']).optional(), award: z.enum(['best', 'honorable']).optional(), score: z.number().optional(),
})
const indexSchema = z.object({
  source: z.object({
    name: z.string(), repository: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/), commit: z.string(), license: z.string(),
  }),
  figures: z.array(figureSchema).min(1),
})
type StoredFigure = z.infer<typeof figureSchema>

/** A gallery search as the tool or the panel asks for it. */
export interface GallerySearch {
  query?: string | undefined
  pattern?: string | undefined
  venue?: string | undefined
  year?: number | undefined
  tier?: typeof galleryTiers[number] | undefined
  limit?: number | undefined
  offset?: number | undefined
}

/** A figure's image as cached on disk. */
export interface GalleryImage {
  figure: GalleryFigure
  file: string
  extension: string
  source: GallerySource
}

interface Loaded {
  source: GallerySource
  figures: StoredFigure[]
  byId: Map<string, number>
  bm25: Bm25
  facets: GalleryPage['facets']
  /** Figure indexes from most to least prominent. */
  prominence: number[]
}

/** The tier a figure is filed under: an award outranks the Oral or Spotlight mark it may also carry. */
function tierOf(figure: StoredFigure): typeof galleryTiers[number] | undefined {
  return figure.award ? 'award' : figure.tier
}

const TIER_RANK: Record<string, number> = { award: 3, oral: 2, spotlight: 1 }

function count(values: readonly (string | number | undefined)[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) if (value !== undefined) counts[String(value)] = (counts[String(value)] ?? 0) + 1
  return counts
}

function load(bytes: Uint8Array): Loaded {
  const file = indexSchema.parse(JSON.parse(gunzipSync(bytes).toString('utf8')))
  const { figures } = file
  const byId = new Map(figures.map((figure, index) => [figure.id, index]))
  if (byId.size !== figures.length) throw new Error('The figure gallery index repeats a figure id')
  const rank = (figure: StoredFigure): number => TIER_RANK[tierOf(figure) ?? ''] ?? 0
  const prominence = figures.map((_, index) => index).sort((a, b) => {
    const x = figures[a] as StoredFigure, y = figures[b] as StoredFigure
    return rank(y) - rank(x) || (y.score ?? 0) - (x.score ?? 0) || y.year - x.year || x.id.localeCompare(y.id)
  })
  return {
    source: file.source, figures, byId, prominence,
    bm25: new Bm25(figures.map(figure => tokens(`${figure.title} ${figure.authors.join(' ')} ${figure.venue} ${figure.pattern}`))),
    facets: {
      venue: count(figures.map(figure => figure.venue)), year: count(figures.map(figure => figure.year)),
      pattern: count(figures.map(figure => figure.pattern)), tier: count(figures.map(tierOf)),
    },
  }
}

/** A figure as callers see it: everything but where the gallery keeps its image. */
function visible(figure: StoredFigure): GalleryFigure {
  const { image: _image, ...rest } = figure
  return rest
}

/** Whether bytes open as a JPEG, PNG or WebP image. */
function isImage(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 12))
  return head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    || (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP')
}

/** Where the gallery's images can be fetched: its repository, a CDN mirror of it, and its site. */
function mirrors(repository: string): string[] {
  const [owner, name] = repository.replace('https://github.com/', '').split('/') as [string, string]
  return [
    `https://raw.githubusercontent.com/${owner}/${name}/main/`,
    `https://cdn.jsdelivr.net/gh/${owner}/${name}@main/`,
    `https://${owner}.github.io/${name}/`,
  ]
}

/** The built-in figure gallery: search, and figures fetched on demand into a cache. */
export class FigureGallery {
  private loaded: Promise<Loaded> | undefined
  private readonly vectors = new Map<string, Float32Array[]>()
  private readonly warming = new Map<string, Promise<void>>()
  private readonly downloads = new Map<string, Promise<void>>()
  private readonly lifetime = new AbortController()

  /**
   * @param indexPath - the shipped index (runtime/figure-gallery/index.json.gz).
   * @param cacheRoot - where fetched figures and title embeddings are kept.
   */
  constructor(private readonly indexPath: string, private readonly cacheRoot: string) {}

  private index(): Promise<Loaded> {
    this.loaded ??= readFile(this.indexPath).then(load)
    // A failed load is retried on the next call instead of being cached.
    this.loaded.catch(() => { this.loaded = undefined })
    return this.loaded
  }

  /**
   * One page of figures: filters narrow the gallery, a query ranks what is
   * left, and without a query the most prominent figures come first.
   * @param search - the query, filters and page.
   * @param embedder - the configured embedding endpoint, when there is one.
   * @param signal - cancellation of the call.
   * @returns the page, with the gallery's facets and source.
   */
  async search(search: GallerySearch, embedder: Embedder | undefined, signal: AbortSignal): Promise<GalleryPage> {
    const loaded = await this.index()
    const { figures } = loaded
    const venue = search.venue?.toLowerCase()
    const pool = new Set(loaded.prominence.filter((index) => {
      const figure = figures[index] as StoredFigure
      return (venue === undefined || figure.venue === venue) && (search.year === undefined || figure.year === search.year)
        && (search.pattern === undefined || figure.pattern === search.pattern)
        && (search.tier === undefined || tierOf(figure) === search.tier)
    }))
    const query = search.query?.trim() ?? ''
    let order: number[]
    let basis: GalleryPage['basis'] = 'browse'
    if (query === '') order = [...pool]
    else {
      const lexical = loaded.bm25.rank(tokens(query), figures.length).map(hit => hit.index).filter(index => pool.has(index))
      const vectors = embedder && await this.titleVectors(embedder, loaded)
      if (embedder && vectors) {
        const [target] = await embedder.embed([query], signal) as [Float32Array]
        const semantic = [...pool].map(index => ({ index, score: cosine(target, vectors[index] as Float32Array) }))
          .sort((a, b) => b.score - a.score).slice(0, SEMANTIC_DEPTH).map(hit => hit.index)
        const fused = fuse([lexical.map(String), semantic.map(String)])
        order = [...fused].sort((a, b) => b[1] - a[1]).map(([key]) => Number(key))
        basis = 'semantic'
      } else {
        order = lexical
        basis = 'keyword'
        if (embedder) this.warm(embedder, loaded)
      }
    }
    const offset = search.offset ?? 0
    return {
      total: order.length, offset, basis, facets: loaded.facets, source: loaded.source,
      figures: order.slice(offset, offset + (search.limit ?? DEFAULT_LIMIT)).map(index => visible(figures[index] as StoredFigure)),
    }
  }

  private vectorFile(embedder: Embedder, loaded: Loaded): string {
    const model = createHash('sha256').update(embedder.model).digest('hex').slice(0, 16)
    return join(this.cacheRoot, `titles.${loaded.source.commit.slice(0, 12)}.${model}.f32`)
  }

  /** The titles' embeddings for this model, from memory or the cache; undefined until they have been computed. */
  private async titleVectors(embedder: Embedder, loaded: Loaded): Promise<Float32Array[] | undefined> {
    const known = this.vectors.get(embedder.model)
    if (known) return known
    let bytes: Buffer
    try { bytes = await readFile(this.vectorFile(embedder, loaded)) } catch { return undefined }
    const count = loaded.figures.length
    const dimension = bytes.byteLength >= 4 ? bytes.readUInt32LE(0) : 0
    if (dimension === 0 || bytes.byteLength !== 4 + count * dimension * 4) return undefined
    const all = new Float32Array(bytes.buffer.slice(bytes.byteOffset + 4, bytes.byteOffset + bytes.byteLength))
    const vectors = Array.from({ length: count }, (_, index) => all.subarray(index * dimension, (index + 1) * dimension))
    this.vectors.set(embedder.model, vectors)
    return vectors
  }

  /** Embed every title once per model, in the background; a failure is retried by the next search. */
  private warm(embedder: Embedder, loaded: Loaded): void {
    if (this.warming.has(embedder.model)) return
    const work = embedder.embed(loaded.figures.map(figure => figure.title), this.lifetime.signal).then(async (vectors) => {
      const dimension = (vectors[0] as Float32Array).length
      const body = Buffer.alloc(4 + vectors.length * dimension * 4)
      body.writeUInt32LE(dimension, 0)
      vectors.forEach((vector, index) => {
        Buffer.from(vector.buffer, vector.byteOffset, dimension * 4).copy(body, 4 + index * dimension * 4)
      })
      await atomicWrite(this.vectorFile(embedder, loaded), body)
      this.vectors.set(embedder.model, vectors)
    }).catch(() => {}).finally(() => { this.warming.delete(embedder.model) })
    this.warming.set(embedder.model, work)
  }

  /**
   * A figure's image, fetched from the gallery on first use and cached.
   * @param id - a gallery figure id.
   * @param signal - cancellation of the call.
   * @param limit - byte ceiling for the image.
   * @returns the figure, its cached file and the gallery it came from.
   */
  async image(id: string, signal: AbortSignal, limit: number): Promise<GalleryImage> {
    const loaded = await this.index()
    const at = loaded.byId.get(id)
    if (at === undefined) throw new Error(`The figure gallery has no figure ${id}`)
    const stored = loaded.figures[at] as StoredFigure
    const extension = extname(stored.image).slice(1).toLowerCase().replace('jpeg', 'jpg')
    const file = join(this.cacheRoot, 'images', `${id}.${extension}`)
    const cached = await access(file).then(() => true, () => false)
    if (!cached) {
      const pending = this.downloads.get(id)
        ?? this.download(stored, loaded.source.repository, file, signal, limit).finally(() => { this.downloads.delete(id) })
      this.downloads.set(id, pending)
      await pending
    }
    return { figure: visible(stored), file, extension, source: loaded.source }
  }

  private async download(figure: StoredFigure, repository: string, file: string, signal: AbortSignal, limit: number): Promise<void> {
    const failures: string[] = []
    for (const base of mirrors(repository)) {
      const host = new URL(base).host
      try {
        const response = await fetch(`${base}${figure.image}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) })
        if (!response.ok) { failures.push(`${host}: HTTP ${response.status}`); continue }
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength > limit) { failures.push(`${host}: larger than the size limit`); continue }
        if (!isImage(bytes)) { failures.push(`${host}: not an image`); continue }
        await atomicWrite(file, bytes)
        return
      } catch (error) {
        signal.throwIfAborted()
        failures.push(`${host}: ${errorText(error)}`)
      }
    }
    if (failures.every(failure => failure.endsWith('HTTP 404'))) throw new Error(`Figure ${figure.id} is no longer in the gallery`)
    throw new Error(`Figure ${figure.id} could not be fetched (${failures.join('; ')})`)
  }

  /** Stop computing title embeddings. */
  dispose(): void { this.lifetime.abort() }
}
