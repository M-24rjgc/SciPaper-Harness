/**
 * Image generation and reference figures, the drawing capability every mode
 * shares. Generation speaks the OpenAI Images API (gpt-image-2 by default):
 * text to image through `images/generations`, and — when the agent passes
 * reference images for style or layout — `images/edits`, falling back to text
 * only if the edit is refused. Providers that return images from chat
 * completions (OpenRouter-style) are reached with `apiStyle: chat`.
 * Reference figures are the architecture figures of published papers, taken
 * from ar5iv, which the agent studies before drawing its own.
 */
import { z } from 'zod'
import { errorText } from './files.ts'
import type { ImageBinding } from './types.ts'

/** What a fresh image configuration starts from; the person only adds the key. */
export const IMAGE_DEFAULTS = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2', size: '1536x1024', quality: 'high' } as const
export const imageQualities = ['low', 'medium', 'high', 'auto'] as const
export const imageBackgrounds = ['transparent', 'opaque', 'auto'] as const
const GENERATION_TIMEOUT_MS = 300_000
const DOWNLOAD_TIMEOUT_MS = 120_000

/** One image generation, as the tool asked for it. */
export interface ImageRequest {
  prompt: string
  size?: string | undefined
  quality?: typeof imageQualities[number] | undefined
  background?: typeof imageBackgrounds[number] | undefined
  /** Reference images sent with the prompt; their bytes and media types. */
  references: { name: string; type: string; bytes: Uint8Array }[]
}

/** A generated image and the endpoint that produced it. */
export interface GeneratedImage {
  bytes: Uint8Array
  via: 'generations' | 'edits' | 'chat'
  /** Why an edit with references fell back to text only, when it did. */
  note?: string | undefined
}

const imagesResponse = z.object({ data: z.array(z.object({ b64_json: z.string().optional(), url: z.url().optional() })).min(1) })
const chatResponse = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.unknown().optional(),
      images: z.array(z.object({ image_url: z.object({ url: z.string() }) })).optional(),
    }),
  })).min(1),
})

/**
 * Generate one image.
 * @param binding - the configured endpoint, model, default size and style.
 * @param key - the image API key.
 * @param request - prompt, overrides and reference images.
 * @param signal - cancellation of the call.
 * @param limit - byte ceiling for the image.
 * @returns the image bytes and how they were produced.
 */
export async function generateImage(
  binding: ImageBinding, key: string, request: ImageRequest, signal: AbortSignal, limit: number,
): Promise<GeneratedImage> {
  const base = binding.baseUrl.replace(/\/$/, '')
  const size = request.size ?? binding.size
  const quality = request.quality ?? binding.quality
  if (binding.apiStyle === 'chat') {
    const body = {
      model: binding.model,
      modalities: ['image', 'text'],
      messages: [{ role: 'user', content: `${request.prompt}\n\n(Render at approximately ${size} resolution.)` }],
    }
    const response = await post(`${base}/chat/completions`, key, JSON.stringify(body), 'application/json', signal)
    const message = chatResponse.parse(await response.json()).choices[0]?.message
    const url = message?.images?.[0]?.image_url.url ?? (typeof message?.content === 'string' && message.content.startsWith('data:image') ? message.content : undefined)
    if (url === undefined) throw new Error('The image provider returned no image')
    return { bytes: await imageBytes(url, signal, limit), via: 'chat' }
  }
  // gpt-image models always answer in base64 and take a quality; older models are asked for base64 explicitly.
  const gptImage = binding.model.startsWith('gpt-image')
  const options = {
    model: binding.model, prompt: request.prompt, n: 1, size,
    ...(gptImage ? { ...(quality === undefined ? {} : { quality }), ...(request.background === undefined ? {} : { background: request.background }) } : { response_format: 'b64_json' }),
  }
  let note: string | undefined
  if (request.references.length > 0) {
    const form = new FormData()
    for (const [name, value] of Object.entries(options)) form.append(name, String(value))
    const field = request.references.length > 1 ? 'image[]' : 'image'
    for (const reference of request.references) {
      form.append(field, new Blob([Uint8Array.from(reference.bytes)], { type: reference.type }), reference.name)
    }
    try {
      const response = await post(`${base}/images/edits`, key, form, undefined, signal)
      return { bytes: await firstImage(response, signal, limit), via: 'edits' }
    } catch (error) {
      signal.throwIfAborted()
      note = `the edit with reference images failed (${errorText(error)}); generated from the prompt alone`
    }
  }
  const response = await post(`${base}/images/generations`, key, JSON.stringify(options), 'application/json', signal)
  return { bytes: await firstImage(response, signal, limit), via: 'generations', ...(note === undefined ? {} : { note }) }
}

