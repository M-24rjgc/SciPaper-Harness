/** Research navigation, native conversation companion and model/tool settings. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ResearchFocus, ResearchInjected, ResearchToolInjected, ResearchView, SessionDirectories } from './contract.ts'
import { projectFileAddress } from './format.ts'
import { Workbench, ResearchMark, ResearchBrand } from './Workbench.tsx'
import { ResearchHeroMark } from './Hero.tsx'
import { ResearchRail, ResearchRailTitle } from './Rail.tsx'
import { ResearchClaimSheet } from './ClaimSheet.tsx'
import { ResearchRuns } from './RunPanel.tsx'
import { ResearchStatusChip } from './Header.tsx'
import { ResearchProjectEntry, ResearchProjects } from './ProjectEntry.tsx'
import { ResearchNewProject } from './NewProject.tsx'
import { ResearchSettingsSection } from './ResearchSettings.tsx'
import { SkipHarnessNotice } from './Onboarding.tsx'
import { EmptyCell } from './EmptyCell.tsx'
import { guardExampleComposers } from './examples.ts'
import { ResearchCheckCard, ResearchToolCard } from './ResearchToolView.tsx'
import { en, zh, type ResearchKey } from './locales.ts'

/** This implementation's identity in the right-sidebar tab system. */
const RESEARCH_TAB_ID = '@deepseek-ai/dsh-client-ui-research'
/** The tab kind this package owns. */
const RESEARCH_TAB_KIND = 'research'
/** The right-sidebar tab kind of the research folder's file tree, owned by ui-sidebar-files. */
const FILES_TAB_KIND = 'files'
/** How long a conversation may take to appear in the session list before its folder's blank conversation opens instead. */
const LISTING_WAIT_MS = 5000

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { research: ResearchKey } }
export type { ResearchInjected, ResearchView, WorkbenchProps } from './contract.ts'
export const inject = ['remote', 'remote.research', 'remote.directoryPicker', 'slots', 'locale', 'layout', 'sessions', 'sidebarRight', 'uiWorkspace']

