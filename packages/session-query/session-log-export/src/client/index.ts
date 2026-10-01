/** Browser plugin owning Session export download state and its shared modal. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-message-feedback/client'
import type {} from '@deepseek-ai/dsh-client-ui-trajectory/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionLogDownloadController } from './controller.ts'
import { SessionLogDownloadHeaderAction, type SessionLogDownloadHeaderInjected } from './HeaderAction.tsx'
import { en, NS, zh, type SessionLogDownloadKey } from './locales.ts'
import { SessionLogToolbarControl, type SessionLogToolbarInjected } from './ToolbarControl.tsx'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionLogDownload: SessionLogDownloadController
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'session-log-download': SessionLogDownloadKey
  }
}

export type { SessionLogDownloadEntry, SessionLogDownloadState } from './controller.ts'

export const inject = ['slots', 'locale']

/**
 * Provide the download controller, mount its modal into the Session Header, and
 * offer the log ID with the export in the Trajectory toolbar when that view is mounted.
 * @param ctx - browser context carrying slots and locale services.
 */
export function apply(ctx: ClientContext): void {
  const controller = new SessionLogDownloadController()
  ctx.provide('sessionLogDownload', controller)
  ctx.effect(() => async () => { await controller.dispose() }, 'session-log-download: browser download lifecycle')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-log-download: browser dictionaries')
  const feedbackAvailable = createSnapshotStore(false)
  ctx.inject(['feedbackUi'], (scope: ClientContext) => {
    scope.effect(() => {
      feedbackAvailable.set(true)
      return () => { feedbackAvailable.set(false) }
    }, 'session-log-download: feedback availability')
  })
  ctx.on('command/executed', (sessionId, commandName, result) => {
    if (commandName === 'export' && result.kind === 'success') void controller.download(sessionId)
  })
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-log-download',
    locale: NS,
    inject: (): SessionLogDownloadHeaderInjected => ({
      hooks: { sessionLogDownload: controller.store, feedbackAvailable },
      request: (sessionId: SessionId) => controller.download(sessionId),
      dismiss: (sessionId: SessionId) => { controller.dismiss(sessionId) },
      // The feedback plugin can unload between the menu render and this click.
      openFeedback: (sessionId: SessionId) => { ctx.get('feedbackUi')?.openSession(sessionId) },
    }),
  }, SessionLogDownloadHeaderAction))
  ctx.slots.inject('conversation.trajectory.toolbar', () => ctx.slots.register({
    name: 'conversation.trajectory.toolbar',
    id: 'session-log-download',
    locale: NS,
    inject: (): SessionLogToolbarInjected => ({
      hooks: { sessionLogDownload: controller.store },
      request: (sessionId: SessionId) => controller.download(sessionId),
    }),
  }, SessionLogToolbarControl))
}

export type { SessionLogDownloadDialogInjected, SessionLogDownloadDialogProps } from './Dialog.tsx'
