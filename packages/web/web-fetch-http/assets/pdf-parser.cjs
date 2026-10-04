/** Package-owned parser Worker; only bounded document data and local PDF.js assets are accepted. */
'use strict'
const { parentPort, workerData } = require('node:worker_threads')

/** PDF.js uses a fake Worker in Node; this entire parser therefore runs outside the host thread. */
async function extract() {
  const { getDocument } = await import(workerData.moduleUrl)
  const loading = getDocument({ data: workerData.bytes, useSystemFonts: false, disableFontFace: true,
    useWorkerFetch: false, enableXfa: false, verbosity: 0,
    cMapUrl: workerData.cMapUrl, cMapPacked: true,
    standardFontDataUrl: workerData.standardFontDataUrl, wasmUrl: workerData.wasmUrl,
  })
  try {
    const pdf = await loading.promise
    const chunks = []
    let length = 0
    let hasText = false
    for (let number = 1; number <= pdf.numPages; number++) {
      if (number > 1000) return hasText ? { content: chunks.join(''), truncated: true } : { textless: true }
      const page = await pdf.getPage(number)
      try {
        const text = await page.getTextContent()
        const body = text.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('')
        if (body.trim().length === 0) continue
        hasText = true
        const section = `\n\n[Page ${number}]\n${body}`
        const remaining = workerData.maxChars - length
        chunks.push(section.slice(0, remaining))
        length += Math.min(section.length, remaining)
        if (section.length > remaining || (length === workerData.maxChars && number < pdf.numPages)) {
          return { content: chunks.join(''), truncated: true }
        }
      } finally { page.cleanup() }
    }
    return hasText ? { content: chunks.join(''), truncated: false } : { textless: true }
  } finally { await loading.destroy() }
}

void extract().then(result => parentPort.postMessage(result), () => parentPort.postMessage({ invalid: true }))
