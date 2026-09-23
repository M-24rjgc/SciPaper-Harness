import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadPdf, openAccessPdf, searchLiterature, verifyLiterature } from '../src/literature.ts'
import type { LiteratureItem } from '../src/types.ts'

const signal = new AbortController().signal
afterEach(() => { vi.unstubAllGlobals() })

/** Answer each request by the first route whose prefix the URL starts with. */
function serve(routes: Record<string, () => Response>): string[] {
  const requested: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requested.push(url)
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    return route ? route[1]() : new Response('missing', { status: 404 })
  }))
  return requested
}
const json = (value: unknown) => () => new Response(JSON.stringify(value))
const xml = (value: string) => () => new Response(value)

const crossrefWork = {
  DOI: '10.1234/x', title: ['A <i>tagged</i>   title'], author: [{ given: 'Ada', family: 'Lovelace' }, { family: 'Solo' }],
  published: { 'date-parts': [[2024, 5]] }, abstract: '<p>Abstract & more</p>',
}
const item: LiteratureItem = { id: '10.1234/x', provider: 'crossref', title: 'T', authors: [], doi: '10.1234/x', url: 'https://doi.org/10.1234/x', abstract: '', bibtex: '' }

describe('scholarly metadata comes from the providers, never from the model', () => {
  it('searches Crossref and OpenAlex and writes BibTeX from what they return', async () => {
    const requested = serve({
      'https://api.crossref.org/works?': json({ message: { items: [crossrefWork, { DOI: '10.2/y' }] } }),
      'https://api.openalex.org/works?': json({ results: [
        { id: 'https://openalex.org/W1', title: 'Open {work}', doi: 'https://doi.org/10.3/z', publication_year: 2023, authorships: [{ author: { display_name: 'B C' } }], abstract_inverted_index: { second: [1], first: [0], far: [60000] } },
        { id: 'https://openalex.org/W2', title: null, doi: null, publication_year: 2020, authorships: [] },
      ] }),
    })
    const [full, bare] = await searchLiterature('crossref', 'sparse & dense', signal)
    expect(requested[0]).toContain('query.bibliographic=sparse%20%26%20dense')
    expect(full).toMatchObject({ title: 'A tagged title', authors: ['Ada Lovelace', 'Solo'], year: 2024, abstract: 'Abstract & more', url: 'https://doi.org/10.1234/x' })
    expect(full?.bibtex).toContain('@article{crossref_10_1234_x,')
    expect(full?.bibtex).toContain('  year={2024},\n  doi={10.1234/x},')
    expect(bare).toMatchObject({ title: '', authors: [], abstract: '' })
    expect(bare?.bibtex).not.toContain('year=')
    const [open, untitled] = await searchLiterature('openalex', 'q', signal)
    expect(open).toMatchObject({ title: 'Open {work}', doi: '10.3/z', abstract: 'first second', url: 'https://doi.org/10.3/z' })
    expect(open?.bibtex).toContain('title={Open work}')
    expect(untitled).toMatchObject({ title: '', url: 'https://openalex.org/W2', abstract: '' })
    expect(untitled && 'doi' in untitled).toBe(false)
  })

  it('reads arXiv feeds with one, many or no entries and authors', async () => {
    const entry = (id: string, authors: string) => `<entry><id>http://arxiv.org/abs/${id}</id><title>Title ${id}</title>${authors}</entry>`
    serve({
      'https://export.arxiv.org/api/query?search_query=all:one': xml(`<feed>${entry('1', '<author><name>Solo</name></author><published>2021-01-01</published><summary> S </summary>')}</feed>`),
      'https://export.arxiv.org/api/query?search_query=all:many': xml(`<feed>${entry('2', '<author><name>A</name></author><author><name>B</name></author>')}${entry('3', '')}</feed>`),
      'https://export.arxiv.org/api/query?search_query=all:none': xml('<feed><title>ArXiv Query</title></feed>'),
    })
    const [one] = await searchLiterature('arxiv', 'one', signal)
    expect(one).toMatchObject({ authors: ['Solo'], year: 2021, abstract: 'S', url: 'https://arxiv.org/abs/1' })
    const many = await searchLiterature('arxiv', 'many', signal)
    expect(many.map(result => result.authors)).toEqual([['A', 'B'], []])
    expect(many[1] && 'year' in many[1]).toBe(false)
    expect(await searchLiterature('arxiv', 'none', signal)).toEqual([])
  })

  it('verifies an imported citation by its identifier and refuses what cannot be verified', async () => {
    serve({
      'https://api.crossref.org/works/10.1234%2Fx': json({ message: crossrefWork }),
      'https://api.openalex.org/works/W7': json({ id: 'https://openalex.org/W7', title: 'Seven', doi: null, publication_year: 2022, authorships: [] }),
      'https://export.arxiv.org/api/query?id_list=2401.00001': xml('<feed><entry><id>http://arxiv.org/abs/2401.00001</id><title>Found</title></entry></feed>'),
      'https://export.arxiv.org/api/query?id_list=9999.99999': xml('<feed><title>ArXiv Query</title></feed>'),
    })
    expect((await verifyLiterature(item, signal)).title).toBe('A tagged title')
    expect((await verifyLiterature({ ...item, doi: undefined, provider: 'openalex', id: 'https://openalex.org/W7' }, signal)).title).toBe('Seven')
    const arxiv = { ...item, doi: undefined, provider: 'arxiv' as const }
    expect((await verifyLiterature({ ...arxiv, id: 'https://arxiv.org/abs/2401.00001' }, signal)).title).toBe('Found')
    await expect(verifyLiterature({ ...arxiv, id: 'https://arxiv.org/abs/9999.99999' }, signal)).rejects.toThrow(/could not be verified/)
    await expect(verifyLiterature({ ...arxiv, id: 'bad id?' }, signal)).rejects.toThrow(/Invalid arXiv/)
    await expect(verifyLiterature({ ...item, doi: undefined, provider: 'openalex', id: 'not-a-work' }, signal)).rejects.toThrow(/could not be verified/)
    await expect(verifyLiterature({ ...item, doi: '10.9999/missing' }, signal)).rejects.toThrow(/HTTP 404/)
  })
})

