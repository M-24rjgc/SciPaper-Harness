/** Native overlay visibility qualification without a Host, network, or user profile. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { DesktopUpdateOverlays } from '../../lib/types/update-overlay.js'
import { waitForUpdateWindow } from '../../lib/types/update-window.js'

const directory = fileURLToPath(new URL('../../.desktop-build/qualification/', import.meta.url))
mkdirSync(directory, { recursive: true })
const root = mkdtempSync(join(directory, 'update-overlay-'))
mkdirSync(join(root, 'profile'))
app.setPath('userData', join(root, 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  const cases = []
  const windows = []
  const closeWindows = () => {
    for (const window of [...windows].reverse()) if (!window.isDestroyed()) window.destroy()
  }
  let phase = 'application ready'
  const deadline = setTimeout(() => {
    console.error(`Update overlay qualification exceeded 30 seconds: ${phase}`)
    closeWindows()
    app.exit(1)
  }, 30_000)

  async function qualify(initiallyVisible, closeParentFirst = false) {
    const parent = new BrowserWindow({ show: initiallyVisible, width: 800, height: 600 })
    windows.push(parent)
    phase = `parent load (${initiallyVisible})`
    await parent.loadURL('data:text/html,<h1>Update overlay visibility</h1><input aria-label="Keyboard probe">')
    const initialShowListeners = parent.listenerCount('show')
    const overlay = new DesktopUpdateOverlays().create(parent, undefined, 'Overlay qualification', false)
    windows.push(overlay)
    const ready = once(overlay, 'ready-to-show')
    const initiallyShown = initiallyVisible ? once(overlay, 'show') : undefined
    phase = `overlay load (${initiallyVisible})`
    await overlay.loadURL('data:text/html,<h1>Update confirmation</h1>')
    phase = `overlay ready (${initiallyVisible})`
    await ready
    await initiallyShown
    const filter = () => parent.webContents.executeJavaScript('getComputedStyle(document.body).filter')
    const loaded = { parent: parent.isVisible(), overlay: overlay.isVisible(), filter: await filter() }
    if (initiallyVisible) {
      const hidden = once(parent, 'hide')
      parent.hide()
      await hidden
    }
    const shown = once(parent, 'show')
    phase = `overlay restored (${initiallyVisible})`
    parent.show()
    await shown
    const restoredFilter = await filter()
    const restored = { parent: parent.isVisible(), overlay: overlay.isVisible(), filter: restoredFilter }
    phase = `overlay release (${initiallyVisible})`
    if (closeParentFirst) {
      parent.destroy()
      if (!overlay.isDestroyed()) overlay.destroy()
      cases.push({ parentDestroyed: parent.isDestroyed(), overlayDestroyed: overlay.isDestroyed() })
      return
    }
    overlay.destroy()
    const released = { filter: await filter(), showListenersRestored: parent.listenerCount('show') === initialShowListeners,
      keyboardListeners: parent.webContents.listenerCount('before-input-event') }
    parent.hide()
    parent.show()
    cases.push({ initiallyVisible, loaded, restored, released })
    parent.destroy()
  }

  try {
    await app.whenReady()
    if (process.platform === 'win32') {
      const parent = new BrowserWindow({ show: false, width: 800, height: 600 })
      windows.push(parent)
      await parent.loadURL('data:text/html,<h1>Update readiness</h1>')
      parent.showInactive()
      const minimized = once(parent, 'minimize')
      parent.minimize()
      await minimized
      assert.equal(parent.isVisible(), false)
      let shown = false
      const onShow = () => { shown = true }
      parent.on('show', onShow)
      const restoreListeners = parent.listenerCount('restore')
      const waiting = waitForUpdateWindow(parent, new AbortController().signal)
      const overlay = new DesktopUpdateOverlays().create(parent, undefined, 'Update ready', false)
      windows.push(overlay)
      const ready = once(overlay, 'ready-to-show')
      await overlay.loadURL('data:text/html,<h1>Install and restart</h1>')
      await ready
      assert.equal(overlay.isVisible(), false)
      const restored = once(parent, 'restore')
      parent.restore()
      await restored
      assert.equal(await waiting, true)
      assert.equal(shown, false, 'Windows restore must exercise the missing show-event regression')
      assert.equal(overlay.isVisible(), true)
      const closed = once(overlay, 'closed')
      overlay.destroy()
      await closed
      parent.off('show', onShow)
      assert.equal(parent.listenerCount('restore'), restoreListeners)
      parent.destroy()
      console.log('Windows minimized download resumes on restore and reveals its confirmation')
    }
    await qualify(true)
    await qualify(false)
    await qualify(true, true)
    await writeFile(join(root, 'result.json'), `${JSON.stringify(cases, null, 2)}\n`)
    const expected = JSON.parse(await readFile(new URL('../expected/update-overlay-visibility.json', import.meta.url), 'utf8'))
    assert.deepEqual(cases, expected)
    console.log(`Update overlay qualification passed: ${root}`)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    clearTimeout(deadline)
    closeWindows()
    app.exit(process.exitCode ?? 0)
  }
}

void main().catch(error => { console.error(error); app.exit(1) })
