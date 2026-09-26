/** Research navigation, native conversation companion and model/tool settings. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ConversationDrafts } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { EvidenceRecord, ProjectId, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type {
  EntryView, FolderPick, ResearchEntryInjected, ResearchFocus, ResearchInjected, ResearchToolInjected, ResearchTreeInjected, ResearchView,
  SessionDirectories, SourceReference,
} from './contract.ts'
import { createResearchEntry, until } from './entry.ts'
import { projectFileAddress, researchFileUrl } from './format.ts'
import { DEFAULT_PRESET_FIELD, PRESET_SETTINGS_NAMESPACE, presetDefaults, type PresetDefaults } from './presets.ts'
import { ResearchMark, ResearchBrand } from './Brand.tsx'
import { ResearchHeroMark } from './Hero.tsx'
import { ResearchRail, ResearchRailTitle } from './Rail.tsx'
import { ResearchBoardTab, ResearchBoardTitle, ResearchGalleryTab, ResearchGalleryTitle, ResearchSourcesTitle } from './Tabs.tsx'
import { ResearchSourcesTab } from './Sources.tsx'
import { diagramTitle, ResearchDiagramTab } from './Diagram.tsx'
import { ResearchClaimSheet } from './ClaimSheet.tsx'
import { ResearchRuns } from './RunPanel.tsx'
import { ResearchStatusChip } from './Header.tsx'
import { ResearchTree } from './ResearchTree.tsx'
import { createResearchTreeStore } from './treeStore.ts'
import { ResearchEntryLine, ResearchTryChips } from './EntryScreen.tsx'
import { ResearchFolderMenu } from './FolderMenu.tsx'
import { ResearchSettingsSection } from './ResearchSettings.tsx'
import { SkipHarnessNotice } from './Onboarding.tsx'
import { EmptyCell } from './EmptyCell.tsx'
import { AutonomyChip } from './AutonomyChip.tsx'
import { guardExampleComposers } from './examples.ts'
import { ResearchCheckCard, ResearchToolCard } from './ResearchToolView.tsx'
import { en, zh, type ResearchKey } from './locales.ts'

/** This implementation's identity in the right-sidebar tab system; each further tab type is named below it. */
const RESEARCH_TAB_ID = '@deepseek-ai/dsh-client-ui-research'
/** The research record's tab kind. */
const RESEARCH_TAB_KIND = 'research'
/** The secondary tools' page kinds, and the draw.io editor's resource kind, each with its implementation id. */
const BOARD_TAB = { id: `${RESEARCH_TAB_ID}/board`, kind: 'research-board' } as const
const SOURCES_TAB = { id: `${RESEARCH_TAB_ID}/sources`, kind: 'research-sources' } as const
const GALLERY_TAB = { id: `${RESEARCH_TAB_ID}/gallery`, kind: 'research-gallery' } as const
const DIAGRAM_TAB = { id: `${RESEARCH_TAB_ID}/drawio`, kind: 'research-drawio' } as const
/** The right-sidebar tab kind of the research folder's file tree, owned by ui-sidebar-files. */
const FILES_TAB_KIND = 'files'
/**
 * The width a tab suggests for the right panel, which applies only while the
 * panel has none yet: the record and the Sources list are a column; the board
 * and the figures need room (D16).
 */
const NARROW_TAB_PX = 320
const WIDE_TAB_PX = 560
/** How long a conversation may take to appear in the session list before its folder's blank conversation opens instead. */
const LISTING_WAIT_MS = 5000
/** How long 这里就是一项新的研究 (This already is a new research) stays on the entry screen. */
const NOTICE_MS = 4000

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { research: ResearchKey } }
export type { ResearchInjected, ResearchView, WorkbenchProps } from './contract.ts'
export const inject = [
  'remote', 'remote.research', 'remote.directoryPicker', 'remote.session', 'slots', 'locale', 'layout', 'sessions', 'workspaces', 'sidebarRight',
  'uiWorkspace', 'settingsScope',
]

/**
 * The page global the host half fills from the row's validated configuration
 * (`../index.ts`) for both Web and desktop pages.
 */
interface ResearchPageGlobal {
  __DSH_RESEARCH__?: { hideDeveloperCells?: unknown }
}

