/** Real parser Workers preserve rendering while cancellation leaves no live conversion thread. */
import { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { renderBody, renderFetchBody } from '../src/html.ts'

const signal = (): AbortSignal => new AbortController().signal
const fixtures = [
  '<h2>Title</h2><p>A &amp; B &copy;</p><ul><li>first</li><li>second</li></ul>',
  '<table><tr><th align="left">Name</th><th>Value</th></tr><tr><td>x</td><td>7</td></tr></table>',
  '<script>hidden()</script><p hidden>hidden</p><p style="display:none">hidden</p><p>Visible <strong>bold</strong></p>',
  '<table><tr><th colspan="1000000">A</th></tr><tr><td>B</td></tr></table>',
  '<div>'.repeat(600) + 'deep' + '</div>'.repeat(600),
]

describe('owned HTML conversion Worker', () => {
  it.each(fixtures)('matches the existing synchronous rendering rules (%#)', async (content) => {
    const body = { kind: 'html' as const, content }
    expect(await renderFetchBody(body, signal(), 5000)).toEqual(renderBody(body, 2_000_000))
  })

  it('keeps the host heartbeat alive during large synchronous parsing and joins its Worker on cancellation', async () => {
    await renderFetchBody({ kind: 'html', content: '<p>Warm parser</p>' }, signal(), 5000)
    const stop = vi.spyOn(Worker.prototype, 'terminate')
    const controller = new AbortController()
    const reason = new Error('stop large HTML fixture')
    let beats = 0
    const heartbeat = setInterval(() => { beats++ }, 20)
    const cancel = setTimeout(() => { controller.abort(reason) }, 500)
    try {
      await expect(renderFetchBody({ kind: 'html', content: '<p>text</p>'.repeat(100_000) }, controller.signal, 15000)).rejects.toBe(reason)
      expect(beats).toBeGreaterThan(1)
      expect(stop).toHaveBeenCalledOnce()
      const worker = stop.mock.contexts[0]
      if (!(worker instanceof Worker)) throw new Error('Missing actual HTML Worker')
      expect(worker.threadId).toBe(-1)
    } finally { clearTimeout(cancel); clearInterval(heartbeat); stop.mockRestore() }
    await expect(renderFetchBody({ kind: 'html', content: '<p>After cancellation</p>' }, signal(), 5000))
      .resolves.toEqual({ text: 'After cancellation', sourceTruncated: false })
  })

  it('uses the remaining conversion budget and joins its Worker before reporting a timeout', async () => {
    const stop = vi.spyOn(Worker.prototype, 'terminate')
    try {
      await expect(renderFetchBody({ kind: 'html', content: '<p>text</p>'.repeat(100_000) }, signal(), 100))
        .rejects.toMatchObject({ code: 'WEB_FETCH_TIMEOUT' })
      expect(stop).toHaveBeenCalledOnce()
      const worker = stop.mock.contexts[0]
      if (!(worker instanceof Worker)) throw new Error('Missing actual HTML Worker')
      expect(worker.threadId).toBe(-1)
      await expect(renderFetchBody({ kind: 'html', content: '<p>x</p>' }, signal(), 0)).rejects.toMatchObject({ code: 'WEB_FETCH_TIMEOUT' })
      expect(stop).toHaveBeenCalledOnce()
    } finally { stop.mockRestore() }
  })

  it('bounds input before transfer while retaining the later text of a normal large page', async () => {
    const content = '<p>' + 'large '.repeat(50_000) + 'UNIQUE-SUFFIX</p>'
    const result = await renderFetchBody({ kind: 'html', content }, signal(), 10000)
    expect(result.text).toContain('UNIQUE-SUFFIX')
    expect(result.sourceTruncated).toBe(false)
    const capped = await renderFetchBody({ kind: 'html', content: '<p>' + 'x'.repeat(2_000_001) + '</p>' }, signal(), 10000)
    expect(capped.text.length).toBeLessThanOrEqual(8_000_000)
    expect(capped.sourceTruncated).toBe(true)
    await expect(renderFetchBody({ kind: 'html', content }, AbortSignal.abort(new Error('before launch')), 10000)).rejects.toThrow('before launch')
  })
})
