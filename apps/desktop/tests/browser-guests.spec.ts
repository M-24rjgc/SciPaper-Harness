/** Workspace-owned Electron browser storage and guest isolation. */
/* oxlint-disable typescript/unbound-method -- Electron WebContents fixture methods below are vi.fn mocks. */

import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { EventEmitter } from 'node:events'
import type { BrowserWindow, WebContents } from 'electron'

interface BrowserSessionFixture {
  cookie: string | undefined
  readonly setPermissionRequestHandler: ReturnType<typeof vi.fn>
  readonly setPermissionCheckHandler: ReturnType<typeof vi.fn>
  readonly setDevicePermissionHandler: ReturnType<typeof vi.fn>
  readonly setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>
  readonly on: ReturnType<typeof vi.fn>
  readonly webRequest: { readonly onBeforeRequest: ReturnType<typeof vi.fn> }
  readonly closeAllConnections: ReturnType<typeof vi.fn>
  readonly clearStorageData: Mock<() => Promise<void>>
  readonly clearCache: ReturnType<typeof vi.fn>
  readonly clearAuthCache: ReturnType<typeof vi.fn>
  readonly flushStorageData: ReturnType<typeof vi.fn>
}

const state = vi.hoisted(() => ({ sessions: new Map<string, BrowserSessionFixture>(), focused: undefined as WebContents | undefined }))
vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: { fromWebContents: () => ({ isFocused: () => true }) },
  webContents: { getFocusedWebContents: () => state.focused ?? null },
  session: {
    fromPartition(partition: string) {
      let current = state.sessions.get(partition)
      if (current === undefined) {
        current = {
          cookie: undefined,
          setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
          setDevicePermissionHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn(),
          on: vi.fn(), webRequest: { onBeforeRequest: vi.fn() },
          closeAllConnections: vi.fn(async () => {}),
          clearStorageData: vi.fn(async () => { if (current !== undefined) current.cookie = undefined }),
          clearCache: vi.fn(async () => {}), clearAuthCache: vi.fn(async () => {}),
          flushStorageData: vi.fn(async () => {}),
        }
        state.sessions.set(partition, current)
      }
      return current
    },
  },
}))

const { DesktopBrowserGuests } = await import('../src/browser-guests.ts')
const owner = {} as WebContents

afterEach(() => { state.sessions.clear(); state.focused = undefined })

it('keeps one persistent partition per desktop profile and workspace across app recreation', () => {
  const first = new DesktopBrowserGuests(() => undefined, 'C:\\Profiles\\Research')
  const again = new DesktopBrowserGuests(() => undefined, 'C:\\Profiles\\Research')
  const otherProfile = new DesktopBrowserGuests(() => undefined, 'C:\\Profiles\\Other')
  const a = first.acquire(owner, 'cwd:C:\\Research\\Study', 'session-a')
  const b = again.acquire(owner, 'cwd:C:\\Research\\Study', 'session-b')
  expect(a.partition).toMatch(/^persist:dsh-sidebar-browser-[a-f0-9]{64}$/u)
  expect(a.partition).toBe(b.partition)
  expect(a.lease).not.toBe(b.lease)
  expect(first.acquire(owner, 'session:another', 'session-a').partition).not.toBe(a.partition)
  expect(otherProfile.acquire(owner, 'cwd:C:\\Research\\Study', 'session-a').partition).not.toBe(a.partition)
  expect(a.partition).not.toContain('Research')
})

it('clears only the selected workspace site data while retaining its storage identity', async () => {
  const guests = new DesktopBrowserGuests(() => undefined, 'C:\\Profiles\\Research')
  const selected = guests.acquire(owner, 'cwd:study', 'session-a')
  const untouched = guests.acquire(owner, 'cwd:other', 'session-b')
  const selectedSession = state.sessions.get(selected.partition)!
  const untouchedSession = state.sessions.get(untouched.partition)!
  selectedSession.cookie = 'signed-in'
  untouchedSession.cookie = 'other-account'
  await guests.clearWorkspaceData(owner, 'cwd:study', 'session-a', selected.lease)
  expect(selectedSession.cookie).toBeUndefined()
  expect(untouchedSession.cookie).toBe('other-account')
  expect(selectedSession.closeAllConnections).toHaveBeenCalledOnce()
  expect(selectedSession.clearStorageData).toHaveBeenCalledOnce()
  expect(selectedSession.clearCache).toHaveBeenCalledOnce()
  expect(selectedSession.clearAuthCache).toHaveBeenCalledOnce()
  expect(selectedSession.flushStorageData).toHaveBeenCalledOnce()
  expect(untouchedSession.clearStorageData).not.toHaveBeenCalled()
  expect(guests.acquire(owner, 'cwd:study', 'session-a').partition).toBe(selected.partition)
})