/**
 * The page global the host half fills from the row's validated configuration
 * (`../index.ts`); absent when no Web server served the page.
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
  const state = createSnapshotStore<ResearchView>({ snapshot: null, tasks: [], response: null })
  // The rail and the frame-wide claim sheet live in different slot scopes, so the
  // selection between them travels through a store rather than through props.
  const focus = createSnapshotStore<ResearchFocus>({ claim: null })
  // Every conversation in a project folder shows that project, so seats need each session's working directory.
  const sessions = ctx.get('sessions') as unknown as ISessions
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
  /** Follow a command's answer to its end, read the record again, and keep the result for the file panel. */
  const follow = async (first: ResearchResponse): Promise<ResearchResponse> => {
    await reread()
    const response = await settled(first)
    state.update((s) => { s.response = response })
    return response
  }
  /** Resolve true once the session list carries the session, false when it has not within the wait or the plugin went away. */
  const whenListed = (sessionId: SessionId): Promise<boolean> => {
    const listed = (): boolean => sessions.list.getSnapshot().byId[sessionId] !== undefined
    if (listed()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const finish = (found: boolean): void => {
        clearTimeout(timer)
        unsubscribe()
        controller.signal.removeEventListener('abort', abandon)
        resolve(found)
      }
      const abandon = (): void => { finish(false) }
      const timer = setTimeout(abandon, LISTING_WAIT_MS)
      const unsubscribe = sessions.list.subscribe(() => { if (listed()) finish(true) })
      controller.signal.addEventListener('abort', abandon)
    })
  }
  const openProjectFile = (root: string, path: string): void => { ctx.sidebarRight.openResource(projectFileAddress(root, path)) }
  const injected = (): ResearchInjected => ({
    hooks: { research: state, focus, directories }, refresh,
    command: async (sessionId, line) => {
      const live = sessions.binding(sessionId as SessionId)?.session
      if (live === undefined) throw new Error('This conversation is not ready yet')
      const result = await live.command(line)
      if (!result.ok) throw new Error(result.error.message)
    },
    openFile: openProjectFile,
    openFiles: () => { ctx.sidebarRight.openTab(FILES_TAB_KIND) },
    showProgress: () => {
      ctx.layout.setInitialRightbarWidth(320)
      ctx.sidebarRight.openTab(RESEARCH_TAB_KIND)
    },
    focusClaim: (claim) => { focus.update((s) => { s.claim = claim }) },
    create: async (request) => {
      const project = unwrap(await ctx.remote.research.create(request))
      await reread()
      return project
    },
    pickDirectory: async () => unwrap(await ctx.remote.directoryPicker.pick()),
    run: async request => follow(unwrap(await ctx.remote.research.command(request, controller.signal))),
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
    install: async (component) => { await follow(unwrap(await ctx.remote.research.installComponent(component))) },
    openConversation: async (sessionId, workspaceId) => {
      const listed = await whenListed(sessionId as SessionId)
      if (controller.signal.aborted) return
      if (listed) ctx.uiWorkspace.openSession(sessionId as SessionId)
      else await ctx.uiWorkspace.openWorkspace(workspaceId as Parameters<UiWorkspace['openWorkspace']>[0])
    },
    expand: (projectId, panel = 'workflow', artifactId) => {
      focus.update((s) => { s.projectId = projectId; s.panel = panel; s.artifactId = artifactId })
      ctx.layout.selectPanel('research' as MainPanelId)
    },
  })
  // The project's files stay reachable, but not as a second application beside
  // the conversation: nothing lists this panel, and the research tab opens it.
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'research', locale: 'research', inject: injected }, Workbench))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', locale: 'research' }, ResearchBrand))
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, ResearchMark))
  // Where the research stands, from the conversation header; clicking it opens the research tab.
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'research-status', order: 5, locale: 'research', inject: injected }, ResearchStatusChip))
  // The blank-session entry: the research mark, and the way to put a research in a folder of one's choosing.
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, ResearchHeroMark))
  ctx.slots.inject('conversation.hero.welcome', () => ctx.slots.register({ name: 'conversation.hero.welcome', id: 'research-create', order: 10, locale: 'research', inject: injected }, ResearchProjectEntry))
  ctx.slots.inject('sidebar.projects', () => ctx.slots.register({ name: 'sidebar.projects', id: 'research-projects', locale: 'research', inject: injected }, ResearchProjects))
  // A way into a project that does not go through the model first.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'research-new-project', order: 5, locale: 'research', inject: injected }, ResearchNewProject))
  // Submitted runs outlive the window, so the group reports itself above the composer.
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'research-runs', order: 6, locale: 'research', inject: injected }, ResearchRuns))
  // A claim's sources open over the whole frame; the rail puts one in focus.
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
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'research', order: 25, label: () => ctx.locale.bind('research')('settingsSection'), locale: 'research', inject: injected }, ResearchSettingsSection))
  // The harness's internal-testing notice is not this product's; shadowing it (lower priority renders) skips it. The API-key step stays.
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({ name: 'settings.onboarding', id: 'welcome-notice', priority: -1 }, SkipHarnessNotice))
  // Shell cells that are developer surfaces here, each shadowed by an empty cell (the host half's `Config`).
  if (hideDeveloperCells) {
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'stats', priority: -1 }, EmptyCell))
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({ name: 'settings.general.item', id: 'permission', priority: -1 }, EmptyCell))
    ctx.slots.inject('settings.action', () => ctx.slots.register({ name: 'settings.action', id: 'open-document', priority: -1 }, EmptyCell))
  }
  // The research record reports beside the conversation, read-only.
  ctx.inject(['sidebarRightTabs'], (scope: Context) => {
    const t = scope.locale.bind('research')
    scope.effect(() => scope.sidebarRightTabs.register({
      id: RESEARCH_TAB_ID,
      kind: RESEARCH_TAB_KIND,
      priority: 'builtin',
      title: () => t('railTitle'),
      guide: [{ id: 'research', order: 15, title: () => t('railGuideTitle'), description: () => t('railGuideDescription'), icon: ResearchHeroMark }],
    }), 'research.rail-type')
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({ name: 'sidebar.right.pane.tab', key: RESEARCH_TAB_ID, locale: 'research', inject: injected }, ResearchRail))
    scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: RESEARCH_TAB_ID, locale: 'research' }, ResearchRailTitle))
  })
  const timer = setInterval(() => { void refresh() }, 3000)
  ctx.effect(() => () => { controller.abort(); clearInterval(timer) }, 'research.refresh')
  void refresh()
}
