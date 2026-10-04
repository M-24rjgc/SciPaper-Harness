/** Bounded PDF text extraction in an interruptible parser Worker. Document scripts are never evaluated. */
import { WebError } from '@deepseek-ai/dsh-web'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

/**
 * Extract page-labelled PDF text without rendering, remote asset loading or OCR. Each call owns
 * an isolated Worker with a 256 MiB V8 old-generation heap ceiling (not an OS memory sandbox).
 * Cancellation terminates and joins that Worker even while its parser performs synchronous work.
 * The module and font/CMap paths resolve from the installed dependency, including Desktop ASAR.
 * @param bytes - complete PDF payload; the parser receives an owned copy.
 * @param maxChars - positive ceiling for the complete extracted text.
 * @param signal - request cancellation, including its deadline.
 * @returns page-labelled text and whether the character ceiling truncated extraction.
 */
export async function extractPdfText(
  bytes: Uint8Array, maxChars: number, signal: AbortSignal,
): Promise<{ content: string; truncated: boolean }> {
  signal.throwIfAborted()
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new WebError('PDF character limit must be a positive integer', 'WEB_PROVIDER_ERROR')
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('pdfjs-dist/package.json'))
  const asset = (name: string): string => `${join(root, name).replaceAll('\\', '/')}/`
  // PDF.js transfers its input buffer internally. Transfer an owned copy so callers retain theirs.
  const input = new Uint8Array(bytes)
  // SEA's Worker adapter installs its snapshot filesystem only for string entry paths.
  // This package-owned asset works from src/, the bundled lib/, and the installed runtime.
  const entry = fileURLToPath(new URL('../assets/pdf-parser.cjs', import.meta.url))
  const worker = new Worker(entry, {
    // Text extraction uses bundled PDF fonts; skip canvas's synchronous system-font scan.
    execArgv: [], env: { DISABLE_SYSTEM_FONTS_LOAD: '1' }, stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    workerData: {
      bytes: input, maxChars, moduleUrl: pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href,
      cMapUrl: asset('cmaps'), standardFontDataUrl: asset('standard_fonts'), wasmUrl: asset('wasm'),
    },
    transferList: [input.buffer],
  })
  worker.stdout.resume()
  worker.stderr.resume()
  let termination: Promise<number> | undefined
  const terminate = (): Promise<number> => termination ??= worker.terminate()
  let abort: (() => void) | undefined
  let result: { content: string; truncated: boolean }
  try {
    result = await new Promise<{ content: string; truncated: boolean }>((resolve, reject) => {
      abort = () => {
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new WebError('PDF parsing aborted', 'WEB_ABORTED', { cause: reason }))
        void terminate().catch(() => {})
      }
      signal.addEventListener('abort', abort, { once: true })
      worker.once('message', (message: unknown) => {
        if (message !== null && typeof message === 'object') {
          if ('textless' in message && message.textless === true) {
            reject(new WebError('PDF contains no extractable text; use OCR for scanned pages', 'WEB_UNSUPPORTED_CONTENT_TYPE'))
            return
          }
          if ('content' in message && typeof message.content === 'string' && message.content.length <= maxChars
            && 'truncated' in message && typeof message.truncated === 'boolean') {
            resolve({ content: message.content, truncated: message.truncated })
            return
          }
        }
        reject(new WebError('PDF text extraction failed (invalid or encrypted document)', 'WEB_PROVIDER_ERROR'))
      })
      worker.once('error', (error) => { reject(new WebError('PDF parser Worker failed', 'WEB_PROVIDER_ERROR', { cause: error })) })
      worker.once('exit', (code) => { reject(new WebError(`PDF parser Worker exited before returning text (${code})`, 'WEB_PROVIDER_ERROR')) })
      if (signal.aborted) abort()
    })
  } finally {
    if (abort !== undefined) signal.removeEventListener('abort', abort)
    await terminate()
    worker.removeAllListeners()
  }
  signal.throwIfAborted()
  return result
}
