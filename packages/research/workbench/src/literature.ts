/** Scholarly metadata adapters; abstract coverage is kept distinct from full text. */
import { XMLParser } from 'fast-xml-parser'
import { z } from 'zod'
import type { LiteratureItem } from './types.ts'

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'', '&apos;': '\'' }
/** Provider text as plain text: markup removed (JATS <scp>, <i>, <p>), entities decoded, whitespace collapsed. */
const clean = (value: string): string => value
  .replace(/<[^>]*>/g, ' ')
  .replace(/&(?:amp|lt|gt|quot|#39|apos);/g, entity => ENTITIES[entity] as string)
  .replace(/\s+([:;,.?!])/g, '$1')
  .replace(/\s+/g, ' ')
  .trim()
const bib = (value: string): string => value.replace(/[{}]/g, '').replaceAll('&', '\\&')
const strings = z.array(z.string()).optional()
const crossrefWork = z.object({
  DOI: z.string(),
  type: z.string().optional(),
  title: strings,
  'container-title': strings,
  publisher: z.string().optional(),
  author: z.array(z.object({ given: z.string().optional(), family: z.string().optional() })).optional(),
  published: z.object({ 'date-parts': z.array(z.array(z.number())) }).optional(),
  URL: z.string().optional(),
  abstract: z.string().optional(),
})
const openalexWork = z.object({
  id: z.string(),
  title: z.string().nullable(),
  doi: z.string().nullable(),
  publication_year: z.number(),
  authorships: z.array(z.object({ author: z.object({ display_name: z.string() }) })),
  abstract_inverted_index: z.record(z.string(), z.array(z.number())).nullable().optional(),
  primary_location: z.object({
    source: z.object({ display_name: z.string(), type: z.string().nullable().optional() }).nullable().optional(),
  }).nullable().optional(),
})

/** Where a work appeared, as BibTeX states it: the entry type and the field that names the venue. */
interface Venue {
  type: 'article' | 'inproceedings' | 'misc'
  field: 'journal' | 'booktitle' | 'howpublished' | 'publisher'
  name: string
}

const openAccessWork = z.object({ best_oa_location: z.object({ pdf_url: z.string().nullable().optional() }).nullable().optional() })
const DOI = /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/

async function response(url: string, signal: AbortSignal, timeoutMs = 30000): Promise<Response> {
  const result = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    headers: { 'User-Agent': 'ResearchWorkbench/0.1 (scholarly metadata client)' },
  })
  if (!result.ok) throw new Error(`Literature provider returned HTTP ${result.status}`)
  return result
}

/**
 * BibTeX for a verified record. A work whose venue the provider names is an
 * article or a proceedings paper with its journal or book title; anything else
 * is a misc entry, so no entry claims a journal it does not have. The title is
 * braced twice so bibliography styles keep its capitals (SummaC, BART).
 */
function withBibtex(item: Omit<LiteratureItem, 'bibtex'>, venue?: Venue, eprint?: string): LiteratureItem {
  const key = `${item.provider}_${item.id.replace(/[^A-Za-z0-9]/g, '_')}`
  const lines = [
    `@${venue?.type ?? 'misc'}{${key},`,
    `  title={{${bib(item.title)}}},`,
    `  author={${item.authors.map(bib).join(' and ')}},`,
    ...(item.year ? [`  year={${item.year}},`] : []),
    ...(venue ? [`  ${venue.field}={${bib(venue.name)}},`] : []),
    ...(item.doi ? [`  doi={${bib(item.doi)}},`] : []),
    ...(eprint ? [`  eprint={${eprint}},`, '  archivePrefix={arXiv},'] : []),
    `  url={${item.url}}`,
    '}',
    '',
  ]
  return { ...item, bibtex: lines.join('\n') }
}

function crossrefVenue(value: z.infer<typeof crossrefWork>): Venue | undefined {
  const container = clean(value['container-title']?.[0] ?? '')
  if (!container) return value.publisher ? { type: 'misc', field: 'publisher', name: value.publisher } : undefined
  if (value.type === 'journal-article') return { type: 'article', field: 'journal', name: container }
  if (value.type === 'proceedings-article' || value.type === 'book-chapter') return { type: 'inproceedings', field: 'booktitle', name: container }
  return { type: 'misc', field: 'howpublished', name: container }
}

function fromCrossref(value: z.infer<typeof crossrefWork>): LiteratureItem {
  return withBibtex({
    id: value.DOI,
    provider: 'crossref',
    title: clean(value.title?.[0] ?? ''),
    authors: value.author?.map(a => [a.given, a.family].filter(Boolean).join(' ')) ?? [],
    year: value.published?.['date-parts'][0]?.[0],
    doi: value.DOI,
    url: `https://doi.org/${value.DOI}`,
    abstract: clean(value.abstract ?? ''),
  }, crossrefVenue(value))
}

function fromOpenalex(value: z.infer<typeof openalexWork>): LiteratureItem {
  const words: string[] = []
  for (const [word, positions] of Object.entries(value.abstract_inverted_index ?? {})) {
    for (const position of positions) if (position < 50000) words[position] = word
  }
  return withBibtex({
    id: value.id,
    provider: 'openalex',
    title: value.title ?? '',
    authors: value.authorships.map(a => a.author.display_name),
    year: value.publication_year,
    ...(value.doi ? { doi: value.doi.replace('https://doi.org/', '') } : {}),
    url: value.doi ?? value.id,
    abstract: words.join(' '),
  }, openalexVenue(value.primary_location?.source))
}

