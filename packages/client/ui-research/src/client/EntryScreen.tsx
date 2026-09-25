/**
 * The research's lines on the entry screen (a blank conversation): under the
 * headline, what this blank conversation is; above the composer, two example
 * sentences for a new research. Neither starts anything.
 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { sessionProject, type EntryNotice, type EntryProps } from './contract.ts'
import { appendedDraft, standingText, type Translate } from './format.ts'
import type { ResearchKey } from './locales.ts'
import styles from './EntryScreen.module.css'

/** The sentence each failed action reads with its reason. */
const FAILED: Record<Extract<EntryNotice, { kind: 'failed' }>['action'], ResearchKey> = {
  land: 'entryLandFailed', new: 'entryNewFailed', move: 'entryMoveFailed', reveal: 'entryRevealFailed',
}
/** The two example sentences, in the order the chips show them. */
const TRY_SENTENCES: readonly ResearchKey[] = ['heroOpeningMaterials', 'heroOpeningIdea']

/** What a notice says. */
function noticeText(notice: EntryNotice, t: Translate): string {
  return notice.kind === 'here' ? t('entryHere') : t(FAILED[notice.action], { reason: notice.reason })
}

/** Composed props of the entry line: the headline's welcome seat and the entry face. */
export type EntryLineProps = PropsRuntime<'conversation.hero.welcome'> & EntryProps

/**
 * The one line under the headline. A new research (the untouched draft) has
 * none; a new conversation in a research reads `新对话 · {mode} · {phase}
 * n/m · 研究记录`, the last opening the research tab; an example reads
 * `示例研究 · 只能查看`. A notice raised on this screen follows the line.
 */
export function ResearchEntryLine(props: EntryLineProps): ReactNode {
  const { t } = props
  const current = props.useSessions(state => state.current)
  const notice = props.useEntry(state => state.notice)
  const snapshot = props.useResearch(state => state.snapshot)
  const directories = props.useDirectories(state => state)
  const modes = snapshot?.modes ?? []
  const project = current === undefined ? undefined : sessionProject(snapshot?.projects, current, directories)
  const shown = notice !== null && notice.sessionId === current ? notice : null
  let line: ReactNode = null
  if (project?.example === true) line = <p className={styles.line}>{t('entryExample')}</p>
  else if (project !== undefined && project.draft !== true) {
    line = <p className={styles.line}>
      <span>{t('entryNewConversation')}</span>
      <span className={styles.separator}>·</span>
      <span>{standingText(project, modes, t)}</span>
      <span className={styles.separator}>·</span>
      <button type="button" className={styles.record} onClick={() => { props.showProgress() }}>{t('entryRecord')}</button>
    </p>
  }
  if (line === null && shown === null) return null
  return <div className={styles.root}>
    {line}
    {shown !== null && <p className={shown.kind === 'failed' ? styles.failed : styles.notice} role={shown.kind === 'failed' ? 'alert' : 'status'}>
      {noticeText(shown, t)}
    </p>}
  </div>
}

/** Composed props of the Try sentences: the input dock's seat and the entry face. */
export type TryChipsProps = PropsRuntime<'conversation.input.dock'> & EntryProps

/**
 * 试试 (Try): two example sentences above the composer of the untouched draft
 * research while nothing is typed. A click adds the sentence to the draft and
 * sends nothing.
 */
export function ResearchTryChips(props: TryChipsProps): ReactNode {
  const { t, input } = props
  const projects = props.useResearch(state => state.snapshot)?.projects
  const project = sessionProject(projects, props.sessionId, props.useDirectories(state => state))
  // Blank until the first turn starts; the draft flag follows only on the next read of the record.
  const blank = props.useSessions(state => state.byId[props.sessionId]?.blank === true)
  if (project?.draft !== true || !blank || input.draft.trim() !== '') return null
  return <div className={styles.try}>
    <span className={styles.tryLabel}>{t('entryTry')}</span>
    {TRY_SENTENCES.map(key => <button key={key} type="button" className={styles.tryChip} title={t('entryTryHint')}
      onClick={() => { props.inputActions.setDraft(appendedDraft(input.draft, t(key))) }}>
      {t('entryTryChip', { sentence: t(key) })}
    </button>)}
  </div>
}
