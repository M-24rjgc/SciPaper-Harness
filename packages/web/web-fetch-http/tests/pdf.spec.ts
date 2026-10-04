import { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { extractPdfText } from '../src/pdf.ts'
import { pdf } from './pdf-fixture.ts'

describe('PDF text retrieval with the real parser', () => {
  it('extracts labelled page text and observes the character cap', async () => {
    const bytes = pdf('Research PDF fixture')
    const retained = bytes.slice()
    const result = await extractPdfText(bytes, 1000, new AbortController().signal)
    expect(result).toMatchObject({ truncated: false })
    expect(result.content).toContain('[Page 1]')
    expect(result.content).toContain('Research PDF fixture')
    expect(bytes).toEqual(retained)
    const capped = await extractPdfText(pdf('Research PDF fixture'), 12, new AbortController().signal)
    expect(capped.truncated).toBe(true)
    expect(capped.content).toHaveLength(12)
  })

  it('distinguishes invalid and textless documents and honours cancellation', async () => {
    await expect(extractPdfText(new Uint8Array([1, 2, 3]), 1000, new AbortController().signal)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await expect(extractPdfText(pdf(''), 1000, new AbortController().signal)).rejects.toMatchObject({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' })
    await expect(extractPdfText(pdf('x'), 1000, AbortSignal.abort(new Error('stopped')))).rejects.toThrow('stopped')
  })

  it('does not turn an empty PDF into success when the output bound cuts a page label', async () => {
    await expect(extractPdfText(pdf(''), 1, new AbortController().signal))
      .rejects.toMatchObject({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' })
  })

  it('honours caller cancellation while joining a Worker that already returned text', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel during PDF Worker join')
    const join = Promise.withResolvers<number>()
    const stopping = Promise.withResolvers<{ worker: Worker; completion: Promise<number> }>()
    const readiness = Promise.withResolvers<never>()
    // oxlint-disable-next-line typescript/unbound-method -- each call supplies the actual Worker receiver.
    const original = Worker.prototype.terminate
    let stopped: { worker: Worker; completion: Promise<number> } | undefined
    const stop = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
      stopped = { worker: this, completion: original.call(this) }
      stopping.resolve(stopped)
      return join.promise
    })
    const extraction = extractPdfText(pdf('PDF join cancellation fixture'), 1000, controller.signal)
    const readinessTimer = setTimeout(() => {
      const error = new Error('PDF Worker did not begin joining within 10 seconds')
      readiness.reject(error)
      controller.abort(error)
    }, 10_000)
    try {
      const record = await Promise.race([
        stopping.promise,
        extraction.then(() => { throw new Error('PDF extraction settled before Worker join') }),
        readiness.promise,
      ])
      controller.abort(reason)
      join.resolve(await record.completion)
      await expect(extraction).rejects.toBe(reason)
      expect(record.worker.threadId).toBe(-1)
    } finally {
      clearTimeout(readinessTimer)
      if (!controller.signal.aborted) controller.abort(reason)
      stop.mockRestore()
      if (stopped !== undefined) {
        try { join.resolve(await stopped.completion) } catch (error) { join.reject(error) }
        if (stopped.worker.threadId !== -1) await original.call(stopped.worker)
      }
      await extraction.catch(() => {})
    }
  })

  it('keeps host cancellation responsive while parsing a tiny PDF with a large compressed text operation', async () => {
    // A single uncompressed token previously blocked the host past its cooperative deadline.
    const bytes = pdf('a'.repeat(3_000_000), true)
    expect(bytes.byteLength).toBeLessThan(5000)
    await extractPdfText(pdf('warm parser fixture'), 1000, new AbortController().signal)
    const controller = new AbortController()
    const reason = new Error('cancel compressed PDF fixture')
    let timerFired = false
    const timeout = setTimeout(() => { timerFired = true; controller.abort(reason) }, 50)
    try {
      await expect(extractPdfText(bytes, 1000, controller.signal)).rejects.toBe(reason)
      expect(timerFired).toBe(true)
      // Successful completion after cancellation would reveal a parser still owning its Worker.
      await expect(extractPdfText(pdf('subsequent fixture'), 1000, new AbortController().signal))
        .resolves.toMatchObject({ truncated: false })
    } finally { clearTimeout(timeout) }
  })

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])('rejects an invalid output bound %s before parsing', async (maxChars) => {
    await expect(extractPdfText(pdf('bounded fixture'), maxChars, new AbortController().signal))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })
})