function openalexVenue(source: { display_name: string; type?: string | null | undefined } | null | undefined): Venue | undefined {
  if (!source) return undefined
  if (source.type === 'journal') return { type: 'article', field: 'journal', name: source.display_name }
  if (source.type === 'conference') return { type: 'inproceedings', field: 'booktitle', name: source.display_name }
  return { type: 'misc', field: 'howpublished', name: source.display_name }
}

function fromArxiv(xml: string): LiteratureItem[] {
  const parsed: unknown = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(xml)
  const entry = z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string().optional(),
    published: z.string().optional(),
    author: z.union([z.object({ name: z.string() }), z.array(z.object({ name: z.string() }))]).optional(),
  })
  const feed = z.object({ feed: z.object({ entry: z.union([entry, z.array(entry)]).optional() }) }).parse(parsed).feed
  const entries = feed.entry ? Array.isArray(feed.entry) ? feed.entry : [feed.entry] : []
  return entries.map((value) => {
    const eprint = value.id.replace(/^.*\/abs\//, '').replace(/v\d+$/, '')
    return withBibtex({
      id: value.id,
      provider: 'arxiv',
      title: clean(value.title),
      authors: (Array.isArray(value.author) ? value.author : value.author ? [value.author] : []).map(a => a.name),
      ...(value.published ? { year: Number(value.published.slice(0, 4)) } : {}),
      url: value.id.replace('http:', 'https:'),
      abstract: clean(value.summary ?? ''),
    }, { type: 'misc', field: 'howpublished', name: `arXiv preprint arXiv:${eprint}` }, eprint)
  })
}

/** Search one scholarly provider without requiring a paid search service. */
export async function searchLiterature(provider: LiteratureItem['provider'], query: string, signal: AbortSignal): Promise<LiteratureItem[]> {
  if (provider === 'crossref') {
    const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=10`
    const data: unknown = await (await response(url, signal)).json()
    return z.object({ message: z.object({ items: z.array(crossrefWork) }) }).parse(data).message.items.map(fromCrossref)
  }
  if (provider === 'openalex') {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=10`
    const data: unknown = await (await response(url, signal)).json()
    return z.object({ results: z.array(openalexWork) }).parse(data).results.map(fromOpenalex)
  }
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=10`
  return fromArxiv(await (await response(url, signal)).text())
}

/**
 * Fetch an imported citation again by identifier from the provider that
 * returned it; model-supplied metadata is not treated as verification. An
 * OpenAlex work is re-read from OpenAlex because its DOI may be one Crossref
 * does not hold (arXiv's DataCite DOIs).
 */
export async function verifyLiterature(item: LiteratureItem, signal: AbortSignal): Promise<LiteratureItem> {
  if (item.provider === 'openalex' && /^(https:\/\/openalex.org\/)?W\d+$/.test(item.id)) {
    const result: unknown = await (await response(`https://api.openalex.org/works/${item.id.split('/').at(-1)}`, signal)).json()
    return fromOpenalex(openalexWork.parse(result))
  }
  if (item.doi) {
    const result: unknown = await (await response(`https://api.crossref.org/works/${encodeURIComponent(item.doi)}`, signal)).json()
    return fromCrossref(z.object({ message: crossrefWork }).parse(result).message)
  }
  if (item.provider === 'arxiv') {
    const identifier = item.id.replace(/^.*\/abs\//, '')
    if (!/^[A-Za-z0-9./-]+$/.test(identifier)) throw new Error('Invalid arXiv identifier')
    const items = fromArxiv(await (await response(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(identifier)}`, signal)).text())
    if (items[0]) return items[0]
  }
  throw new Error('This citation could not be verified by its provider identifier')
}

/**
 * Locate an open-access PDF for a verified reference: arXiv's own, else the
 * best open location OpenAlex records for its DOI or work. No email-based
 * service is asked, so nothing identifying the user leaves the machine.
 * @returns the PDF's HTTPS URL, or undefined when no open copy is known.
 */
export async function openAccessPdf(item: LiteratureItem, signal: AbortSignal): Promise<string | undefined> {
  if (item.provider === 'arxiv') return item.url.replace('/abs/', '/pdf/')
  if (item.doi !== undefined && !DOI.test(item.doi)) return undefined
  const work = item.doi === undefined ? item.id.replace('https://openalex.org/', '') : `doi:${item.doi}`
  const data: unknown = await (await response(`https://api.openalex.org/works/${work}`, signal)).json()
  const url = openAccessWork.parse(data).best_oa_location?.pdf_url
  return url?.startsWith('https://') ? url : undefined
}

/**
 * Download an open-access PDF within the source size ceiling.
 * @throws when the response is too large or is not a PDF.
 */
export async function downloadPdf(url: string, signal: AbortSignal, limit: number): Promise<Uint8Array> {
  const result = await response(url, signal, 120000)
  if (Number(result.headers.get('content-length') ?? 0) > limit) throw new Error('The open-access PDF exceeds the source size limit')
  const bytes = new Uint8Array(await result.arrayBuffer())
  if (bytes.byteLength > limit) throw new Error('The open-access PDF exceeds the source size limit')
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new Error('The open-access location did not return a PDF')
  return bytes
}
