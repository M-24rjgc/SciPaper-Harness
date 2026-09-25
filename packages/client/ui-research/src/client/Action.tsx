/**
 * One user action's own progress on screen. Every research control that asks
 * the host for something keeps an action of its own, so a slow import never
 * holds up an unrelated button and a failure shows beside the control that
 * caused it, never in a shared banner.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Translate } from './format.ts'
import styles from './Action.module.css'

/** Where one control's work stands. */
export interface Action {
  /** True while work this action started is still in flight. */
  readonly pending: boolean
  /** Why the last attempt failed; empty before any attempt, while one runs, and after a success. */
  readonly error: string
  /** True once the last attempt succeeded and nothing is in flight. */
  readonly done: boolean
  /** Run `work`; a throw or a rejection becomes `error`. Each call runs, so the control disables itself while `pending`. */
  start(work: () => unknown): void
  /** Forget how the last attempt ended, as when its form is opened afresh. */
  clear(): void
}

/** The message of a thrown value, whatever was thrown. */
function reasonOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Track one control's work: how many attempts are in flight and how the last
 * one ended. Updates after the component unmounted are dropped.
 * @returns the action's state and its start function.
 */
export function useAction(): Action {
  const [running, setRunning] = useState(0)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const settle = (failed: boolean, reason?: unknown): void => {
    if (!mounted.current) return
    setRunning(count => count - 1)
    setDone(!failed)
    setError(failed ? reasonOf(reason) : '')
  }
  return {
    pending: running > 0,
    error,
    done: done && running === 0,
    start: (work) => {
      setError('')
      setDone(false)
      setRunning(count => count + 1)
      void Promise.resolve().then(work).then(() => { settle(false) }, (reason: unknown) => { settle(true, reason) })
    },
    clear: () => {
      setError('')
      setDone(false)
    },
  }
}

/**
 * The failure line under a control; nothing while the action has not failed.
 * A control in a row of other controls passes its own `className` for a line
 * that fits beside it.
 */
export function ActionError(props: { t: Translate; error: string; className?: string | undefined }): ReactNode {
  if (props.error === '') return null
  return <p className={props.className ?? styles.error} role="alert">{props.t('actionFailed', { reason: props.error })}</p>
}

/** What a button that runs one action says, and the work one press starts. */
export interface ActionButtonProps {
  t: Translate
  label: string
  /** Said instead of `label` while the work runs; `label` stays when absent. */
  pendingLabel?: string | undefined
  className?: string | undefined
  /** Held off by the caller, whatever the action's own state. */
  disabled?: boolean | undefined
  work: () => unknown
}

/**
 * A button that owns one action: it holds itself off while its work runs, and
 * the failure line follows it.
 */
export function ActionButton(props: ActionButtonProps): ReactNode {
  const action = useAction()
  return <>
    <button type="button" className={props.className} disabled={props.disabled === true || action.pending} onClick={() => { action.start(props.work) }}>
      {action.pending && props.pendingLabel !== undefined ? props.pendingLabel : props.label}
    </button>
    <ActionError t={props.t} error={action.error} />
  </>
}
