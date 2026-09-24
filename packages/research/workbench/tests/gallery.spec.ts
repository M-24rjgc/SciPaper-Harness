import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeAsset } from '../src/components.ts'
import { FigureGallery } from '../src/gallery.ts'
import type { Embedder } from '../src/knowledge.ts'

const signal = new AbortController().signal
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
const source = { name: 'Gallery', repository: 'https://github.com/owner/gallery', commit: '0123456789abcdef', license: 'MIT' }

interface Figure {
  id: string
  venue?: string
  year?: number
  title?: string
  pattern?: string
  tier?: string
  award?: string
  score?: number
  image?: string
}
function figure(value: Figure): Record<string, unknown> {
  const venue = value.venue ?? 'neurips'
  return {
    venue, year: 2024, title: `Paper ${value.id}`, authors: ['Ada Lovelace'], pattern: 'architecture',
    paper: `https://papers.example/${value.id}`, image: `images/${venue}/final/${value.id}.jpg`, width: 800, height: 400, ...value,
  }
}

const FIGURES = [
  figure({ id: 'neurips2024-1', title: 'Sparse attention for long context', score: 50 }),
  figure({ id: 'neurips2024-2', title: 'Diffusion policies for robots', tier: 'oral', score: 40, pattern: 'pipeline' }),
  figure({ id: 'iclr2025-3', venue: 'iclr', year: 2025, title: 'Retrieval augmented agent memory', award: 'best', tier: 'oral', score: 10 }),
  figure({ id: 'icml2023-4', venue: 'icml', year: 2023, title: 'Graph transformers at scale', tier: 'spotlight', score: 70, pattern: 'framework' }),
  figure({ id: 'icml2023-5', venue: 'icml', year: 2023, title: 'Graph neural diffusion', tier: 'spotlight', score: 70, image: 'images/icml/final/icml2023-5.jpeg' }),
  figure({ id: 'acl2024-6', venue: 'acl', title: 'Sparse retrieval for question answering', image: 'images/acl/final/acl2024-6.png' }),
  figure({ id: 'acl2024-7', venue: 'acl', title: 'Agent benchmarks', award: 'honorable', image: 'images/acl/final/acl2024-7.webp' }),
  figure({ id: 'aaai2024-8', venue: 'aaai', title: 'Robot memory', score: 50 }),
  figure({ id: 'aaai2024-9', venue: 'aaai', title: 'Robot planning', score: 50 }),
]

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'gallery-')) })
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) })

async function gallery(figures = FIGURES): Promise<FigureGallery> {
  await writeFile(join(root, 'index.json.gz'), gzipSync(JSON.stringify({ source, figures })))
  return new FigureGallery(join(root, 'index.json.gz'), join(root, 'cache'))
}

/** An embedder that places each text on an axis by the words it names. */
function embedder(calls: string[][] = []): Embedder {
  const axes = ['memory', 'robot', 'graph']
  return {
    model: 'toy',
    async embed(texts) {
      calls.push(texts)
      return texts.map(text => Float32Array.from(axes.map(axis => (text.toLowerCase().includes(axis) ? 1 : 0.01))))
    },
  }
}

