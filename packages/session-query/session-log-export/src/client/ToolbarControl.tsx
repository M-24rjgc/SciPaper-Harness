import type { ReactNode } from 'react'
import {
  IconCheckOutlineRegular, IconCopyOutlineRegular, IconDownloadOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionLogDownloadDialogInjected } from './Dialog.tsx'
import { shortLogId } from './log-id.ts'
import type { NS } from './locales.ts'
import { useLogIdCopy } from './use-log-id-copy.tsx'
import css from './ToolbarControl.module.css'

/** Download state and export request injected into the Trajectory toolbar contribution. */
export interface SessionLogToolbarInjected {
  hooks: Pick<SessionLogDownloadDialogInjected['hooks'], 'sessionLogDownload'>
  request: SessionLogDownloadDialogInjected['request']
}

/** Trajectory toolbar props plus the download face. */
export type SessionLogToolbarProps =
  PropsRuntime<'conversation.trajectory.toolbar'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionLogToolbarInjected>

/**
 * Render the Session's log ID with a copy action and the log export. Export progress and
 * failure appear in the shared dialog the Session Header owns.
 * @param props - Session runtime, download state, export request, and localized copy.
 * @returns the log ID control for the Trajectory toolbar.
 */
export function SessionLogToolbarControl({
  sessionId, useSessionLogDownload, request, t,
}: SessionLogToolbarProps): ReactNode {
  const logId = String(sessionId)
  const busy = useSessionLogDownload(state => state.bySession[logId]?.status === 'downloading')
  const { copied, copy, banner } = useLogIdCopy(logId, t)
  return (
    <div className={css.root} role="group" aria-label={t('log.group')}>
      <span className={css.label}>{t('log.label')}</span>
      {/* Portaled: the toolbar is a layout container, which would otherwise capture the fixed bubble. */}
      <Tooltip label={t('log.fullId', { id: logId })} side="bottom" portal>
        <span className={css.id} tabIndex={0}>{shortLogId(logId)}</span>
      </Tooltip>
      <Tooltip label={t('log.copy')} side="bottom" portal>
        <button type="button" className={css.iconControl} aria-label={t('log.copy')} onClick={copy}>
          {copied ? <IconCheckOutlineRegular size={12} /> : <IconCopyOutlineRegular size={12} />}
        </button>
      </Tooltip>
      <button
        type="button"
        className={css.control}
        aria-label={t('log.export')}
        title={t('log.export')}
        aria-busy={busy}
        disabled={busy}
        onClick={() => { void request(sessionId) }}
      >
        <IconDownloadOutlineRegular size={12} />
        <span className={css.exportText}>{t('log.export')}</span>
      </button>
      {banner}
    </div>
  )
}
