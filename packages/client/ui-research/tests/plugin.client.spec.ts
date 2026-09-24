// @vitest-environment jsdom

/**
 * What the research plugin contributes, and what the face it injects into every
 * seat actually does. The slot registry is real, because "registered" is
 * exactly what the registry says it is; the Remote, locale, layout, session and
 * right-sidebar faces are recorders, because what matters here is the call each
 * action makes, the state it leaves in the two stores, and that disposing the
 * fiber takes back every registration and stops the polling clock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  CreateProjectRequest, ResearchCommand, ResearchProject, ResearchResponse, ResearchSnapshot, ResearchTask,
} from '@deepseek-ai/dsh-research-workbench/types'
import { apply as applyHost } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { ResearchBrand, ResearchMark, Workbench } from '../src/client/Workbench.tsx'
import { ResearchDock, ResearchHeroMark, ResearchPromise } from '../src/client/Hero.tsx'
import { ResearchRail, ResearchRailTitle } from '../src/client/Rail.tsx'
import { ResearchClaimSheet } from '../src/client/ClaimSheet.tsx'
import { ResearchRuns } from '../src/client/RunPanel.tsx'
import { ResearchProjectActions, ResearchStatusChip } from '../src/client/Header.tsx'
import { ResearchSettingsSection } from '../src/client/ResearchSettings.tsx'
import { SkipHarnessNotice } from '../src/client/Onboarding.tsx'
import type { ResearchFocus, ResearchInjected, ResearchView, WorkbenchProps } from '../src/client/contract.ts'
import { en, zh } from '../src/client/locales.ts'

/** This implementation's identity in the right-sidebar tab system (private to the plugin). */
const TAB_ID = '@deepseek-ai/dsh-client-ui-research'

const CLAIM_ID = 'claim-sparse'
const CLAIM_TEXT = 'Block-sparse attention holds accuracy at a quarter of the FLOPs.'

/** Enough project for the claim sheet: the sheet only reads claims, artifacts, evidence and runs. */
const PROJECT = {
  id: 'project-sparse',
  title: 'Sparse attention scaling study',
  claims: [{
    id: CLAIM_ID,
    text: CLAIM_TEXT,
    kind: 'empirical',
    state: 'supported',
    evidence: [],
    artifactIds: [],
  }],
  artifacts: [],
  evidence: [],
  experiments: [],
} as unknown as ResearchProject

const BLANK: ResearchSnapshot = { projects: [], preferences: {}, components: [], modes: [] }
const LOADED: ResearchSnapshot = { projects: [PROJECT], preferences: {}, components: [], modes: [] }
const OUTCOME: ResearchResponse = { message: 'experiment submitted' }
const NEW_PROJECT: CreateProjectRequest = { title: 'Sparse attention', root: '/tmp/sparse', brief: '' }
const CHECK: ResearchCommand = { action: 'check', projectId: PROJECT.id }

/** One durable task handle in the shape the Host stores it. */
function task(id: string, status: ResearchTask['status'], message: string, result?: ResearchResponse): ResearchTask {
  return {
    id,
    kind: 'stage',
    status,
    message,
    createdAt: '2026-09-20T08:00:00.000Z',
    ...(result === undefined ? {} : { result }),
  }
}

/** What one Remote method answers with. */
type Answer<T> = Promise<RemoteResult<T>>

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function bad(message: string): RemoteResult<never> {
  return { ok: false, error: { message } as never }
}

