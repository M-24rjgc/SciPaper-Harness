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
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { UiWorkspaceEntryPolicy } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type {
  CreateProjectRequest, EvidenceRecord, ResearchCommand, ResearchProject, ResearchResponse, ResearchSnapshot, ResearchTask,
} from '@deepseek-ai/dsh-research-workbench/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { apply as applyHost, Config as HostConfig } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { ResearchBrand, ResearchMark } from '../src/client/Brand.tsx'
import { ResearchHeroMark } from '../src/client/Hero.tsx'
import { ResearchRail, ResearchRailTitle } from '../src/client/Rail.tsx'
import { ResearchBoardTab, ResearchBoardTitle, ResearchGalleryTab, ResearchGalleryTitle, ResearchSourcesTitle } from '../src/client/Tabs.tsx'
import { ResearchSourcesTab } from '../src/client/Sources.tsx'
import { ResearchDiagramTab } from '../src/client/Diagram.tsx'
import { ResearchClaimSheet } from '../src/client/ClaimSheet.tsx'
import { ResearchRuns } from '../src/client/RunPanel.tsx'
import { ResearchStatusChip } from '../src/client/Header.tsx'
import { ResearchTree } from '../src/client/ResearchTree.tsx'
import { ResearchEntryLine, ResearchTryChips } from '../src/client/EntryScreen.tsx'
import { ResearchFolderMenu } from '../src/client/FolderMenu.tsx'
import { ResearchSettingsSection } from '../src/client/ResearchSettings.tsx'
import { SkipHarnessNotice } from '../src/client/Onboarding.tsx'
import { EmptyCell } from '../src/client/EmptyCell.tsx'
import { AutonomyChip } from '../src/client/AutonomyChip.tsx'
import { ResearchCheckCard, ResearchToolCard } from '../src/client/ResearchToolView.tsx'
import { RESEARCH_TOOLS } from '../src/client/toolCallValues.ts'
import type {
  ResearchEntryInjected, ResearchFocus, ResearchInjected, ResearchToolInjected, ResearchTreeInjected, ResearchView, WorkbenchProps,
} from '../src/client/contract.ts'
import { en, zh } from '../src/client/locales.ts'

/** This implementation's identity in the right-sidebar tab system (private to the plugin), and each further tab type's. */
const TAB_ID = '@deepseek-ai/dsh-client-ui-research'
const BOARD_ID = `${TAB_ID}/board`
const SOURCES_ID = `${TAB_ID}/sources`
const GALLERY_ID = `${TAB_ID}/gallery`
const DRAWIO_ID = `${TAB_ID}/drawio`

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
  title: (address: string) => string
  patterns?: string[]
  canOpen?: (address: string) => boolean
  guide?: { id: string; order: number; title: () => string; description: () => string; icon: unknown }[]
}

const live: { dispose: () => Promise<void> }[] = []

