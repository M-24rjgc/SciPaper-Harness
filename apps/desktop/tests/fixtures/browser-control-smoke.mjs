/** Real Electron webview regression for Session-bound model browser operations. */
import assert from 'node:assert/strict'
import { app, BrowserWindow, nativeImage } from 'electron'
import { pathToFileURL } from 'node:url'

const [managerModule, userData, origin] = process.argv.slice(2)
if (!managerModule || !userData || !origin) throw new Error('expected manager module, userData and origin')
app.setPath('userData', userData)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

async function within(promise, label, milliseconds = 10_000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds)
    })])
  } finally {
    clearTimeout(timer)
  }
}

function assertVisualScreenshot(result) {
  const png = Buffer.from(result.png, 'base64')
  assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
  const image = nativeImage.createFromBuffer(png)
  assert.equal(image.isEmpty(), false)
  const pixels = image.toBitmap()
  let red = 0, outsideGreen = 0, ownerOverlay = 0
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    if (pixels[offset + 1] < 50 && pixels[offset + 3] > 200
      && ((pixels[offset] > 200 && pixels[offset + 2] < 50)
        || (pixels[offset + 2] > 200 && pixels[offset] < 50))) red += 1
    if (pixels[offset + 1] > 200 && pixels[offset] < 50 && pixels[offset + 2] < 50) outsideGreen += 1
    if (pixels[offset] > 200 && pixels[offset + 1] < 50 && pixels[offset + 2] > 200) ownerOverlay += 1
  }
  assert.ok(red > 1_000, 'screenshot did not contain the red Browser page marker')
  assert.ok(outsideGreen < 1_000,
    `screenshot included pixels outside the Browser tab: size=${JSON.stringify(image.getSize())}, red=${red}, green=${outsideGreen}`)
  assert.equal(ownerOverlay, 0, 'screenshot included a covering control from the application window')
  return png.length
}

async function run() {
  await app.whenReady()
  const { DesktopBrowserGuests } = await import(pathToFileURL(managerModule).href)
  const owner = new BrowserWindow({ show: true, width: 800, height: 640,
    webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  try {
    const manager = new DesktopBrowserGuests(() => 'http://127.0.0.1:31888/', userData)
    manager.bind(owner, () => () => {})
    await owner.loadURL('data:text/html,<html><body style="margin:0;background:%2300ff00"><input id="composer"></body></html>')
    const reservation = manager.acquire(owner.webContents, 'research-fixture', 'session-owner')
    const attached = new Promise(resolve => owner.webContents.once('did-attach-webview', (_event, guest) => {
      guest.once('dom-ready', () => resolve(guest))
    }))
    await owner.webContents.executeJavaScript(`(() => {
      const view = document.createElement('webview');
      view.style.cssText = 'width:760px;height:560px;display:block;background:#fff';
      view.setAttribute('name', ${JSON.stringify(reservation.lease)});
      view.setAttribute('partition', ${JSON.stringify(reservation.partition)});
      view.setAttribute('src', ${JSON.stringify('about:blank#' + reservation.lease)});
      document.body.append(view);
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;left:250px;top:250px;width:100px;height:100px;background:#ff00ff;z-index:2147483647;pointer-events:none';
      document.body.append(overlay);
    })()`)
    const guest = await Promise.race([attached, new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('webview attachment timed out')), 10_000)
    })])
    await guest.loadURL(origin)
    assert.equal((await manager.operate({ action: 'list', sessionId: 'session-owner' }))[0].tabId, reservation.lease)
    assert.deepEqual(await manager.operate({ action: 'list', sessionId: 'session-other' }), [])
    const inspected = await manager.operate({ action: 'inspect', sessionId: 'session-owner' })
    assert.match(inspected.page.text, /Browser control fixture/)
    assert.ok(inspected.page.elements.some(element => element.selector === '#run'))
    await assert.rejects(manager.operate({ action: 'inspect', sessionId: 'session-other', tabId: reservation.lease }), /no open tab belongs/)
    await owner.webContents.executeJavaScript("document.querySelector('webview').hidden = true")
    for (let attempt = 0; attempt < 10 && !owner.isFocused(); attempt += 1) {
      owner.show()
      owner.moveTop()
      owner.focus()
      owner.webContents.focus()
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!owner.isFocused()) throw new Error('test Browser window could not take foreground focus')
    await owner.webContents.executeJavaScript("document.querySelector('#composer').focus()")
    await owner.webContents.executeJavaScript("document.querySelector('webview').hidden = false")
    assert.equal(await owner.webContents.executeJavaScript('document.activeElement?.id'), 'composer')
    await manager.operate({ action: 'click', sessionId: 'session-owner', selector: '#run' })
    const clicked = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 1500
      const poll = async () => {
        const value = await guest.executeJavaScript("document.querySelector('#count').textContent")
        if (value === '1') resolve(value)
        else if (Date.now() >= deadline) reject(new Error('click event was not delivered to the live guest'))
        else setTimeout(poll, 25)
      }
      void poll()
    })
    assert.equal(clicked, '1')
    assert.equal(await owner.webContents.executeJavaScript('document.activeElement?.id'), 'composer',
      'Browser click did not restore the chat composer focus')
    await manager.operate({ action: 'type', sessionId: 'session-owner', selector: '#entry', text: 'hello' })
    assert.equal(await guest.executeJavaScript("document.querySelector('#entry').value"), 'hello')
    assert.equal(await owner.webContents.executeJavaScript('document.activeElement?.id'), 'composer',
      'Browser typing did not restore the chat composer focus')
    await assert.rejects(within(manager.operate({ action: 'type', sessionId: 'session-owner', selector: '#secret', text: 'no' }), 'password refusal'), /non-password/)
    const screenshot = await within(manager.operate({ action: 'screenshot', sessionId: 'session-owner' }), 'screenshot', 20_000)
    const screenshotBytes = assertVisualScreenshot(screenshot)
    guest.debugger.attach('1.3')
    try {
      const fallback = await within(manager.operate({ action: 'screenshot', sessionId: 'session-owner' }), 'guest screenshot fallback', 20_000)
      assertVisualScreenshot(fallback)
    } finally {
      if (guest.debugger.isAttached()) guest.debugger.detach()
    }
    await owner.webContents.executeJavaScript("document.querySelector('webview').setAttribute('aria-hidden', 'true')")
    await assert.rejects(manager.operate({ action: 'click', sessionId: 'session-owner', selector: '#run' }), /Browser tab is not visible/)
    assert.equal(await owner.webContents.executeJavaScript('document.activeElement?.id'), 'composer',
      'Hidden Browser tab changed the chat composer focus')
    await owner.webContents.executeJavaScript("document.querySelector('webview').removeAttribute('aria-hidden')")
    assert.equal(await guest.executeJavaScript("document.querySelector('#count').textContent"), '1')
    await assert.rejects(manager.operate({ action: 'navigate', sessionId: 'session-owner', url: 'file:///C:/secret.txt' }), /restricted/)
    console.log('BROWSER_CONTROL_RESULT ' + JSON.stringify({ inspected: true, clicked: true, typed: true,
      screenshotBytes, isolated: true }))
  } finally {
    owner.close()
    app.quit()
  }
}

run().catch(error => { console.error(error); app.exit(1) })