describe('open-access full text is located without identifying the user', () => {
  it('uses arXiv PDFs directly and asks OpenAlex for the best open location otherwise', async () => {
    const requested = serve({
      'https://api.openalex.org/works/doi:10.1234/x': json({ best_oa_location: { pdf_url: 'https://oa.example/x.pdf' } }),
      'https://api.openalex.org/works/doi:10.2345/insecure': json({ best_oa_location: { pdf_url: 'http://oa.example/y.pdf' } }),
      'https://api.openalex.org/works/doi:10.3456/closed': json({ best_oa_location: null }),
      'https://api.openalex.org/works/W5': json({ best_oa_location: { pdf_url: null } }),
    })
    expect(await openAccessPdf({ ...item, provider: 'arxiv', url: 'https://arxiv.org/abs/2401.00001v2' }, signal)).toBe('https://arxiv.org/pdf/2401.00001v2')
    expect(await openAccessPdf(item, signal)).toBe('https://oa.example/x.pdf')
    expect(await openAccessPdf({ ...item, doi: '10.2345/insecure' }, signal)).toBeUndefined()
    expect(await openAccessPdf({ ...item, doi: '10.3456/closed' }, signal)).toBeUndefined()
    expect(await openAccessPdf({ ...item, doi: undefined, provider: 'openalex', id: 'https://openalex.org/W5' }, signal)).toBeUndefined()
    expect(await openAccessPdf({ ...item, doi: '10.4567/<script>' }, signal)).toBeUndefined()
    expect(requested.every(url => !url.includes('@') && !url.includes('mailto'))).toBe(true)
  })

  it('downloads only a PDF within the size limit', async () => {
    serve({
      'https://oa.example/ok.pdf': () => new Response('%PDF-1.7 body'),
      'https://oa.example/declared.pdf': () => new Response('%PDF-', { headers: { 'content-length': '999' } }),
      'https://oa.example/large.pdf': () => new Response(`%PDF-${'x'.repeat(100)}`),
      'https://oa.example/landing': () => new Response('<html>'),
    })
    expect(Buffer.from(await downloadPdf('https://oa.example/ok.pdf', signal, 100)).toString()).toBe('%PDF-1.7 body')
    await expect(downloadPdf('https://oa.example/declared.pdf', signal, 100)).rejects.toThrow(/size limit/)
    await expect(downloadPdf('https://oa.example/large.pdf', signal, 100)).rejects.toThrow(/size limit/)
    await expect(downloadPdf('https://oa.example/landing', signal, 100)).rejects.toThrow(/did not return a PDF/)
  })
})
