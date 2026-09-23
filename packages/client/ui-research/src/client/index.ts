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
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ResearchFocus, ResearchInjected, ResearchView, SessionDirectories } from './contract.ts'
import { projectFileAddress } from './format.ts'
import { Workbench, ResearchMark, ResearchBrand } from './Workbench.tsx'
import { ResearchDock, ResearchHeroMark, ResearchPromise, ResearchStarters } from './Hero.tsx'
import { ResearchRail, ResearchRailTitle } from './Rail.tsx'
import { ResearchClaimSheet } from './ClaimSheet.tsx'
import { ResearchRuns } from './RunPanel.tsx'
import { ResearchProjectActions, ResearchStatusChip } from './Header.tsx'
import { ResearchProjectEntry, ResearchProjects } from './ProjectEntry.tsx'
import { ResearchNewProject } from './NewProject.tsx'
import { ResearchSettingsSection } from './ResearchSettings.tsx'
import { SkipHarnessNotice } from './Onboarding.tsx'
import { en, zh, type ResearchKey } from './locales.ts'

/** This implementation's identity in the right-sidebar tab system. */
const RESEARCH_TAB_ID = '@deepseek-ai/dsh-client-ui-research'
/** The tab kind this package owns. */
const RESEARCH_TAB_KIND = 'research'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { research: ResearchKey } }
export type { ResearchInjected, ResearchView, WorkbenchProps } from './contract.ts'
export const inject = ['remote', 'remote.research', 'remote.directoryPicker', 'slots', 'locale', 'layout', 'sessions', 'sidebarRight']