describe('figure gallery search', () => {
  it('browses the most prominent figures first, with facets, filters and pages', async () => {
    const shelf = await gallery()
    const page = await shelf.search({}, undefined, signal)
    expect(page.basis).toBe('browse')
    expect(page.total).toBe(9)
    // Awards, then Oral, then Spotlight; then design score, year and id.
    expect(page.figures.map(item => item.id)).toEqual([
      'iclr2025-3', 'acl2024-7', 'neurips2024-2', 'icml2023-4', 'icml2023-5', 'aaai2024-8', 'aaai2024-9', 'neurips2024-1', 'acl2024-6',
    ])
    expect(page.figures[0]).not.toHaveProperty('image')
    expect(page.source).toEqual(source)
    expect(page.facets.tier).toEqual({ award: 2, oral: 1, spotlight: 2 })
    expect(page.facets.venue).toEqual({ neurips: 2, iclr: 1, icml: 2, acl: 2, aaai: 2 })
    expect(page.facets.year).toEqual({ 2023: 2, 2024: 6, 2025: 1 })
    expect(page.facets.pattern).toEqual({ architecture: 7, pipeline: 1, framework: 1 })

    const second = await shelf.search({ limit: 2, offset: 2 }, undefined, signal)
    expect([second.offset, second.figures.map(item => item.id)]).toEqual([2, ['neurips2024-2', 'icml2023-4']])
    expect((await shelf.search({ venue: 'ICML' }, undefined, signal)).figures.map(item => item.id)).toEqual(['icml2023-4', 'icml2023-5'])
    expect((await shelf.search({ year: 2025 }, undefined, signal)).total).toBe(1)
    expect((await shelf.search({ pattern: 'pipeline' }, undefined, signal)).figures.map(item => item.id)).toEqual(['neurips2024-2'])
    // An award outranks the Oral mark the same paper carries.
    expect((await shelf.search({ tier: 'award' }, undefined, signal)).figures.map(item => item.id)).toEqual(['iclr2025-3', 'acl2024-7'])
    expect((await shelf.search({ tier: 'oral' }, undefined, signal)).figures.map(item => item.id)).toEqual(['neurips2024-2'])
  })

  it('ranks titles, authors, venues and patterns for a query, inside the filters', async () => {
    const shelf = await gallery()
    const page = await shelf.search({ query: '  sparse retrieval ' }, undefined, signal)
    expect(page.basis).toBe('keyword')
    expect(page.figures[0]?.id).toBe('acl2024-6')
    expect(page.figures.map(item => item.id).sort()).toEqual(['acl2024-6', 'iclr2025-3', 'neurips2024-1'])
    expect((await shelf.search({ query: 'sparse', venue: 'acl' }, undefined, signal)).figures.map(item => item.id)).toEqual(['acl2024-6'])
    expect((await shelf.search({ query: 'lovelace pipeline' }, undefined, signal)).figures[0]?.id).toBe('neurips2024-2')
    expect((await shelf.search({ query: 'nothing matches' }, undefined, signal)).total).toBe(0)
  })

  it('fuses embeddings once the titles are embedded, computing them in the background', async () => {
    const calls: string[][] = []
    const toy = embedder(calls)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    // The titles wait at the gate, so the searches below arrive while they are being embedded.
    const gated: Embedder = { model: 'toy', embed: async (texts, given) => { if (texts.length > 1) await gate; return toy.embed(texts, given) } }
    const shelf = await gallery()
    expect((await shelf.search({ query: 'robot memory' }, gated, signal)).basis).toBe('keyword')
    expect((await shelf.search({ query: 'robot' }, gated, signal)).basis).toBe('keyword')
    release()
    await vi.waitFor(async () => {
      expect((await shelf.search({ query: 'recollection', pattern: 'architecture' }, gated, signal)).basis).toBe('semantic')
    })
    const semantic = await shelf.search({ query: 'memory' }, gated, signal)
    expect(semantic.basis).toBe('semantic')
    expect(semantic.figures.slice(0, 2).map(item => item.id).sort()).toEqual(['aaai2024-8', 'iclr2025-3'])
    expect(calls.filter(texts => texts.length === 9)).toHaveLength(1)
    expect(calls.at(-1)).toEqual(['memory'])

    // Another process reads the vectors back from the cache instead of embedding the titles again.
    const later: string[][] = []
    const reread = new FigureGallery(join(root, 'index.json.gz'), join(root, 'cache'))
    expect((await reread.search({ query: 'graph' }, embedder(later), signal)).basis).toBe('semantic')
    expect(later).toEqual([['graph']])
  })

  it('ignores a damaged vector cache and retries an embedding that failed', async () => {
    const shelf = await gallery()
    const embed = vi.fn(async (): Promise<Float32Array[]> => { throw new Error('endpoint down') })
    const failing: Embedder = { model: 'toy', embed }
    expect((await shelf.search({ query: 'robot' }, failing, signal)).basis).toBe('keyword')
    await vi.waitFor(async () => {
      await shelf.search({ query: 'robot' }, failing, signal)
      expect(embed).toHaveBeenCalledTimes(2)
    })

    await new FigureGallery(join(root, 'index.json.gz'), join(root, 'cache')).search({ query: 'robot' }, embedder(), signal)
    const cached = await vi.waitFor(async () => {
      const names = (await readdir(join(root, 'cache'))).filter(name => name.endsWith('.f32'))
      expect(names).toHaveLength(1)
      return join(root, 'cache', names[0] as string)
    })
    // Too short to hold a dimension, then a length that does not match the gallery: neither is used.
    const stalled: Embedder = { model: 'toy', embed: () => new Promise(() => {}) }
    for (const damage of [Buffer.alloc(2), Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.alloc(12)])]) {
      await writeFile(cached, damage)
      const fresh = new FigureGallery(join(root, 'index.json.gz'), join(root, 'cache'))
      expect((await fresh.search({ query: 'robot' }, stalled, signal)).basis).toBe('keyword')
    }
  })

  it('stops embedding when disposed', async () => {
    const shelf = await gallery()
    const seen: AbortSignal[] = []
    const slow: Embedder = {
      model: 'slow',
      embed: (_texts, given) => new Promise((_resolve, reject) => { seen.push(given); given.addEventListener('abort', () => { reject(new Error('aborted')) }) }),
    }
    await shelf.search({ query: 'robot' }, slow, signal)
    shelf.dispose()
    expect(seen[0]?.aborted).toBe(true)
  })

  it('refuses an index that repeats an id, and retries a load that failed', async () => {
    const repeated = await gallery([...FIGURES, FIGURES[0] as Record<string, unknown>])
    await expect(repeated.search({}, undefined, signal)).rejects.toThrow(/repeats a figure id/)
    const missing = new FigureGallery(join(root, 'absent.json.gz'), join(root, 'cache'))
    await expect(missing.search({}, undefined, signal)).rejects.toThrow()
    await writeFile(join(root, 'absent.json.gz'), gzipSync(JSON.stringify({ source, figures: FIGURES })))
    expect((await missing.search({}, undefined, signal)).total).toBe(9)
  })

  it('reads the index the package ships', async () => {
    const shipped = new FigureGallery(runtimeAsset('figure-gallery/index.json.gz'), join(root, 'cache'))
    const page = await shipped.search({ query: 'diffusion', pattern: 'architecture', limit: 3 }, undefined, signal)
    expect(page.source.repository).toBe('https://github.com/qwdwqfwq/topconf-paper-figure-gallery')
    expect(Object.values(page.facets.venue).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(3000)
    expect(page.figures).toHaveLength(3)
    expect(page.figures.every(item => item.pattern === 'architecture')).toBe(true)
  })
})

