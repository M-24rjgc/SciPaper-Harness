import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchReferenceFigures, generateImage, IMAGE_DEFAULTS } from '../src/images.ts'
import type { ImageBinding } from '../src/types.ts'

afterEach(() => { vi.unstubAllGlobals() })

const signal = new AbortController().signal
const PNG = Buffer.from('png-bytes')
const b64 = PNG.toString('base64')

interface Call { url: string; init?: RequestInit | undefined }

/** Answer fetch calls in order; each answer is a Response factory or an error to throw. */
function script(answers: ((call: Call) => Response | Promise<Response>)[]): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const call = { url, init }
    calls.push(call)
    const answer = answers.shift()
    if (!answer) throw new Error(`unexpected fetch ${url}`)
    return answer(call)
  })
  return calls
}
const json = (value: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(value), { status: 200, headers })
const status = (code: number) => () => new Response('no', { status: code })
const bytes = (value: Uint8Array, headers: Record<string, string> = {}) => () =>
  new Response(Uint8Array.from(value), { status: 200, headers })
const binding: ImageBinding = { ...IMAGE_DEFAULTS }
/** The JSON body a call sent. */
const sent = (call?: Call): Record<string, unknown> => JSON.parse(call?.init?.body as string) as Record<string, unknown>
const request = { prompt: 'A pipeline diagram', references: [] }

