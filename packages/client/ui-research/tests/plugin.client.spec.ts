// @vitest-environment jsdom

/**
 * What the research plugin contributes, and what the face it injects into every
 * seat actually does. The slot registry is real, because "registered" is
 * exactly what the registry says it is; the Remote, locale, layout, session,
 * workspace-navigation and right-sidebar faces are recorders, because what
 * matters here is the call each action makes, what it hands back to its caller,
 * the state it leaves in the stores, and that disposing the fiber takes back
 * every registration and stops the polling clock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  CreateProjectRequest, ResearchCommand, ResearchProject, ResearchResponse, ResearchSnapshot, ResearchTask,
} from '@deepseek-ai/dsh-research-workbench/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { apply as applyHost, Config as HostConfig } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { ResearchBrand, ResearchMark, Workbench } from '../src/client/Workbench.tsx'
import { ResearchHeroMark } from '../src/client/Hero.tsx'
import { ResearchRail, ResearchRailTitle } from '../src/client/Rail.tsx'
import { ResearchClaimSheet } from '../src/client/ClaimSheet.tsx'
import { ResearchRuns } from '../src/client/RunPanel.tsx'
import { ResearchStatusChip } from '../src/client/Header.tsx'
import { ResearchProjectEntry, ResearchProjects } from '../src/client/ProjectEntry.tsx'
import { ResearchNewProject } from '../src/client/NewProject.tsx'
import { ResearchSettingsSection } from '../src/client/ResearchSettings.tsx'
import { SkipHarnessNotice } from '../src/client/Onboarding.tsx'
import { EmptyCell } from '../src/client/EmptyCell.tsx'
import { AutonomyChip } from '../src/client/AutonomyChip.tsx'
import { ResearchCheckCard, ResearchToolCard } from '../src/client/ResearchToolView.tsx'
import { RESEARCH_TOOLS } from '../src/client/toolCallValues.ts'
import type { ResearchFocus, ResearchInjected, ResearchToolInjected, ResearchView, WorkbenchProps } from '../src/client/contract.ts'
import { en, zh } from '../src/client/locales.ts'

/** This implementation's identity in the right-sidebar tab system (private to the plugin). */
const TAB_ID = '@deepseek-ai/dsh-client-ui-research'

const CLAIM_ID = 'claim-sparse'
const CLAIM_TEXT = 'Block-sparse attention holds accuracy at a quarter of the FLOPs.'

/** Enough project for the claim sheet: the sheet only reads claims, artifacts, evidence and runs. */
const PROJECT = {
  id: 'project-sparse',
  workspaceId: 'workspace-sparse',
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
const IMPORT: ResearchCommand = { action: 'import', projectId: PROJECT.id, paths: ['data/results.csv'] }

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
function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle!: (value: T) => void
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle }
}

/** Let the plugin's own promise chains run, where the clock is fake. */
async function flush(): Promise<void> {
  for (let round = 0; round < 6; round++) await Promise.resolve()
}

/** Let every promise chain the recorders started run to its end, on the real clock. */
function idle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
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

