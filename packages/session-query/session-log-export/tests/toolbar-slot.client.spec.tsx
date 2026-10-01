// @vitest-environment jsdom
/**
 * The log ID and export as a person meets them: the plugin mounted on the real slot
 * renderer, rendered into the Trajectory toolbar seat and the Session Header menu
 * seat of one Session, with the browser's clipboard, fetch, and download stubbed.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import * as localePlugin from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'

const SID = 'session-8f261bbc-706e-4817-b5f7-1e2f6dfa3401' as SessionId
const SAVED_FILENAME = 'dsh-session-session-8f261bbc-706e-4817-b5f7-1e2f6dfa3401.zip'
const EXPORT_ROUTE = `api/session.export?sessionId=${SID}&includeDescendants=true`

let runtime: SlotTestRuntime | undefined
let writeText: ReturnType<typeof vi.fn>
let saves: { href: string | null; download: string }[]

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  saves = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    saves.push({ href: this.getAttribute('href'), download: this.download })
  })
})

afterEach(async () => {
  cleanup()
  await runtime?.dispose()
  runtime = undefined
  Reflect.deleteProperty(navigator, 'clipboard')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Mount the plugin on a real slot tree and render both of its seats for one Session. */
async function boot() {
  const rt = await SlotTestRuntime.create()
  runtime = rt
  await rt.declare({
    'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    'conversation.trajectory.toolbar': { kind: 'list', scope: 'session' },
  })
  // The locale plugin backs the `t` seat the renderer hands a localized entry.
  rt.ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  rt.ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  await rt.mount(localePlugin)
  await rt.mount({ inject: [...inject], apply })
  const id = await rt.sessions.add({ id: SID })
  const session = rt.sessions.retain(id)
  await session.ready
  const header = rt.renderSlot('conversation.session.header.utilities', {}, { session })
  const toolbar = rt.renderSlot('conversation.trajectory.toolbar', {}, { session })
  return { rt, header, toolbar }
}

describe('log ID and export in English', () => {
  usePinnedBrowserLanguages('en-US')

  it('shows the short log ID and keeps the full id out of the toolbar text', async () => {
    const { toolbar } = await boot()
    const group = toolbar.view.getByRole('group', { name: 'Session log' })
    expect(group.textContent).toContain('Log ID')
    expect(group.textContent).toContain('8f261bbc')
    expect(group.textContent).not.toContain('706e')
    expect(toolbar.view.getByRole('button', { name: 'Copy log ID' })).toBeTruthy()
    expect(toolbar.view.getByRole('button', { name: 'Export log' })).toBeTruthy()
  })

  it('reveals the full log ID when the short one is hovered', async () => {
    const { toolbar } = await boot()
    fireEvent.mouseEnter(toolbar.view.getByText('8f261bbc'))
    expect(await screen.findByText(`Full log ID: ${SID}`)).toBeTruthy()
  })

  it('copies the full log ID and confirms it', async () => {
    const { toolbar } = await boot()
    fireEvent.click(toolbar.view.getByRole('button', { name: 'Copy log ID' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Log ID copied')
    expect(writeText).toHaveBeenCalledExactlyOnceWith(SID)
  })

  it('lets the confirmation fade, and restarts it when the log ID is copied again', async () => {
    const { toolbar } = await boot()
    const copy = toolbar.view.getByRole('button', { name: 'Copy log ID' })
    const settleCopy = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
    vi.useFakeTimers()
    try {
      fireEvent.click(copy)
      await settleCopy()
      expect(screen.getByRole('alert').textContent).toBe('Log ID copied')
      act(() => { vi.advanceTimersByTime(1500) })
      expect(screen.queryByRole('alert')).not.toBeNull()

      fireEvent.click(copy)
      await settleCopy()
      act(() => { vi.advanceTimersByTime(1500) })
      expect(screen.queryByRole('alert')).not.toBeNull()
      act(() => { vi.advanceTimersByTime(5000) })
      expect(screen.queryByRole('alert')).toBeNull()
      expect(writeText).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says so when the clipboard refuses the log ID', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    const { toolbar } = await boot()
    fireEvent.click(toolbar.view.getByRole('button', { name: 'Copy log ID' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Could not copy the log ID')
  })

  it('exports through the existing Session export and reports that the download started', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const { toolbar } = await boot()
    fireEvent.click(toolbar.view.getByRole('button', { name: 'Export log' }))
    expect(await screen.findByRole('dialog', { name: 'Session download started' })).toBeTruthy()
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(EXPORT_ROUTE, expect.objectContaining({ method: 'HEAD' }))
    expect(saves).toEqual([{ href: EXPORT_ROUTE, download: SAVED_FILENAME }])
  })

  it('shows why the export failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('the stored log is unreadable', { status: 500 })))
    const { toolbar } = await boot()
    fireEvent.click(toolbar.view.getByRole('button', { name: 'Export log' }))
    const dialog = await screen.findByRole('dialog', { name: 'Session export failed' })
    expect(dialog.textContent).toContain('Export failed: HTTP 500 the stored log is unreadable')
    expect(saves).toEqual([])
  })

  it('holds the export button while this Session downloads', async () => {
    let release!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve })))
    const { toolbar } = await boot()
    const button = toolbar.view.getByRole('button', { name: 'Export log' }) as HTMLButtonElement
    fireEvent.click(button)
    await waitFor(() => { expect(button.disabled).toBe(true) })
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(await screen.findByRole('dialog', { name: 'Exporting Session' })).toBeTruthy()
    await act(async () => { release(new Response(null, { status: 200 })) })
    await waitFor(() => { expect(button.disabled).toBe(false) })
    expect(button.getAttribute('aria-busy')).toBe('false')
  })

  it('offers the log ID, its copy, and the export in the Session Header menu', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const { header } = await boot()

    fireEvent.click(header.view.getByRole('button', { name: 'More actions' }))
    expect(screen.getByText('Log ID: 8f261bbc')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy log ID' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect((await screen.findByRole('alert')).textContent).toBe('Log ID copied')
    expect(writeText).toHaveBeenCalledExactlyOnceWith(SID)

    fireEvent.click(header.view.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download session log' }))
    expect(await screen.findByRole('dialog', { name: 'Session download started' })).toBeTruthy()
    expect(saves).toEqual([{ href: EXPORT_ROUTE, download: SAVED_FILENAME }])
  })
})

describe('log ID and export in Chinese', () => {
  usePinnedBrowserLanguages('zh-CN')

  it('labels the log ID, its copy, and the export in Chinese', async () => {
    const { toolbar } = await boot()
    const group = toolbar.view.getByRole('group', { name: '会话日志' })
    expect(group.textContent).toContain('日志 ID')
    expect(group.textContent).toContain('8f261bbc')
    expect(toolbar.view.getByRole('button', { name: '复制日志 ID' })).toBeTruthy()
    expect(toolbar.view.getByRole('button', { name: '导出日志' })).toBeTruthy()
    fireEvent.click(toolbar.view.getByRole('button', { name: '复制日志 ID' }))
    expect((await screen.findByRole('alert')).textContent).toBe('日志 ID 已复制')
  })
})