afterEach(async () => {
  cleanup()
  for (const fiber of live.splice(0)) await fiber.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** What a bench starts with besides the defaults: the lists as the page finds them, and the host's file-manager answer. */
interface BenchServices {
  conversation?: unknown
  sessions?: Record<string, Partial<SessionSummary>>
  current?: string
  /** Workspace id, path and listed sessions. */
  workspaces?: [string, string, string[]][]
  /** Sessions the Workspace list reports archived. */
  archived?: string[]
  snapshot?: ResearchSnapshot
  /** The host's answer to whether it can show a folder in the file manager; yes by default. */
  canReveal?: Promise<RemoteResult<boolean>>
  /** The `agent-presets` settings namespace as first read; not read yet by default. */
  presetSettings?: { status: 'loading' | 'ready' | 'unavailable'; base: unknown; user: unknown; value: unknown; revision: number | undefined }
  /** The settings refuse to clear the saved default. */
  presetsKept?: boolean
}

async function bench(services: BenchServices = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  if (services.conversation !== undefined) ctx.provide('conversation', services.conversation as never)
  // The frame this plugin registers into: every seat it takes has to be
  // declared by somebody, and the declaration is what authorizes the entry.
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.brand.name': { kind: 'single', scope: 'root' },
      'sidebar.brand.mark': { kind: 'single', scope: 'root' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'sidebar.projects': { kind: 'list', scope: 'root' },
      'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'conversation.hero.welcome': { kind: 'list', scope: 'root' },
      'conversation.hero.footer': { kind: 'list', scope: 'root' },
      'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
      'conversation.hero.workspace': { kind: 'single', scope: 'root' },
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
    snapshot: vi.fn((): Answer<ResearchSnapshot> => Promise.resolve(ok(services.snapshot ?? BLANK))),
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
  const remoteSession = {
    canOpenWorkspacePath: vi.fn((): Answer<boolean> => services.canReveal ?? Promise.resolve(ok(true))),
    openWorkspacePath: vi.fn((_request: { path: string; action?: string }, _signal?: AbortSignal): Answer<{ opened: true }> =>
      Promise.resolve(ok({ opened: true }))),
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
  let navigation = new AbortController()
  const layout = {
    selectPanel: vi.fn(), setInitialRightbarWidth: vi.fn(),
    beginNavigation: vi.fn(() => {
      navigation.abort()
      navigation = new AbortController()
      return navigation.signal
    }),
  }
  const rows = (entries: Record<string, Partial<SessionSummary>>): SessionListState => ({
    ids: Object.keys(entries) as SessionId[],
    byId: Object.fromEntries(Object.entries(entries).map(([id, row]) => [id, {
      id, displayTitle: id, running: false, blank: false, updatedAt: 0, ...row,
    }])) as Record<SessionId, SessionSummary>,
    current: services.current as SessionId | undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const list = createSnapshotStore<SessionListState>(rows(services.sessions ?? { 'session-a': { cwd: 'C:\\research\\sparse' }, 'session-b': {} }))
  // Each listed session renames itself through its binding; an unknown one has none.
  const renames = new Map<string, ReturnType<typeof vi.fn>>()
  const sessions = {
    list,
    binding: vi.fn((id: string) => {
      if (!(id in list.getSnapshot().byId)) return undefined
      if (!renames.has(id)) renames.set(id, vi.fn((_title: string) => Promise.resolve(ok({ title: _title, seq: 1 }))))
      return { session: { rename: renames.get(id) } }
    }),
    search: vi.fn((_query: string, _signal: AbortSignal) => Promise.resolve(ok({ items: [{ sessionId: 'session-a', snippet: 'measured 42' }], hasMore: false }))),
    searchResultLimit: 20,
  }
  const publishSessions = (next: Record<string, Partial<SessionSummary>>): void => {
    const { ids, byId } = rows(next)
    list.update((state) => { state.ids = ids; state.byId = byId })
  }
  const select = (id: string | undefined): void => { list.update((state) => { state.current = id as SessionId | undefined }) }
  const workspaceList = createSnapshotStore<WorkspaceSnapshot>({
    items: (services.workspaces ?? []).map(([workspaceId, path, ids]) => ({
      workspaceId: workspaceId as WorkspaceId, path, title: path, sessionIds: ids as SessionId[], createdAt: '', updatedAt: '',
    })),
    archivedSessionIds: (services.archived ?? []) as SessionId[], state: 'idle', phase: 'ready', error: null,
  })
  const workspaces = { list: workspaceList, delete: vi.fn((_workspaceId: string) => Promise.resolve()) }
  const policies: UiWorkspaceEntryPolicy[] = []
  const uiWorkspace = {
    openSession: vi.fn((id: string) => { select(id) }),
    openWorkspace: vi.fn((_workspaceId: string) => Promise.resolve()),
    startSession: vi.fn((_workspaceId?: string) => {}),
    archiveSession: vi.fn((_sessionId: string) => Promise.resolve()),
    setEntryPolicy: vi.fn((policy: UiWorkspaceEntryPolicy) => {
      policies.push(policy)
      return () => { policies.splice(policies.indexOf(policy), 1) }
    }),
  }
  // The right panel collapsed and empty until a tab opens; the header chip reads what it shows.
  const panel = { expanded: false, active: undefined as { kind: string } | undefined }
  const sidebarRight = {
    openTab: vi.fn((kind: string) => { panel.expanded = true; panel.active = { kind } }),
    openResource: vi.fn(),
    isExpanded: vi.fn(() => panel.expanded),
    active: vi.fn(() => panel.active),
    toggleExpanded: vi.fn(() => { panel.expanded = !panel.expanded }),
  }
  // The `agent-presets` namespace as the settings mirror holds it; `unset` answers as the settings mirror would.
  const presetScope = createSnapshotStore<{ status: 'loading' | 'ready' | 'unavailable'; base: unknown; user: unknown; value: unknown; revision: number | undefined }>(
    services.presetSettings ?? { status: 'loading', base: undefined, user: undefined, value: undefined, revision: undefined },
  )
  const unsetPreset = vi.fn((field: string): Promise<void> => {
    presetScope.update((draft) => {
      const kept = services.presetsKept === true
      if (!kept && typeof draft.user === 'object' && draft.user !== null) draft.user = Object.fromEntries(Object.entries(draft.user).filter(([key]) => key !== field))
      draft.revision = (draft.revision ?? 0) + 1
    })
    return Promise.resolve()
  })
  const bound: string[] = []
  const settingsScope = {
    bind: vi.fn((spec: { namespace: string }) => {
      bound.push(spec.namespace)
      return {
        getSnapshot: () => presetScope.getSnapshot(),
        subscribe: (listener: () => void) => presetScope.subscribe(listener),
        unset: unsetPreset,
      }
    }),
  }
  const tabs: TabType[] = []
  const sidebarRightTabs = {
    register: vi.fn((definition: TabType) => {
      tabs.push(definition)
      return () => { tabs.splice(tabs.indexOf(definition), 1) }
    }),
  }

  ctx.provide('remote', { research: remote, directoryPicker, session: remoteSession } as never)
  ctx.provide('remote.research', remote as never)
  ctx.provide('remote.directoryPicker', directoryPicker as never)
  ctx.provide('remote.session', remoteSession as never)
  ctx.provide('locale', locale as never)
  ctx.provide('layout', layout as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('workspaces', workspaces as never)
  ctx.provide('uiWorkspace', uiWorkspace as never)
  ctx.provide('sidebarRight', sidebarRight as never)
  ctx.provide('sidebarRightTabs', sidebarRightTabs as never)
  ctx.provide('settingsScope', settingsScope as never)

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
  const injected = (seat('shell.overlay', 'research-claim').inject as unknown as () => ResearchInjected)()
  // The entry screen's seats share their own face.
  const entry = (seat('conversation.hero.welcome', 'research-entry').inject as unknown as () => ResearchEntryInjected)()
  // apply() starts one read of its own; joining it leaves the store settled.
  await injected.refresh()
  return {
    ctx, dictionaries, directoryPicker, entry, face: injected, fiber, layout, remote, remoteSession, seat, tabs, policies,
    publishSessions, select, list, workspaceList, sidebarRight, uiWorkspace, sessions, renames, workspaces,
    panel, presetScope, unsetPreset, bound,
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

  it('opens each secondary tool as a tab beside the conversation, the board and the gallery wide, the Sources list as a column', async () => {
    const b = await bench()
    const opened = (): unknown[] => b.sidebarRight.openTab.mock.calls.map((call: unknown[]) => call)
    const widths = (): unknown[] => b.layout.setInitialRightbarWidth.mock.calls.map((call: unknown[]) => call[0])
    b.face.openBoard()
    b.face.openGallery()
    b.face.openSources()
    b.face.openSources('claims')
    b.face.openFiles()
    expect(opened()).toEqual([
      ['research-board'], ['research-gallery'], ['research-sources', {}], ['research-sources', { params: { section: 'claims' } }], ['files'],
    ])
    // A width only applies while the panel has none; the files tab keeps whatever the panel has.
    expect(widths()).toEqual([560, 560, 320, 320])
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
      'remote', 'remote.research', 'remote.directoryPicker', 'remote.session', 'slots', 'locale', 'layout', 'sessions', 'workspaces',
      'sidebarRight', 'uiWorkspace', 'settingsScope',
    ])
  })

  it('has the header chip open the research tab, and close the panel while it shows the research tab', async () => {
    const b = await bench()
    b.face.toggleProgress()
    expect(b.sidebarRight.openTab).toHaveBeenLastCalledWith('research')
    expect(b.layout.setInitialRightbarWidth).toHaveBeenLastCalledWith(320)
    // Showing the record, the chip collapses the panel; collapsed, it opens the record again.
    b.face.toggleProgress()
    expect(b.sidebarRight.toggleExpanded).toHaveBeenCalledTimes(1)
    expect(b.panel.expanded).toBe(false)
    b.face.toggleProgress()
    expect(b.sidebarRight.openTab).toHaveBeenCalledTimes(2)
    // Showing another tab, the chip brings the record forward instead of closing the panel.
    b.face.openBoard()
    b.face.toggleProgress()
    expect(b.sidebarRight.openTab).toHaveBeenLastCalledWith('research')
    expect(b.sidebarRight.toggleExpanded).toHaveBeenCalledTimes(1)
  })

  it('shows the research folder in the file manager from the record, and says why it could not', async () => {
    const b = await bench()
    expect(b.face.hooks.canReveal).toBe(b.entry.hooks.canReveal)
    await b.face.reveal('/research/sparse')
    expect(b.remoteSession.openWorkspacePath).toHaveBeenCalledWith({ path: '/research/sparse', action: 'reveal' }, expect.any(AbortSignal))
    b.remoteSession.openWorkspacePath.mockResolvedValueOnce(bad('no desktop on this host'))
    await expect(b.face.reveal('/research/sparse')).rejects.toThrow('no desktop on this host')
  })

  it('reads the agent presets from their settings namespace, and puts the research assistant back as the default', async () => {
    const saved = { status: 'ready' as const, base: { default: 'research', modeSelectionEnabled: true }, user: { default: 'standard' }, value: { default: 'standard', modeSelectionEnabled: true }, revision: 3 }
    const b = await bench({ presetSettings: { status: 'loading', base: undefined, user: undefined, value: undefined, revision: undefined } })
    expect(b.bound).toEqual(['agent-presets'])
    expect(b.face.hooks.presets.getSnapshot()).toBeNull()
    b.presetScope.set(saved)
    const before = b.face.hooks.presets.getSnapshot()
    expect(before).toEqual({ research: 'research', saved: 'standard' })
    // A change that leaves the presets as they were publishes nothing new.
    b.presetScope.set({ ...saved, revision: 4 })
    expect(b.face.hooks.presets.getSnapshot()).toBe(before)
    await b.face.resetDefaultPreset()
    expect(b.unsetPreset).toHaveBeenCalledWith('default')
    expect(b.face.hooks.presets.getSnapshot()).toEqual({ research: 'research' })
    // Settings that keep the saved default refuse the reset in the reader's language.
    const kept = await bench({ presetSettings: saved, presetsKept: true })
    expect(kept.face.hooks.presets.getSnapshot()).toEqual({ research: 'research', saved: 'standard' })
    await expect(kept.face.resetDefaultPreset()).rejects.toThrow(en.legacyResetUnchanged)
  })

  it('takes every seat it needs, and gives all of them back with the fiber', async () => {
    const b = await bench()

    expect(b.dictionaries.get('research')).toEqual({ en, zh })
    expect(b.seat('sidebar.brand.name')).toMatchObject({ locale: 'research', component: ResearchBrand })
    expect(b.seat('sidebar.brand.mark')).toMatchObject({ component: ResearchMark })
    expect(b.seat('conversation.session.header.actions', 'research-status'))
      .toMatchObject({ locale: 'research', component: ResearchStatusChip, options: { order: 5 } })
    expect(b.seat('conversation.hero.brand.mark')).toMatchObject({ component: ResearchHeroMark })
    expect(b.seat('conversation.hero.welcome', 'research-entry'))
      .toMatchObject({ locale: 'research', component: ResearchEntryLine, options: { order: 10 } })
    expect(b.seat('conversation.input.dock', 'research-try'))
      .toMatchObject({ locale: 'research', component: ResearchTryChips, options: { order: 7 } })
    expect(b.seat('conversation.input.dock', 'research-runs'))
      .toMatchObject({ locale: 'research', component: ResearchRuns, options: { order: 6 } })
    // The entry screen's seats share one face of their own.
    expect(Object.keys((b.seat('conversation.input.dock', 'research-try').inject as unknown as () => ResearchEntryInjected)())).toEqual(Object.keys(b.entry))
    expect(b.seat('shell.overlay', 'research-claim'))
      .toMatchObject({ locale: 'research', component: ResearchClaimSheet, options: { order: 20 } })
    // The record and each secondary tool draw beside the conversation, every body with the same face.
    const bodies: [string, unknown][] = [
      [TAB_ID, ResearchRail], [BOARD_ID, ResearchBoardTab], [SOURCES_ID, ResearchSourcesTab], [GALLERY_ID, ResearchGalleryTab],
      [DRAWIO_ID, ResearchDiagramTab],
    ]
    for (const [key, component] of bodies) {
      const body = b.seat('sidebar.right.pane.tab', key)
      expect(body).toMatchObject({ locale: 'research', component })
      expect(Object.keys((body.inject as unknown as () => ResearchInjected)())).toEqual(Object.keys(b.face))
    }
    const titles: [string, unknown][] = [
      [TAB_ID, ResearchRailTitle], [BOARD_ID, ResearchBoardTitle], [SOURCES_ID, ResearchSourcesTitle], [GALLERY_ID, ResearchGalleryTitle],
    ]
    for (const [key, component] of titles) expect(b.seat('sidebar.right.pane.tab.title', key)).toMatchObject({ locale: 'research', component })
    // The draw.io editor's chip shows the file's name, captured when the tab opens.
    expect(b.ctx.slots.entries('sidebar.right.pane.tab.title').map(entry => entry.options.key)).not.toContain(DRAWIO_ID)

    // Every research tool's calls get a research card; a research check gets its own.
    const cards = b.ctx.slots.entries('tool.call.toolview')
    expect(cards.map(entry => entry.options.key).sort()).toEqual([...RESEARCH_TOOLS].sort())
    for (const entry of cards) {
      expect(entry).toMatchObject({ locale: 'research', component: entry.options.key === 'research_check' ? ResearchCheckCard : ResearchToolCard })
    }

    // The entry screen carries no cards, intro, promises or folder button, the composer no folder button,
    // and the header no file, board or gallery buttons.
    expect(b.ctx.slots.entries('conversation.hero.welcome').map(entry => entry.options.id)).toEqual(['research-entry'])
    expect(b.ctx.slots.entries('conversation.hero.footer')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.input.dock').map(entry => entry.options.id).sort()).toEqual(['research-runs', 'research-try'])
    expect(b.ctx.slots.entries('conversation.input.left')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
    // Without the edition's setting the shell's folder picker and workspace browser keep their seats,
    // and the sidebar has no project cards: the research tree lists researches under the edition's setting.
    expect(b.ctx.slots.entries('conversation.hero.workspace')).toHaveLength(0)
    expect(b.ctx.slots.entries('sidebar.workspaces')).toHaveLength(0)
    expect(b.ctx.slots.entries('sidebar.projects')).toHaveLength(0)

    // The settings row names itself through the dictionary, at read time.
    const settings = b.seat('settings.section', 'research')
    expect(settings).toMatchObject({ locale: 'research', component: ResearchSettingsSection, options: { order: 24 } })
    expect((settings.options.label as () => string)()).toBe(en.settingsSection)

    // Without the edition's setting the harness's own first-run notice keeps its seat.
    expect(b.ctx.slots.entries('settings.onboarding')).toHaveLength(0)

    // The record and the secondary tools are builtin tab types; only the record is offered on the guide page.
    expect(b.tabs.map(type => [type.id, type.kind, type.priority, type.title('sidebar://page'), type.guide !== undefined])).toEqual([
      [TAB_ID, 'research', 'builtin', en.railTitle, true],
      [BOARD_ID, 'research-board', 'builtin', en.boardTitle, false],
      [SOURCES_ID, 'research-sources', 'builtin', en.sourcesTab, false],
      [GALLERY_ID, 'research-gallery', 'builtin', en.gallery, false],
      [DRAWIO_ID, 'research-drawio', 'builtin', 'sidebar://page', false],
    ])
    expect(b.tabs[0]!.guide!.map(entry => [entry.id, entry.order, entry.title(), entry.description(), entry.icon]))
      .toEqual([['research', 15, en.railGuideTitle, en.railGuideDescription, ResearchHeroMark]])
    // The draw.io editor claims `.drawio` file addresses of either scope, named by the file.
    const drawio = b.tabs[4]!
    expect(drawio.patterns).toEqual(['*.drawio'])
    expect(drawio.canOpen!('dsh-resource://file/session/s1/figures/arch.drawio')).toBe(true)
    expect(drawio.canOpen!('dsh-resource://file/absolute/C:/r/arch.drawio')).toBe(true)
    expect(drawio.canOpen!('dsh-resource://file/elsewhere/arch.drawio')).toBe(false)
    expect(drawio.title('dsh-resource://file/session/s1/figures/arch%20v2.drawio')).toBe('arch v2.drawio')

    // Nothing takes the main panel: the research is not a second application beside the conversation.
    expect(b.ctx.slots.entries('sidebar.panellist')).toHaveLength(0)

    await stop(b)

    for (const name of [
      'sidebar.brand.name', 'sidebar.brand.mark', 'conversation.session.header.actions',
      'conversation.hero.welcome', 'conversation.hero.brand.mark', 'conversation.input.dock',
      'shell.overlay', 'settings.section', 'settings.onboarding', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title',
      'tool.call.toolview',
    ]) {
      expect(b.ctx.slots.entries(name as never)).toHaveLength(0)
    }
    expect(b.tabs).toEqual([])
    expect(b.dictionaries.size).toBe(0)
    expect(b.policies).toEqual([])
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
  /** The blank conversation's folder seat, a single cell the shell's Workspace picker takes. */
  const FOLDER_SEAT = 'conversation.hero.workspace'
  const folderWinner = (ctx: Context): StoredEntry | undefined => ctx.slots.entriesOfSlot(FOLDER_SEAT)[0]
  /** The sidebar's browsing seat, a single cell the shell's workspace browser takes, declaring its directory-flow child. */
  const BROWSER_SEAT = 'sidebar.workspaces'
  const FLOW_SEAT = 'sidebar.workspaces.directoryFlow'
  const browserWinner = (ctx: Context): StoredEntry | undefined => ctx.slots.entriesOfSlot(BROWSER_SEAT)[0]
  const Flow = (): ReactNode => null
  const registerShipped = (ctx: Context): void => {
    for (const [name, id] of DEVELOPER_CELLS) ctx.slots.register({ name, id } as never, Shipped)
    ctx.slots.register({ name: ACCESS_SEAT } as never, Shipped)
    ctx.slots.register({ name: FOLDER_SEAT } as never, Shipped)
    ctx.slots.register({ name: BROWSER_SEAT, children: { [FLOW_SEAT]: { kind: 'single', scope: 'root' } } } as never, Shipped)
    // A folder picker's flow fills the child the shipped browser declares.
    ctx.slots.register({ name: FLOW_SEAT } as never, Flow)
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
      // The harness's own first-run notice is shadowed: a lower priority renders instead of it.
      expect(b.seat('settings.onboarding', 'welcome-notice')).toMatchObject({ component: SkipHarnessNotice, options: { priority: -1 } })
      // The research's autonomy takes the access chip's seat, with the same face every research seat gets.
      const chip = accessWinner(b.ctx)!
      expect(chip).toMatchObject({ locale: 'research', component: AutonomyChip, options: { priority: -1 } })
      expect(Object.keys((chip.inject as unknown as () => ResearchInjected)())).toEqual(Object.keys(b.face))
      // The research's folder menu takes the blank conversation's Workspace picker, with the entry screen's face.
      const folder = folderWinner(b.ctx)!
      expect(folder).toMatchObject({ locale: 'research', component: ResearchFolderMenu, options: { priority: -1 } })
      expect(Object.keys((folder.inject as unknown as () => ResearchEntryInjected)())).toEqual(Object.keys(b.entry))
      // The research tree takes the workspace browser's seat with its own store; the shadowed browser
      // still declares its directory-flow child, so the folder pickers' flow keeps its seat.
      const tree = browserWinner(b.ctx)!
      expect(tree).toMatchObject({ locale: 'research', component: ResearchTree, options: { priority: -1 } })
      expect(tree.store).toBeDefined()
      // The browser stays registered underneath: shadowed, not replaced.
      const browsers = b.ctx.slots.entries(BROWSER_SEAT as never).map(entry => entry.component)
      expect(browsers).toEqual(expect.arrayContaining([ResearchTree, Shipped]))
      expect(b.ctx.slots.spec(FLOW_SEAT)).toMatchObject({ kind: 'single' })
      expect(b.ctx.slots.entriesOfSlot(FLOW_SEAT)[0]?.component).toBe(Flow)

      await stop(b)
      expect(winners(b.ctx)).toEqual([[['stats', Shipped]], [['permission', Shipped]], [['open-document', Shipped]]])
      expect(accessWinner(b.ctx)?.component).toBe(Shipped)
      expect(folderWinner(b.ctx)?.component).toBe(Shipped)
      expect(browserWinner(b.ctx)?.component).toBe(Shipped)
      expect(b.ctx.slots.entriesOfSlot(FLOW_SEAT)[0]?.component).toBe(Flow)
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
      expect(folderWinner(b.ctx)?.component).toBe(Shipped)
      expect(browserWinner(b.ctx)?.component).toBe(Shipped)
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
    ] })
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
    b.directoryPicker.pick.mockResolvedValueOnce(bad('the chooser crashed'))
    await expect(b.face.pickDirectory()).rejects.toThrow('the chooser crashed')
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
    expect(b.face.hooks.research.getSnapshot()).toMatchObject({ snapshot: LOADED })
  })

  it('sends each action to its own Remote method', async () => {
    const b = await bench()

    // The created record comes back, because the caller opens its conversation.
    expect(await b.face.create(NEW_PROJECT)).toBe(PROJECT)
    expect(b.remote.create).toHaveBeenCalledWith(NEW_PROJECT)

    // The chooser's answer: a folder, a dismissal, or no chooser on this host.
    expect(await b.face.pickDirectory()).toEqual({ kind: 'picked', path: '/picked/project' })
    expect(b.directoryPicker.pick).toHaveBeenCalledOnce()
    b.directoryPicker.pick.mockResolvedValueOnce(ok(null))
    expect(await b.face.pickDirectory()).toEqual({ kind: 'cancelled' })
    b.directoryPicker.pick.mockResolvedValueOnce({ ok: false, error: { code: 'directory-picker/unavailable', message: 'browse' } } as never)
    expect(await b.face.pickDirectory()).toEqual({ kind: 'unavailable' })

    expect(await b.face.run(CHECK)).toBe(OUTCOME)
    expect(b.remote.command.mock.calls[0]![0]).toBe(CHECK)
    expect(b.remote.command.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)

    // No key, no credential write.
    await b.face.configure({ python: '/usr/bin/python3' }, { image: '', embedding: '' })
    expect(b.remote.configure).toHaveBeenCalledWith({ python: '/usr/bin/python3' })
    expect(b.remote.setCredential).not.toHaveBeenCalled()

    await b.face.configure({}, { image: 'sk-image-key', embedding: 'sk-embed-key' })
    expect(b.remote.setCredential.mock.calls).toEqual([['image', 'sk-image-key'], ['embedding', 'sk-embed-key']])

    // An install reads the record again once it settled, so the component list says what is installed.
    b.remote.installComponent.mockResolvedValueOnce(ok({ message: 'python ready' }))
    b.remote.snapshot.mockClear()
    await b.face.install('python')
    expect(b.remote.installComponent).toHaveBeenCalledWith('python')
    expect(b.remote.snapshot).toHaveBeenCalledTimes(2)

    // A gallery search answers with its page and reads nothing else.
    const search = { action: 'find-reference-figures' as const, projectId: PROJECT.id, query: 'agent memory' }
    const gallery = {
      total: 0, offset: 0, figures: [], basis: 'keyword' as const,
      facets: { venue: {}, year: {}, pattern: {}, tier: {} }, source: { name: 'g', repository: 'r', commit: 'c', license: 'l' },
    }
    b.remote.command.mockResolvedValueOnce(ok({ message: '0 figures', gallery }))
    expect(await b.face.searchFigures(search)).toBe(gallery)
    expect(b.remote.command).toHaveBeenLastCalledWith(search, expect.any(AbortSignal))
    b.remote.command.mockResolvedValueOnce(ok({ message: 'no page' }))
    await expect(b.face.searchFigures(search)).rejects.toThrow(/returned no page/)
    b.remote.command.mockResolvedValueOnce(bad('gallery offline'))
    await expect(b.face.searchFigures(search)).rejects.toThrow('gallery offline')

    // A board read answers with the board the same way.
    const read = { action: 'board-view' as const, projectId: PROJECT.id, refresh: true }
    const board = { spec: { sections: [], collectors: [] }, refreshing: false, machines: [], series: {}, collected: {}, alerts: [] }
    b.remote.command.mockResolvedValueOnce(ok({ message: 'Experiment board', board }))
    expect(await b.face.board(read)).toBe(board)
    expect(b.remote.command).toHaveBeenLastCalledWith(read, expect.any(AbortSignal))
    b.remote.command.mockResolvedValueOnce(ok({ message: 'nothing' }))
    await expect(b.face.board(read)).rejects.toThrow(/returned nothing/)
  })

  it('follows a job the host started until the job list reports it settled', async () => {
    const b = await bench()
    b.remote.command.mockResolvedValueOnce(ok({ message: 'import started', jobId: 'job-import' }))
    let answer: ResearchResponse | undefined
    const running = b.face.run(IMPORT).then((response) => { answer = response })
    await idle()
    // Not listed yet, then listed as running: the caller keeps waiting.
    expect(answer).toBeUndefined()
    b.remote.tasks.mockResolvedValue(ok([task('job-import', 'running', 'import')]))
    await b.face.refresh()
    await idle()
    expect(answer).toBeUndefined()
    const imported = { message: 'Imported 1 source' }
    b.remote.tasks.mockResolvedValue(ok([task('job-import', 'completed', 'Imported 1 source', imported)]))
    await b.face.refresh()
    await running
    expect(answer).toBe(imported)

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
    expect(reading.face.hooks.research.getSnapshot()).toEqual({ snapshot: BLANK, tasks: [] })

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

  it('puts one claim over the whole frame through the focus store, and takes it down again', async () => {
    const b = await bench()

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
    expect(b.face.hooks.focus.getSnapshot()).toEqual({ claim: { projectId: PROJECT.id, claimId: CLAIM_ID } })
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
  it('opens project files in the right sidebar through the conversation on screen, and lets a refusal reach the caller', async () => {
    const b = await bench({ current: 'session-a' })
    b.face.openFile('C:\\research\\sparse', 'paper\\main.pdf')
    expect(b.sidebarRight.openResource).toHaveBeenCalledWith('dsh-resource://file/session/session-a/C:/research/sparse/paper/main.pdf')
    b.sidebarRight.openResource.mockImplementationOnce(() => { throw new Error('no session is bound') })
    expect(() => { b.face.openFile('/r', 'x.pdf') }).toThrow('no session is bound')
    // With no conversation on screen there is no sidebar to show it in.
    b.select(undefined)
    expect(() => { b.face.openFile('/r', 'x.pdf') }).toThrow('No conversation is on screen')
  })

  it('hands a research tool card the record and the same way into a project file', async () => {
    const b = await bench({ current: 'session-a' })
    const card = (b.seat('tool.call.toolview', 'research_check').inject as unknown as () => ResearchToolInjected)()
    expect(card.hooks.research).toBe(b.face.hooks.research)
    card.openProjectFile('C:\\research\\sparse', 'refs.bib')
    expect(b.sidebarRight.openResource).toHaveBeenLastCalledWith('dsh-resource://file/session/session-a/C:/research/sparse/refs.bib')
  })

  it('reads a literature source\'s authors and year once per revision, and leaves them out when its record cannot be read', async () => {
    const b = await bench()
    const answered = (value: unknown, ok = true): Promise<Response> =>
      Promise.resolve({ ok, json: () => Promise.resolve(value) } as Response)
    const answers: (() => Promise<Response>)[] = [
      () => answered({ authors: ['Laban', 'Schnabel', 7], year: 2022 }),
      () => answered({ authors: ['Fabbri'] }),
      () => answered({}, false),
      () => answered({ title: 'no authors' }),
      () => answered(null),
      () => Promise.reject(new Error('offline')),
      () => answered({ authors: ['Kryscinski'], year: 2020 }),
    ]
    const fetched: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      fetched.push(url)
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return answers.shift()!()
    }))
    const source = (revision: number) => ({ id: 'ref', path: '.research/sources/ref/reference.json', revision }) as EvidenceRecord
    expect(await b.face.reference(PROJECT.id, source(1))).toEqual({ authors: ['Laban', 'Schnabel'], year: 2022 })
    // The same revision is read once; a new revision is read again, and a year is left out when there is none.
    expect(await b.face.reference(PROJECT.id, source(1))).toEqual({ authors: ['Laban', 'Schnabel'], year: 2022 })
    expect(await b.face.reference(PROJECT.id, source(2))).toEqual({ authors: ['Fabbri'] })
    expect(fetched).toEqual([
      '/api/research/file?projectId=project-sparse&path=.research%2Fsources%2Fref%2Freference.json',
      '/api/research/file?projectId=project-sparse&path=.research%2Fsources%2Fref%2Freference.json',
    ])
    // A refused read, a record without authors, one that is not an object and a failed fetch each leave the byline out,
    // and the next ask reads again.
    for (let attempt = 0; attempt < 4; attempt++) expect(await b.face.reference(PROJECT.id, source(3))).toBeUndefined()
    expect(await b.face.reference(PROJECT.id, source(3))).toEqual({ authors: ['Kryscinski'], year: 2020 })
    expect(fetched).toHaveLength(7)
  })

  it('tracks every listed session\'s working directory as the list changes', async () => {
    const b = await bench()
    expect(b.face.hooks.directories.getSnapshot()).toEqual({ 'session-a': 'C:\\research\\sparse' })
    b.publishSessions({ 'session-c': { cwd: '/research/other' } })
    expect(b.face.hooks.directories.getSnapshot()).toEqual({ 'session-c': '/research/other' })
  })
})

describe('where startup and 新研究 go', () => {
  const own = newProject({ title: '块稀疏注意力', root: '/research/sparse', brief: '' }, 'w-sparse' as WorkspaceId)
  const example: ResearchProject = { ...newProject({ title: '示例', root: '/demo/example', brief: '' }, 'w-example' as WorkspaceId), example: true }
  const draft: ResearchProject = { ...newProject({ title: '新研究', root: '/home/SciPaper/2026-09-26-1', brief: '' }, 'w-draft' as WorkspaceId), draft: true, untitled: true }
  const snapshotOf = (projects: ResearchProject[]): ResearchSnapshot => ({ projects, preferences: {}, components: [], modes: [] })

  it('registers its landing and 新研究 with ui-workspace for as long as the plugin runs', async () => {
    const b = await bench({
      sessions: { 's-sparse': { cwd: '/research/sparse' } }, workspaces: [['w-sparse', '/research/sparse', ['s-sparse']]], snapshot: snapshotOf([own]),
    })
    expect(b.policies).toHaveLength(1)
    await b.policies[0]!.land()
    expect(b.uiWorkspace.openSession).toHaveBeenCalledWith('s-sparse')
    b.remote.command.mockResolvedValueOnce(ok({ message: 'New research created', project: draft, sessionId: 's-draft' }))
    const opening = b.policies[0]!.startNew()
    b.publishSessions({ 's-sparse': { cwd: '/research/sparse' }, 's-draft': { cwd: draft.root, blank: true } })
    await opening
    expect(b.remote.command).toHaveBeenLastCalledWith({ action: 'start-new' }, expect.any(AbortSignal))
    expect(b.uiWorkspace.openSession).toHaveBeenLastCalledWith('s-draft')
    await stop(b)
    expect(b.policies).toEqual([])
  })

  it('lands in a research\'s folder when none of its conversations has started', async () => {
    const b = await bench({ workspaces: [['w-sparse', '/research/sparse', []]], snapshot: snapshotOf([own]) })
    await b.policies[0]!.land()
    expect(b.uiWorkspace.openWorkspace).toHaveBeenCalledWith('w-sparse')
  })

  it('never keeps an example restored from the last visit selected, and leaves one the person opens later', async () => {
    const b = await bench({
      current: 's-example', sessions: { 's-example': { cwd: '/demo/example' }, 's-sparse': { cwd: '/research/sparse' } },
      workspaces: [['w-sparse', '/research/sparse', ['s-sparse']], ['w-example', '/demo/example', ['s-example']]], snapshot: snapshotOf([own, example]),
    })
    await idle()
    expect(b.uiWorkspace.openSession).toHaveBeenCalledWith('s-sparse')
    b.uiWorkspace.openSession.mockClear()
    b.select('s-example')
    await b.face.refresh()
    await idle()
    expect(b.uiWorkspace.openSession).not.toHaveBeenCalled()
  })

  it('leaves a selection the move lost alone while the draft moves, and carries the draft with the menu\'s own pick', async () => {
    const b = await bench({
      current: 's-draft', sessions: { 's-draft': { cwd: draft.root, blank: true } }, workspaces: [['w-draft', draft.root, ['s-draft']]], snapshot: snapshotOf([draft]),
    })
    const moved: ResearchProject = { ...draft, workspaceId: 'w-moved' as WorkspaceId, root: '/picked' }
    const answer = deferred<RemoteResult<ResearchResponse>>()
    b.remote.command.mockImplementationOnce(() => answer.promise)
    const carry = vi.fn(() => { b.select('s-moved') })
    const moving = b.entry.move({ projectId: draft.id, root: '/picked' }, carry)
    // The host archives the draft's conversation before it answers, and ui-workspace clears the selection and asks to land.
    b.select(undefined)
    await b.policies[0]!.land()
    expect(b.remote.command).toHaveBeenCalledTimes(1)
    expect(b.uiWorkspace.openSession).not.toHaveBeenCalled()
    answer.settle(ok({ message: 'Research moved', outcome: 'moved', project: moved, sessionId: 's-moved' }))
    await idle()
    b.publishSessions({ 's-moved': { cwd: '/picked', blank: true } })
    b.workspaceList.set({
      ...b.workspaceList.getSnapshot(),
      items: [{ workspaceId: 'w-moved' as WorkspaceId, path: '/picked', title: 'picked', sessionIds: ['s-moved' as SessionId], createdAt: '', updatedAt: '' }],
    })
    expect(await moving).toMatchObject({ outcome: 'moved' })
    expect(carry).toHaveBeenCalledWith('w-moved')
    expect(b.uiWorkspace.openSession).not.toHaveBeenCalled()
  })

  it('opens another research with the draft and then discards the draft, through the same face', async () => {
    const b = await bench({
      current: 's-draft', sessions: { 's-draft': { cwd: draft.root, blank: true }, 's-other': { cwd: '/research/sparse', blank: true } },
      workspaces: [['w-draft', draft.root, ['s-draft']], ['w-sparse', '/research/sparse', ['s-other']]], snapshot: snapshotOf([draft, own]),
    })
    await b.entry.adopt(draft.id, 'w-sparse' as WorkspaceId, () => { b.select('s-other') })
    expect(b.remote.command).toHaveBeenLastCalledWith({ action: 'discard-draft', projectId: draft.id }, expect.any(AbortSignal))
  })

  it('opens nothing late: not after a newer navigation, and not once the plugin is gone', async () => {
    const b = await bench({ current: 's-talk', sessions: { 's-talk': { cwd: '/elsewhere' } } })
    b.remote.command.mockResolvedValueOnce(ok({ message: 'New research created', sessionId: 's-draft' }))
    const superseded = b.policies[0]!.startNew()
    await idle()
    b.layout.beginNavigation()
    b.publishSessions({ 's-talk': { cwd: '/elsewhere' }, 's-draft': { cwd: draft.root, blank: true } })
    await superseded
    b.remote.command.mockResolvedValueOnce(ok({ message: 'New research created', sessionId: 's-late' }))
    const policy = b.policies[0]!
    const late = policy.startNew()
    await idle()
    await stop(b)
    await expect(late).rejects.toThrow(en.entryNotListed)
    b.publishSessions({ 's-late': {} })
    expect(b.uiWorkspace.openSession).not.toHaveBeenCalled()
  })
})

describe('the face the entry screen acts through', () => {
  it('shows a folder in the file manager where the host can, and says so on the entry line when it cannot', async () => {
    const b = await bench()
    expect(b.entry.hooks.canReveal.getSnapshot()).toBe(true)
    b.entry.reveal('/research/sparse')
    await idle()
    expect(b.remoteSession.openWorkspacePath).toHaveBeenCalledWith({ path: '/research/sparse', action: 'reveal' }, expect.any(AbortSignal))
    b.remoteSession.openWorkspacePath.mockResolvedValueOnce(bad('no desktop on this host'))
    b.entry.reveal('/research/sparse')
    await idle()
    expect(b.entry.hooks.entry.getSnapshot().notice).toMatchObject({ kind: 'failed', action: 'reveal', reason: 'no desktop on this host' })
    b.entry.showProgress()
    expect(b.sidebarRight.openTab).toHaveBeenCalledWith('research')
  })

  it('reads a chooser that failed as dismissed, saying why on the entry line', async () => {
    const b = await bench()
    expect(await b.entry.chooseFolder()).toEqual({ kind: 'picked', path: '/picked/project' })
    b.directoryPicker.pick.mockResolvedValueOnce(bad('the chooser crashed'))
    expect(await b.entry.chooseFolder()).toEqual({ kind: 'cancelled' })
    expect(b.entry.hooks.entry.getSnapshot().notice).toMatchObject({ kind: 'failed', action: 'move', reason: 'the chooser crashed' })
  })

  it('offers no file manager when the host says no, cannot say, or answers after the plugin is gone', async () => {
    const refused = await bench({ canReveal: Promise.resolve(bad('no desktop')) })
    const failed = await bench({ canReveal: Promise.reject(new Error('the carrier is down')) })
    const answer = deferred<RemoteResult<boolean>>()
    const late = await bench({ canReveal: answer.promise })
    await stop(late)
    answer.settle(ok(true))
    await idle()
    for (const b of [refused, failed, late]) expect(b.entry.hooks.canReveal.getSnapshot()).toBe(false)
  })
})

describe('the face the research tree acts through', () => {
  const page = globalThis as { __DSH_RESEARCH__?: unknown }

  /** A bench whose page carries the edition's setting, so the tree takes the sidebar's browsing seat. */
  async function treeBench(services: BenchServices = {}) {
    page.__DSH_RESEARCH__ = { hideDeveloperCells: true }
    try {
      const b = await bench(services)
      return { ...b, tree: (b.seat('sidebar.workspaces').inject as unknown as () => ResearchTreeInjected)() }
    } finally {
      delete page.__DSH_RESEARCH__
    }
  }

  it('reads the record, the folders and the file-manager answer the other seats read, and navigates through ui-workspace', async () => {
    const b = await treeBench()
    expect(b.tree.hooks.research).toBe(b.face.hooks.research)
    expect(b.tree.hooks.directories).toBe(b.face.hooks.directories)
    expect(b.tree.hooks.canReveal).toBe(b.entry.hooks.canReveal)
    b.tree.openSession('session-b' as SessionId)
    expect(b.uiWorkspace.openSession).toHaveBeenCalledWith('session-b')
    await b.tree.openWorkspace('workspace-sparse' as WorkspaceId)
    expect(b.uiWorkspace.openWorkspace).toHaveBeenCalledWith('workspace-sparse')
    b.tree.startSession('workspace-sparse' as WorkspaceId)
    expect(b.uiWorkspace.startSession).toHaveBeenCalledWith('workspace-sparse')
    // Commands and creation go the way every research seat sends them.
    expect(await b.tree.run(CHECK)).toBe(OUTCOME)
    expect(await b.tree.create(NEW_PROJECT)).toBe(PROJECT)
    expect(b.remote.create).toHaveBeenCalledWith(NEW_PROJECT)
  })

  it('renames a conversation through its own session, and says why an unknown or refused one failed', async () => {
    const b = await treeBench()
    await b.tree.renameConversation('session-a' as SessionId, 'Measured sample')
    expect(b.sessions.binding).toHaveBeenCalledWith('session-a')
    expect(b.renames.get('session-a')).toHaveBeenCalledWith('Measured sample')
    b.renames.get('session-a')!.mockResolvedValueOnce(bad('the title is too long'))
    await expect(b.tree.renameConversation('session-a' as SessionId, 'x'.repeat(500))).rejects.toThrow('the title is too long')
    await expect(b.tree.renameConversation('session-gone' as SessionId, 'Gone')).rejects.toThrow('unknown session "session-gone"')
  })

  it('archives one conversation, and takes a folder out of the list with every conversation it still lists', async () => {
    const b = await treeBench({ workspaces: [['w-legacy', '/legacy', ['s-1', 's-2', 's-3']]], archived: ['s-2'] })
    await b.tree.archiveConversation('s-9' as SessionId)
    expect(b.uiWorkspace.archiveSession.mock.calls).toEqual([['s-9']])
    b.uiWorkspace.archiveSession.mockClear()
    await b.tree.removeFolder('w-legacy' as WorkspaceId)
    // The conversation archived already stays as it is; the registration goes after the others.
    expect(b.uiWorkspace.archiveSession.mock.calls).toEqual([['s-1'], ['s-3']])
    expect(b.workspaces.delete).toHaveBeenCalledWith('w-legacy')
    // A folder the list no longer carries archives nothing and is still unregistered.
    b.uiWorkspace.archiveSession.mockClear()
    await b.tree.removeFolder('w-gone' as WorkspaceId)
    expect(b.uiWorkspace.archiveSession).not.toHaveBeenCalled()
    expect(b.workspaces.delete).toHaveBeenLastCalledWith('w-gone')
  })

  it('shows a folder in the file manager, and passes the host\'s refusal on', async () => {
    const b = await treeBench()
    await b.tree.reveal('/research/sparse')
    expect(b.remoteSession.openWorkspacePath).toHaveBeenCalledWith({ path: '/research/sparse', action: 'reveal' }, expect.any(AbortSignal))
    b.remoteSession.openWorkspacePath.mockResolvedValueOnce(bad('no desktop on this host'))
    await expect(b.tree.reveal('/research/sparse')).rejects.toThrow('no desktop on this host')
  })

  it('searches conversation text through the shell\'s session search, within its bound', async () => {
    const b = await treeBench()
    const signal = new AbortController().signal
    expect(await b.tree.searchConversations('42', signal)).toEqual({ items: [{ sessionId: 'session-a', snippet: 'measured 42' }], hasMore: false })
    expect(b.sessions.search).toHaveBeenCalledWith('42', signal)
    b.sessions.search.mockResolvedValueOnce(bad('content search is off'))
    await expect(b.tree.searchConversations('42', signal)).rejects.toThrow('content search is off')
    expect(b.tree.searchResultLimit).toBe(20)
  })
})