async function bench(services: { conversation?: unknown } = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  if (services.conversation !== undefined) ctx.provide('conversation', services.conversation as never)
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
      'conversation.input.permission': { kind: 'single', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.onboarding': { kind: 'list', scope: 'root' },
      'settings.general.item': { kind: 'list', scope: 'root' },
      'settings.action': { kind: 'list', scope: 'root' },
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
      'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)

  const remote = {
    snapshot: vi.fn((): Answer<ResearchSnapshot> => Promise.resolve(ok(BLANK))),
    tasks: vi.fn((): Answer<ResearchTask[]> => Promise.resolve(ok([]))),
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
  const sessions = { list }
  const publishSessions = (next: Record<string, { cwd?: string }>): void => { listed = next; for (const listener of listeners) listener() }
  const uiWorkspace = { openSession: vi.fn(), openWorkspace: vi.fn((_workspaceId: string) => Promise.resolve()) }
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
  ctx.provide('uiWorkspace', uiWorkspace as never)
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
    ctx, dictionaries, directoryPicker, face: injected, fiber, layout, remote, seat, tabs,
    publishSessions, sidebarRight, uiWorkspace,
  }
}

/** Dispose a bench's fiber once, and keep the shared teardown from repeating it. */
async function stop(target: { fiber: { dispose: () => Promise<void> } }): Promise<void> {
  live.splice(live.indexOf(target.fiber), 1)
  await target.fiber.dispose()
}

describe('the research plugin', () => {
  it('suggests the research rail width only when the person opens the research tab', async () => {
    const b = await bench()
    expect(b.layout.setInitialRightbarWidth).not.toHaveBeenCalled()
    b.face.showProgress()
    expect(b.layout.setInitialRightbarWidth).toHaveBeenCalledWith(320)
    expect(b.sidebarRight.openTab).toHaveBeenCalledWith('research')
  })

  it('hands the first run past the harness notice at once, showing nothing', () => {
    const complete = vi.fn()
    const view = render(createElement(SkipHarnessNotice, { stepId: 'welcome-notice', complete, openSection: vi.fn() }))
    expect(view.container.innerHTML).toBe('')
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('has the host half put the validated setting into every served page, and take it back', async () => {
    const host = new Context()
    host.provide('webServer', {} as never)
    const served = async (config?: unknown): Promise<unknown[]> => {
      const fiber = config === undefined ? host.plugin({ apply: applyHost }) : host.plugin({ apply: applyHost, Config: HostConfig }, config)
      await fiber.await()
      const rows: unknown[] = []
      host.emit('webserver/index-inject', rows as never)
      await fiber.dispose()
      const after: unknown[] = []
      host.emit('webserver/index-inject', after as never)
      expect(after).toEqual([])
      return rows
    }
    const global = (hideDeveloperCells: boolean): unknown[] => [{ kind: 'global', name: '__DSH_RESEARCH__', value: { hideDeveloperCells } }]
    expect(await served({ hideDeveloperCells: true })).toEqual(global(true))
    expect(await served({})).toEqual(global(false))
    expect(await served()).toEqual(global(false))
    // A row whose YAML says something other than a boolean fails the load.
    expect(() => HostConfig({ hideDeveloperCells: 'yes' } as never)).toThrow()
    // Without a Web server no page is served, and applying does nothing.
    await new Context().plugin({ apply: applyHost }).await()
  })

  it('injects exactly the services it reads', () => {
    expect(inject).toEqual([
      'remote', 'remote.research', 'remote.directoryPicker', 'slots', 'locale', 'layout', 'sessions', 'sidebarRight', 'uiWorkspace',
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
    expect(b.seat('conversation.hero.brand.mark')).toMatchObject({ component: ResearchHeroMark })
    expect(b.seat('conversation.hero.welcome', 'research-create'))
      .toMatchObject({ locale: 'research', component: ResearchProjectEntry, options: { order: 10 } })
    expect(b.seat('sidebar.projects', 'research-projects')).toMatchObject({ locale: 'research', component: ResearchProjects })
    expect(b.seat('conversation.input.left', 'research-new-project'))
      .toMatchObject({ locale: 'research', component: ResearchNewProject, options: { order: 5 } })
    expect(b.seat('conversation.input.dock', 'research-runs'))
      .toMatchObject({ locale: 'research', component: ResearchRuns, options: { order: 6 } })
    expect(b.seat('shell.overlay', 'research-claim'))
      .toMatchObject({ locale: 'research', component: ResearchClaimSheet, options: { order: 20 } })
    expect(b.seat('sidebar.right.pane.tab', TAB_ID)).toMatchObject({ locale: 'research', component: ResearchRail })
    expect(b.seat('sidebar.right.pane.tab.title', TAB_ID)).toMatchObject({ locale: 'research', component: ResearchRailTitle })

    // Every research tool's calls get a research card; a research check gets its own.
    const cards = b.ctx.slots.entries('tool.call.toolview')
    expect(cards.map(entry => entry.options.key).sort()).toEqual([...RESEARCH_TOOLS].sort())
    for (const entry of cards) {
      expect(entry).toMatchObject({ locale: 'research', component: entry.options.key === 'research_check' ? ResearchCheckCard : ResearchToolCard })
    }

    // The entry screen carries no cards, intro or promises, the input dock no second research entry,
    // and the header no file, board or gallery buttons.
    expect(b.ctx.slots.entries('conversation.hero.welcome').map(entry => entry.options.id)).toEqual(['research-create'])
    expect(b.ctx.slots.entries('conversation.hero.footer')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.input.dock').map(entry => entry.options.id)).toEqual(['research-runs'])
    expect(b.ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(0)

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
      'main', 'sidebar.brand.name', 'sidebar.brand.mark', 'conversation.session.header.actions', 'sidebar.projects',
      'conversation.hero.welcome', 'conversation.hero.brand.mark', 'conversation.input.dock', 'conversation.input.left',
      'shell.overlay', 'settings.section', 'settings.onboarding', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title',
      'tool.call.toolview',
    ]) {
      expect(b.ctx.slots.entries(name as never)).toHaveLength(0)
    }
    expect(b.tabs).toEqual([])
    expect(b.dictionaries.size).toBe(0)
  })

  // The composer's turn/step/token/cache pills, General settings' default access preset, and the open-config-file button.
  const DEVELOPER_CELLS = [
    ['conversation.composer.dock', 'stats'],
    ['settings.general.item', 'permission'],
    ['settings.action', 'open-document'],
  ] as const
  const Shipped = (): ReactNode => 'a shipped cell'
  /** What each developer cell's outlet renders: the lowest-priority entry registered under that id. */
  const winners = (ctx: Context): unknown[] => DEVELOPER_CELLS.map(([name]) => ctx.slots.entriesOfSlot(name)
    .map(entry => [entry.options.id, entry.component]))
  /** The composer's access seat, a single cell: the shell's access chip registers it without an id. */
  const ACCESS_SEAT = 'conversation.input.permission'
  const accessWinner = (ctx: Context): StoredEntry | undefined => ctx.slots.entriesOfSlot(ACCESS_SEAT)[0]
  const registerShipped = (ctx: Context): void => {
    for (const [name, id] of DEVELOPER_CELLS) ctx.slots.register({ name, id } as never, Shipped)
    ctx.slots.register({ name: ACCESS_SEAT } as never, Shipped)
  }

  /** The global the host half puts into the served page. */
  const page = globalThis as { __DSH_RESEARCH__?: unknown }

  it('draws nothing in place of the shell\'s developer cells and the autonomy in place of the access chip when the page says so, and gives them back with the fiber', async () => {
    page.__DSH_RESEARCH__ = { hideDeveloperCells: true }
    try {
      const b = await bench()
      registerShipped(b.ctx)

      expect(winners(b.ctx)).toEqual([[['stats', EmptyCell]], [['permission', EmptyCell]], [['open-document', EmptyCell]]])
      expect(render(createElement(EmptyCell)).container.innerHTML).toBe('')
      // The research's autonomy takes the access chip's seat, with the same face every research seat gets.
      const chip = accessWinner(b.ctx)!
      expect(chip).toMatchObject({ locale: 'research', component: AutonomyChip, options: { priority: -1 } })
      expect(Object.keys((chip.inject as unknown as () => ResearchInjected)())).toEqual(Object.keys(b.face))

      await stop(b)
      expect(winners(b.ctx)).toEqual([[['stats', Shipped]], [['permission', Shipped]], [['open-document', Shipped]]])
      expect(accessWinner(b.ctx)?.component).toBe(Shipped)
    } finally {
      delete page.__DSH_RESEARCH__
    }
  })

  it('leaves the shell\'s developer cells and access chip alone on a page without the setting', async () => {
    for (const global of [undefined, {}, { hideDeveloperCells: 'yes' }]) {
      if (global === undefined) delete page.__DSH_RESEARCH__
      else page.__DSH_RESEARCH__ = global
      const b = await bench()
      registerShipped(b.ctx)
      expect(winners(b.ctx)).toEqual([[['stats', Shipped]], [['permission', Shipped]], [['open-document', Shipped]]])
      expect(accessWinner(b.ctx)?.component).toBe(Shipped)
      await stop(b)
    }
    delete page.__DSH_RESEARCH__
  })

  it('keeps the composer of an example\'s conversation inert while the conversation plugin runs, and lets go with the fiber', async () => {
    const blocks = new Map<string, ReturnType<typeof createSnapshotStore<{ reason: string } | undefined>>>()
    const storeFor = (id: string) => {
      if (!blocks.has(id)) blocks.set(id, createSnapshotStore<{ reason: string } | undefined>(undefined))
      return blocks.get(id)!
    }
    const conversation = { blocks: { storeFor, set: (id: string, block: { reason: string } | undefined) => { storeFor(id).set(block) } } }
    const b = await bench({ conversation })
    b.remote.snapshot.mockResolvedValue(ok({ ...LOADED, projects: [{ ...PROJECT, example: true, sessionId: 'session-a' }] }))
    await b.face.refresh()
    expect(storeFor('session-a').getSnapshot()).toEqual({ reason: en.exampleComposerBlocked })
    await stop(b)
    expect(storeFor('session-a').getSnapshot()).toBeUndefined()
  })

  it('keeps the record and the job list it reads, and nothing about any action\'s progress', async () => {
    const b = await bench()
    b.remote.snapshot.mockResolvedValue(ok(LOADED))
    b.remote.tasks.mockResolvedValue(ok([task('task-running', 'running', 'still going'), task('task-broken', 'failed', 'the run never started')]))
    await b.face.refresh()
    expect(b.face.hooks.research.getSnapshot()).toEqual({ snapshot: LOADED, tasks: [
      task('task-running', 'running', 'still going'), task('task-broken', 'failed', 'the run never started'),
    ], response: null })
  })

  it('shares one promise between concurrent reads, and keeps the last record when a read fails', async () => {
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

    // Once it settles the next call reads again; a rejected or refused read never rejects and changes nothing.
    b.remote.snapshot.mockRejectedValueOnce(new Error('the carrier is down'))
    await expect(b.face.refresh()).resolves.toBeUndefined()
    b.remote.snapshot.mockResolvedValueOnce(bad('the ledger is locked'))
    await b.face.refresh()
    expect(b.face.hooks.research.getSnapshot().snapshot).toBe(LOADED)
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

  it('hands every refusal to the caller that asked, and reads the record again after each action', async () => {
    const b = await bench()
    const slow = deferred<RemoteResult<ResearchProject>>()
    b.remote.create.mockImplementationOnce(() => slow.promise)
    b.remote.snapshot.mockClear()

    const creating = b.face.create(NEW_PROJECT)
    slow.settle(ok(PROJECT))
    expect(await creating).toBe(PROJECT)
    expect(b.remote.snapshot).toHaveBeenCalledTimes(1)

    // A refused call: the Remote answered, the answer said no.
    b.remote.create.mockResolvedValueOnce(bad('that directory is already a project'))
    await expect(b.face.create(NEW_PROJECT)).rejects.toThrow('that directory is already a project')
    // A throw that is not an Error at all reaches the caller unchanged.
    b.remote.create.mockRejectedValueOnce('the bridge went away')
    await expect(b.face.create(NEW_PROJECT)).rejects.toBe('the bridge went away')
    b.remote.command.mockResolvedValueOnce(bad('no such project'))
    await expect(b.face.run(CHECK)).rejects.toThrow('no such project')
    b.remote.configure.mockResolvedValueOnce(bad('invalid preferences'))
    await expect(b.face.configure({}, { image: '', embedding: '' })).rejects.toThrow('invalid preferences')
    b.directoryPicker.pick.mockResolvedValueOnce(bad('no native picker'))
    await expect(b.face.pickDirectory()).rejects.toThrow('no native picker')
  })

  it('starts the read that follows an action after a read already in flight', async () => {
    const b = await bench()
    const inFlight = deferred<RemoteResult<ResearchSnapshot>>()
    b.remote.snapshot.mockImplementationOnce(() => inFlight.promise)
    const polling = b.face.refresh()
    b.remote.snapshot.mockClear()
    b.remote.snapshot.mockResolvedValue(ok(LOADED))
    const running = b.face.run(CHECK)
    await flush()
    // The action's own read waits for the one that may predate it.
    expect(b.remote.snapshot).not.toHaveBeenCalled()
    inFlight.settle(ok(BLANK))
    await polling
    expect(await running).toBe(OUTCOME)
    expect(b.remote.snapshot).toHaveBeenCalledTimes(1)
    expect(b.face.hooks.research.getSnapshot()).toMatchObject({ snapshot: LOADED, response: OUTCOME })
  })

  it('sends each action to its own Remote method', async () => {
    const b = await bench()

    // The created record comes back, because the caller opens its conversation.
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

    // A gallery search answers with its page, and leaves the last response alone.
    const search = { action: 'find-reference-figures' as const, projectId: PROJECT.id, query: 'agent memory' }
    const gallery = {
      total: 0, offset: 0, figures: [], basis: 'keyword' as const,
      facets: { venue: {}, year: {}, pattern: {}, tier: {} }, source: { name: 'g', repository: 'r', commit: 'c', license: 'l' },
    }
    b.remote.command.mockResolvedValueOnce(ok({ message: '0 figures', gallery }))
    expect(await b.face.searchFigures(search)).toBe(gallery)
    expect(b.remote.command).toHaveBeenLastCalledWith(search, expect.any(AbortSignal))
    expect(b.face.hooks.research.getSnapshot().response).toEqual({ message: 'python ready' })
    b.remote.command.mockResolvedValueOnce(ok({ message: 'no page' }))
    await expect(b.face.searchFigures(search)).rejects.toThrow(/returned no page/)
    b.remote.command.mockResolvedValueOnce(bad('gallery offline'))
    await expect(b.face.searchFigures(search)).rejects.toThrow('gallery offline')

    // A board read answers with the board, and leaves the response alone the same way.
    const read = { action: 'board-view' as const, projectId: PROJECT.id, refresh: true }
    const board = { spec: { sections: [], collectors: [] }, refreshing: false, machines: [], series: {}, collected: {}, alerts: [] }
    b.remote.command.mockResolvedValueOnce(ok({ message: 'Experiment board', board }))
    expect(await b.face.board(read)).toBe(board)
    expect(b.remote.command).toHaveBeenLastCalledWith(read, expect.any(AbortSignal))
    expect(b.face.hooks.research.getSnapshot().response).toEqual({ message: 'python ready' })
    b.remote.command.mockResolvedValueOnce(ok({ message: 'nothing' }))
    await expect(b.face.board(read)).rejects.toThrow(/returned nothing/)
  })

  it('follows a job the host started until the job list reports it settled', async () => {
    const b = await bench()
    b.remote.command.mockResolvedValueOnce(ok({ message: 'import started', jobId: 'job-import' }))
    let answer: ResearchResponse | undefined
    const running = b.face.run(IMPORT).then((response) => { answer = response })
    await idle()
    // Not listed yet, then listed as running: the caller keeps waiting, and the response is not replaced yet.
    expect(answer).toBeUndefined()
    b.remote.tasks.mockResolvedValue(ok([task('job-import', 'running', 'import')]))
    await b.face.refresh()
    await idle()
    expect(answer).toBeUndefined()
    expect(b.face.hooks.research.getSnapshot().response).toBeNull()
    const imported = { message: 'Imported 1 source' }
    b.remote.tasks.mockResolvedValue(ok([task('job-import', 'completed', 'Imported 1 source', imported)]))
    await b.face.refresh()
    await running
    expect(answer).toBe(imported)
    expect(b.face.hooks.research.getSnapshot().response).toBe(imported)

    // A job that settled before the action's own read: its message stands in for a result it did not carry.
    b.remote.command.mockResolvedValueOnce(ok({ message: 'refresh started', jobId: 'job-quiet' }))
    b.remote.tasks.mockResolvedValue(ok([task('job-quiet', 'completed', 'nothing to say')]))
    expect(await b.face.run(IMPORT)).toEqual({ message: 'nothing to say' })

    // A failed job rejects with the host's own message, and so does an install's.
    b.remote.command.mockResolvedValueOnce(ok({ message: 'cancel started', jobId: 'job-cancel' }))
    b.remote.tasks.mockResolvedValue(ok([task('job-cancel', 'failed', 'The supervisor is unreachable')]))
    await expect(b.face.run(IMPORT)).rejects.toThrow('The supervisor is unreachable')
    b.remote.installComponent.mockResolvedValueOnce(ok({ message: 'install-latex started', jobId: 'job-latex' }))
    b.remote.tasks.mockResolvedValue(ok([task('job-latex', 'interrupted', 'the application restarted')]))
    await expect(b.face.install('latex')).rejects.toThrow('the application restarted')
  })

  it('leaves a followed job\'s caller alone once the fiber goes, while waiting on the job or still reading', async () => {
    const outcomes: string[] = []
    const record = (promise: Promise<unknown>): void => {
      void promise.then(() => { outcomes.push('resolved') }, () => { outcomes.push('rejected') })
    }

    // Waiting on the job: the host lists it as running when the fiber goes.
    const waiting = await bench()
    waiting.remote.command.mockResolvedValueOnce(ok({ message: 'import started', jobId: 'job-long' }))
    waiting.remote.tasks.mockResolvedValue(ok([task('job-long', 'running', 'import')]))
    record(waiting.face.run(IMPORT))
    await idle()
    expect(waiting.face.hooks.research.getSnapshot().tasks).toEqual([task('job-long', 'running', 'import')])
    await stop(waiting)
    await idle()
    expect(waiting.face.hooks.research.getSnapshot().response).toBeNull()

    // Still reading: the command answered, and the fiber went before the action's own read landed.
    const reading = await bench()
    const late = deferred<RemoteResult<ResearchSnapshot>>()
    reading.remote.command.mockResolvedValueOnce(ok({ message: 'import started', jobId: 'job-late' }))
    reading.remote.snapshot.mockImplementationOnce(() => late.promise)
    record(reading.face.run(IMPORT))
    await idle()
    await stop(reading)
    late.settle(ok(LOADED))
    await idle()
    expect(reading.face.hooks.research.getSnapshot()).toEqual({ snapshot: BLANK, tasks: [], response: null })

    expect(outcomes).toEqual([])
  })

  it('opens a conversation once it is listed, and the research folder\'s blank one when it never is', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const b = await bench()

    // Listed already: selected at once.
    await b.face.openConversation('session-a', 'workspace-sparse')
    expect(b.uiWorkspace.openSession).toHaveBeenCalledWith('session-a')
    expect(b.uiWorkspace.openWorkspace).not.toHaveBeenCalled()

    // Listed a moment later, as a project's new conversation is: selected when it appears.
    const arriving = b.face.openConversation('session-new', 'workspace-sparse')
    b.publishSessions({ 'session-a': {} })
    await flush()
    expect(b.uiWorkspace.openSession).not.toHaveBeenCalledWith('session-new')
    b.publishSessions({ 'session-a': {}, 'session-new': { cwd: '/research/sparse' } })
    await arriving
    expect(b.uiWorkspace.openSession).toHaveBeenLastCalledWith('session-new')

    // Never listed within five seconds: the folder's blank conversation opens instead of a failure the person cannot act on.
    const missing = b.face.openConversation('session-gone', 'workspace-sparse')
    await vi.advanceTimersByTimeAsync(4999)
    expect(b.uiWorkspace.openWorkspace).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await missing
    expect(b.uiWorkspace.openWorkspace).toHaveBeenCalledWith('workspace-sparse')
    expect(b.uiWorkspace.openSession).not.toHaveBeenCalledWith('session-gone')

    // The fiber going away ends the wait and opens nothing, then or later.
    const abandoned = b.face.openConversation('session-late', 'workspace-sparse')
    await stop(b)
    await abandoned
    b.publishSessions({ 'session-late': {} })
    await vi.advanceTimersByTimeAsync(5000)
    expect(b.uiWorkspace.openWorkspace).toHaveBeenCalledTimes(1)
    expect(b.uiWorkspace.openSession).not.toHaveBeenCalledWith('session-late')
  })

  it('moves the frame onto the panel and one claim, and opens the research folder\'s files', async () => {
    const b = await bench()

    b.face.expand()
    expect(b.layout.selectPanel).toHaveBeenLastCalledWith('research')
    b.face.openFiles()
    expect(b.sidebarRight.openTab).toHaveBeenCalledWith('files')

    b.remote.snapshot.mockResolvedValue(ok(LOADED))
    await b.face.refresh()
    const props = {
      t: (key: string) => (zh as Record<string, string>)[key] ?? key,
      useResearch: (select: (value: ResearchView) => unknown) => select(b.face.hooks.research.getSnapshot()),
      useFocus: (select: (value: ResearchFocus) => unknown) => select(b.face.hooks.focus.getSnapshot()),
      focusClaim: (claim: ResearchFocus['claim']) => { b.face.focusClaim(claim) },
    } as unknown as WorkbenchProps

    const view = render(createElement(ResearchClaimSheet, props))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    // The rail and the overlay never meet; the store is how one reaches the other.
    b.face.focusClaim({ projectId: PROJECT.id, claimId: CLAIM_ID })
    expect(b.face.hooks.focus.getSnapshot()).toMatchObject({ claim: { projectId: PROJECT.id, claimId: CLAIM_ID }, panel: 'workflow' })
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
  it('opens project files in the right sidebar, and lets a refusal reach the caller', async () => {
    const b = await bench()
    b.face.openFile('C:\\research\\sparse', 'paper\\main.pdf')
    expect(b.sidebarRight.openResource).toHaveBeenCalledWith('dsh-resource://file/absolute/C:/research/sparse/paper/main.pdf')
    b.sidebarRight.openResource.mockImplementationOnce(() => { throw new Error('no session is bound') })
    expect(() => { b.face.openFile('/r', 'x.pdf') }).toThrow('no session is bound')
  })

  it('hands a research tool card the record and the same way into a project file', async () => {
    const b = await bench()
    const card = (b.seat('tool.call.toolview', 'research_check').inject as unknown as () => ResearchToolInjected)()
    expect(card.hooks.research).toBe(b.face.hooks.research)
    card.openProjectFile('C:\\research\\sparse', 'refs.bib')
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith('dsh-resource://file/absolute/C:/research/sparse/refs.bib')
  })

  it('tracks every listed session\'s working directory as the list changes', async () => {
    const b = await bench()
    expect(b.face.hooks.directories.getSnapshot()).toEqual({ 'session-a': 'C:\\research\\sparse' })
    b.publishSessions({ 'session-c': { cwd: '/research/other' } })
    expect(b.face.hooks.directories.getSnapshot()).toEqual({ 'session-c': '/research/other' })
  })
})
