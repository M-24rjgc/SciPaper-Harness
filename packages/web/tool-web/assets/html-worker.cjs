/** Package-owned conversion Worker. Inputs are bounded HTML text; dependencies are local and fixed. */
'use strict'
const { parentPort, workerData } = require('node:worker_threads')
const { createHtmlConverter } = require('./html-converter.cjs')
const { renderHtml } = createHtmlConverter(require('turndown'), require('@joplin/turndown-plugin-gfm').gfm)

try {
  if (typeof workerData.html !== 'string' || workerData.html.length > 2_000_000) throw new Error('Invalid HTML input bound')
  const result = renderHtml(workerData.html, 2_000_000)
  // Markdown escaping can expand source text. Bound the retained response independently of the Worker heap.
  const maxOutputChars = 8_000_000
  parentPort.postMessage({ text: result.text.slice(0, maxOutputChars),
    sourceTruncated: result.sourceTruncated || result.text.length > maxOutputChars })
} catch { parentPort.postMessage({ invalid: true }) }
