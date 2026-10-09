import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { expect, it } from 'vitest'
import { waitForUpdateWindow } from '../src/update-window.ts'

function fixture(visible = false, minimized = false) {
  const state = { visible, minimized, destroyed: false }
  const window = Object.assign(new EventEmitter(), {
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isDestroyed: () => state.destroyed,
  })
  const controller = new AbortController()
  const wait = () => waitForUpdateWindow(window as BrowserWindow, controller.signal)
  return { window, state, controller, wait }
}

it('resumes installation confirmation on Windows restore without requiring a show event', async () => {
  const f = fixture(false, true)
  let completed = false
  const waiting = f.wait().then((result) => { completed = true; return result })
  f.window.emit('focus')
  await Promise.resolve()
  expect(completed).toBe(false)
  f.state.visible = true
  f.state.minimized = false
  f.window.emit('restore')
  expect(await waiting).toBe(true)
  expect(f.window.eventNames()).toEqual([])
})

it.each(['show', 'focus'])('accepts %s only when the confirmation can be seen', async (event) => {
  const f = fixture()
  const waiting = f.wait()
  f.state.visible = true
  f.window.emit(event)
  expect(await waiting).toBe(true)
  expect(f.window.eventNames()).toEqual([])
})

it('does not retain listeners when the window is already visible', async () => {
  const f = fixture(true)
  expect(await f.wait()).toBe(true)
  expect(f.window.eventNames()).toEqual([])
})

it.each(['abort', 'closed', 'destroyed'])('cancels and releases listeners on %s without authorizing installation', async (reason) => {
  const f = fixture()
  const waiting = f.wait()
  if (reason === 'abort') f.controller.abort()
  else if (reason === 'closed') f.window.emit('closed')
  else { f.state.destroyed = true; f.window.emit('show') }
  expect(await waiting).toBe(false)
  expect(f.window.eventNames()).toEqual([])
})

it('rejects missing, destroyed, and cancelled windows immediately', async () => {
  const f = fixture()
  expect(await waitForUpdateWindow(undefined, f.controller.signal)).toBe(false)
  f.state.destroyed = true
  expect(await f.wait()).toBe(false)
  f.state.destroyed = false
  f.controller.abort()
  expect(await f.wait()).toBe(false)
  expect(f.window.eventNames()).toEqual([])
})
