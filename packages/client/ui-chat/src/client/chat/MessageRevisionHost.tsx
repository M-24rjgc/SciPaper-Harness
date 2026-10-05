/** Frame-owned revision editor and feedback, retained across view navigation. */
import { Button, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './MessageRevisionHost.module.css'

export interface MessageRevisionState {
  draft: {
    sessionId: SessionId
    seq: number
    text: string
    hasAttachments: boolean
    mode: 'edit' | 'retry'
  } | null
  pending: boolean
  error: string | null
}

export interface MessageRevisionInjected {
  hooks: { revision: ObservableSnapshot<MessageRevisionState> }
  changeText: (text: string) => void
  submitRevision: () => void
  closeRevision: () => void
  dismissError: () => void
}

/**
 * Render the message editor without owning the asynchronous operation.
 * @param props - frame-owned draft, actions, and localized copy.
 * @returns the revision dialog and feedback surface.
 */
export function MessageRevisionHost({ useRevision, changeText, submitRevision, closeRevision, dismissError, t }:
  PropsRuntime<'shell.overlay'> & PropsLocale<'chat'> & InjectFace<MessageRevisionInjected>) {
  const state = useRevision(value => value)
  const draft = state.draft
  return <>
    {draft !== null && <Modal
      open title={t(draft.mode === 'edit' ? 'message.edit' : 'message.resend')}
      description={t('message.historyHint')} closeLabel={t('message.cancel')} onClose={closeRevision}
      footer={<>
        <Button variant="outline" disabled={state.pending} onClick={closeRevision}>{t('message.cancel')}</Button>
        <Button variant="primary" disabled={state.pending || (draft.mode === 'edit' && !draft.hasAttachments && draft.text.trim() === '')} onClick={submitRevision}>
          {t(state.pending ? 'message.resending' : 'message.resend')}
        </Button>
      </>}
    >
      {draft.mode === 'edit' && <textarea
        data-modal-autofocus className={css.editor} aria-label={t('message.editText')}
        value={draft.text} disabled={state.pending}
        onChange={(event) => { changeText(event.target.value) }}
      />}
      {draft.hasAttachments && <p className={css.hint}>{t('message.keepAttachments')}</p>}
      {state.error !== null && <p role="alert" className={css.error}>{state.error}</p>}
    </Modal>}
    {draft === null && state.error !== null && <Toast text={state.error} onDone={dismissError} />}
  </>
}
