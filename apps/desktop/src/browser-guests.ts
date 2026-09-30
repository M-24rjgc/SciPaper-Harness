/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { app, BrowserWindow, session, webContents, type Session, type WebContents } from 'electron'
import type { DesktopBrowserLeaseId, DesktopBrowserOpenRequest, DesktopBrowserOperation, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'
import { resolveDesktopPaths } from './paths.ts'

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  readonly storageKey: string
  readonly sessionId: string
  attached: boolean
  guest?: WebContents
  releaseInput?: () => void
}

const OPERATION_DEADLINE_MS = 25_000

const INSPECT_SCRIPT = `(() => {
  const selectorFor = element => {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    for (let node = element; node && node !== document.body && parts.length < 8; node = node.parentElement) {
      const siblings = node.parentElement ? [...node.parentElement.children].filter(other => other.tagName === node.tagName) : [node];
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')');
    }
    return 'body > ' + parts.join(' > ');
  };
  const elements = [...document.querySelectorAll('a, button, input, textarea, select, [role="button"], [contenteditable="true"]')]
    .filter(element => element.getClientRects().length > 0).slice(0, 120)
    .map(element => ({ selector: selectorFor(element), tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || undefined, type: element.getAttribute('type') || undefined,
      name: element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') ||
        (element.innerText || '').trim().slice(0, 120), href: element.tagName === 'A' ? element.href : undefined }));
  return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 16000), elements };
})()`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPoint(value: unknown): value is { x: number; y: number; width: number; height: number } {
  return isRecord(value) && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y)
    && typeof value.width === 'number' && value.width > 0
    && typeof value.height === 'number' && value.height > 0
}