async function post(url: string, key: string, body: string | FormData, type: string | undefined, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(GENERATION_TIMEOUT_MS)]),
    headers: { Authorization: `Bearer ${key}`, ...(type === undefined ? {} : { 'Content-Type': type }) },
    body,
  })
  if (!response.ok) throw new Error(`Image provider returned HTTP ${response.status}`)
  return response
}

async function firstImage(response: Response, signal: AbortSignal, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length') ?? 0) > limit * 2) throw new Error('Generated image exceeds the configured size limit')
  const [first] = imagesResponse.parse(await response.json()).data
  if (first?.b64_json) return checked(Buffer.from(first.b64_json, 'base64'), limit)
  if (first?.url) return imageBytes(first.url, signal, limit)
  throw new Error('The image provider returned no image')
}

/** The bytes behind an image address: a data URI, or an HTTP(S) URL fetched with a size cap. */
async function imageBytes(url: string, signal: AbortSignal, limit: number): Promise<Uint8Array> {
  const data = /^data:image\/[\w.+-]+;base64,(.+)$/s.exec(url)
  if (data) return checked(Buffer.from(data[1] as string, 'base64'), limit)
  if (!/^https?:\/\//i.test(url)) throw new Error('The image provider returned an unusable image address')
  const download = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) })
  if (!download.ok) throw new Error('Generated image could not be retrieved')
  if (Number(download.headers.get('content-length') ?? 0) > limit) throw new Error('Generated image exceeds the configured size limit')
  return checked(new Uint8Array(await download.arrayBuffer()), limit)
}

function checked(bytes: Uint8Array, limit: number): Uint8Array {
  if (bytes.byteLength > limit) throw new Error('Generated image exceeds the configured size limit')
  return bytes
}

/** One figure taken from a paper's ar5iv rendering. */
export interface ReferenceFigure {
  arxivId: string
  caption: string
  extension: string
  bytes: Uint8Array
}

/** Captions of the figures worth copying the layout of: the method overview, not results. */
const OVERVIEW = /overall|framework|architecture|overview|pipeline|proposed|our (?:method|model|approach)/i
const NOT_OVERVIEW = /result|ablation|qualitative|curve|t-?sne|comparison of|visuali[sz]ation|accuracy|loss/i
const MAX_PER_PAPER = 2

/**
 * The overview figures of published papers, from their ar5iv renderings.
 * @param arxivIds - new-style arXiv identifiers (at most six).
 * @param signal - cancellation of the call.
 * @param limit - byte ceiling for each image.
 * @returns up to two figures per paper, with the reason any paper yielded none.
 */
export async function fetchReferenceFigures(
  arxivIds: string[], signal: AbortSignal, limit: number,
): Promise<{ figures: ReferenceFigure[]; skipped: string[] }> {
  const figures: ReferenceFigure[] = []
  const skipped: string[] = []
  for (const arxivId of arxivIds) {
    const page = `https://ar5iv.labs.arxiv.org/html/${arxivId}`
    let html: string
    try {
      const response = await fetch(page, { signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) })
      if (!response.ok) { skipped.push(`${arxivId}: ar5iv returned HTTP ${response.status}`); continue }
      html = await response.text()
    } catch (error) {
      signal.throwIfAborted()
      skipped.push(`${arxivId}: ${errorText(error)}`)
      continue
    }
    let taken = 0
    for (const figure of html.matchAll(/<figure\b[\s\S]*?<\/figure>/gi)) {
      if (taken >= MAX_PER_PAPER) break
      const caption = plainText(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(figure[0])?.[1] ?? '')
      const source = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(figure[0])?.[1]
      if (!source || !OVERVIEW.test(caption) || NOT_OVERVIEW.test(caption)) continue
      const address = new URL(source, `${page}/`).href
      const extension = /\.(png|jpe?g|gif|webp|svg)(?:$|\?)/i.exec(address)?.[1]?.toLowerCase().replace('jpeg', 'jpg') ?? 'png'
      try {
        figures.push({ arxivId, caption, extension, bytes: await imageBytes(address, signal, limit) })
        taken++
      } catch (error) {
        signal.throwIfAborted()
        skipped.push(`${arxivId}: a figure could not be downloaded (${errorText(error)})`)
      }
    }
    if (taken === 0 && !skipped.some(line => line.startsWith(`${arxivId}:`))) skipped.push(`${arxivId}: no overview figure found`)
  }
  return { figures, skipped }
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
}