it('clears the live lease partition after its Workspace registration changes', async () => {
  const guests = new DesktopBrowserGuests(() => undefined, 'C:\\Profiles\\Research')
  const original = guests.acquire(owner, 'cwd:/removed-workspace', 'session-a')
  const fallback = guests.acquire(owner, 'session:session-a', 'session-a')
  const originalStore = state.sessions.get(original.partition)!
  const fallbackStore = state.sessions.get(fallback.partition)!
  originalStore.cookie = 'old-site-account'
  fallbackStore.cookie = 'new-site-account'
  await expect(guests.clearWorkspaceData(owner, 'session:session-a', 'session-b', original.lease))
    .rejects.toThrow('does not belong')
  await expect(guests.clearWorkspaceData(owner, 'session:session-a', 'session-a', 'missing'))
    .rejects.toThrow('does not belong')
  await guests.clearWorkspaceData(owner, 'session:session-a', 'session-a', original.lease)
  expect(originalStore.cookie).toBeUndefined()
  expect(fallbackStore.cookie).toBe('new-site-account')
  expect(originalStore.clearStorageData).toHaveBeenCalledOnce()
  expect(fallbackStore.clearStorageData).not.toHaveBeenCalled()
})

it('retains the original lease for a clear retry after storage removal fails', async () => {
  const guests = new DesktopBrowserGuests(() => undefined, 'C:\\Profiles\\Research')
  const reservation = guests.acquire(owner, 'cwd:/study', 'session-a')
  const storage = state.sessions.get(reservation.partition)!
  storage.cookie = 'site-account'
  storage.clearStorageData.mockRejectedValueOnce(new Error('storage busy'))
  await expect(guests.clearWorkspaceData(owner, 'session:session-a', 'session-a', reservation.lease))
    .rejects.toThrow('storage busy')
  expect(storage.cookie).toBe('site-account')
  await guests.clearWorkspaceData(owner, 'session:session-a', 'session-a', reservation.lease)
  expect(storage.cookie).toBeUndefined()
  expect(storage.clearStorageData).toHaveBeenCalledTimes(2)
})

it('rejects invalid identities, other window ownership, and acquisition during clearing', async () => {
  const guests = new DesktopBrowserGuests(() => undefined, 'C:\\Profiles\\Research')
  const otherOwner = {} as WebContents
  expect(() => guests.acquire(owner, '', 'session-a')).toThrow('workspace storage identity')
  expect(() => guests.acquire(owner, 'cwd:owned', '')).toThrow('conversation identity')
  await expect(guests.clearWorkspaceData(owner, 'x'.repeat(4097), 'session-a', 'lease')).rejects.toThrow('workspace storage identity')
  const reservation = guests.acquire(otherOwner, 'cwd:owned', 'session-a')
  await expect(guests.clearWorkspaceData(owner, 'cwd:owned', 'session-a', reservation.lease)).rejects.toThrow('does not belong')
  expect(state.sessions.get(reservation.partition)?.clearStorageData).not.toHaveBeenCalled()
  const own = guests.acquire(owner, 'cwd:clear', 'session-a')
  const current = state.sessions.get(own.partition)!
  const ready = Promise.withResolvers<undefined>()
  current.clearStorageData.mockImplementationOnce(() => ready.promise)
  const clearing = guests.clearWorkspaceData(owner, 'cwd:clear', 'session-a', own.lease)
  expect(() => guests.acquire(owner, 'cwd:clear', 'session-a')).toThrow('being cleared')
  ready.resolve(undefined)
  await clearing
  expect(guests.acquire(owner, 'cwd:clear', 'session-a').partition).toBe(own.partition)
})