describe('figure gallery images', () => {
  /** Answer fetch calls in order; each answer is a Response factory or an error to throw. */
  function script(answers: (() => Response)[]): string[] {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      const answer = answers.shift()
      if (!answer) throw new Error(`unexpected fetch ${url}`)
      return answer()
    }))
    return urls
  }
  const ok = (bytes: Uint8Array) => () => new Response(Uint8Array.from(bytes))
  const status = (code: number) => () => new Response('no', { status: code })

  it('fetches a figure once from the first mirror that serves an image, then reads the cache', async () => {
    const shelf = await gallery()
    const urls = script([status(503), ok(Buffer.from('<html>')), ok(JPEG)])
    const [a, b] = await Promise.all([shelf.image('neurips2024-1', signal, 1000), shelf.image('neurips2024-1', signal, 1000)])
    expect(urls).toEqual([
      'https://raw.githubusercontent.com/owner/gallery/main/images/neurips/final/neurips2024-1.jpg',
      'https://cdn.jsdelivr.net/gh/owner/gallery@main/images/neurips/final/neurips2024-1.jpg',
      'https://owner.github.io/gallery/images/neurips/final/neurips2024-1.jpg',
    ])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ extension: 'jpg', source, figure: { id: 'neurips2024-1', title: 'Sparse attention for long context' } })
    expect(await readFile(a.file)).toEqual(JPEG)
    script([])
    expect((await shelf.image('neurips2024-1', signal, 1000)).file).toBe(a.file)
  })

  it('names the file after the image type and accepts PNG and WebP', async () => {
    const shelf = await gallery()
    script([ok(JPEG), ok(PNG), ok(WEBP)])
    expect((await shelf.image('icml2023-5', signal, 1000)).extension).toBe('jpg')
    expect((await shelf.image('acl2024-6', signal, 1000)).file).toMatch(/acl2024-6\.png$/)
    expect((await shelf.image('acl2024-7', signal, 1000)).file).toMatch(/acl2024-7\.webp$/)
  })

  it('reports why a figure could not be fetched', async () => {
    const shelf = await gallery()
    await expect(shelf.image('neurips2099-0', signal, 1000)).rejects.toThrow(/no figure neurips2099-0/)
    script([status(404), status(404), status(404)])
    await expect(shelf.image('neurips2024-1', signal, 1000)).rejects.toThrow(/no longer in the gallery/)
    const riff = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])
    script([() => { throw new Error('offline') }, ok(Buffer.alloc(2000)), ok(riff)])
    const failure = 'could not be fetched (raw.githubusercontent.com: offline; cdn.jsdelivr.net: larger than the size limit; owner.github.io: not an image)'
    await expect(shelf.image('neurips2024-1', signal, 1000)).rejects.toThrow(failure)
    const aborted = new AbortController()
    script([() => { aborted.abort(); throw new Error('cancelled') }])
    await expect(shelf.image('neurips2024-1', aborted.signal, 1000)).rejects.toThrow()
  })
})
