import { describe, expect, it } from 'vitest'
import { OperationScope } from '../src/operation-scope.ts'

describe('OperationScope', () => {
  it('returns the work result and forgets the operation once it settles', async () => {
    const scope = new OperationScope('closed')
    await expect(scope.run(new AbortController().signal, async () => 7)).resolves.toBe(7)
    await expect(scope.run(new AbortController().signal, async () => { throw new Error('failed') })).rejects.toThrow('failed')
    await expect(scope.close()).resolves.toBeUndefined()
  })

  it('refuses work whose caller has already cancelled, without starting it', () => {
    const scope = new OperationScope('closed')
    const caller = new AbortController()
    caller.abort(new Error('caller left'))
    let started = false
    expect(() => scope.run(caller.signal, async () => { started = true })).toThrow('caller left')
    expect(started).toBe(false)
  })

  it('rejects work whose caller cancels while it runs, and work that finishes after the cancel', async () => {
    const scope = new OperationScope('closed')
    const caller = new AbortController()
    const waiting = scope.run(caller.signal, signal => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error(String(signal.reason))) }, { once: true })
    }))
    caller.abort(new Error('caller left'))
    await expect(waiting).rejects.toThrow('caller left')
    const late = new AbortController()
    const ignoring = scope.run(late.signal, async () => { late.abort(new Error('too late')); return 'done' })
    await expect(ignoring).rejects.toThrow('too late')
  })

  it('aborts the work in flight with its reason when closed, waits for it, and refuses work afterwards', async () => {
    const scope = new OperationScope('The plugin was disabled')
    const started = Promise.withResolvers<undefined>()
    let settled = false
    const inFlight = scope.run(new AbortController().signal, signal => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { setTimeout(() => { settled = true; reject(new Error(String(signal.reason))) }, 5) }, { once: true })
      started.resolve(undefined)
    }))
    const rejected = expect(inFlight).rejects.toThrow('The plugin was disabled')
    await started.promise
    await scope.close()
    expect(settled).toBe(true)
    await rejected
    expect(() => scope.run(new AbortController().signal, async () => 1)).toThrow('The plugin was disabled')
  })
})