it('operates the actual attached guest only for its owning conversation', async () => {
  const guests = new DesktopBrowserGuests(() => 'http://127.0.0.1:19387/', 'C:\\Profiles\\Research')
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, executeJavaScript: vi.fn(async () => true), focus: vi.fn(),
  }) as Pick<WebContents, 'isDestroyed'> as WebContents
  state.focused = contents
  const window = { webContents: contents } as BrowserWindow
  guests.bind(window, () => () => {})
  const reservation = guests.acquire(contents, 'cwd:study', 'session-a')
  let url = `about:blank#${reservation.lease}`
  const guest = Object.assign(new EventEmitter(), {
    id: 1, getURL: () => url, getTitle: () => 'Research page', isDestroyed: () => false,
    setWindowOpenHandler: vi.fn(), focus: vi.fn(),
    debugger: {
      isAttached: vi.fn(() => false), attach: vi.fn(), detach: vi.fn(),
      sendCommand: vi.fn(async (command: string) => command === 'Page.captureScreenshot'
        ? { data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') } : undefined),
    },
    executeJavaScript: vi.fn(async (script: string) => {
      if (script.includes('?.done === true')) return true
      if (script.includes('document.body?.innerText')) {
        return { text: 'Observed page', elements: [{ selector: '#run', name: 'Run' }] }
      }
      if (script.includes('document.activeElement === matches[0]')) return true
      if (script.includes('getBoundingClientRect')) return { x: 20, y: 30, width: 20, height: 10 }
      return { width: 800, height: 600 }
    }),
    capturePage: vi.fn(async () => ({ isEmpty: () => false,
      toPNG: () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) })),
    loadURL: vi.fn(async (next: string) => { url = next }),
    close: vi.fn(),
  }) as Pick<WebContents, 'isDestroyed'> as WebContents
  vi.mocked(guest.focus).mockImplementation(() => { state.focused = guest })
  const attach = { preventDefault: vi.fn() }
  contents.emit('will-attach-webview', attach, {}, { src: url, partition: reservation.partition })
  expect(attach.preventDefault).not.toHaveBeenCalled()
  contents.emit('did-attach-webview', {}, guest)
  guest.emit('dom-ready')
  url = 'https://example.test/app'

  expect(await guests.operate({ action: 'list', sessionId: 'session-a' }))
    .toEqual([{ tabId: reservation.lease, url, title: 'Research page' }])
  expect(await guests.operate({ action: 'list', sessionId: 'session-b' })).toEqual([])
  await expect(guests.operate({ action: 'inspect', sessionId: 'session-b', tabId: reservation.lease }))
    .rejects.toThrow('no open tab belongs')
  expect(await guests.operate({ action: 'inspect', sessionId: 'session-a' }))
    .toMatchObject({ tabId: reservation.lease, page: { text: 'Observed page' } })
  await guests.operate({ action: 'click', sessionId: 'session-a', selector: '#run' })
  expect(guest.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent',
    expect.objectContaining({ type: 'mousePressed', x: 20, y: 30 }))
  const priorInputs = vi.mocked(guest.debugger.sendCommand).mock.calls.length
  vi.mocked(contents.executeJavaScript).mockResolvedValueOnce(false)
  await expect(guests.operate({ action: 'click', sessionId: 'session-a', selector: '#hidden' }))
    .rejects.toThrow('Browser tab is not visible')
  vi.mocked(guest.executeJavaScript).mockResolvedValueOnce({ matchCount: 2 })
  await expect(guests.operate({ action: 'click', sessionId: 'session-a', selector: '.repeated' }))
    .rejects.toThrow('matched multiple elements')
  vi.mocked(guest.executeJavaScript).mockResolvedValueOnce({ hidden: true })
  await expect(guests.operate({ action: 'click', sessionId: 'session-a', selector: '#covered' }))
    .rejects.toThrow('target is not visible')
  vi.mocked(guest.executeJavaScript).mockResolvedValueOnce({ refused: true })
  await expect(guests.operate({ action: 'type', sessionId: 'session-a', selector: '#password', text: 'secret' }))
    .rejects.toThrow('non-password input')
  expect(vi.mocked(guest.debugger.sendCommand).mock.calls.length).toBe(priorInputs)
  await guests.operate({ action: 'type', sessionId: 'session-a', selector: '#query', text: 'fractional diffusion' })
  expect(guest.debugger.sendCommand).toHaveBeenCalledWith('Input.insertText', { text: 'fractional diffusion' })
  await guests.operate({ action: 'scroll', sessionId: 'session-a', deltaY: 400 })
  expect(guest.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent',
    expect.objectContaining({ type: 'mouseWheel', deltaY: 400 }))
  expect(await guests.operate({ action: 'screenshot', sessionId: 'session-a' }))
    .toMatchObject({ tabId: reservation.lease, png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') })
  vi.mocked(guest.debugger.isAttached).mockReturnValueOnce(true)
  expect(await guests.operate({ action: 'screenshot', sessionId: 'session-a' }))
    .toMatchObject({ tabId: reservation.lease, png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') })
  expect(guest.capturePage).toHaveBeenCalledOnce()
  await guests.operate({ action: 'navigate', sessionId: 'session-a', url: 'https://example.test/next' })
  expect(url).toBe('https://example.test/next')
  const heldNavigation = Promise.withResolvers<undefined>()
  const navigationEntered = Promise.withResolvers<undefined>()
  vi.mocked(guest.loadURL).mockImplementationOnce(async (next: string) => {
    navigationEntered.resolve(undefined)
    await heldNavigation.promise
    url = next
  })
  const navigating = guests.operate({ action: 'navigate', sessionId: 'session-a', url: 'https://example.test/hold' })
  await navigationEntered.promise
  const cancellation = new AbortController()
  const priorCommands = vi.mocked(guest.debugger.sendCommand).mock.calls.length
  const queuedClick = guests.operate({ action: 'click', sessionId: 'session-a', selector: '#run' }, cancellation.signal)
  cancellation.abort()
  heldNavigation.resolve(undefined)
  await navigating
  await expect(queuedClick).rejects.toThrow()
  expect(guest.debugger.sendCommand).toHaveBeenCalledTimes(priorCommands)
  await expect(guests.operate({ action: 'navigate', sessionId: 'session-a', url: 'file:///secret' }))
    .rejects.toThrow('restricted to HTTP(S)')
  await expect(guests.operate({ action: 'navigate', sessionId: 'session-a', url: 'http://127.0.0.1:19387/' }))
    .rejects.toThrow('restricted to HTTP(S)')
  await expect(guests.operate({ action: 'navigate', sessionId: 'session-a', url: 'http://localhost.:19387/' }))
    .rejects.toThrow('restricted to HTTP(S)')
  const storage = state.sessions.get(reservation.partition)!
  storage.clearStorageData.mockRejectedValueOnce(new Error('storage busy'))
  vi.mocked(guest.close).mockImplementationOnce(() => { guest.emit('destroyed') })
  await expect(guests.clearWorkspaceData(contents, 'session:session-a', 'session-a', reservation.lease))
    .rejects.toThrow('storage busy')
  await guests.clearWorkspaceData(contents, 'session:session-a', 'session-a', reservation.lease)
  expect(storage.clearStorageData).toHaveBeenCalledTimes(2)
})

it('closes a stalled Electron guest before it can block the operation queue indefinitely', async () => {
  const guests = new DesktopBrowserGuests(() => undefined, 'C:\\Profiles\\Research')
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as WebContents
  guests.bind({ webContents: contents } as BrowserWindow, () => () => {})
  const reservation = guests.acquire(contents, 'cwd:study', 'session-a')
  let url = `about:blank#${reservation.lease}`
  const entered = Promise.withResolvers<undefined>()
  const hanging = Promise.withResolvers<undefined>()
  const guest = Object.assign(new EventEmitter(), {
    id: 91, getURL: () => url, getTitle: () => 'Stalled page', isDestroyed: () => false,
    setWindowOpenHandler: vi.fn(), close: vi.fn(),
    loadURL: vi.fn(async () => { entered.resolve(undefined); await hanging.promise }),
  }) as Pick<WebContents, 'isDestroyed'> as WebContents
  vi.mocked(guest.close).mockImplementation(() => { guest.emit('destroyed') })
  contents.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: url, partition: reservation.partition })
  contents.emit('did-attach-webview', {}, guest)
  guest.emit('dom-ready')
  url = 'https://example.test/'
  vi.useFakeTimers()
  try {
    const navigating = guests.operate({ action: 'navigate', sessionId: 'session-a', url: 'https://example.test/slow' })
    const timedOut = expect(navigating).rejects.toThrow(/navigate timed out.*action may have completed/)
    await entered.promise
    await vi.advanceTimersByTimeAsync(25_000)
    await timedOut
    expect(guest.close).toHaveBeenCalledOnce()
    expect(await guests.operate({ action: 'list', sessionId: 'session-a' })).toEqual([])
    await expect(guests.operate({ action: 'inspect', sessionId: 'session-a', tabId: reservation.lease }))
      .rejects.toThrow('no open tab belongs')
    expect(guests.acquire(contents, 'cwd:study', 'session-a').lease).not.toBe(reservation.lease)
  } finally {
    hanging.resolve(undefined)
    vi.useRealTimers()
  }
})