/** A promise this spec settles by hand, so an in-flight call can be observed. */
function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void; fail: (reason: unknown) => void } {
  let settle!: (value: T) => void
  let fail!: (reason: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  return { promise, settle, fail }
}

/** One contributed right-sidebar tab type, as the registry records it. */
interface TabType {
  id: string
  kind: string
  priority: string
  title: () => string
  guide: { id: string; order: number; title: () => string; description: () => string; icon: unknown }[]
}

const live: { dispose: () => Promise<void> }[] = []

afterEach(async () => {
  cleanup()
  for (const fiber of live.splice(0)) await fiber.dispose()
  vi.useRealTimers()
})

async function bench(history: ResearchTask[] = []) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  // The frame this plugin registers into: every seat it takes has to be
  // declared by somebody, and the declaration is what authorizes the entry.
  ctx.slots.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.brand.name': { kind: 'single', scope: 'root' },
      'sidebar.brand.mark': { kind: 'single', scope: 'root' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'sidebar.projects': { kind: 'list', scope: 'root' },
      'conversation.hero.welcome': { kind: 'list', scope: 'root' },
      'conversation.hero.footer': { kind: 'list', scope: 'root' },
      'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.composer.dock': { kind: 'list', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.onboarding': { kind: 'list', scope: 'root' },
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
      'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)

  const remote = {
    snapshot: vi.fn((): Answer<ResearchSnapshot> => Promise.resolve(ok(BLANK))),
    tasks: vi.fn((): Answer<ResearchTask[]> => Promise.resolve(ok(history))),
    create: vi.fn((_request: CreateProjectRequest): Answer<ResearchProject> => Promise.resolve(ok(PROJECT))),
    command: vi.fn((_request: ResearchCommand, _signal: AbortSignal): Answer<ResearchResponse> => Promise.resolve(ok(OUTCOME))),
    configure: vi.fn((_preferences: unknown): Answer<unknown> => Promise.resolve(ok({}))),
    setCredential: vi.fn((_kind: 'image' | 'embedding', _key: string): Answer<void> => Promise.resolve(ok(undefined))),
    installComponent: vi.fn((_component: string): Answer<ResearchResponse> => Promise.resolve(ok(OUTCOME))),
  }
  const directoryPicker = {
    pick: vi.fn((): Answer<string | null> => Promise.resolve(ok('/picked/project'))),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    register: vi.fn((namespace: string, dicts: unknown) => {
      dictionaries.set(namespace, dicts)
      return () => { dictionaries.delete(namespace) }
    }),
    // The English dictionary answers, so a thunked label proves the key resolved.
    bind: vi.fn(() => (key: string) => (en as Record<string, string>)[key] ?? key),
  }
  const layout = { selectPanel: vi.fn(), setInitialRightbarWidth: vi.fn() }
  const listeners = new Set<() => void>()
  let listed: Record<string, { cwd?: string }> = { 'session-a': { cwd: 'C:\\research\\sparse' }, 'session-b': {} }
  const list = {
    getSnapshot: () => ({ byId: listed }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const commandResult: { current: RemoteResult<{ matched: boolean }> } = { current: ok({ matched: true }) }
  const face = { command: vi.fn((_line: string) => Promise.resolve(commandResult.current)) }
  const sessions = {
    open: vi.fn(),
    list,
    binding: vi.fn((id: string) => id === 'session-a' ? { session: face } : undefined),
  }
  const publishSessions = (next: Record<string, { cwd?: string }>): void => { listed = next; for (const listener of listeners) listener() }
  const sidebarRight = { openTab: vi.fn(), openResource: vi.fn() }
  const tabs: TabType[] = []
  const sidebarRightTabs = {
    register: vi.fn((definition: TabType) => {
      tabs.push(definition)
      return () => { tabs.splice(tabs.indexOf(definition), 1) }
    }),
  }

  ctx.provide('remote', { research: remote, directoryPicker } as never)
  ctx.provide('remote.research', remote as never)
  ctx.provide('remote.directoryPicker', directoryPicker as never)
  ctx.provide('locale', locale as never)
  ctx.provide('layout', layout as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('sidebarRight', sidebarRight as never)
  ctx.provide('sidebarRightTabs', sidebarRightTabs as never)

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  live.push(fiber)

  const seat = (name: string, cell?: string): StoredEntry => {
    const entries = ctx.slots.entries(name as never)
    return (cell === undefined
      ? entries[0]
      : entries.find(entry => entry.options.id === cell || entry.options.key === cell))!
  }
  // Every seat is handed the same face; the plugin's own closure is behind it.
  const injected = (seat('main').inject as unknown as () => ResearchInjected)()
  // apply() starts one read of its own; joining it leaves the store settled.
  await injected.refresh()
  return {
    ctx, dictionaries, directoryPicker, face: injected, fiber, layout, locale, remote, seat, sessions, tabs,
    sessionFace: face, commandResult, publishSessions, sidebarRight,
  }
}

/** Dispose a bench's fiber once, and keep the shared teardown from repeating it. */
async function stop(target: { fiber: { dispose: () => Promise<void> } }): Promise<void> {
  live.splice(live.indexOf(target.fiber), 1)
  await target.fiber.dispose()
}

describe('the research plugin', () => {
  it('suggests the research rail width only when opening a project', async () => {
    const b = await bench()
    expect(b.layout.setInitialRightbarWidth).not.toHaveBeenCalled()
    b.face.showProgress?.()
    expect(b.layout.setInitialRightbarWidth).toHaveBeenCalledWith(320)
  })

  it('hands the first run past the harness notice at once, showing nothing', () => {
    const complete = vi.fn()
    const view = render(createElement(SkipHarnessNotice, { stepId: 'welcome-notice', complete, openSection: vi.fn() }))
    expect(view.container.innerHTML).toBe('')
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('keeps the host half empty', () => {
    expect(() => { applyHost() }).not.toThrow()
    expect(inject).toEqual([
      'remote', 'remote.research', 'remote.directoryPicker', 'slots', 'locale', 'layout', 'sessions', 'sidebarRight',
    ])
  })

  it('takes every seat it needs, and gives all of them back with the fiber', async () => {
    const b = await bench()

    expect(b.dictionaries.get('research')).toEqual({ en, zh })
    expect(b.seat('main', 'research')).toMatchObject({ locale: 'research', component: Workbench })
    expect(b.seat('sidebar.brand.name')).toMatchObject({ locale: 'research', component: ResearchBrand })
    expect(b.seat('sidebar.brand.mark')).toMatchObject({ component: ResearchMark })
    expect(b.seat('conversation.session.header.actions', 'research-status'))
      .toMatchObject({ locale: 'research', component: ResearchStatusChip, options: { order: 5 } })
    expect(b.seat('conversation.session.header.utilities', 'research-project'))
      .toMatchObject({ locale: 'research', component: ResearchProjectActions, options: { order: 5 } })
    expect(b.seat('conversation.hero.brand.mark')).toMatchObject({ component: ResearchHeroMark })
    expect(b.seat('conversation.input.dock', 'research-openings'))
      .toMatchObject({ locale: 'research', component: ResearchDock, options: { order: 5 } })
    expect(b.seat('conversation.input.dock', 'research-runs'))
      .toMatchObject({ locale: 'research', component: ResearchRuns, options: { order: 6 } })
    expect(b.seat('shell.overlay', 'research-claim'))
      .toMatchObject({ locale: 'research', component: ResearchClaimSheet, options: { order: 20 } })
    expect(b.seat('conversation.hero.footer', 'research-promise'))
      .toMatchObject({ locale: 'research', component: ResearchPromise, options: { order: 5 } })
    expect(b.seat('sidebar.right.pane.tab', TAB_ID)).toMatchObject({ locale: 'research', component: ResearchRail })
    expect(b.seat('sidebar.right.pane.tab.title', TAB_ID)).toMatchObject({ locale: 'research', component: ResearchRailTitle })

    // The settings row names itself through the dictionary, at read time.
    const settings = b.seat('settings.section', 'research')
    expect(settings).toMatchObject({ locale: 'research', component: ResearchSettingsSection, options: { order: 25 } })
    expect((settings.options.label as () => string)()).toBe(en.settingsSection)

    // The harness's own first-run notice is shadowed: a lower priority renders instead of it.
    expect(b.seat('settings.onboarding', 'welcome-notice')).toMatchObject({ component: SkipHarnessNotice, options: { priority: -1 } })

    // The record reports beside the conversation as a builtin tab type.
    expect(b.tabs).toHaveLength(1)
    const type = b.tabs[0]!
    expect([type.id, type.kind, type.priority]).toEqual([TAB_ID, 'research', 'builtin'])
    expect(type.title()).toBe(en.railTitle)
    expect(type.guide.map(entry => [entry.id, entry.order, entry.title(), entry.description(), entry.icon]))
      .toEqual([['research', 15, en.railGuideTitle, en.railGuideDescription, ResearchHeroMark]])

    // The file workbench is no longer a peer application: nothing lists it.
    expect(b.ctx.slots.entries('sidebar.panellist')).toHaveLength(0)

    await stop(b)

    for (const name of [
      'main', 'sidebar.brand.name', 'sidebar.brand.mark', 'conversation.session.header.actions',
      'conversation.session.header.utilities', 'conversation.hero.brand.mark', 'conversation.input.dock',
      'conversation.composer.dock', 'shell.overlay', 'settings.section', 'settings.onboarding',
      'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title',
    ]) {
      expect(b.ctx.slots.entries(name as never)).toHaveLength(0)
    }
    expect(b.tabs).toEqual([])
    expect(b.dictionaries.size).toBe(0)
  })

  it('folds each task exactly once: a result becomes the response, a failure becomes the error', async () => {
    const b = await bench()
    b.remote.snapshot.mockResolvedValue(ok(LOADED))
    b.remote.tasks.mockResolvedValue(ok([
      task('task-running', 'running', 'still going'),
      task('task-quiet', 'completed', 'nothing to say'),
      task('task-done', 'completed', 'stage finished', OUTCOME),
      task('task-broken', 'failed', 'the run never started'),
    ]))
    await b.face.refresh()

    const first = b.face.hooks.research.getSnapshot()
    expect(first.snapshot).toBe(LOADED)
    expect(first.tasks).toHaveLength(4)
    expect(first.response).toBe(OUTCOME)
    expect(first.error).toBe('the run never started')

    // A second read sees the same handles: already observed, so nothing folds again.
    b.remote.tasks.mockResolvedValue(ok([
      task('task-running', 'running', 'still going'),
      task('task-done', 'completed', 'stage finished', { message: 'a later answer' }),
      task('task-broken', 'failed', 'a later failure'),
    ]))
    await b.face.refresh()
    expect(b.face.hooks.research.getSnapshot().response).toBe(OUTCOME)
    expect(b.face.hooks.research.getSnapshot().error).toBe('the run never started')

    // The running one is only folded once it stops running.
    b.remote.tasks.mockResolvedValue(ok([task('task-running', 'completed', 'done at last', { message: 'late answer' })]))
    await b.face.refresh()
    expect(b.face.hooks.research.getSnapshot().response).toEqual({ message: 'late answer' })
  })

  it('shares one promise between concurrent reads, and keeps a rejected read as the error', async () => {
    const b = await bench()
    const pending = deferred<RemoteResult<ResearchSnapshot>>()
    b.remote.snapshot.mockClear()
    b.remote.snapshot.mockImplementationOnce(() => pending.promise)

    const first = b.face.refresh()
    const second = b.face.refresh()
    expect(second).toBe(first)
    expect(b.remote.snapshot).toHaveBeenCalledTimes(1)
    pending.settle(ok(LOADED))
    await first
    expect(b.face.hooks.research.getSnapshot().snapshot).toBe(LOADED)

    // Once it settles the next call reads again, and a rejection is reported.
    b.remote.snapshot.mockRejectedValueOnce(new Error('the carrier is down'))
    await b.face.refresh()
    expect(b.face.hooks.research.getSnapshot().error).toBe('Error: the carrier is down')
  })

  it('drops a read that lands after the fiber is gone', async () => {
    const b = await bench()
    const late = deferred<RemoteResult<ResearchSnapshot>>()
    b.remote.snapshot.mockImplementationOnce(() => late.promise)
    const settling = b.face.refresh()
    await stop(b)
    late.settle(ok(LOADED))
    await settling
    expect(b.face.hooks.research.getSnapshot().snapshot).toBe(BLANK)
  })

  it('drops a read that fails after the fiber is gone', async () => {
    const b = await bench()
    const late = deferred<RemoteResult<ResearchSnapshot>>()
    b.remote.snapshot.mockImplementationOnce(() => late.promise)
    const failing = b.face.refresh()
    await stop(b)
    late.fail(new Error('too late'))
    await failing
    expect(b.face.hooks.research.getSnapshot().error).toBe('')
  })

  it('marks itself busy around an action, and keeps whatever the action threw', async () => {
    const b = await bench()
    const slow = deferred<RemoteResult<ResearchProject>>()
    b.remote.create.mockImplementationOnce(() => slow.promise)

    const creating = b.face.create(NEW_PROJECT)
    expect(b.face.hooks.research.getSnapshot().busy).toBe(true)
    slow.settle(ok(PROJECT))
    await creating
    expect(b.face.hooks.research.getSnapshot().busy).toBe(false)
    expect(b.face.hooks.research.getSnapshot().error).toBe('')

    // A refused call: the Remote answered, the answer said no.
    b.remote.create.mockResolvedValueOnce(bad('that directory is already a project'))
    await expect(b.face.create(NEW_PROJECT)).rejects.toThrow('that directory is already a project')
    expect(b.face.hooks.research.getSnapshot().error).toBe('that directory is already a project')
    expect(b.face.hooks.research.getSnapshot().busy).toBe(false)

    // A throw that is not an Error at all.
    b.remote.create.mockRejectedValueOnce('the bridge went away')
    await expect(b.face.create(NEW_PROJECT)).rejects.toBe('the bridge went away')
    expect(b.face.hooks.research.getSnapshot().error).toBe('the bridge went away')
    expect(b.face.hooks.research.getSnapshot().busy).toBe(false)
  })

  it('sends each action to its own Remote method', async () => {
    const b = await bench()

    // The created record comes back, because the caller starts its first stage.
    expect(await b.face.create(NEW_PROJECT)).toBe(PROJECT)
    expect(b.remote.create).toHaveBeenCalledWith(NEW_PROJECT)

    expect(await b.face.pickDirectory()).toBe('/picked/project')
    expect(b.directoryPicker.pick).toHaveBeenCalledOnce()

    expect(await b.face.run(CHECK)).toBe(OUTCOME)
    expect(b.remote.command.mock.calls[0]![0]).toBe(CHECK)
    expect(b.remote.command.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
    expect(b.face.hooks.research.getSnapshot().response).toBe(OUTCOME)

    // No key, no credential write.
    await b.face.configure({ python: '/usr/bin/python3' }, { image: '', embedding: '' })
    expect(b.remote.configure).toHaveBeenCalledWith({ python: '/usr/bin/python3' })
    expect(b.remote.setCredential).not.toHaveBeenCalled()

    await b.face.configure({}, { image: 'sk-image-key', embedding: 'sk-embed-key' })
    expect(b.remote.setCredential.mock.calls).toEqual([['image', 'sk-image-key'], ['embedding', 'sk-embed-key']])

    b.remote.installComponent.mockResolvedValueOnce(ok({ message: 'python ready' }))
    await b.face.install('python')
    expect(b.remote.installComponent).toHaveBeenCalledWith('python')
    expect(b.face.hooks.research.getSnapshot().response).toEqual({ message: 'python ready' })

    // A gallery search answers with its page, and leaves the workbench's busy state and last response alone.
    const search = { action: 'find-reference-figures' as const, projectId: PROJECT.id, query: 'agent memory' }
    const gallery = {
      total: 0, offset: 0, figures: [], basis: 'keyword' as const,
      facets: { venue: {}, year: {}, pattern: {}, tier: {} }, source: { name: 'g', repository: 'r', commit: 'c', license: 'l' },
    }
    b.remote.command.mockResolvedValueOnce(ok({ message: '0 figures', gallery }))
    expect(await b.face.searchFigures(search)).toBe(gallery)
    expect(b.remote.command).toHaveBeenLastCalledWith(search, expect.any(AbortSignal))
    expect(b.face.hooks.research.getSnapshot()).toMatchObject({ busy: false, response: { message: 'python ready' } })
    b.remote.command.mockResolvedValueOnce(ok({ message: 'no page' }))
    await expect(b.face.searchFigures(search)).rejects.toThrow(/returned no page/)
    b.remote.command.mockResolvedValueOnce(bad('gallery offline'))
    await expect(b.face.searchFigures(search)).rejects.toThrow('gallery offline')

    // A board read answers with the board, and leaves the workbench alone the same way.
    const read = { action: 'board-view' as const, projectId: PROJECT.id, refresh: true }
    const board = { spec: { sections: [], collectors: [] }, refreshing: false, machines: [], series: {}, collected: {}, alerts: [] }
    b.remote.command.mockResolvedValueOnce(ok({ message: 'Experiment board', board }))
    expect(await b.face.board(read)).toBe(board)
    expect(b.remote.command).toHaveBeenLastCalledWith(read, expect.any(AbortSignal))
    expect(b.face.hooks.research.getSnapshot()).toMatchObject({ busy: false, response: { message: 'python ready' } })
    b.remote.command.mockResolvedValueOnce(ok({ message: 'nothing' }))
    await expect(b.face.board(read)).rejects.toThrow(/returned nothing/)
  })

  it('moves the frame: back to a conversation, onto the panel, and onto one claim', async () => {
    const b = await bench()

    await b.face.openConversation('session-42')
    expect(b.sessions.open).toHaveBeenCalledWith('session-42')
    expect(b.layout.selectPanel).toHaveBeenCalledWith(null)

    b.face.expand()
    expect(b.layout.selectPanel).toHaveBeenLastCalledWith('research')

    b.remote.snapshot.mockResolvedValue(ok(LOADED))
    await b.face.refresh()
    const props = {
      t: (key: string) => (zh as Record<string, string>)[key] ?? key,
      useResearch: (select: (value: ResearchView) => unknown) => select(b.face.hooks.research.getSnapshot()),
      useFocus: (select: (value: ResearchFocus) => unknown) => select(b.face.hooks.focus.getSnapshot()),
      focusClaim: (claimId: string | null) => { b.face.focusClaim(claimId) },
    } as unknown as WorkbenchProps

    const view = render(createElement(ResearchClaimSheet, props))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    // The rail and the overlay never meet; the store is how one reaches the other.
    b.face.focusClaim(CLAIM_ID)
    expect(b.face.hooks.focus.getSnapshot()).toMatchObject({ claimId: CLAIM_ID, panel: 'workflow' })
    view.rerender(createElement(ResearchClaimSheet, props))
    expect(view.getByRole('dialog').getAttribute('aria-label')).toBe(zh.claim)
    expect(view.getByText(CLAIM_TEXT)).toBeTruthy()

    b.face.focusClaim(null)
    view.rerender(createElement(ResearchClaimSheet, props))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('reads again every three seconds, until the fiber takes the clock and the signal with it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const b = await bench()
    await b.face.run(CHECK)
    const signal = b.remote.command.mock.calls[0]![1]
    expect(signal.aborted).toBe(false)

    b.remote.snapshot.mockClear()
    vi.advanceTimersByTime(3000)
    expect(b.remote.snapshot).toHaveBeenCalledTimes(1)
    await b.face.refresh()

    await stop(b)
    expect(signal.aborted).toBe(true)
    b.remote.snapshot.mockClear()
    vi.advanceTimersByTime(9000)
    expect(b.remote.snapshot).not.toHaveBeenCalled()
  })
})

describe('the face a research seat acts through', () => {
  it('runs a slash command in a live session and reports what the host refused', async () => {
    const b = await bench()
    await b.face.command('session-a', '/permission research-auto')
    expect(b.sessionFace.command).toHaveBeenCalledWith('/permission research-auto')
    b.commandResult.current = bad('no such preset')
    await expect(b.face.command('session-a', '/permission nope')).rejects.toThrow('no such preset')
    await expect(b.face.command('session-missing', '/goal x')).rejects.toThrow(/not ready/)
    expect(b.face.hooks.research.getSnapshot().error).toMatch(/not ready/)
  })

  it('opens project files in the right sidebar, and keeps a refusal as the error', async () => {
    const b = await bench()
    b.face.openFile('C:\\research\\sparse', 'paper\\main.pdf')
    expect(b.sidebarRight.openResource).toHaveBeenCalledWith('dsh-resource://file/absolute/C:/research/sparse/paper/main.pdf')
    b.sidebarRight.openResource.mockImplementationOnce(() => { throw new Error('no session is bound') })
    b.face.openFile('/r', 'x.pdf')
    expect(b.face.hooks.research.getSnapshot().error).toBe('no session is bound')
    b.sidebarRight.openResource.mockImplementationOnce(() => { throw 'plain refusal' })
    b.face.openFile('/r', 'x.pdf')
    expect(b.face.hooks.research.getSnapshot().error).toBe('plain refusal')
  })

  it('tracks every listed session\'s working directory as the list changes', async () => {
    const b = await bench()
    expect(b.face.hooks.directories.getSnapshot()).toEqual({ 'session-a': 'C:\\research\\sparse' })
    b.publishSessions({ 'session-c': { cwd: '/research/other' } })
    expect(b.face.hooks.directories.getSnapshot()).toEqual({ 'session-c': '/research/other' })
  })

  it('treats tasks already settled at the first read as history, and reports an interruption after it', async () => {
    const b = await bench()
    b.remote.tasks.mockResolvedValue(ok([task('task-late', 'interrupted', 'the application restarted')]))
    await b.face.refresh()
    expect(b.face.hooks.research.getSnapshot().error).toBe('the application restarted')
    // A fresh window over settled history reports nothing from it, on the first read or after.
    const fresh = await bench([task('task-old', 'failed', 'old failure', { message: 'old answer' })])
    await fresh.face.refresh()
    expect(fresh.face.hooks.research.getSnapshot().error).toBe('')
    expect(fresh.face.hooks.research.getSnapshot().response).toBeNull()
  })
})