/** Mount the project workbench using the native slot and Remote interfaces. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('research', { en, zh }), 'research.locales')
  ctx.effect(() => {
    document.body.dataset.researchWorkbench = ''
    return () => { delete document.body.dataset.researchWorkbench }
  }, 'research.appearance')
  const state = createSnapshotStore<ResearchView>({ snapshot: null, tasks: [], busy: false, error: '', response: null })
  // The rail and the frame-wide claim sheet live in different slot scopes, so the
  // selection between them travels through a store rather than through props.
  const focus = createSnapshotStore<ResearchFocus>({ claimId: null })
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
  const controller = new AbortController()
  let refreshing: Promise<void> | undefined
  // Tasks already settled when this window first reads are history, not news: they are never replayed.
  let primed = false
  const observed = new Set<string>()
  const unwrap = <T>(result: RemoteResult<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value }
  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing
    const reading = [ctx.remote.research.snapshot().then(unwrap), ctx.remote.research.tasks().then(unwrap)] as const
    refreshing = Promise.all(reading).then(([snapshot, tasks]) => {
      if (controller.signal.aborted) return
      let response = state.getSnapshot().response
      let error = state.getSnapshot().error
      for (const task of tasks) {
        if (observed.has(task.id) || task.status === 'running') continue
        observed.add(task.id)
        if (!primed) continue
        if (task.result) response = task.result
        if (task.status === 'failed' || task.status === 'interrupted') error = task.message
      }
      primed = true
      // Forget handles the host no longer reports, so the set stays as small as the task list.
      const listed = new Set(tasks.map(task => task.id))
      for (const id of observed) if (!listed.has(id)) observed.delete(id)
      state.set({ ...state.getSnapshot(), snapshot, tasks, response, error })
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) state.update((s) => { s.error = String(error) })
    }).finally(() => { refreshing = undefined })
    return refreshing
  }
  const perform = async <T>(work: () => Promise<T>): Promise<T> => {
    state.update((s) => { s.busy = true; s.error = '' })
    try { const result = await work(); await refresh(); return result }
    catch (error) { state.update((s) => { s.error = error instanceof Error ? error.message : String(error) }); throw error }
    finally { state.update((s) => { s.busy = false }) }
  }
  const injected = (): ResearchInjected => ({
    hooks: { research: state, focus, directories }, refresh,
    command: (sessionId, line) => perform(async () => {
      const live = sessions.binding(sessionId as SessionId)?.session
      if (live === undefined) throw new Error('This conversation is not ready yet')
      const result = await live.command(line)
      if (!result.ok) throw new Error(result.error.message)
    }),
    openFile: (root, path) => {
      try { ctx.sidebarRight.openResource(projectFileAddress(root, path)) }
      catch (error) { state.update((s) => { s.error = error instanceof Error ? error.message : String(error) }) }
    },
    showProgress: () => {
      ctx.layout.setInitialRightbarWidth(320)
      ctx.sidebarRight.openTab('research')
    },
    focusClaim: (claimId) => { focus.update((s) => { s.claimId = claimId }) },
    create: request => perform(async () => unwrap(await ctx.remote.research.create(request))),
    pickDirectory: () => perform(async () => unwrap(await ctx.remote.directoryPicker.pick())),
    run: request => perform(async () => {
      const response = unwrap(await ctx.remote.research.command(request, controller.signal))
      state.update((s) => { s.response = response })
      return response
    }),
    configure: (preferences, imageKey) => perform(async () => {
      unwrap(await ctx.remote.research.configure(preferences))
      if (imageKey) unwrap(await ctx.remote.research.setImageCredential(imageKey))
    }),
    install: component => perform(async () => {
      const response = unwrap(await ctx.remote.research.installComponent(component))
      state.update((s) => { s.response = response })
    }),
    openConversation: (sessionId) => {
      sessions.open(sessionId as SessionId)
      ctx.layout.selectPanel(null)
      return Promise.resolve()
    },
    expand: (projectId, panel = 'workflow', artifactId) => {
      focus.update((s) => { s.projectId = projectId; s.panel = panel; s.artifactId = artifactId })
      ctx.layout.selectPanel('research' as MainPanelId)
    },
  })
  // The project's files stay reachable, but not as a second application beside
  // the conversation: nothing lists this panel, and the session header opens it.
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'research', locale: 'research', inject: injected }, Workbench))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', locale: 'research' }, ResearchBrand))
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, ResearchMark))
  // Where the research stands, and the project files, from the conversation header.
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'research-status', order: 5, locale: 'research', inject: injected }, ResearchStatusChip))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'research-project', order: 5, locale: 'research', inject: injected }, ResearchProjectActions))
  // The blank-session entry belongs to research: its mark, and the openings that teach what to say.
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, ResearchHeroMark))
  ctx.slots.inject('conversation.hero.welcome', () => ctx.slots.register({ name: 'conversation.hero.welcome', id: 'research-starters', locale: 'research', inject: injected }, ResearchStarters))
  ctx.slots.inject('conversation.hero.welcome', () => ctx.slots.register({ name: 'conversation.hero.welcome', id: 'research-create', order: 10, locale: 'research', inject: injected }, ResearchProjectEntry))
  ctx.slots.inject('sidebar.projects', () => ctx.slots.register({ name: 'sidebar.projects', id: 'research-projects', locale: 'research', inject: injected }, ResearchProjects))
  // A way into a project that does not go through the model first.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'research-new-project', order: 5, locale: 'research', inject: injected }, ResearchNewProject))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'research-openings', order: 5, locale: 'research', inject: injected }, ResearchDock))
  // Submitted runs outlive the window, so the group reports itself above the composer.
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'research-runs', order: 6, locale: 'research', inject: injected }, ResearchRuns))
  // A claim's sources open over the whole frame; the rail puts one in focus.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'research-claim', order: 20, locale: 'research', inject: injected }, ResearchClaimSheet))
  ctx.slots.inject('conversation.hero.footer', () => ctx.slots.register({ name: 'conversation.hero.footer', id: 'research-promise', order: 5, locale: 'research', inject: injected }, ResearchPromise))
  // Configuration lives in settings; the main surface stays free of it.
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'research', order: 25, label: () => ctx.locale.bind('research')('settingsSection'), locale: 'research', inject: injected }, ResearchSettingsSection))
  // The harness's internal-testing notice is not this product's; shadowing it (lower priority renders) skips it. The API-key step stays.
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({ name: 'settings.onboarding', id: 'welcome-notice', priority: -1 }, SkipHarnessNotice))
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