/**
 * Mount the project workbench using the native slot and Remote interfaces.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  const hideDeveloperCells = (globalThis as ResearchPageGlobal).__DSH_RESEARCH__?.hideDeveloperCells === true
  ctx.effect(() => ctx.locale.register('research', { en, zh }), 'research.locales')
  ctx.effect(() => {
    document.body.dataset.researchWorkbench = ''
    return () => { delete document.body.dataset.researchWorkbench }
  }, 'research.appearance')
  const state = createSnapshotStore<ResearchView>({ snapshot: null, tasks: [] })
  // The Sources tab and the frame-wide claim sheet live in different slot scopes, so
  // the selection between them travels through a store rather than through props.
  const focus = createSnapshotStore<ResearchFocus>({ claim: null })
  // Every conversation in a project folder shows that project, so seats need each session's working directory.
  const sessions = ctx.get('sessions') as unknown as ISessions
  const workspaces = ctx.get('workspaces') as unknown as IWorkspaces
  const directories = createSnapshotStore<SessionDirectories>({})
  const readDirectories = (): void => {
    const byId = sessions.list.getSnapshot().byId
    const next: Record<string, string> = {}
    for (const [id, summary] of Object.entries(byId)) if (summary.cwd !== undefined) next[id] = summary.cwd
    directories.set(next)
  }
  readDirectories()
  ctx.effect(() => sessions.list.subscribe(readDirectories), 'research.session-directories')
  // An example's conversations can be read, not continued; the composer says so where the conversation plugin runs.
  ctx.inject(['conversation'], (scope: Context) => {
    scope.effect(() => guardExampleComposers({
      research: state, directories, blocks: scope.conversation.blocks,
      reason: () => ctx.locale.bind('research')('exampleComposerBlocked'),
    }), 'research.example-composers')
  })
  const controller = new AbortController()
  let refreshing: Promise<void> | undefined
  const unwrap = <T>(result: RemoteResult<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value }
  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing
    const reading = [ctx.remote.research.snapshot().then(unwrap), ctx.remote.research.tasks().then(unwrap)] as const
    refreshing = Promise.all(reading).then(([snapshot, tasks]) => {
      if (!controller.signal.aborted) state.set({ ...state.getSnapshot(), snapshot, tasks })
    }, (_failure: unknown) => {
      // A failed read keeps the last record and job list; the three-second poll reads again.
    }).finally(() => { refreshing = undefined })
    return refreshing
  }
  /** A read that starts after the action it follows: a read already in flight may predate it. */
  const reread = async (): Promise<void> => {
    await refreshing
    await refresh()
  }
  /** Resolve with a host job's result once the job list reports it settled; a failed job rejects with its message. */
  const settled = (first: ResearchResponse): Promise<ResearchResponse> => {
    const jobId = first.jobId
    if (jobId === undefined) return Promise.resolve(first)
    return new Promise((resolve, reject) => {
      const outcome = (): boolean => {
        const task = state.getSnapshot().tasks.find(item => item.id === jobId)
        if (task === undefined || task.status === 'running') return false
        if (task.status === 'completed') resolve(task.result ?? { message: task.message })
        else reject(new Error(task.message))
        return true
      }
      // Once the plugin is gone nobody waits for the answer, so the promise is left unsettled.
      if (outcome() || controller.signal.aborted) return
      const stop = (): void => { unsubscribe(); controller.signal.removeEventListener('abort', stop) }
      const unsubscribe = state.subscribe(() => { if (outcome()) stop() })
      controller.signal.addEventListener('abort', stop)
    })
  }
  /** Follow a command's answer to its end, reading the record again first. */
  const follow = async (first: ResearchResponse): Promise<ResearchResponse> => {
    await reread()
    return settled(first)
  }
  /** Resolve true once the session list carries the session, false when it has not within the wait or the plugin went away. */
  const whenListed = (sessionId: SessionId): Promise<boolean> =>
    until(() => sessions.list.getSnapshot().byId[sessionId] !== undefined, [sessions.list], LISTING_WAIT_MS, controller.signal)
  /** The host's folder chooser; a composition without one (browse, a remote browser) answers `unavailable`. */
  const pickFolder = async (): Promise<FolderPick> => {
    const result = await ctx.remote.directoryPicker.pick()
    if (result.ok) return result.value === null ? { kind: 'cancelled' } : { kind: 'picked', path: result.value }
    if (result.error.code === 'directory-picker/unavailable') return { kind: 'unavailable' }
    throw new Error(result.error.message)
  }
  // A file opens through the conversation on screen, which is the one whose right sidebar is mounted.
  const openProjectFile = (root: string, path: string): void => {
    const current = sessions.list.getSnapshot().current
    if (current === undefined) throw new Error('No conversation is on screen to show the file beside')
    ctx.sidebarRight.openResource(projectFileAddress(current, root, path))
  }
  const openTab = (kind: string, width: number): void => {
    ctx.layout.setInitialRightbarWidth(width)
    ctx.sidebarRight.openTab(kind)
  }
  const showProgress = (): void => { openTab(RESEARCH_TAB_KIND, NARROW_TAB_PX) }
  // The header chip is the record's door both ways: it closes the panel only while the panel shows the record.
  const toggleProgress = (): void => {
    if (ctx.sidebarRight.isExpanded() && ctx.sidebarRight.active()?.kind === RESEARCH_TAB_KIND) ctx.sidebarRight.toggleExpanded()
    else showProgress()
  }
  // Whether the host can show a folder in the desktop's file manager: asked once, false until the host says so.
  const canReveal = createSnapshotStore(false)
  void ctx.remote.session.canOpenWorkspacePath().then((result) => {
    if (result.ok && !controller.signal.aborted) canReveal.set(result.value)
  }, (_failure: unknown) => {
    // Without an answer the menus offer no file-manager row; nothing else depends on it.
  })
  const reveal = async (path: string): Promise<void> => {
    unwrap(await ctx.remote.session.openWorkspacePath({ path, action: 'reveal' }, controller.signal))
  }
  // Which agent preset conversations compose from: the research assistant's, unless the settings keep another as the default.
  const presetScope = ctx.settingsScope.bind({ namespace: PRESET_SETTINGS_NAMESPACE })
  const presets = createSnapshotStore<PresetDefaults | null>(null)
  const readPresets = (): void => {
    const next = presetDefaults(presetScope.getSnapshot())
    const known = presets.getSnapshot()
    if (next?.research !== known?.research || next?.saved !== known?.saved) presets.set(next)
  }
  readPresets()
  ctx.effect(() => presetScope.subscribe(readPresets), 'research.agent-presets')
  const resetDefaultPreset = async (): Promise<void> => {
    await presetScope.unset(DEFAULT_PRESET_FIELD)
    // A refused write reloads the settings instead of failing, so a default still saved is the refusal.
    if (presetDefaults(presetScope.getSnapshot())?.saved !== undefined) throw new Error(ctx.locale.bind('research')('legacyResetUnchanged'))
  }
  // A literature source's authors and year live in the reference record beside it; each revision is read once.
  const references = new Map<string, Promise<SourceReference | undefined>>()
  const readReference = async (projectId: ProjectId, source: EvidenceRecord): Promise<SourceReference | undefined> => {
    const response = await fetch(researchFileUrl(projectId, source.path), { signal: controller.signal })
    if (!response.ok) return undefined
    const value: unknown = await response.json()
    const authors: unknown = typeof value === 'object' && value !== null && 'authors' in value ? value.authors : undefined
    if (!Array.isArray(authors)) return undefined
    const names = (authors as unknown[]).filter((name): name is string => typeof name === 'string')
    const year: unknown = (value as { year?: unknown }).year
    return typeof year === 'number' ? { authors: names, year } : { authors: names }
  }
  const reference: ResearchInjected['reference'] = (projectId, source) => {
    const key = `${projectId}\n${source.path}\n${source.revision}`
    const known = references.get(key)
    if (known !== undefined) return known
    // A reference that cannot be read, refused or failing or naming no authors, leaves the byline out until a later tab asks again.
    const read = readReference(projectId, source).catch((_failure: unknown) => undefined).then((found) => {
      if (found === undefined) references.delete(key)
      return found
    })
    references.set(key, read)
    return read
  }
  const create: ResearchInjected['create'] = async (request) => {
    const project = unwrap(await ctx.remote.research.create(request))
    await reread()
    return project
  }
  const run: ResearchInjected['run'] = async request => follow(unwrap(await ctx.remote.research.command(request, controller.signal)))
  const injected = (): ResearchInjected => ({
    hooks: { research: state, focus, directories, canReveal, presets }, refresh,
    openFile: openProjectFile,
    openFiles: () => { ctx.sidebarRight.openTab(FILES_TAB_KIND) },
    showProgress,
    toggleProgress,
    reveal,
    resetDefaultPreset,
    focusClaim: (claim) => { focus.update((s) => { s.claim = claim }) },
    create,
    pickDirectory: pickFolder,
    run,
    searchFigures: async (request) => {
      const { gallery } = unwrap(await ctx.remote.research.command(request, controller.signal))
      if (!gallery) throw new Error('The figure gallery returned no page')
      return gallery
    },
    board: async (request) => {
      const { board } = unwrap(await ctx.remote.research.command(request, controller.signal))
      if (!board) throw new Error('The experiment board returned nothing')
      return board
    },
    configure: async (preferences, keys) => {
      unwrap(await ctx.remote.research.configure(preferences))
      if (keys.image) unwrap(await ctx.remote.research.setCredential('image', keys.image))
      if (keys.embedding) unwrap(await ctx.remote.research.setCredential('embedding', keys.embedding))
      await reread()
    },
    reference,
    // The component list says what is installed, so it is read again once the install has settled.
    install: async (component) => {
      await follow(unwrap(await ctx.remote.research.installComponent(component)))
      await reread()
    },
    openConversation: async (sessionId, workspaceId) => {
      const listed = await whenListed(sessionId as SessionId)
      if (controller.signal.aborted) return
      if (listed) ctx.uiWorkspace.openSession(sessionId as SessionId)
      else await ctx.uiWorkspace.openWorkspace(workspaceId as Parameters<UiWorkspace['openWorkspace']>[0])
    },
    openBoard: () => { openTab(BOARD_TAB.kind, WIDE_TAB_PX) },
    openSources: (section) => {
      ctx.layout.setInitialRightbarWidth(NARROW_TAB_PX)
      ctx.sidebarRight.openTab(SOURCES_TAB.kind, section === undefined ? {} : { params: { section } })
    },
    openGallery: () => { openTab(GALLERY_TAB.kind, WIDE_TAB_PX) },
  })
  // Where startup and 新研究 go (ui-workspace's entry policy), and the untouched draft's moves.
  const entryView = createSnapshotStore<EntryView>({ notice: null })
  const researchEntry = createResearchEntry({
    sessions, workspaces, research: state, entry: entryView, reread,
    command: async request => unwrap(await ctx.remote.research.command(request, controller.signal)),
    openSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
    openWorkspace: workspaceId => ctx.uiWorkspace.openWorkspace(workspaceId),
    beginNavigation: () => ctx.layout.beginNavigation(),
    lifetime: controller.signal,
    t: ctx.locale.bind('research'),
    timing: { listingMs: LISTING_WAIT_MS, noticeMs: NOTICE_MS },
  })
  ctx.effect(() => {
    const unregister = ctx.uiWorkspace.setEntryPolicy({ land: () => researchEntry.land(), startNew: () => researchEntry.startNew() })
    const stopWatching = researchEntry.leaveStartupExample()
    return () => {
      stopWatching()
      unregister()
    }
  }, 'research.entry-policy')
  const entryInjected = (): ResearchEntryInjected => ({
    hooks: { research: state, directories, entry: entryView, canReveal },
    chooseFolder: () => pickFolder().catch((error: unknown): FolderPick => {
      researchEntry.fail('move', error)
      return { kind: 'cancelled' }
    }),
    move: (request, carry) => researchEntry.move(request, carry),
    adopt: (draftId, workspaceId, carry) => researchEntry.adopt(draftId, workspaceId, carry),
    reveal: (path) => {
      void ctx.remote.session.openWorkspacePath({ path, action: 'reveal' }, controller.signal).then(unwrap).catch((error: unknown) => {
        researchEntry.fail('reveal', error)
      })
    },
    showProgress,
  })
  const treeInjected = (drafts: ObservableSnapshot<ConversationDrafts>): ResearchTreeInjected => ({
    hooks: { research: state, directories, canReveal, drafts },
    openSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
    openWorkspace: workspaceId => ctx.uiWorkspace.openWorkspace(workspaceId),
    startSession: (workspaceId) => { ctx.uiWorkspace.startSession(workspaceId) },
    run,
    create,
    renameConversation: async (sessionId, title) => {
      // A conversation renames itself (the session face); the binding resolves any listed one.
      const session = sessions.binding(sessionId)?.session
      if (session === undefined) throw new Error(`unknown session "${sessionId}"`)
      const result = await session.rename(title)
      if (!result.ok) throw new Error(result.error.message)
    },
    archiveConversation: sessionId => ctx.uiWorkspace.archiveSession(sessionId),
    removeFolder: async (workspaceId) => {
      const { items, archivedSessionIds } = workspaces.list.getSnapshot()
      const archived = new Set<string>(archivedSessionIds)
      const folder = items.find(item => item.workspaceId === workspaceId)
      for (const sessionId of folder?.sessionIds ?? []) if (!archived.has(sessionId)) await ctx.uiWorkspace.archiveSession(sessionId)
      await workspaces.delete(workspaceId)
    },
    reveal,
    searchConversations: async (query, signal) => unwrap(await sessions.search(query, signal)),
    searchResultLimit: sessions.searchResultLimit,
  })
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', locale: 'research' }, ResearchBrand))
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, ResearchMark))
  // Where the research stands, from the conversation header; clicking it opens the research tab, or closes the panel showing it.
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'research-status', order: 5, locale: 'research', inject: injected }, ResearchStatusChip))
  // The blank-session entry: the research mark, the line under the headline, and two example sentences to start from.
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, ResearchHeroMark))
  ctx.slots.inject('conversation.hero.welcome', () => ctx.slots.register({ name: 'conversation.hero.welcome', id: 'research-entry', order: 10, locale: 'research', inject: entryInjected }, ResearchEntryLine))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'research-try', order: 7, locale: 'research', inject: entryInjected }, ResearchTryChips))
  // Submitted runs outlive the window, so the group reports itself above the composer.
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'research-runs', order: 6, locale: 'research', inject: injected }, ResearchRuns))
  // A claim's sources open over the whole frame; the Sources tab puts one in focus.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'research-claim', order: 20, locale: 'research', inject: injected }, ResearchClaimSheet))
  // The research tools' calls read in the reader's language inside the conversation, a research check as its own card.
  const toolInjected = (): ResearchToolInjected => ({ hooks: { research: state }, openProjectFile })
  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'research_check', locale: 'research', inject: toolInjected }, ResearchCheckCard)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'research_project', locale: 'research', inject: toolInjected }, ResearchToolCard)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'research_evidence', locale: 'research', inject: toolInjected }, ResearchToolCard)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'research_artifact', locale: 'research', inject: toolInjected }, ResearchToolCard)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'research_environment', locale: 'research', inject: toolInjected }, ResearchToolCard)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'research_experiment', locale: 'research', inject: toolInjected }, ResearchToolCard)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'research_board', locale: 'research', inject: toolInjected }, ResearchToolCard)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'research_media', locale: 'research', inject: toolInjected }, ResearchToolCard)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'research_knowledge', locale: 'research', inject: toolInjected }, ResearchToolCard)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'research_task', locale: 'research', inject: toolInjected }, ResearchToolCard)
  })
  // Configuration lives in settings; the main surface stays free of it.
  // Just before 已归档会话 (25), so the section order never depends on which plugin loaded first.
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'research', order: 24, label: () => ctx.locale.bind('research')('settingsSection'), locale: 'research', inject: injected }, ResearchSettingsSection))
  // Shell cells that are developer surfaces here, each shadowed (the host half's `Config`): three by an empty
  // cell, the harness's first-run notice by a step that completes at once, the composer's access chip by the
  // research's autonomy, which decides every conversation's preset, and the blank conversation's folder menu
  // by the research's, which offers no folder that is not a research.
  if (hideDeveloperCells) {
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'stats', priority: -1 }, EmptyCell))
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({ name: 'settings.general.item', id: 'permission', priority: -1 }, EmptyCell))
    ctx.slots.inject('settings.action', () => ctx.slots.register({ name: 'settings.action', id: 'open-document', priority: -1 }, EmptyCell))
    // The harness's internal-testing notice is not this product's; the API-key step stays.
    ctx.slots.inject('settings.onboarding', () => ctx.slots.register({ name: 'settings.onboarding', id: 'welcome-notice', priority: -1 }, SkipHarnessNotice))
    ctx.slots.inject('conversation.input.permission', () => ctx.slots.register({ name: 'conversation.input.permission', priority: -1, locale: 'research', inject: injected }, AutonomyChip))
    ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register({ name: 'conversation.hero.workspace', priority: -1, locale: 'research', inject: entryInjected }, ResearchFolderMenu))
    // The sidebar lists researches and their conversations in place of the shell's workspace browser, which
    // stays registered underneath and keeps declaring its directory-flow child for the folder pickers.
    ctx.inject(['conversation'], scope => scope.slots.inject('sidebar.workspaces', () => scope.slots.register({
      name: 'sidebar.workspaces', priority: -1, locale: 'research', store: createResearchTreeStore(),
      inject: () => treeInjected(scope.conversation.input.drafts),
    }, ResearchTree)))
  }
  // Beside the conversation: the research record, which reports read-only, and the secondary tools as tabs
  // of their own, opened only from the record, a run card or the entry line. The guide page lists the record
  // alone. A `.drawio` file opens in the draw.io editor, ahead of the plain text viewer.
  ctx.inject(['sidebarRightTabs'], (scope: Context) => {
    const t = scope.locale.bind('research')
    scope.effect(() => scope.sidebarRightTabs.register({
      id: RESEARCH_TAB_ID,
      kind: RESEARCH_TAB_KIND,
      priority: 'builtin',
      title: () => t('railTitle'),
      guide: [{ id: 'research', order: 15, title: () => t('railGuideTitle'), description: () => t('railGuideDescription'), icon: ResearchHeroMark }],
    }), 'research.rail-type')
    scope.effect(() => scope.sidebarRightTabs.register({ ...BOARD_TAB, priority: 'builtin', title: () => t('boardTitle') }), 'research.board-type')
    scope.effect(() => scope.sidebarRightTabs.register({ ...SOURCES_TAB, priority: 'builtin', title: () => t('sourcesTab') }), 'research.sources-type')
    scope.effect(() => scope.sidebarRightTabs.register({ ...GALLERY_TAB, priority: 'builtin', title: () => t('gallery') }), 'research.gallery-type')
    scope.effect(() => scope.sidebarRightTabs.register({
      ...DIAGRAM_TAB,
      priority: 'builtin',
      patterns: ['*.drawio'],
      canOpen: address => parseFileAddress(address) !== undefined,
      title: diagramTitle,
    }), 'research.drawio-type')
    scope.slots.inject('sidebar.right.pane.tab', function* () {
      yield scope.slots.register({ name: 'sidebar.right.pane.tab', key: RESEARCH_TAB_ID, locale: 'research', inject: injected }, ResearchRail)
      yield scope.slots.register({ name: 'sidebar.right.pane.tab', key: BOARD_TAB.id, locale: 'research', inject: injected }, ResearchBoardTab)
      yield scope.slots.register({ name: 'sidebar.right.pane.tab', key: SOURCES_TAB.id, locale: 'research', inject: injected }, ResearchSourcesTab)
      yield scope.slots.register({ name: 'sidebar.right.pane.tab', key: GALLERY_TAB.id, locale: 'research', inject: injected }, ResearchGalleryTab)
      yield scope.slots.register({ name: 'sidebar.right.pane.tab', key: DIAGRAM_TAB.id, locale: 'research', inject: injected }, ResearchDiagramTab)
    })
    scope.slots.inject('sidebar.right.pane.tab.title', function* () {
      yield scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: RESEARCH_TAB_ID, locale: 'research' }, ResearchRailTitle)
      yield scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: BOARD_TAB.id, locale: 'research' }, ResearchBoardTitle)
      yield scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: SOURCES_TAB.id, locale: 'research' }, ResearchSourcesTitle)
      yield scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: GALLERY_TAB.id, locale: 'research' }, ResearchGalleryTitle)
    })
  })
  const timer = setInterval(() => { void refresh() }, 3000)
  ctx.effect(() => () => { controller.abort(); clearInterval(timer) }, 'research.refresh')
  void refresh()
}
