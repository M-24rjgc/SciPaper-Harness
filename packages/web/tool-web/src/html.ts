/** Fixed HTML presentation with an owned, bounded Worker for complete fetch conversion. */
import type converterAsset from '../assets/html-converter.cjs'
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { WebError, type WebFetchBody } from '@deepseek-ai/dsh-web'

/** Converted markdown and whether a source or retained-text limit removed later content. */
interface RenderedBody { text: string; sourceTruncated: boolean }
const MAX_HTML_INPUT_CHARS = 2_000_000
const MAX_HTML_OUTPUT_CHARS = 8_000_000
// Resolve at execution time: tsc's lib/types input is bundled into lib/index.js,
// while source, bundled and installed entries all own the sibling assets directory.
const converter = createRequire(import.meta.url)(fileURLToPath(new URL('../assets/html-converter.cjs', import.meta.url))) as typeof converterAsset
const htmlConverter = converter.createHtmlConverter(TurndownService, gfm)

/**
 * Legacy synchronous formatting stays bounded by its caller's output cap. Live fetches use renderFetchBody.
 * @param body - decoded HTML or text supplied by a fetch provider.
 * @param maxInputChars - maximum source-prefix characters converted synchronously.
 * @returns converted markdown and whether the source prefix was cut.
 */
export function renderBody(body: WebFetchBody, maxInputChars: number): RenderedBody {
  if (body.kind === 'html') return htmlConverter.renderHtml(body.content, maxInputChars)
  const text = body.content.slice(0, maxInputChars)
  return { text, sourceTruncated: text.length !== body.content.length }
}

/**
 * Convert a fetch body with the remaining tool-call budget. HTML owns an isolated Worker with a
 * 256 MiB V8 old-generation heap ceiling (not an OS sandbox). It receives only a bounded HTML
 * prefix, uses fixed local parser dependencies, and cannot inherit credentials or Node options.
 * Cancellation/timeout terminates and joins the Worker before this operation settles, including
 * during synchronous DOM parsing. String entry paths also initialize the SEA snapshot filesystem;
 * relative package assets work from source, bundled lib and Desktop ASAR installations.
 * @param body - decoded HTML or text supplied by a fetch provider.
 * @param signal - caller cancellation, including any outer tool deadline.
 * @param remainingMs - time remaining from fetch start to the configured tool deadline.
 * @returns converted text and whether an input or retained-output limit cut the source.
 */
export async function renderFetchBody(body: WebFetchBody, signal: AbortSignal, remainingMs: number): Promise<RenderedBody> {
  signal.throwIfAborted()
  if (remainingMs <= 0) throw new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT')
  if (body.kind === 'text') return renderBody(body, MAX_HTML_INPUT_CHARS)
  using budget = deadline(signal, Math.max(1, Math.ceil(remainingMs)), 'WEB_HTML_TIMEOUT')
  const html = body.content.slice(0, MAX_HTML_INPUT_CHARS)
  const entry = fileURLToPath(new URL('../assets/html-worker.cjs', import.meta.url))
  const worker = new Worker(entry, {
    execArgv: [], env: {}, stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    workerData: { html },
  })
  worker.stdout.resume()
  worker.stderr.resume()
  let termination: Promise<number> | undefined
  const terminate = (): Promise<number> => termination ??= worker.terminate()
  let abort: (() => void) | undefined
  const failure = (): Error => {
    const timeout = timeoutOf(budget.signal, 'WEB_HTML_TIMEOUT')
    const reason: unknown = signal.reason
    if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
    return reason instanceof Error ? reason : new WebError('web fetch aborted', 'WEB_ABORTED', { cause: reason })
  }
  let result: RenderedBody
  try {
    result = await new Promise<RenderedBody>((resolve, reject) => {
      abort = () => {
        reject(failure())
        void terminate().catch(() => {})
      }
      budget.signal.addEventListener('abort', abort, { once: true })
      worker.once('message', (message: unknown) => {
        if (message !== null && typeof message === 'object' && 'text' in message && typeof message.text === 'string'
          && message.text.length <= MAX_HTML_OUTPUT_CHARS && 'sourceTruncated' in message && typeof message.sourceTruncated === 'boolean') {
          resolve({ text: message.text, sourceTruncated: message.sourceTruncated || html.length !== body.content.length })
        } else reject(new WebError('HTML conversion failed', 'WEB_PROVIDER_ERROR'))
      })
      worker.once('error', (error) => { reject(new WebError('HTML conversion Worker failed', 'WEB_PROVIDER_ERROR', { cause: error })) })
      worker.once('exit', (code) => { reject(new WebError(`HTML conversion Worker exited before returning text (${code})`, 'WEB_PROVIDER_ERROR')) })
      if (budget.signal.aborted) abort()
    })
  } finally {
    if (abort !== undefined) budget.signal.removeEventListener('abort', abort)
    await terminate()
    worker.removeAllListeners()
  }
  if (budget.signal.aborted) throw failure()
  return result
}