function isViewport(value: unknown): value is { width: number; height: number } {
  return isRecord(value) && typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0
    && typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0
}

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly operationQueues = new Map<number, Promise<void>>()
  private readonly partitions = new Map<string, string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()
  private readonly clearing = new Set<string>()
  private readonly profileIdentity: string

  /**
   * @param hostUrl - current authenticated DSH Host, which guests cannot request.
   * @param profileDir - Electron-managed profile that owns this browser's storage.
   */
  constructor(private readonly hostUrl: () => string | undefined, profileDir: string = resolveDesktopPaths().profile) {
    const path = resolve(profileDir)
    this.profileIdentity = process.platform === 'win32' ? path.toLowerCase() : path
  }

  /**
   * Reserve one guest in a workspace's persistent, profile-owned partition.
   * @param owner - authenticated primary application WebContents.
   * @param workspace - workspace identity received over IPC.
   * @param sessionId - conversation owning this guest.
   * @returns opaque lease and the partition approved for it.
   */
  acquire(owner: WebContents, workspace: unknown, sessionId: unknown): DesktopBrowserReservation {
    this.assertWorkspace(workspace)
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) {
      throw new Error('desktop browser: a conversation identity is required')
    }
    if (this.clearing.has(workspace)) throw new Error('desktop browser: workspace data is being cleared')
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      partition = this.partitionFor(workspace)
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, partition, storageKey: workspace, sessionId, attached: false })
    return { lease, partition }
  }

  /** Operate only a live guest opened by the requesting conversation. */
  async operate(operation: DesktopBrowserOperation, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    if (typeof operation.sessionId !== 'string' || operation.sessionId.length === 0) {
      throw new Error('desktop browser: invalid conversation identity')
    }
    if (operation.action === 'list') {
      return [...this.leases].flatMap(([tabId, lease]) => {
        const guest = lease.guest
        return lease.sessionId === operation.sessionId && guest !== undefined && !guest.isDestroyed()
          ? [{ tabId, url: guest.getURL(), title: guest.getTitle() }] : []
      })
    }
    const matching = [...this.leases].filter(([tabId, lease]) => lease.sessionId === operation.sessionId
      && (operation.tabId === undefined || tabId === operation.tabId)
      && lease.guest !== undefined && !lease.guest.isDestroyed())
    if (matching.length === 0) throw new Error('desktop browser: no open tab belongs to this conversation')
    if (matching.length > 1) throw new Error('desktop browser: specify tabId from list')
    const match = matching[0]
    if (match === undefined) throw new Error('desktop browser: no open tab belongs to this conversation')
    const [tabId, lease] = match
    if (this.clearing.has(lease.storageKey)) throw new Error('desktop browser: website data is being cleared')
    const guest = lease.guest
    if (guest === undefined) throw new Error('desktop browser: tab is unavailable')
    switch (operation.action) {
      case 'inspect': {
        return this.serialOperation(guest, lease, signal, operation.action, async () => {
          const value: unknown = await guest.executeJavaScript(INSPECT_SCRIPT, true)
          return { tabId, page: value }
        })
      }
      case 'screenshot': {
        return this.serialOperation(guest, lease, signal, operation.action, async () => {
          let png: Buffer
          try {
            const value: unknown = await this.withDebugger(guest, () => this.bounded(
              guest.debugger.sendCommand('Page.captureScreenshot',
                { format: 'png', captureBeyondViewport: false, fromSurface: true }), 5_000))
            if (!isRecord(value) || typeof value.data !== 'string'
              || value.data.length > Math.ceil(4 * 1024 * 1024 * 4 / 3) + 8) {
              throw new Error('desktop browser: debugger screenshot is unavailable')
            }
            png = Buffer.from(value.data, 'base64')
          } catch {
            try {
              const image = await this.bounded(guest.capturePage(), 8_000)
              if (image.isEmpty()) throw new Error('desktop browser: Browser guest returned an empty screenshot')
              png = image.toPNG()
            } catch (error) {
              delete lease.guest
              try { if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false }) } catch { /* already closing */ }
              throw new Error('desktop browser: screenshot unavailable; Browser tab was closed for a fresh retry', { cause: error })
            }
          }
          if (png.byteLength > 4 * 1024 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            throw new Error('desktop browser: screenshot is not a valid PNG below 4 MiB')
          }
          return { tabId, url: guest.getURL(), png: png.toString('base64') }
        })
      }
      case 'click': {
        await this.serialOperation(guest, lease, signal, operation.action, async () => {
          await this.assertVisibleTab(lease, tabId, guest)
          const pageUrl = guest.getURL()
          const point = await this.locate(guest, operation.selector, false)
          await this.visibleInput(lease, tabId, guest, () => this.devtoolsInput(guest, async () => {
            if (guest.getURL() !== pageUrl) throw new Error('desktop browser: page changed before click')
            signal?.throwIfAborted()
            await this.dispatchClick(guest, point)
          }))
        })
        return { tabId, delivered: true, url: guest.getURL() }
      }
      case 'type': {
        if (operation.text.length > 4096) throw new Error('desktop browser: text exceeds 4096 characters')
        await this.serialOperation(guest, lease, signal, operation.action, async () => {
          await this.assertVisibleTab(lease, tabId, guest)
          const pageUrl = guest.getURL()
          const point = await this.locate(guest, operation.selector, true)
          await this.visibleInput(lease, tabId, guest, () => this.devtoolsInput(guest, async () => {
            if (guest.getURL() !== pageUrl) throw new Error('desktop browser: page changed before typing')
            signal?.throwIfAborted()
            await this.dispatchClick(guest, point)
            const focused: unknown = await guest.executeJavaScript(`(() => {
              const matches = document.querySelectorAll(${JSON.stringify(operation.selector)});
              return matches.length === 1 && document.activeElement === matches[0]
                && !matches[0].matches('input[type="password"], :disabled, [readonly]');
            })()`, true)
            if (focused !== true) throw new Error('desktop browser: target input did not receive focus')
            signal?.throwIfAborted()
            await guest.debugger.sendCommand('Input.insertText', { text: operation.text })
          }))
        })
        return { tabId, delivered: true, url: guest.getURL() }
      }
      case 'scroll': {
        if (!Number.isFinite(operation.deltaY) || Math.abs(operation.deltaY) > 3000) {
          throw new Error('desktop browser: invalid scroll distance')
        }
        await this.serialOperation(guest, lease, signal, operation.action, async () => {
          await this.assertVisibleTab(lease, tabId, guest)
          const pageUrl = guest.getURL()
          const viewport: unknown = await guest.executeJavaScript('({ width: innerWidth, height: innerHeight })', true)
          if (!isViewport(viewport)) throw new Error('desktop browser: page viewport is unavailable')
          await this.visibleInput(lease, tabId, guest, () => this.devtoolsInput(guest, async () => {
            if (guest.getURL() !== pageUrl) throw new Error('desktop browser: page changed before scrolling')
            signal?.throwIfAborted()
            await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel',
              x: Math.floor(viewport.width / 2), y: Math.floor(viewport.height / 2),
              deltaX: 0, deltaY: Math.round(operation.deltaY) })
          }))
        })
        return { tabId, delivered: true, url: guest.getURL() }
      }
      case 'navigate': {
        return this.serialOperation(guest, lease, signal, operation.action, async () => {
          if (!this.allowedNavigation(operation.url)) throw new Error('desktop browser: navigation is restricted to HTTP(S) pages')
          signal?.throwIfAborted()
          await guest.loadURL(operation.url)
          return { tabId, url: guest.getURL(), title: guest.getTitle() }
        })
      }
    }
  }

  private async serialOperation<T>(guest: WebContents, lease: GuestLease, signal: AbortSignal | undefined,
    kind: DesktopBrowserOperation['action'], action: () => Promise<T>): Promise<T> {
    const previous = this.operationQueues.get(guest.id) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.operationQueues.set(guest.id, current)
    await previous
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      signal?.throwIfAborted()
      if (this.clearing.has(lease.storageKey) || guest.isDestroyed()) {
        throw new Error('desktop browser: tab is unavailable while website data is being cleared')
      }
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          delete lease.guest
          try { if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false }) } catch { /* already closing */ }
          const uncertain = kind === 'inspect' || kind === 'screenshot' ? '' : '; action may have completed'
          reject(new Error(`desktop browser: ${kind} timed out; Browser tab was closed${uncertain}`))
        }, OPERATION_DEADLINE_MS)
      })
      return await Promise.race([action(), deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      release()
      if (this.operationQueues.get(guest.id) === current) this.operationQueues.delete(guest.id)
    }
  }

  private async devtoolsInput(guest: WebContents, action: () => Promise<void>): Promise<void> {
    await this.withDebugger(guest, async () => {
      try {
        await action()
      } catch (error) {
        throw new Error('desktop browser: input outcome is uncertain; inspect the page before retrying', { cause: error })
      }
    })
  }

  private async withDebugger<T>(guest: WebContents, action: () => Promise<T>): Promise<T> {
    if (guest.debugger.isAttached()) throw new Error('desktop browser: this tab already has an active debugger')
    guest.debugger.attach('1.3')
    try {
      return await action()
    } finally {
      if (!guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach()
    }
  }

  private async bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('desktop browser: screenshot capture timed out')) }, milliseconds)
      })])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async dispatchClick(guest: WebContents, point: { x: number; y: number }): Promise<void> {
    const key = `dsh-browser-click-${randomUUID()}`
    await guest.executeJavaScript(`(() => {
      const key = ${JSON.stringify(key)};
      const state = { done: false, handler: null };
      state.handler = () => { state.done = true; };
      window[key] = state;
      document.addEventListener('click', state.handler, true);
      return true;
    })()`, true)
    let pressed = false
    try {
      await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed',
        x: point.x, y: point.y, button: 'left', clickCount: 1 })
      pressed = true
      await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased',
        x: point.x, y: point.y, button: 'left', clickCount: 1 })
      pressed = false
      let confirmed = false
      for (let attempt = 0; attempt < 40; attempt += 1) {
        confirmed = await guest.executeJavaScript(`window[${JSON.stringify(key)}]?.done === true`, true) === true
        if (confirmed) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (!confirmed) throw new Error('desktop browser: click was not observed in the page')
    } finally {
      if (pressed && !guest.isDestroyed()) {
        await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased',
          x: point.x, y: point.y, button: 'left', clickCount: 1 }).catch(() => undefined)
      }
      if (!guest.isDestroyed()) {
        await guest.executeJavaScript(`(() => {
          const key = ${JSON.stringify(key)};
          const state = window[key];
          if (state) document.removeEventListener('click', state.handler, true);
          delete window[key];
        })()`, true).catch(() => undefined)
      }
    }
  }

  private async assertVisibleTab(lease: GuestLease, tabId: DesktopBrowserLeaseId, guest: WebContents,
    focusKey?: string): Promise<void> {
    const ownerWindow = BrowserWindow.fromWebContents(lease.owner)
    if (ownerWindow?.isFocused() !== true) {
      throw new Error('desktop browser: focus this application before interacting with its Browser tab')
    }
    const visible: unknown = await lease.owner.executeJavaScript(`(() => {
      const view = [...document.querySelectorAll('webview')].find(node => node.getAttribute('name') === ${JSON.stringify(tabId)});
      if (!view || view.getClientRects().length === 0 || view.closest('[hidden], [aria-hidden="true"]')
        || getComputedStyle(view).visibility !== 'visible') return false;
      if (view.getWebContentsId?.() !== ${String(guest.id)}) return false;
      const rect = view.getBoundingClientRect();
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
      if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      const top = document.elementFromPoint(x, y);
      if (top !== view && !view.contains(top)) return false;
      if (${String(focusKey !== undefined)}) {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        window[${JSON.stringify(focusKey)}] = active;
      }
      return true;
    })()`, true)
    if (!ownerWindow.isFocused()) {
      throw new Error('desktop browser: application focus changed before input was delivered')
    }
    if (!visible) throw new Error('desktop browser: the Browser tab is not visible')
  }

  private async visibleInput(lease: GuestLease, tabId: DesktopBrowserLeaseId, guest: WebContents,
    deliver: () => void | Promise<void>): Promise<void> {
    const previous = webContents.getFocusedWebContents()
    if (previous !== lease.owner && previous !== guest) {
      throw new Error('desktop browser: focus this application before interacting with its Browser tab')
    }
    const focusKey = `dsh-browser-focus-${randomUUID()}`
    try {
      await this.assertVisibleTab(lease, tabId, guest, focusKey)
      if (webContents.getFocusedWebContents() !== previous) {
        throw new Error('desktop browser: application focus changed before input was delivered')
      }
      guest.focus()
      await new Promise(resolve => setTimeout(resolve, 50))
      if (BrowserWindow.fromWebContents(lease.owner)?.isFocused() !== true
        || webContents.getFocusedWebContents() !== guest) {
        throw new Error('desktop browser: focus changed before input was delivered')
      }
      await deliver()
      // The guest renderer observes the input before focus returns to the chat.
      await guest.executeJavaScript('true', true).catch(() => undefined)
    } finally {
      const current = webContents.getFocusedWebContents()
      const ownerWindow = BrowserWindow.fromWebContents(lease.owner)
      const restore = ownerWindow?.isFocused() === true && (current === guest || current === lease.owner)
      if (restore) {
        if (previous !== guest && !previous.isDestroyed() && current === guest) previous.focus()
      }
      if (!lease.owner.isDestroyed()) {
        await lease.owner.executeJavaScript(`(() => {
          const key = ${JSON.stringify(focusKey)};
          const active = window[key];
          delete window[key];
          if (!${String(restore)}) return;
          let current = document.activeElement;
          if (current?.tagName !== 'WEBVIEW') {
            while (current?.shadowRoot?.activeElement) current = current.shadowRoot.activeElement;
          }
          if (active?.isConnected && (current === active || current === document.body
            || current === document.documentElement || current?.tagName === 'WEBVIEW')) {
            active.focus({ preventScroll: true });
          }
        })()`, true).catch(() => undefined)
      }
    }
  }

  private async locate(guest: WebContents, selector: string, forTyping: boolean): Promise<{ x: number; y: number }> {
    if (typeof selector !== 'string' || selector.length === 0 || selector.length > 1024) {
      throw new Error('desktop browser: a CSS selector is required')
    }
    const script = `(() => {
      const matches = document.querySelectorAll(${JSON.stringify(selector)});
      if (matches.length !== 1) return { matchCount: matches.length };
      const element = matches[0];
      if (${String(forTyping)} && (element.matches('input[type="password"], :disabled, [readonly]') ||
        !element.matches('input, textarea, [contenteditable="true"]'))) return { refused: true };
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const box = element.getBoundingClientRect();
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);
      if (box.width <= 0 || box.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { hidden: true };
      const target = document.elementFromPoint(x, y);
      if (!target || (target !== element && !element.contains(target))) return { hidden: true };
      return { x, y, width: box.width, height: box.height };
    })()`
    const point: unknown = await guest.executeJavaScript(script, true)
    if (isRecord(point) && typeof point.matchCount === 'number') {
      throw new Error(point.matchCount === 0
        ? 'desktop browser: selector did not match the current page'
        : 'desktop browser: selector matched multiple elements')
    }
    if (isRecord(point) && point.refused === true) throw new Error('desktop browser: typing requires a non-password input')
    if (!isPoint(point)) throw new Error('desktop browser: target is not visible')
    return { x: point.x, y: point.y }
  }

  /** Clear one workspace's saved website state after closing all of its guest views. */
  async clearWorkspaceData(owner: WebContents, workspace: unknown, sessionId: unknown, leaseId: unknown): Promise<void> {
    this.assertWorkspace(workspace)
    if (typeof sessionId !== 'string' || typeof leaseId !== 'string') {
      throw new Error('desktop browser: reopen the Browser tab before clearing website data')
    }
    const lease = this.leases.get(leaseId as DesktopBrowserLeaseId)
    if (lease === undefined || lease.owner !== owner || lease.sessionId !== sessionId) {
      throw new Error('desktop browser: the Browser tab does not belong to this conversation')
    }
    const storageKey = lease.storageKey
    if (this.clearing.has(storageKey)) throw new Error('desktop browser: workspace data is being cleared')
    this.clearing.add(storageKey)
    try {
      const partition = lease.partition
      const owned = [...this.leases].filter(([, lease]) => lease.partition === partition)
      if (owned.some(([, lease]) => lease.owner !== owner)) {
        throw new Error('desktop browser: workspace guest belongs to another window')
      }
      await Promise.all(owned.flatMap(([, candidate]) => {
        const pending = candidate.guest === undefined ? undefined : this.operationQueues.get(candidate.guest.id)
        return pending === undefined ? [] : [pending]
      }))
      for (const [, candidate] of owned) {
        candidate.releaseInput?.()
        delete candidate.releaseInput
        const guest = candidate.guest
        if (guest !== undefined && !guest.isDestroyed()) {
          const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
          guest.close({ waitForBeforeUnload: false })
          await destroyed
        }
        delete candidate.guest
      }
      const browserSession = session.fromPartition(partition)
      await browserSession.closeAllConnections()
      await browserSession.clearStorageData()
      await browserSession.clearCache()
      await browserSession.clearAuthCache()
      browserSession.flushStorageData()
      for (const [id] of owned) this.leases.delete(id)
    } finally {
      this.clearing.delete(storageKey)
    }
  }

  /**
   * Release only a lease issued to this application window; workspace storage survives.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   */
  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    if (this.clearing.has(lease.storageKey)) return
    lease.releaseInput?.()
    this.leases.delete(key)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  /**
   * Install attachment checks before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void): void {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id as DesktopBrowserLeaseId)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attachedLease: DesktopBrowserLeaseId | undefined
      // The first document is an inert about:blank carrying the approved lease.
      // Bind on the main-process event before the renderer can navigate the ready guest.
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = (url.startsWith('about:blank#') ? url.slice('about:blank#'.length) : '') as DesktopBrowserLeaseId
        const lease = this.leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attachedLease = id
        lease.releaseInput = attachInput(guest, id)
        guest.once('destroyed', () => {
          lease.releaseInput?.()
          delete lease.guest
          if (!this.clearing.has(lease.storageKey)) this.leases.delete(id)
        })
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (attachedLease !== undefined && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed()
          && postBody === undefined && this.allowedNavigation(url)) {
          const request: DesktopBrowserOpenRequest = { lease: attachedLease, url: new URL(url).href }
          owner.send(DESKTOP_IPC.browserOpenRequested, request)
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
      })
      guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
    const releaseAll = (): void => {
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error: unknown) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  private configureSession(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event) => { event.preventDefault() })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol) })
    })
  }

  private assertWorkspace(workspace: unknown): asserts workspace is string {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
  }

  private partitionFor(workspace: string): string {
    const key = createHash('sha256').update(JSON.stringify([this.profileIdentity, workspace])).digest('hex')
    return `persist:dsh-sidebar-browser-${key}`
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    // The Host listens on a private ephemeral port. Deny that port regardless of
    // hostname so loopback aliases and DNS names cannot bypass guest isolation.
    return url.port === host.port
  }
}