describe('image generation', () => {
  it('asks gpt-image models for the size and quality, and decodes base64', async () => {
    const calls = script([json({ data: [{ b64_json: b64 }] })])
    const image = await generateImage(binding, 'key', { ...request, background: 'transparent' }, signal, 1000)
    expect(Buffer.from(image.bytes).toString()).toBe('png-bytes')
    expect(image).toMatchObject({ via: 'generations' })
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/images/generations')
    expect(sent(calls[0])).toEqual({ model: 'gpt-image-2', prompt: 'A pipeline diagram', n: 1, size: '1536x1024', quality: 'high', background: 'transparent' })
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer key')
  })

  it('asks other models for base64 and follows a returned URL', async () => {
    const calls = script([json({ data: [{ url: 'https://img.example/a.png' }] }), bytes(PNG)])
    const image = await generateImage({ baseUrl: 'https://img.example/v1/', model: 'dall-e-3', size: '1024x1024' }, 'k', { ...request, size: '1792x1024' }, signal, 1000)
    expect(sent(calls[0])).toEqual({ model: 'dall-e-3', prompt: 'A pipeline diagram', n: 1, size: '1792x1024', response_format: 'b64_json' })
    expect(calls[1]?.url).toBe('https://img.example/a.png')
    expect(image.bytes.byteLength).toBe(PNG.byteLength)
  })

  it('sends reference images to the edits endpoint, and falls back to text when the edit is refused', async () => {
    const reference = { name: 'ref.png', type: 'image/png', bytes: PNG }
    const edits = script([json({ data: [{ b64_json: b64 }] })])
    const edited = await generateImage({ ...binding, quality: undefined }, 'k', { ...request, quality: 'low', references: [reference] }, signal, 1000)
    expect(edited.via).toBe('edits')
    expect(edits[0]?.url).toBe('https://api.openai.com/v1/images/edits')
    const form = edits[0]?.init?.body as FormData
    expect([form.get('model'), form.get('quality'), form.get('n'), (form.get('image') as File).name]).toEqual(['gpt-image-2', 'low', '1', 'ref.png'])

    const fallback = script([status(400), json({ data: [{ b64_json: b64 }] })])
    const plain = await generateImage({ ...binding, quality: undefined }, 'k', { ...request, references: [reference, { ...reference, name: 'b.png' }] }, signal, 1000)
    expect((fallback[0]?.init?.body as FormData).getAll('image[]')).toHaveLength(2)
    expect(plain.via).toBe('generations')
    expect(plain.note).toMatch(/edit with reference images failed \(Image provider returned HTTP 400\)/)
    expect(sent(fallback[1])).not.toHaveProperty('quality')

    const aborted = new AbortController()
    script([() => { aborted.abort(); throw new Error('network down') }])
    await expect(generateImage(binding, 'k', { ...request, references: [reference] }, aborted.signal, 1000)).rejects.toThrow()
  })

  it('reads images from chat completions for providers that answer there', async () => {
    const chat: ImageBinding = { ...binding, apiStyle: 'chat', model: 'google/gemini-image' }
    const calls = script([json({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${b64}` } }] } }] })])
    expect((await generateImage(chat, 'k', request, signal, 1000)).via).toBe('chat')
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect((sent(calls[0]).messages as { content: string }[])[0]?.content).toMatch(/approximately 1536x1024 resolution/)
    script([json({ choices: [{ message: { content: `data:image/webp;base64,${b64}` } }] })])
    expect((await generateImage(chat, 'k', request, signal, 1000)).bytes.byteLength).toBe(PNG.byteLength)
    script([json({ choices: [{ message: { content: [{ type: 'text', text: 'sorry' }] } }] })])
    await expect(generateImage(chat, 'k', request, signal, 1000)).rejects.toThrow('The image provider returned no image')
    script([json({ choices: [{ message: { images: [{ image_url: { url: 'ftp://x/y.png' } }] } }] })])
    await expect(generateImage(chat, 'k', request, signal, 1000)).rejects.toThrow(/unusable image address/)
  })

  it('refuses errors, empty answers and images over the size limit', async () => {
    script([status(500)])
    await expect(generateImage(binding, 'k', request, signal, 1000)).rejects.toThrow('HTTP 500')
    script([json({ data: [{}] })])
    await expect(generateImage(binding, 'k', request, signal, 1000)).rejects.toThrow('returned no image')
    script([json({ data: [{ b64_json: b64 }] }, { 'content-length': '99999' })])
    await expect(generateImage(binding, 'k', request, signal, 10)).rejects.toThrow(/size limit/)
    script([json({ data: [{ b64_json: b64 }] })])
    await expect(generateImage(binding, 'k', request, signal, 3)).rejects.toThrow(/size limit/)
    script([json({ data: [{ url: 'https://img.example/a.png' }] }), status(404)])
    await expect(generateImage(binding, 'k', request, signal, 1000)).rejects.toThrow('could not be retrieved')
    script([json({ data: [{ url: 'https://img.example/a.png' }] }), bytes(PNG, { 'content-length': '5000' })])
    await expect(generateImage(binding, 'k', request, signal, 1000)).rejects.toThrow(/size limit/)
  })
})

const FIGURES = `
<figure><img src="uncaptioned.png"></figure>
<figure id="S1.F1"><img src="/html/1706.03762/assets/Figures/ModalNet-21.png" alt=""><figcaption>Figure 1: The Transformer - model &amp; architecture.</figcaption></figure>
<figure><img src="x/results.png"><figcaption>Figure 2: Results on WMT.</figcaption></figure>
<figure><figcaption>Figure 3: Overview without an image.</figcaption></figure>
<figure><img src="https://cdn.example/render?id=4"><figcaption>Figure 4: Overview of the pipeline.</figcaption></figure>
<figure><img src="https://cdn.example/third.png"><figcaption>Figure 5: Our method overview, again.</figcaption></figure>
`

describe('reference figures', () => {
  it('takes up to two overview figures per paper and says why a paper gave none', async () => {
    const calls = script([
      () => new Response(FIGURES, { status: 200 }), bytes(PNG), bytes(PNG),
      status(404),
      () => new Response('<figure><img src="a.JPEG"><figcaption>Framework</figcaption></figure>', { status: 200 }), status(500),
      () => new Response('<p>no figures</p>', { status: 200 }),
      () => { throw new Error('offline') },
    ])
    const { figures, skipped } = await fetchReferenceFigures(['1706.03762', '2101.00001', '2102.00002', '2103.00003', '2104.00004'], signal, 1000)
    expect(calls[0]?.url).toBe('https://ar5iv.labs.arxiv.org/html/1706.03762')
    expect(calls[1]?.url).toBe('https://ar5iv.labs.arxiv.org/html/1706.03762/assets/Figures/ModalNet-21.png')
    expect(calls[2]?.url).toBe('https://cdn.example/render?id=4')
    // An address without a file extension is saved as PNG.
    expect(figures.map(figure => [figure.arxivId, figure.extension, figure.caption])).toEqual([
      ['1706.03762', 'png', 'Figure 1: The Transformer - model & architecture.'],
      ['1706.03762', 'png', 'Figure 4: Overview of the pipeline.'],
    ])
    expect(skipped).toEqual([
      '2101.00001: ar5iv returned HTTP 404',
      '2102.00002: a figure could not be downloaded (Generated image could not be retrieved)',
      '2103.00003: no overview figure found',
      '2104.00004: offline',
    ])
  })

  it('stops when cancelled instead of reporting the paper as skipped', async () => {
    const aborted = new AbortController()
    script([() => { aborted.abort(); throw new Error('cancelled') }])
    await expect(fetchReferenceFigures(['1706.03762'], aborted.signal, 1000)).rejects.toThrow()
    const again = new AbortController()
    script([() => new Response(FIGURES, { status: 200 }), () => { again.abort(); throw new Error('cancelled') }])
    await expect(fetchReferenceFigures(['1706.03762'], again.signal, 1000)).rejects.toThrow()
  })
})
